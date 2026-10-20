use super::*;
use std::{os::unix::fs::PermissionsExt, path::PathBuf};

struct Fixture {
    directory: PathBuf,
    manifest_path: PathBuf,
    manifest: HandoffManifestIdentity,
    record_path: PathBuf,
    log_path: PathBuf,
    record: serde_json::Value,
}

impl Fixture {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "bse-{}",
            &super::super::random_token().unwrap()[..12]
        ));
        crate::create_private_dir(&directory).unwrap();
        let bootstrap = super::super::prepare_bootstrap_handoff(
            &directory,
            r#"{"api":{"listen":"127.0.0.1:10085"},"inbounds":[{"tag":"test","listen":"0.0.0.0","port":14444,"protocol":"anytls"}]}"#,
        )
        .unwrap();
        let record_path = bootstrap
            .manifest
            .control_path
            .with_file_name("control.sock.startup-error.json");
        let process = crate::process_ref(std::process::id() as i32).unwrap();
        let record = serde_json::json!({
            "version": 1,
            "generation_id": bootstrap.manifest.generation_id,
            "pid": process.pid,
            "pid_start_ticks": process.start_ticks.to_string(),
            "boot_id": fs::read_to_string("/proc/sys/kernel/random/boot_id").unwrap().trim(),
            "network": "tcp", "address": "0.0.0.0:14444", "errno": libc::EADDRINUSE,
        });
        let result = Self {
            log_path: directory.join("xray.log"),
            manifest_path: bootstrap.manifest_path,
            manifest: bootstrap.manifest,
            directory,
            record_path,
            record,
        };
        fs::write(&result.log_path, "test-log-sentinel").unwrap();
        result.write_record(&result.record);
        result
    }

    fn write_record(&self, record: &serde_json::Value) {
        crate::fsutil::atomic_write_private(
            &self.record_path,
            &serde_json::to_vec(record).unwrap(),
        )
        .unwrap();
    }

    fn failure(&self) -> String {
        failure(
            &self.log_path,
            "control socket ENOENT",
            Some(&self.manifest_path),
            None,
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn startup_errno_replaces_secondary_error_and_log_tail() {
    let fixture = Fixture::new();
    assert_eq!(
        fixture.failure(),
        "Xray 监听失败：TCP 0.0.0.0:14444；EADDRINUSE（errno=98，地址或端口已被占用）"
    );
    for (errno, code) in [
        (libc::EACCES, "EACCES"),
        (libc::EADDRNOTAVAIL, "EADDRNOTAVAIL"),
        (libc::EMFILE, "EMFILE"),
        (libc::EPROTONOSUPPORT, "EPROTONOSUPPORT"),
    ] {
        let mut record = fixture.record.clone();
        record["errno"] = errno.into();
        record["future_field"] = true.into();
        fixture.write_record(&record);
        let error = fixture.failure();
        assert!(error.contains(code), "{error}");
        assert!(!error.contains("日志"), "{error}");
        assert!(!error.contains("test-log-sentinel"), "{error}");
        assert!(!error.contains("ENOENT"), "{error}");
    }
}

#[test]
fn startup_diagnostics_validate_generation_process_and_endpoint() {
    let fixture = Fixture::new();
    for (key, value) in [
        ("version", serde_json::json!(2)),
        ("generation_id", serde_json::json!("stale-generation")),
        ("boot_id", serde_json::json!("stale-boot")),
        ("pid", serde_json::json!(0)),
        ("pid_start_ticks", serde_json::json!("0")),
        ("network", serde_json::json!("unix")),
        ("address", serde_json::json!("0.0.0.0:14445")),
        ("address", serde_json::json!("example.test:14444")),
        ("errno", serde_json::json!(4095)),
        ("errno", serde_json::json!(0)),
    ] {
        let mut record = fixture.record.clone();
        record[key] = value;
        fixture.write_record(&record);
        assert!(fixture.failure().contains("test-log-sentinel"), "{key}");
    }
    fixture.write_record(&fixture.record);
    let mut expected = crate::process_ref(std::process::id() as i32).unwrap();
    assert!(root_failure(&fixture.manifest, Some(expected)).is_some());
    expected.start_ticks += 1;
    assert!(root_failure(&fixture.manifest, Some(expected)).is_none());
    assert!(failure(
        &fixture.log_path,
        "fallback",
        Some(&fixture.manifest_path),
        Some(expected)
    )
    .contains("test-log-sentinel"));
    expected.pid += 1;
    assert!(root_failure(&fixture.manifest, Some(expected)).is_none());
}

#[test]
fn startup_diagnostics_accept_ipv6_udp() {
    let fixture = Fixture::new();
    let mut manifest = fixture.manifest.clone();
    manifest.listeners[0].network = "udp".to_owned();
    manifest.listeners[0].address = "[::1]:14444".to_owned();
    manifest.listeners[0].bind_address = "[::1]:14444".to_owned();
    let mut record = fixture.record.clone();
    record["network"] = "udp".into();
    record["address"] = "[::1]:14444".into();
    fixture.write_record(&record);
    assert!(root_failure(&manifest, None)
        .unwrap()
        .contains("UDP [::1]:14444"));
}

#[test]
fn startup_diagnostics_reject_unsafe_and_incomplete_files() {
    let fixture = Fixture::new();
    for content in [b"{".to_vec(), vec![b' '; MAX_FAILURE_BYTES as usize + 1]] {
        crate::fsutil::atomic_write_private(&fixture.record_path, &content).unwrap();
        assert!(fixture.failure().contains("test-log-sentinel"));
    }
    fixture.write_record(&fixture.record);
    fs::set_permissions(&fixture.record_path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(fixture.failure().contains("test-log-sentinel"));
    fixture.write_record(&fixture.record);
    let linked = fixture.directory.join("linked");
    fs::hard_link(&fixture.record_path, &linked).unwrap();
    assert!(fixture.failure().contains("test-log-sentinel"));
    fs::remove_file(&fixture.record_path).unwrap();
    std::os::unix::fs::symlink(&linked, &fixture.record_path).unwrap();
    assert!(fixture.failure().contains("test-log-sentinel"));
    fs::remove_file(&fixture.record_path).unwrap();
    fs::create_dir(&fixture.record_path).unwrap();
    assert!(fixture.failure().contains("test-log-sentinel"));
}

#[test]
fn startup_legacy_fallback_reads_only_a_bounded_tail() {
    let fixture = Fixture::new();
    fs::remove_file(&fixture.record_path).unwrap();
    let log = format!("old-banner{}new-tail", "x".repeat(100_000));
    fs::write(&fixture.log_path, log).unwrap();
    let error = fixture.failure();
    assert!(error.starts_with("control socket ENOENT；Xray 日志末尾："));
    assert!(!error.contains("old-banner"));
    assert!(error.ends_with("new-tail"));
    assert!(error.len() < MAX_LOG_TAIL as usize + 100);
    assert_eq!(
        failure(&fixture.log_path, "legacy", None, None),
        error.replace("control socket ENOENT", "legacy")
    );
    fs::remove_file(&fixture.log_path).unwrap();
    assert_eq!(fixture.failure(), "control socket ENOENT");
    fs::write(&fixture.log_path, "\n  ").unwrap();
    assert_eq!(fixture.failure(), "control socket ENOENT");
}
