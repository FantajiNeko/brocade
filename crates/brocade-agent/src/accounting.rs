//! Continuous counter identity and explicit managed downtime. A zero interval never resets a
//! cumulative byte counter. Unknown process loss is deliberately not certified as zero.

use std::{
    fs,
    path::{Path, PathBuf},
};

use brocade_deployment::protocol::{UsageReportRequest, UsageZeroWindow};
use serde::{Deserialize, Serialize};

use crate::{
    fsutil::atomic_write_private,
    spool::{spool_push, USAGE_SPOOL},
    xray_grpc::XrayStat,
};

fn current_unix_millis() -> Result<i64, String> {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    i64::try_from(elapsed.as_millis()).map_err(|_| "accounting clock overflow".to_owned())
}

pub(crate) const JOURNAL_FILE: &str = "xray-accounting.bin";
const STOP_FILE: &str = "usage-stopped.json";
const ZERO_FILE: &str = "usage-zero-windows.json";
const HEADER_SIZE: usize = 64;
const RECORD_SIZE: usize = 512;
const CAPACITY: usize = 16384;
const JOURNAL_SIZE: u64 = (HEADER_SIZE + RECORD_SIZE * CAPACITY) as u64;

#[derive(Serialize, Deserialize)]
struct StoppedUsage {
    report: UsageReportRequest,
    writer_pid: i32,
    stopped_at_unix_millis: Option<i64>,
}

pub(crate) fn journal_path(state_dir: &Path) -> PathBuf {
    state_dir.join(JOURNAL_FILE)
}

fn header(state_dir: &Path) -> Result<Option<[u8; HEADER_SIZE]>, String> {
    use std::io::Read;
    let path = journal_path(state_dir);
    let mut file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read accounting journal: {error}")),
    };
    if file.metadata().map_err(|e| e.to_string())?.len() != JOURNAL_SIZE {
        return Err("invalid accounting journal size".to_owned());
    }
    let mut header = [0; HEADER_SIZE];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    if &header[..8] != b"BRACCT02" {
        return Err("invalid accounting journal format".to_owned());
    }
    Ok(Some(header))
}

pub(crate) fn epoch(state_dir: &Path, process_epoch: &str, pid: i32) -> Result<String, String> {
    let Some(header) = header(state_dir)? else {
        return Ok(process_epoch.to_owned());
    };
    let writer = u32::from_le_bytes(header[28..32].try_into().map_err(|_| "journal pid")?);
    if writer != pid as u32 {
        return Ok(process_epoch.to_owned());
    }
    let ticks = u64::from_le_bytes(header[32..40].try_into().map_err(|_| "journal ticks")?);
    let process_ticks = process_epoch
        .rsplit(':')
        .next()
        .and_then(|ticks| ticks.parse::<u64>().ok());
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(|e| e.to_string())?;
    let boot = boot.trim().replace('-', "");
    if process_ticks != Some(ticks)
        || boot
            != header[40..56]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
    {
        return Ok(process_epoch.to_owned());
    }
    Ok(format!(
        "journal:{}",
        header[8..24]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

pub(crate) fn sync_live_journal(
    state_dir: &Path,
    process_epoch: &str,
    pid: i32,
) -> Result<(), String> {
    if epoch(state_dir, process_epoch, pid)?.starts_with("journal:") {
        fs::File::open(journal_path(state_dir))
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("sync live accounting journal: {error}"))?;
    }
    Ok(())
}

/// Only read the complete mapping after its writer exited. Live samples use Xray's atomic
/// QueryStats; treating a concurrently changing file as an atomic snapshot would be incorrect.
fn stopped_stats(state_dir: &Path, pid: i32) -> Result<Option<Vec<XrayStat>>, String> {
    let Some(header) = header(state_dir)? else {
        return Ok(None);
    };
    if u32::from_le_bytes(header[28..32].try_into().map_err(|_| "journal pid")?) != pid as u32 {
        return Ok(None);
    }
    let file = fs::File::open(journal_path(state_dir)).map_err(|e| e.to_string())?;
    file.sync_all()
        .map_err(|e| format!("sync accounting journal: {e}"))?;
    let bytes = fs::read(journal_path(state_dir)).map_err(|e| e.to_string())?;
    decode_stats(&bytes).map(Some)
}

fn decode_stats(bytes: &[u8]) -> Result<Vec<XrayStat>, String> {
    if bytes.len() as u64 != JOURNAL_SIZE || &bytes[..8] != b"BRACCT02" {
        return Err("invalid accounting journal".to_owned());
    }
    let count = u32::from_le_bytes(bytes[24..28].try_into().map_err(|_| "journal count")?) as usize;
    if count > CAPACITY {
        return Err("invalid accounting journal count".to_owned());
    }
    (0..count)
        .map(|index| {
            let record =
                &bytes[HEADER_SIZE + index * RECORD_SIZE..HEADER_SIZE + (index + 1) * RECORD_SIZE];
            let length =
                u32::from_le_bytes(record[8..12].try_into().map_err(|_| "journal label")?) as usize;
            if length == 0 || length > RECORD_SIZE - 16 {
                return Err("invalid accounting journal label".to_owned());
            }
            let name = std::str::from_utf8(&record[16..16 + length])
                .map_err(|_| "invalid journal UTF-8")?
                .to_owned();
            let value = i64::from_le_bytes(record[..8].try_into().map_err(|_| "journal value")?);
            if value < 0 {
                return Err("negative accounting journal counter".to_owned());
            }
            Ok(XrayStat { name, value })
        })
        .collect()
}

fn read_stopped(state_dir: &Path) -> Result<Option<StoppedUsage>, String> {
    match fs::read(state_dir.join(STOP_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("decode stopped usage: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read stopped usage: {e}")),
    }
}

fn write_stopped(state_dir: &Path, stopped: &StoppedUsage) -> Result<(), String> {
    atomic_write_private(
        &state_dir.join(STOP_FILE),
        &serde_json::to_vec(stopped).map_err(|e| e.to_string())?,
    )
}

pub(crate) fn stop(state_dir: &Path) -> Result<(), String> {
    let Some(process) = crate::serving_xray_process_in(state_dir) else {
        return Ok(());
    };
    // A legacy process may have no generation (initial installation). It has no accounted
    // namespace to protect. Every established namespace must be durably sampled before stopping.
    if crate::read_usage_generation(state_dir)?.is_none() {
        return crate::terminate_processes(
            &[process],
            crate::XRAY_TERM_GRACE,
            crate::XRAY_KILL_GRACE,
        );
    }
    let report = crate::read_usage_report(state_dir)?;
    spool_push(USAGE_SPOOL, state_dir, &report)?;
    let mut stopped = StoppedUsage {
        report,
        writer_pid: process.pid,
        stopped_at_unix_millis: None,
    };
    write_stopped(state_dir, &stopped)?;
    crate::terminate_processes(&[process], crate::XRAY_TERM_GRACE, crate::XRAY_KILL_GRACE)?;
    stopped.stopped_at_unix_millis = Some(current_unix_millis()?);
    if let Some(stats) = stopped_stats(state_dir, process.pid)? {
        stopped.report.counters = crate::usage_counters_from_stats(&stats);
    }
    stopped.report.read_at_unix_secs = crate::current_unix_secs()?;
    let (instance, sequence) = crate::reserve_usage_sequence(state_dir)?;
    stopped.report.agent_instance_id = instance;
    stopped.report.sequence = sequence;
    write_stopped(state_dir, &stopped)?;
    spool_push(USAGE_SPOOL, state_dir, &stopped.report)
}

pub(crate) fn zero_windows(state_dir: &Path) -> Result<Vec<UsageZeroWindow>, String> {
    match fs::read(state_dir.join(ZERO_FILE)) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|e| format!("decode zero windows: {e}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("read zero windows: {e}")),
    }
}

/// End certified downtime just before launching: traffic can begin before the API health gate.
pub(crate) fn before_launch(state_dir: &Path) -> Result<(), String> {
    let Some(stopped) = read_stopped(state_dir)? else {
        return Ok(());
    };
    let Some(start) = stopped.stopped_at_unix_millis else {
        return Ok(());
    };
    let end = current_unix_millis()?;
    if end <= start {
        return Ok(());
    }
    // A machine may stay disabled beyond receipt retention. Use a fresh id/time instead of
    // replaying an ancient sequence behind the durable cursor; unchanged cumulative values
    // still contribute zero, and an undelivered tail can only be booked once.
    let mut final_report = stopped.report.clone();
    let (instance, sequence) = crate::reserve_usage_sequence(state_dir)?;
    final_report.agent_instance_id = instance;
    final_report.sequence = sequence;
    final_report.read_at_unix_secs = end / 1000;
    final_report.zero_windows = zero_windows(state_dir)?;
    final_report.zero_windows.push(UsageZeroWindow {
        start_unix_millis: start,
        end_unix_millis: end,
    });
    spool_push(USAGE_SPOOL, state_dir, &final_report)?;
    if !stopped.report.xray_epoch.starts_with("journal:") && journal_path(state_dir).exists() {
        // A legacy rollback breaks counter continuity. Reusing an older journal afterwards
        // would bill its already-accounted totals again; retain one bounded recovery copy.
        fs::rename(
            journal_path(state_dir),
            state_dir.join("xray-accounting.previous.bin"),
        )
        .map_err(|error| format!("archive discontinuous accounting journal: {error}"))?;
    }
    let mut windows = zero_windows(state_dir)?;
    if windows.len() >= 32 {
        return Err("unreported managed downtime queue is full".to_owned());
    }
    windows.push(UsageZeroWindow {
        start_unix_millis: start,
        end_unix_millis: end,
    });
    atomic_write_private(
        &state_dir.join(ZERO_FILE),
        &serde_json::to_vec(&windows).map_err(|e| e.to_string())?,
    )
}

pub(crate) fn launched(state_dir: &Path) -> Result<(), String> {
    if let Some(stopped) = read_stopped(state_dir)? {
        if let (Some(start), Some(header)) = (stopped.stopped_at_unix_millis, header(state_dir)?) {
            let end = i64::from_le_bytes(
                header[56..64]
                    .try_into()
                    .map_err(|_| "journal launch time")?,
            );
            let writer =
                u32::from_le_bytes(header[28..32].try_into().map_err(|_| "journal writer")?);
            if end > start
                && crate::serving_xray_process_in(state_dir)
                    .is_some_and(|process| process.pid as u32 == writer)
            {
                let mut windows = zero_windows(state_dir)?;
                if let Some(window) = windows
                    .iter_mut()
                    .rev()
                    .find(|window| window.start_unix_millis == start)
                {
                    window.end_unix_millis = window.end_unix_millis.max(end);
                } else {
                    if windows.len() >= 32 {
                        return Err("unreported managed downtime queue is full".to_owned());
                    }
                    windows.push(UsageZeroWindow {
                        start_unix_millis: start,
                        end_unix_millis: end,
                    });
                }
                atomic_write_private(
                    &state_dir.join(ZERO_FILE),
                    &serde_json::to_vec(&windows).map_err(|e| e.to_string())?,
                )?;
            }
        }
    }
    remove_if_present(&state_dir.join(STOP_FILE))
}

pub(crate) fn collected(state_dir: &Path) -> Result<(), String> {
    remove_if_present(&state_dir.join(ZERO_FILE))
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove accounting checkpoint: {e}")),
    }
}

pub(crate) fn has_stopped(state_dir: &Path) -> bool {
    state_dir.join(STOP_FILE).exists()
}

pub(crate) fn confirmed_stopped_counters(
    state_dir: &Path,
) -> Result<Option<Vec<brocade_deployment::protocol::UsageCounter>>, String> {
    let Some(stopped) = read_stopped(state_dir)? else {
        return Ok(None);
    };
    Ok(stopped
        .stopped_at_unix_millis
        .map(|_| stopped.report.counters))
}

pub(crate) fn stopped_report(state_dir: &Path) -> Result<UsageReportRequest, String> {
    let stopped = read_stopped(state_dir)?.ok_or("xray is absent without a confirmed stop")?;
    let start = stopped
        .stopped_at_unix_millis
        .ok_or("xray stop boundary is unknown")?;
    let mut report = stopped.report;
    let now = current_unix_millis()?;
    report.read_at_unix_secs = now / 1000;
    let (instance, sequence) = crate::reserve_usage_sequence(state_dir)?;
    report.agent_instance_id = instance;
    report.sequence = sequence;
    report.zero_windows = zero_windows(state_dir)?;
    if now > start {
        report.zero_windows.push(UsageZeroWindow {
            start_unix_millis: start,
            end_unix_millis: now,
        });
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_decode_is_bounded_and_preserves_full_counters() {
        let mut bytes = vec![0; JOURNAL_SIZE as usize];
        bytes[..8].copy_from_slice(b"BRACCT02");
        bytes[24..28].copy_from_slice(&1_u32.to_le_bytes());
        let name = b"user>>>alice#entry>>>traffic>>>downlink";
        bytes[64..72].copy_from_slice(&12345_i64.to_le_bytes());
        bytes[72..76].copy_from_slice(&(name.len() as u32).to_le_bytes());
        bytes[80..80 + name.len()].copy_from_slice(name);
        let stats = decode_stats(&bytes).unwrap();
        assert_eq!(stats[0].value, 12345);
        assert_eq!(stats[0].name, std::str::from_utf8(name).unwrap());
        bytes[24..28].copy_from_slice(&(CAPACITY as u32 + 1).to_le_bytes());
        assert!(decode_stats(&bytes).is_err());
    }

    #[test]
    fn confirmed_stop_reports_unchanged_counters_not_a_counter_reset() {
        let dir =
            std::env::temp_dir().join(format!("brocade-accounting-stop-{}", std::process::id()));
        crate::create_private_dir(&dir).unwrap();
        let now = current_unix_millis().unwrap();
        let report = UsageReportRequest {
            agent_instance_id: "fixture".to_owned(),
            sequence: 1,
            usage_generation_id: 9,
            read_at_unix_secs: now / 1000 - 10,
            xray_started_at_unix_secs: now / 1000 - 100,
            xray_epoch: "journal:fixture".to_owned(),
            route: None,
            counters: vec![brocade_deployment::protocol::UsageCounter {
                label: "alice#entry".to_owned(),
                uplink_bytes: 123,
                downlink_bytes: 456,
            }],
            zero_windows: Vec::new(),
        };
        write_stopped(
            &dir,
            &StoppedUsage {
                report: report.clone(),
                writer_pid: 1,
                stopped_at_unix_millis: None,
            },
        )
        .unwrap();
        assert!(
            stopped_report(&dir).is_err(),
            "uncertain exit must never become zero"
        );
        assert!(confirmed_stopped_counters(&dir).unwrap().is_none());
        write_stopped(
            &dir,
            &StoppedUsage {
                report: report.clone(),
                writer_pid: 1,
                stopped_at_unix_millis: Some(now - 5000),
            },
        )
        .unwrap();
        let zero = stopped_report(&dir).unwrap();
        assert_eq!(zero.counters, report.counters);
        assert_eq!(zero.xray_epoch, report.xray_epoch);
        assert_eq!(zero.zero_windows[0].start_unix_millis, now - 5000);
        assert!(zero.zero_windows[0].end_unix_millis >= now);
        before_launch(&dir).unwrap();
        assert_eq!(zero_windows(&dir).unwrap().len(), 1);
        launched(&dir).unwrap();
        assert!(!has_stopped(&dir));
        assert_eq!(
            zero_windows(&dir).unwrap().len(),
            1,
            "startup does not acknowledge undelivered zero coverage"
        );
        collected(&dir).unwrap();
        assert!(zero_windows(&dir).unwrap().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    #[ignore = "requires BROCADE_TEST_XRAY pointing to a newly built managed Xray"]
    fn native_xray_restarts_keep_unsampled_tail_and_counter_identity() {
        use std::{
            io::{Read, Write},
            net::{TcpListener, TcpStream},
            process::{Command, Stdio},
            thread,
            time::{Duration, Instant},
        };
        struct ChildGuard(std::process::Child);
        impl Drop for ChildGuard {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let binary = std::env::var("BROCADE_TEST_XRAY").expect("newly built Xray is required");
        let dir =
            std::env::temp_dir().join(format!("brocade-native-accounting-{}", std::process::id()));
        crate::create_private_dir(&dir).unwrap();
        let port = || {
            TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port()
        };
        let api_port = port();
        let inbound_port = port();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let target_port = listener.local_addr().unwrap().port();
        let config = dir.join("xray.json");
        fs::write(&config, serde_json::to_vec(&serde_json::json!({
            "log": {"loglevel": "warning"}, "stats": {},
            "api": {"tag": "api", "services": ["StatsService"]},
            "policy": {"system": {"statsInboundUplink": true, "statsInboundDownlink": true}},
            "inbounds": [
                {"tag": "api", "listen": "127.0.0.1", "port": api_port, "protocol": "dokodemo-door", "settings": {"address": "127.0.0.1"}},
                {"tag": "fwd:7", "listen": "127.0.0.1", "port": inbound_port, "protocol": "dokodemo-door", "settings": {"address": "127.0.0.1", "port": target_port, "network": "tcp"}}
            ], "outbounds": [{"protocol": "freedom", "tag": "direct"}],
            "routing": {"rules": [{"type": "field", "inboundTag": ["api"], "outboundTag": "api"}]}
        })).unwrap()).unwrap();
        let launch = || {
            let mut child = ChildGuard(
                Command::new(&binary)
                    .args(["run", "-config", config.to_str().unwrap()])
                    .env("XRAY_BROCADE_ACCOUNTING_FILE", journal_path(&dir))
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            );
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if crate::xray_grpc::query_stats(api_port, "inbound>>>fwd:7").is_ok() {
                    break;
                }
                assert!(
                    child.0.try_wait().unwrap().is_none(),
                    "Xray exited before serving"
                );
                assert!(Instant::now() < deadline, "Xray did not serve in time");
                thread::sleep(Duration::from_millis(10));
            }
            child
        };
        let mut old = launch();
        let mut client = TcpStream::connect(("127.0.0.1", inbound_port)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        client.write_all(&[1; 1024]).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        server
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        server.read_exact(&mut [0; 1024]).unwrap();
        server.write_all(&[2; 2048]).unwrap();
        client.read_exact(&mut [0; 2048]).unwrap();
        let baseline = crate::xray_grpc::query_stats(api_port, "inbound>>>fwd:7").unwrap();
        assert_eq!(baseline.iter().map(|stat| stat.value).sum::<i64>(), 3072);
        let original_header = header(&dir).unwrap().unwrap();
        let original_ticks = u64::from_le_bytes(original_header[32..40].try_into().unwrap());
        let original_epoch =
            epoch(&dir, &format!("1234:{original_ticks}"), old.0.id() as i32).unwrap();
        assert!(
            original_epoch.starts_with("journal:"),
            "journal identity must not depend on NTP-adjustable btime"
        );
        // These bytes occur after the last QueryStats. No final API sample precedes shutdown.
        client.write_all(&[3; 512]).unwrap();
        server.read_exact(&mut [0; 512]).unwrap();
        server.write_all(&[4; 1024]).unwrap();
        client.read_exact(&mut [0; 1024]).unwrap();
        thread::sleep(Duration::from_millis(20));
        let process = crate::process_ref(old.0.id() as i32).unwrap();
        crate::terminate_processes(&[process], crate::XRAY_TERM_GRACE, crate::XRAY_KILL_GRACE)
            .unwrap();
        old.0.wait().unwrap();
        let final_stats = stopped_stats(&dir, process.pid).unwrap().unwrap();
        let counters = final_stats
            .iter()
            .filter(|stat| stat.name.starts_with("inbound>>>fwd:7"))
            .collect::<Vec<_>>();
        assert_eq!(
            counters.iter().map(|stat| stat.value).sum::<i64>(),
            4608,
            "the unsampled tail must survive"
        );
        let mut new = launch();
        let restored = crate::xray_grpc::query_stats(api_port, "inbound>>>fwd:7").unwrap();
        assert_eq!(
            restored.iter().map(|stat| stat.value).sum::<i64>(),
            4608,
            "startup must not zero cumulative counters"
        );
        let restored_header = header(&dir).unwrap().unwrap();
        let restored_ticks = u64::from_le_bytes(restored_header[32..40].try_into().unwrap());
        assert_eq!(
            epoch(&dir, &format!("5678:{restored_ticks}"), new.0.id() as i32).unwrap(),
            original_epoch
        );
        assert_eq!(
            original_header[8..24],
            restored_header[8..24],
            "counter identity stays stable"
        );
        assert_ne!(
            original_header[28..40],
            restored_header[28..40],
            "process identity changes"
        );
        new.0.kill().unwrap();
        new.0.wait().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
}
