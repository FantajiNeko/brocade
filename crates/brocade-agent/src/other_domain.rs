//! Optional details have independent samplers and durable retry spools, never billing locks.
use crate::spool::{spool_drain, spool_push, Spool, DOMAIN_DETAIL_SPOOL, FAILED_DETAIL_SPOOL};
use crate::{http::HttpClient, options::Options, xray_grpc::XrayStat};
use brocade_deployment::other_domain::{
    valid_domain, OtherDomainCounter, OtherDomainPolicy, OtherDomainReport,
    DETAIL_CHECKPOINT_VERSION, OTHER_DOMAIN_MAX_ROWS, OTHER_DOMAIN_VERSION,
};
use brocade_deployment::sniffing_failed::{
    valid_target, SniffingFailedCounter, SniffingFailedPolicy, SniffingFailedReport,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone, Copy)]
enum DetailKind {
    Domain,
    FailedTarget,
    Source,
}
impl DetailKind {
    fn spool(self) -> Option<Spool> {
        match self {
            Self::Domain => Some(DOMAIN_DETAIL_SPOOL),
            Self::FailedTarget => Some(FAILED_DETAIL_SPOOL),
            Self::Source => None,
        }
    }
    fn pattern(self) -> &'static str {
        match self {
            Self::Domain => "otherdomain>>>",
            Self::FailedTarget => "sniffingfailed>>>",
            Self::Source => "sourcetraffic>>>",
        }
    }
    fn file(self) -> &'static str {
        match self {
            Self::Domain => "other-domain-policy.json",
            Self::FailedTarget => "sniffing-failed-policy.json",
            Self::Source => "source-traffic-policy.json",
        }
    }
    fn route(self) -> &'static str {
        match self {
            Self::Domain => "/agent/v1/other-domain-usage",
            Self::FailedTarget => "/agent/v1/sniffing-failed-usage",
            Self::Source => "/agent/v1/source-traffic",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Domain => "other-domain",
            Self::FailedTarget => "sniffing-failed",
            Self::Source => "source-traffic",
        }
    }
    fn valid_key(self, key: &str) -> bool {
        match self {
            Self::Domain => valid_domain(key),
            Self::FailedTarget => valid_target(key),
            Self::Source => brocade_deployment::source_traffic::valid_source_ip(key),
        }
    }
    fn decode_policy(self, bytes: &[u8]) -> Result<OtherDomainPolicy, String> {
        let policy = match self {
            Self::Domain | Self::Source => {
                serde_json::from_slice(bytes).map_err(|_| "invalid detail policy")?
            }
            Self::FailedTarget => serde_json::from_slice::<SniffingFailedPolicy>(bytes)
                .map_err(|_| "invalid failed-target policy")?
                .budget(),
        };
        policy.validate().map_err(str::to_owned)?;
        Ok(policy)
    }
    fn policy_bytes(self, policy: OtherDomainPolicy) -> Result<Vec<u8>, String> {
        match self {
            Self::Domain | Self::Source => serde_json::to_vec(&policy),
            Self::FailedTarget => serde_json::to_vec(&SniffingFailedPolicy::from_budget(policy)),
        }
        .map_err(|_| "cannot encode optional collection policy".into())
    }
    fn report_body(self, report: &OtherDomainReport) -> Result<String, String> {
        match self {
            Self::Domain => serde_json::to_string(report),
            Self::Source => serde_json::to_string(&report.clone().map_counters(|r| {
                brocade_deployment::source_traffic::SourceTrafficCounter {
                    bucket: r.bucket,
                    label: r.label,
                    source_ip: r.domain,
                    uplink_bytes: r.uplink_bytes,
                    downlink_bytes: r.downlink_bytes,
                }
            })),
            Self::FailedTarget => serde_json::to_string(&SniffingFailedReport {
                version: report.version,
                epoch: report.epoch.clone(),
                activation_unix_secs: report.activation_unix_secs,
                read_at_unix_secs: report.read_at_unix_secs,
                usage_generation_id: report.usage_generation_id,
                limited: report.limited,
                counters: report
                    .counters
                    .iter()
                    .map(|r| SniffingFailedCounter {
                        counter_id: r.counter_id,
                        bucket: r.bucket,
                        label: r.label.clone(),
                        target: r.domain.clone(),
                        uplink_bytes: r.uplink_bytes,
                        downlink_bytes: r.downlink_bytes,
                    })
                    .collect(),
            }),
        }
        .map_err(|_| "cannot encode optional observation".into())
    }
}

impl DetailKind {
    fn bucket_secs(self) -> i64 {
        match self {
            Self::Source => 30,
            _ => 3600,
        }
    }
}

pub(crate) fn apply_source_capability(dir: &Path, header: Option<&str>) -> Result<(), String> {
    let policy = OtherDomainPolicy {
        enabled: header == Some("1"),
        top_n: 64,
        max_domains_per_user: 64,
        node_capacity: 4096,
        report_interval_secs: 15,
    };
    let value = serde_json::to_string(&policy).map_err(|_| "cannot encode source capability")?;
    apply_policy_for(dir, Some(&value), DetailKind::Source)
}

pub(crate) fn control_path(dir: &Path) -> PathBuf {
    dir.join("other-domain-policy.json")
}

pub(crate) fn apply_policy(dir: &Path, header: Option<&str>) -> Result<(), String> {
    apply_policy_for(dir, header, DetailKind::Domain)
}
pub(crate) fn failed_control_path(dir: &Path) -> PathBuf {
    dir.join(DetailKind::FailedTarget.file())
}
pub(crate) fn apply_failed_policy(dir: &Path, header: Option<&str>) -> Result<(), String> {
    apply_policy_for(dir, header, DetailKind::FailedTarget)
}
fn apply_policy_for(dir: &Path, header: Option<&str>, kind: DetailKind) -> Result<(), String> {
    let parsed: Result<OtherDomainPolicy, String> = (|| {
        let policy = match header {
            Some(value) if value.len() <= 1024 => kind.decode_policy(value.as_bytes())?,
            None => OtherDomainPolicy::default(),
            _ => return Err("domain collection policy is too large".into()),
        };
        policy.validate().map_err(str::to_owned)?;
        Ok(policy)
    })();
    // Malformed/newer policies fail closed instead of keeping a previously enabled profile.
    let policy = parsed.as_ref().copied().unwrap_or_default();
    let bytes = kind.policy_bytes(policy)?;
    let path = dir.join(kind.file());
    // Always repair permissions too; optional policies are private runtime state.
    use std::os::unix::fs::PermissionsExt;
    if std::fs::symlink_metadata(&path)
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o777 == 0o600)
        && std::fs::read(&path).is_ok_and(|value| value == bytes)
    {
        return parsed.map(|_| ());
    }
    crate::fsutil::atomic_write_private(&path, &bytes)?;
    parsed.map(|_| ())
}

fn read_policy(dir: &Path) -> Result<OtherDomainPolicy, String> {
    read_policy_for(dir, DetailKind::Domain)
}
fn read_policy_for(dir: &Path, kind: DetailKind) -> Result<OtherDomainPolicy, String> {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(kind.file());
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(OtherDomainPolicy::default())
        }
        Err(_) => return Err("cannot inspect domain policy".into()),
    };
    if !metadata.is_file() || metadata.permissions().mode() & 0o777 != 0o600 {
        return Err("domain policy is not private".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .and_then(|file| file.take(1025).read_to_end(&mut bytes))
        .map_err(|_| "cannot read domain policy")?;
    if bytes.len() > 1024 {
        return Err("domain policy is too large".into());
    }
    kind.decode_policy(&bytes)
}

pub(crate) fn from_stats(
    stats: &[XrayStat],
    generation: i64,
    now: i64,
) -> Result<Option<OtherDomainReport>, String> {
    from_stats_for(stats, generation, now, DetailKind::Domain)
}
fn from_stats_for(
    stats: &[XrayStat],
    generation: i64,
    now: i64,
    kind: DetailKind,
) -> Result<Option<OtherDomainReport>, String> {
    let prefix = kind.pattern();
    if stats.len() > OTHER_DOMAIN_MAX_ROWS * 2 + 6 {
        return Err("domain snapshot exceeds capacity".into());
    }
    if !stats
        .iter()
        .any(|s| s.name.strip_prefix(prefix) == Some("enabled") && s.value == 1)
    {
        return Ok(None);
    }
    let mut epoch = None;
    let mut activation = None;
    let wire_version = stats
        .iter()
        .find(|s| s.name == format!("{prefix}version"))
        .map(|s| s.value)
        .ok_or("missing domain snapshot version")?;
    if wire_version != i64::from(OTHER_DOMAIN_VERSION)
        && (wire_version != i64::from(DETAIL_CHECKPOINT_VERSION)
            || matches!(kind, DetailKind::Source))
    {
        return Err("unsupported domain snapshot version".into());
    }
    let checkpointed = wire_version == i64::from(DETAIL_CHECKPOINT_VERSION);
    let mut limited = false;
    let sampled_at = if matches!(kind, DetailKind::Source) {
        stats
            .iter()
            .find(|s| s.name == format!("{prefix}sampled_at"))
            .filter(|s| s.value > 0 && s.value >= now - 60 && s.value <= now + 60)
            .map(|s| s.value)
            .ok_or("missing or stale source snapshot time")?
    } else {
        now
    };
    let mut rows = BTreeMap::<(i64, String, String, u64), (u64, u64)>::new();
    let mut source_fields = BTreeMap::<(i64, String, String, u64), (bool, bool)>::new();
    for stat in stats {
        let suffix = stat
            .name
            .strip_prefix(prefix)
            .ok_or("unexpected observation namespace")?;
        if let Some(value) = suffix.strip_prefix("epoch:") {
            if epoch.is_some() || value.len() != 32 || !value.bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err("invalid domain snapshot epoch".into());
            }
            epoch = Some(value.to_owned());
        } else {
            match suffix {
                "version" if stat.value == wire_version => {}
                "activation" if stat.value > 0 && stat.value <= now + 60 => {
                    activation = Some(stat.value)
                }
                "enabled" if stat.value == 1 => {}
                "limited" if matches!(stat.value, 0 | 1) => limited = stat.value == 1,
                "sampled_at" if matches!(kind, DetailKind::Source) && stat.value == sampled_at => {}
                _ => {
                    let parts: Vec<_> = stat.name.split(">>>").collect();
                    if parts.len() != if checkpointed { 6 } else { 5 }
                        || !stat.name.starts_with(prefix)
                        || parts[2].len() > 256
                        || !kind.valid_key(parts[3])
                        || !matches!(parts[parts.len() - 1], "uplink" | "downlink")
                    {
                        return Err("invalid domain snapshot row".into());
                    }
                    let bucket = parts[1]
                        .parse::<i64>()
                        .map_err(|_| "invalid domain snapshot bucket")?;
                    let seconds = kind.bucket_secs();
                    if bucket != sampled_at / seconds * seconds
                        && bucket != sampled_at / seconds * seconds - seconds
                    {
                        return Err("stale domain snapshot bucket".into());
                    }
                    let value = u64::try_from(stat.value)
                        .map_err(|_| "negative domain snapshot counter")?;
                    let counter_id = if checkpointed {
                        parts[4]
                            .parse::<u64>()
                            .ok()
                            .filter(|id| *id > 0 && *id <= i64::MAX as u64)
                            .ok_or("invalid domain counter identity")?
                    } else {
                        0
                    };
                    if checkpointed || matches!(kind, DetailKind::Source) {
                        let fields = source_fields
                            .entry((bucket, parts[2].to_owned(), parts[3].to_owned(), counter_id))
                            .or_default();
                        let present = if parts[parts.len() - 1] == "uplink" {
                            &mut fields.0
                        } else {
                            &mut fields.1
                        };
                        if *present {
                            return Err("duplicate source snapshot direction".into());
                        }
                        *present = true;
                    }
                    let row = rows
                        .entry((bucket, parts[2].to_owned(), parts[3].to_owned(), counter_id))
                        .or_default();
                    if parts[parts.len() - 1] == "uplink" {
                        row.0 = value;
                    } else {
                        row.1 = value;
                    }
                }
            }
        }
    }
    if source_fields.values().any(|fields| *fields != (true, true)) {
        return Err("incomplete source snapshot directions".into());
    }
    if checkpointed {
        let mut identities = BTreeSet::new();
        if rows.keys().any(|(_, _, _, id)| !identities.insert(*id)) {
            return Err("reused domain segment identity".into());
        }
    }
    Ok(Some(OtherDomainReport {
        version: wire_version as u32,
        epoch: epoch.ok_or("missing domain snapshot epoch")?,
        activation_unix_secs: activation.ok_or("missing domain snapshot activation")?,
        read_at_unix_secs: sampled_at,
        usage_generation_id: generation,
        limited,
        counters: rows
            .into_iter()
            .filter(|(_, v)| *v != (0, 0))
            .map(
                |((bucket, label, domain, counter_id), (uplink_bytes, downlink_bytes))| {
                    OtherDomainCounter {
                        counter_id,
                        bucket,
                        label,
                        domain,
                        uplink_bytes,
                        downlink_bytes,
                    }
                },
            )
            .collect(),
    }))
}

fn sample(options: &Options, kind: DetailKind) -> Result<Option<OtherDomainReport>, String> {
    let state = &options.state_dir;
    let Some(generation) = crate::read_usage_generation(state)? else {
        return Ok(None);
    };
    let process = crate::xray_process_identity(state)?;
    let config = std::fs::read_to_string(state.join("xray.json"))
        .map_err(|_| "cannot read domain query configuration")?;
    let api_address = crate::xray_api_address(&config).ok_or("missing domain query API")?;
    let stats = if kind.spool().is_some() {
        let checkpointed =
            crate::xray_grpc::query_stats(api_address, &format!("{}v2", kind.pattern()))?;
        if checkpointed.is_empty() {
            crate::xray_grpc::query_stats(api_address, kind.pattern())?
        } else {
            checkpointed
        }
    } else {
        crate::xray_grpc::query_stats(api_address, kind.pattern())?
    };
    crate::validate_xray_sample_process(state, &process)?;
    if crate::read_usage_generation(state)? != Some(generation) {
        return Err("domain observation changed generation".into());
    }
    match kind {
        DetailKind::Domain => from_stats(&stats, generation, crate::current_unix_secs()?),
        DetailKind::FailedTarget | DetailKind::Source => {
            from_stats_for(&stats, generation, crate::current_unix_secs()?, kind)
        }
    }
}

type DetailHeads = BTreeMap<(i64, String, String, u64), (u64, u64)>;

fn persist_checkpoint(
    state: &Path,
    kind: DetailKind,
    report: &OtherDomainReport,
    durable: &mut DetailHeads,
    acknowledge: impl FnOnce(&OtherDomainReport) -> Result<(), String>,
) -> Result<(), String> {
    let resident_ids = report
        .counters
        .iter()
        .map(|r| r.counter_id)
        .collect::<BTreeSet<_>>();
    durable.retain(|(_, _, _, id), _| resident_ids.contains(id));
    let mut changed = report.clone();
    changed.counters.retain(|r| {
        durable.get(&(r.bucket, r.label.clone(), r.domain.clone(), r.counter_id))
            != Some(&(r.uplink_bytes, r.downlink_bytes))
    });
    if !changed.counters.is_empty() {
        let spool = kind.spool().ok_or("detail spool unavailable")?;
        let value: serde_json::Value = serde_json::from_str(&kind.report_body(&changed)?)
            .map_err(|_| "invalid encoded detail report")?;
        spool_push(spool, state, &value)?;
        for r in &changed.counters {
            durable.insert(
                (r.bucket, r.label.clone(), r.domain.clone(), r.counter_id),
                (r.uplink_bytes, r.downlink_bytes),
            );
        }
    }
    // Also retries a lost local acknowledgement, without queuing unchanged bytes again.
    acknowledge(report)
}

fn acknowledge(state: &Path, kind: DetailKind, report: &OtherDomainReport) -> Result<(), String> {
    let config = std::fs::read_to_string(state.join("xray.json"))
        .map_err(|_| "cannot read checkpoint query configuration")?;
    let api = crate::xray_api_address(&config).ok_or("missing checkpoint query API")?;
    for chunk in report.counters.chunks(256) {
        let rows = chunk
            .iter()
            .map(|r| format!("{}:{}:{}", r.counter_id, r.uplink_bytes, r.downlink_bytes))
            .collect::<Vec<_>>()
            .join(",");
        crate::xray_grpc::query_stats(
            api,
            &format!("{}ack>>>{}>>>{rows}", kind.pattern(), report.epoch),
        )?;
    }
    Ok(())
}

pub(crate) fn spawn(options: Options) -> Result<(), String> {
    for kind in [
        DetailKind::Domain,
        DetailKind::FailedTarget,
        DetailKind::Source,
    ] {
        spawn_for(options.clone(), kind)?;
    }
    Ok(())
}
fn spawn_for(options: Options, kind: DetailKind) -> Result<(), String> {
    let status = Arc::new(Mutex::new(None::<OtherDomainReport>));
    if let Some(spool) = kind.spool() {
        let reporter_options = options.clone();
        let reporter_status = Arc::clone(&status);
        std::thread::Builder::new()
            .name(format!("{}-reporter", kind.name()))
            .spawn(move || {
                let mut last_status = 0;
                while !crate::TERMINATION_REQUESTED.load(std::sync::atomic::Ordering::SeqCst) {
                    let drained = spool_drain(spool, &reporter_options);
                    if drained.is_err() {
                        eprintln!("{} durable report unavailable; retrying", kind.name());
                    } else {
                        let current = reporter_status
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .clone();
                        if let Some(report) =
                            current.filter(|report| report.read_at_unix_secs >= last_status + 60)
                        {
                            // An empty, best-effort heartbeat keeps coverage fresh without
                            // queuing unchanged counters or competing with durable delivery.
                            let sent = (|| -> Result<(), String> {
                                let client = HttpClient::new(&reporter_options.server)?;
                                let body = kind.report_body(&report)?;
                                let response = client.request(
                                    "POST",
                                    kind.route(),
                                    &reporter_options.token,
                                    Some(&body),
                                )?;
                                if response.status != 200 {
                                    return Err("detail heartbeat failed".into());
                                }
                                Ok(())
                            })();
                            if sent.is_ok() {
                                last_status = report.read_at_unix_secs;
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_secs(5));
                }
            })
            .map_err(|_| "cannot spawn detail reporter".to_owned())?;
    }
    std::thread::Builder::new()
        .name(kind.name().into())
        .spawn(move || {
            let mut sent = BTreeMap::<(i64, String, String, u64), (u64, u64)>::new();
            let mut epoch = String::new();
            let mut generation = None;
            let mut policy_failed = false;
            loop {
                if crate::TERMINATION_REQUESTED.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                let policy = match match kind {
                    DetailKind::Domain => read_policy(&options.state_dir),
                    DetailKind::FailedTarget | DetailKind::Source => {
                        read_policy_for(&options.state_dir, kind)
                    }
                } {
                    Ok(value) => {
                        policy_failed = false;
                        value
                    }
                    Err(_) => {
                        if !policy_failed {
                            eprintln!("{} policy unavailable; collection disabled", kind.name());
                        }
                        policy_failed = true;
                        OtherDomainPolicy::default()
                    }
                };
                if policy.enabled {
                    // Sampling never waits for a Console request. Only a durable checkpoint may
                    // authorize Xray to evict a resident segment.
                    let outcome = (|| -> Result<(), String> {
                        let Some(mut report) = sample(&options, kind)? else {
                            return Ok(());
                        };
                        if epoch != report.epoch || generation != Some(report.usage_generation_id) {
                            sent.clear();
                            epoch = report.epoch.clone();
                            generation = Some(report.usage_generation_id);
                        }
                        let seconds = kind.bucket_secs();
                        let floor = report.read_at_unix_secs / seconds * seconds - seconds;
                        sent.retain(|(bucket, _, _, _), _| *bucket >= floor);
                        if report.version == DETAIL_CHECKPOINT_VERSION {
                            let mut header = report.clone();
                            header.counters.clear();
                            let saved = persist_checkpoint(
                                &options.state_dir,
                                kind,
                                &report,
                                &mut sent,
                                |checkpoint| acknowledge(&options.state_dir, kind, checkpoint),
                            );
                            header.limited |= saved.is_err();
                            *status
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(header);
                            saved?;
                            return Ok(());
                        }
                        report.counters.retain(|r| {
                            sent.get(&(r.bucket, r.label.clone(), r.domain.clone(), r.counter_id))
                                != Some(&(r.uplink_bytes, r.downlink_bytes))
                        });
                        let body = kind.report_body(&report)?;
                        let client = HttpClient::new(&options.server)?;
                        let response =
                            client.request("POST", kind.route(), &options.token, Some(&body))?;
                        if response.status != 200 {
                            return Err(format!("domain report HTTP {}", response.status));
                        }
                        for r in report.counters {
                            sent.insert(
                                (r.bucket, r.label, r.domain, r.counter_id),
                                (r.uplink_bytes, r.downlink_bytes),
                            );
                        }
                        Ok(())
                    })();
                    // Do not print rows, labels, domain names or response bodies.
                    if outcome.is_err() {
                        eprintln!(
                            "{} observation unavailable; retrying next interval",
                            kind.name()
                        );
                    }
                } else {
                    sent.clear();
                    epoch.clear();
                }
                std::thread::sleep(Duration::from_secs(u64::from(policy.report_interval_secs)));
            }
        })
        .map_err(|_| "cannot spawn domain observation worker".to_owned())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn checkpoint_test_dir(name: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("brocade-{name}-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
    fn detail_checkpoint(id: u64, up: u64) -> OtherDomainReport {
        OtherDomainReport {
            version: DETAIL_CHECKPOINT_VERSION,
            epoch: "a".repeat(32),
            activation_unix_secs: 7200,
            read_at_unix_secs: 7300,
            usage_generation_id: 1,
            limited: false,
            counters: vec![OtherDomainCounter {
                counter_id: id,
                bucket: 7200,
                label: "a@t#i".into(),
                domain: "a.example".into(),
                uplink_bytes: up,
                downlink_bytes: 0,
            }],
        }
    }

    #[test]
    fn checkpoint_is_durable_before_ack_and_unchanged_values_do_not_queue_again() {
        let dir = checkpoint_test_dir("detail-checkpoint");
        let mut durable = DetailHeads::new();
        let report = detail_checkpoint(1, 10);
        persist_checkpoint(&dir, DetailKind::Domain, &report, &mut durable, |_| {
            assert_eq!(
                crate::spool::spool_read(DOMAIN_DETAIL_SPOOL, &dir)?.len(),
                1
            );
            Err("lost local acknowledgement".into())
        })
        .unwrap_err();
        persist_checkpoint(&dir, DetailKind::Domain, &report, &mut durable, |_| Ok(())).unwrap();
        assert_eq!(
            crate::spool::spool_read(DOMAIN_DETAIL_SPOOL, &dir)
                .unwrap()
                .len(),
            1
        );
        persist_checkpoint(
            &dir,
            DetailKind::Domain,
            &detail_checkpoint(1, 15),
            &mut durable,
            |_| Ok(()),
        )
        .unwrap();
        persist_checkpoint(
            &dir,
            DetailKind::Domain,
            &detail_checkpoint(2, 3),
            &mut durable,
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(
            durable.len(),
            1,
            "evicted identities cannot grow the sampler cache"
        );
        let queued = crate::spool::spool_read(DOMAIN_DETAIL_SPOOL, &dir).unwrap();
        assert_eq!(
            queued.len(),
            1,
            "pending cumulative snapshots coalesce without losing old segments"
        );
        let replay: OtherDomainReport = serde_json::from_str(&queued[0]).unwrap();
        assert_eq!(
            replay.counters[0].uplink_bytes, 15,
            "send cumulative values, never an unprotected delta"
        );
        assert_eq!(replay.counters[1].counter_id, 2);
        assert_eq!(replay.counters[1].uplink_bytes, 3);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn full_detail_spool_never_authorizes_eviction_or_discards_old_checkpoints() {
        let dir = checkpoint_test_dir("detail-checkpoint-full");
        let queued = (0..DOMAIN_DETAIL_SPOOL.max)
            .map(|id| {
                let mut report = detail_checkpoint(1, 10);
                report.epoch = format!("{id:032x}");
                format!("{}\n", serde_json::to_string(&report).unwrap())
            })
            .collect::<String>();
        std::fs::write(dir.join(DOMAIN_DETAIL_SPOOL.file), &queued).unwrap();
        let mut durable = DetailHeads::new();
        let mut acknowledged = false;
        assert!(persist_checkpoint(
            &dir,
            DetailKind::Domain,
            &detail_checkpoint(1, 10),
            &mut durable,
            |_| {
                acknowledged = true;
                Ok(())
            }
        )
        .is_err());
        assert!(!acknowledged);
        assert!(durable.is_empty());
        assert_eq!(
            std::fs::read_to_string(dir.join(DOMAIN_DETAIL_SPOOL.file)).unwrap(),
            queued
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn v2_snapshot_preserves_segment_identity_and_requires_both_directions() {
        let mut stats = vec![
            XrayStat {
                name: "otherdomain>>>version".into(),
                value: 2,
            },
            XrayStat {
                name: "otherdomain>>>enabled".into(),
                value: 1,
            },
            XrayStat {
                name: format!("otherdomain>>>epoch:{}", "a".repeat(32)),
                value: 1,
            },
            XrayStat {
                name: "otherdomain>>>activation".into(),
                value: 7200,
            },
            XrayStat {
                name: "otherdomain>>>7200>>>a@t#i>>>a.example>>>42>>>uplink".into(),
                value: 10,
            },
        ];
        assert!(from_stats(&stats, 1, 7300).is_err());
        stats.push(XrayStat {
            name: "otherdomain>>>7200>>>a@t#i>>>a.example>>>42>>>downlink".into(),
            value: 3,
        });
        let report = from_stats(&stats, 1, 7300).unwrap().unwrap();
        assert_eq!(report.version, 2);
        assert_eq!(report.counters[0].counter_id, 42);
        assert_eq!(report.counters[0].downlink_bytes, 3);
        stats.push(stats.last().unwrap().clone());
        assert!(from_stats(&stats, 1, 7300).is_err());
    }
    #[test]
    fn source_capability_and_thirty_second_windows_are_independent() {
        let now = 1_800_000_045;
        let prefix = "sourcetraffic>>>";
        let stats = vec![
            XrayStat {
                name: format!("{prefix}sampled_at"),
                value: now,
            },
            XrayStat {
                name: format!("{prefix}version"),
                value: 1,
            },
            XrayStat {
                name: format!("{prefix}enabled"),
                value: 1,
            },
            XrayStat {
                name: format!("{prefix}epoch:0123456789abcdef0123456789abcdef"),
                value: 1,
            },
            XrayStat {
                name: format!("{prefix}activation"),
                value: now - 60,
            },
            XrayStat {
                name: format!("{prefix}1800000000>>>alice@t#i>>>192.0.2.1>>>uplink"),
                value: 12,
            },
            XrayStat {
                name: format!("{prefix}1800000000>>>alice@t#i>>>192.0.2.1>>>downlink"),
                value: 34,
            },
        ];
        let report = from_stats_for(&stats, 1, now, DetailKind::Source)
            .unwrap()
            .unwrap();
        assert_eq!(report.counters[0].uplink_bytes, 12);
        let body = DetailKind::Source.report_body(&report).unwrap();
        let wire: brocade_deployment::source_traffic::SourceTrafficReport =
            serde_json::from_str(&body).unwrap();
        assert_eq!(wire.counters[0].source_ip, "192.0.2.1");
        assert!(!body.contains("domain"));
        assert!(from_stats_for(&stats, 1, now + 30, DetailKind::Source).is_ok());
        assert!(from_stats_for(&stats, 1, now + 61, DetailKind::Source).is_err());
        assert!(from_stats_for(&[], 1, now, DetailKind::Source)
            .unwrap()
            .is_none());
    }
    #[test]
    fn failed_policy_is_independent_private_and_fail_closed() {
        let dir =
            std::env::temp_dir().join(format!("brocade-failed-policy-{}", std::process::id()));
        crate::create_private_dir(&dir).unwrap();
        apply_failed_policy(&dir, None).unwrap();
        assert!(
            !read_policy_for(&dir, DetailKind::FailedTarget)
                .unwrap()
                .enabled
        );
        apply_failed_policy(
            &dir,
            Some(r#"{"enabled":true,"max_targets_per_user":2048}"#),
        )
        .unwrap();
        assert_eq!(
            read_policy_for(&dir, DetailKind::FailedTarget)
                .unwrap()
                .max_domains_per_user,
            2048
        );
        assert!(!read_policy(&dir).unwrap().enabled);
        apply_failed_policy(
            &dir,
            Some(r#"{"enabled":true,"max_domains_per_user":123456}"#),
        )
        .unwrap();
        let parsed = read_policy_for(&dir, DetailKind::FailedTarget).unwrap();
        assert!(parsed.enabled);
        assert_eq!(
            parsed.max_domains_per_user, 1024,
            "additional fields do not set target budgets"
        );
        assert!(apply_failed_policy(
            &dir,
            Some(r#"{"enabled":true,"max_targets_per_user":9999}"#)
        )
        .is_err());
        assert!(
            !read_policy_for(&dir, DetailKind::FailedTarget)
                .unwrap()
                .enabled
        );
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(failed_control_path(&dir))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn failed_target_parser_and_wire_keep_dimensions_separate() {
        let stats = [
            ("sniffingfailed>>>enabled", 1),
            ("sniffingfailed>>>version", 1),
            ("sniffingfailed>>>activation", 7201),
            ("sniffingfailed>>>epoch:0123456789abcdef0123456789abcdef", 1),
            ("sniffingfailed>>>limited", 0),
            (
                "sniffingfailed>>>7200>>>a@t#i>>>udp://[2001:db8::1]:53>>>uplink",
                123,
            ),
        ]
        .map(|(name, value)| XrayStat {
            name: name.into(),
            value,
        });
        let report = from_stats_for(&stats, 1, 7300, DetailKind::FailedTarget)
            .unwrap()
            .unwrap();
        let body: serde_json::Value =
            serde_json::from_str(&DetailKind::FailedTarget.report_body(&report).unwrap()).unwrap();
        assert_eq!(body["counters"][0]["target"], "udp://[2001:db8::1]:53");
        assert!(body["counters"][0].get("domain").is_none());
        assert!(from_stats(&stats, 1, 7300).unwrap().is_none());
        let mut invalid = stats;
        invalid[5].name = "sniffingfailed>>>7200>>>a@t#i>>>tcp://host.example:443>>>uplink".into();
        assert!(from_stats_for(&invalid, 1, 7300, DetailKind::FailedTarget).is_err());
    }
    #[test]
    fn policies_default_off_are_private_and_fail_closed() {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("brocade-domain-policy-{}", std::process::id()));
        crate::create_private_dir(&dir).unwrap();
        apply_policy(&dir, None).unwrap();
        assert_eq!(read_policy(&dir).unwrap(), OtherDomainPolicy::default());
        apply_policy(&dir,Some(r#"{"enabled":true,"top_n":128,"max_domains_per_user":1024,"node_capacity":4096,"report_interval_secs":30}"#)).unwrap();
        assert!(read_policy(&dir).unwrap().enabled);
        assert!(apply_policy(&dir, Some(r#"{"enabled":true,"top_n":9999}"#)).is_err());
        assert!(!read_policy(&dir).unwrap().enabled);
        let path = control_path(&dir);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_policy(&dir).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn dedicated_parser_rejects_urls_and_old_windows() {
        let mut stats = vec![
            ("otherdomain>>>enabled", 1),
            ("otherdomain>>>version", 1),
            ("otherdomain>>>activation", 7201),
            ("otherdomain>>>epoch:0123456789abcdef0123456789abcdef", 1),
            ("otherdomain>>>limited", 0),
            ("otherdomain>>>7200>>>a@t#i>>>video.example>>>uplink", 123),
        ]
        .into_iter()
        .map(|(name, value)| XrayStat {
            name: name.into(),
            value,
        })
        .collect::<Vec<_>>();
        let report = from_stats(&stats, 1, 7300).unwrap().unwrap();
        assert_eq!(report.counters[0].uplink_bytes, 123);
        stats.last_mut().unwrap().name =
            "otherdomain>>>7200>>>a@t#i>>>https://video.example/x>>>uplink".into();
        assert!(from_stats(&stats, 1, 7300).is_err());
        assert!(from_stats(&[], 1, 7300).unwrap().is_none());
    }
}
