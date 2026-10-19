//! Each optional detail dimension has an independent worker, never the billing meter/spool.
use crate::{http::HttpClient, options::Options, xray_grpc::XrayStat};
use brocade_deployment::other_domain::{
    valid_domain, OtherDomainCounter, OtherDomainPolicy, OtherDomainReport, OTHER_DOMAIN_MAX_ROWS,
    OTHER_DOMAIN_VERSION,
};
use brocade_deployment::sniffing_failed::{
    valid_target, SniffingFailedCounter, SniffingFailedPolicy, SniffingFailedReport,
};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Copy)]
enum DetailKind {
    Domain,
    FailedTarget,
}
impl DetailKind {
    fn pattern(self) -> &'static str {
        match self {
            Self::Domain => "otherdomain>>>",
            Self::FailedTarget => "sniffingfailed>>>",
        }
    }
    fn file(self) -> &'static str {
        match self {
            Self::Domain => "other-domain-policy.json",
            Self::FailedTarget => "sniffing-failed-policy.json",
        }
    }
    fn route(self) -> &'static str {
        match self {
            Self::Domain => "/agent/v1/other-domain-usage",
            Self::FailedTarget => "/agent/v1/sniffing-failed-usage",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Domain => "other-domain",
            Self::FailedTarget => "sniffing-failed",
        }
    }
    fn valid_key(self, key: &str) -> bool {
        match self {
            Self::Domain => valid_domain(key),
            Self::FailedTarget => valid_target(key),
        }
    }
    fn decode_policy(self, bytes: &[u8]) -> Result<OtherDomainPolicy, String> {
        let policy = match self {
            Self::Domain => serde_json::from_slice(bytes).map_err(|_| "invalid domain policy")?,
            Self::FailedTarget => serde_json::from_slice::<SniffingFailedPolicy>(bytes)
                .map_err(|_| "invalid failed-target policy")?
                .budget(),
        };
        policy.validate().map_err(str::to_owned)?;
        Ok(policy)
    }
    fn policy_bytes(self, policy: OtherDomainPolicy) -> Result<Vec<u8>, String> {
        match self {
            Self::Domain => serde_json::to_vec(&policy),
            Self::FailedTarget => serde_json::to_vec(&SniffingFailedPolicy::from_budget(policy)),
        }
        .map_err(|_| "cannot encode optional collection policy".into())
    }
    fn report_body(self, report: &OtherDomainReport) -> Result<String, String> {
        match self {
            Self::Domain => serde_json::to_string(report),
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
    if stats.len() > OTHER_DOMAIN_MAX_ROWS * 2 + 5 {
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
    let mut version = None;
    let mut limited = false;
    let mut rows = BTreeMap::<(i64, String, String), (u64, u64)>::new();
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
                "version" if stat.value == i64::from(OTHER_DOMAIN_VERSION) => {
                    version = Some(OTHER_DOMAIN_VERSION)
                }
                "activation" if stat.value > 0 && stat.value <= now + 60 => {
                    activation = Some(stat.value)
                }
                "enabled" if stat.value == 1 => {}
                "limited" if matches!(stat.value, 0 | 1) => limited = stat.value == 1,
                _ => {
                    let parts: Vec<_> = stat.name.split(">>>").collect();
                    if parts.len() != 5
                        || !stat.name.starts_with(prefix)
                        || parts[2].len() > 256
                        || !kind.valid_key(parts[3])
                        || !matches!(parts[4], "uplink" | "downlink")
                    {
                        return Err("invalid domain snapshot row".into());
                    }
                    let bucket = parts[1]
                        .parse::<i64>()
                        .map_err(|_| "invalid domain snapshot bucket")?;
                    if bucket != now / 3600 * 3600 && bucket != now / 3600 * 3600 - 3600 {
                        return Err("stale domain snapshot bucket".into());
                    }
                    let value = u64::try_from(stat.value)
                        .map_err(|_| "negative domain snapshot counter")?;
                    let row = rows
                        .entry((bucket, parts[2].to_owned(), parts[3].to_owned()))
                        .or_default();
                    if parts[4] == "uplink" {
                        row.0 = value;
                    } else {
                        row.1 = value;
                    }
                }
            }
        }
    }
    Ok(Some(OtherDomainReport {
        version: version.ok_or("missing domain snapshot version")?,
        epoch: epoch.ok_or("missing domain snapshot epoch")?,
        activation_unix_secs: activation.ok_or("missing domain snapshot activation")?,
        read_at_unix_secs: now,
        usage_generation_id: generation,
        limited,
        counters: rows
            .into_iter()
            .filter(|(_, v)| *v != (0, 0))
            .map(
                |((bucket, label, domain), (uplink_bytes, downlink_bytes))| OtherDomainCounter {
                    bucket,
                    label,
                    domain,
                    uplink_bytes,
                    downlink_bytes,
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
    let stats = crate::xray_grpc::query_stats(api_address, kind.pattern())?;
    crate::validate_xray_sample_process(state, &process)?;
    if crate::read_usage_generation(state)? != Some(generation) {
        return Err("domain observation changed generation".into());
    }
    match kind {
        DetailKind::Domain => from_stats(&stats, generation, crate::current_unix_secs()?),
        DetailKind::FailedTarget => {
            from_stats_for(&stats, generation, crate::current_unix_secs()?, kind)
        }
    }
}

pub(crate) fn spawn(options: Options) -> Result<(), String> {
    for kind in [DetailKind::Domain, DetailKind::FailedTarget] {
        spawn_for(options.clone(), kind)?;
    }
    Ok(())
}
fn spawn_for(options: Options, kind: DetailKind) -> Result<(), String> {
    std::thread::Builder::new()
        .name(kind.name().into())
        .spawn(move || {
            let mut sent = BTreeMap::<(i64, String, String), (u64, u64)>::new();
            let mut epoch = String::new();
            let mut generation = None;
            let mut policy_failed = false;
            loop {
                if crate::TERMINATION_REQUESTED.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                let policy = match match kind {
                    DetailKind::Domain => read_policy(&options.state_dir),
                    DetailKind::FailedTarget => read_policy_for(&options.state_dir, kind),
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
                    // Only one bounded snapshot/payload in flight. Retry cumulative values next tick;
                    // no disk journal, unbounded queue, billing lock or per-packet async task.
                    let outcome = (|| -> Result<(), String> {
                        let Some(mut report) = sample(&options, kind)? else {
                            return Ok(());
                        };
                        if epoch != report.epoch || generation != Some(report.usage_generation_id) {
                            sent.clear();
                            epoch = report.epoch.clone();
                            generation = Some(report.usage_generation_id);
                        }
                        let floor = report.read_at_unix_secs / 3600 * 3600 - 3600;
                        sent.retain(|(bucket, _, _), _| *bucket >= floor);
                        report.counters.retain(|r| {
                            sent.get(&(r.bucket, r.label.clone(), r.domain.clone()))
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
                                (r.bucket, r.label, r.domain),
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
        assert!(apply_failed_policy(
            &dir,
            Some(r#"{"enabled":true,"max_domains_per_user":1024}"#)
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
