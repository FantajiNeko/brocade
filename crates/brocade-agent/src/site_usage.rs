//! Parse only bounded, versioned category counters; never export raw destinations.
use std::collections::BTreeMap;

use crate::xray_grpc::XrayStat;
use brocade_deployment::site_usage::{
    catalog, SiteUsageCounter, SiteUsageReport, MAX_SITE_USAGE_COUNTERS, SITE_USAGE_VERSION,
};

pub(crate) fn from_stats(stats: &[XrayStat]) -> Result<Option<SiteUsageReport>, String> {
    if let Some(flag) = stats.iter().find(|stat| stat.name == "site>>>enabled") {
        if flag.value == 0 {
            return Ok(None);
        }
        if flag.value != 1 {
            return Err("invalid site accounting enabled flag".into());
        }
    }
    let mut epoch = None;
    let mut version = None;
    let mut activation_id = None;
    let mut limited = false;
    let mut counters = BTreeMap::<(String, String), (u64, u64)>::new();
    for stat in stats {
        if let Some(value) = stat.name.strip_prefix("site>>>epoch:") {
            if value.len() != 32
                || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
                || epoch.is_some()
            {
                return Err("invalid site accounting identity".to_owned());
            }
            epoch = Some(value.to_owned());
        } else if stat.name == "site>>>activation" {
            if stat.value <= 0 {
                return Err("invalid site accounting activation".into());
            }
            activation_id = Some(stat.value);
        } else if stat.name == "site>>>enabled" {
            // Checked before allocating any category rows.
        } else if stat.name == "site>>>version" {
            if stat.value != i64::from(SITE_USAGE_VERSION) || version.is_some() {
                return Err("unsupported site accounting catalog version".to_owned());
            }
            version = Some(SITE_USAGE_VERSION);
        } else if stat.name == "site>>>limited" {
            limited |= stat.value != 0;
        } else if stat.name == "site>>>pending" {
            if stat.value < 0 {
                return Err("invalid pending site registration count".into());
            }
            // An unfinished registration may be live or left behind by a crash.
            // Neither is proof of complete persisted observations.
            limited |= stat.value != 0;
        } else if stat.name.starts_with("site>>>") {
            let parts = stat.name.split(">>>").collect::<Vec<_>>();
            if parts.len() != 5
                || parts[3] != "traffic"
                || !matches!(parts[4], "uplink" | "downlink")
            {
                return Err("invalid site accounting counter".to_owned());
            }
            if !catalog().iter().any(|site| site.id == parts[2]) {
                return Err("unsupported site accounting category".to_owned());
            }
            let value =
                u64::try_from(stat.value).map_err(|_| "negative site accounting counter")?;
            let entry = counters
                .entry((parts[1].to_owned(), parts[2].to_owned()))
                .or_default();
            if parts[4] == "uplink" {
                entry.0 = value;
            } else {
                entry.1 = value;
            }
            if counters.len() > MAX_SITE_USAGE_COUNTERS {
                return Err("too many site accounting counters".to_owned());
            }
        }
    }
    let Some(epoch) = epoch else {
        if !counters.is_empty() {
            return Err("site accounting identity is absent".to_owned());
        }
        return Ok(None);
    };
    Ok(Some(SiteUsageReport {
        version: version.ok_or("site accounting catalog version is absent")?,
        epoch,
        activation_id,
        limited,
        counters: counters
            .into_iter()
            .map(
                |((label, site_id), (uplink_bytes, downlink_bytes))| SiteUsageCounter {
                    label,
                    site_id,
                    uplink_bytes,
                    downlink_bytes,
                },
            )
            .collect(),
    }))
}

pub(crate) fn control_path(state_dir: &std::path::Path) -> std::path::PathBuf {
    state_dir.join("site-usage.enabled")
}

pub(crate) fn apply_policy(
    state_dir: &std::path::Path,
    header: Option<&str>,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let content = match header {
        Some("1") => b"1\n",
        Some("0") | None => b"0\n",
        _ => return Err("invalid site usage policy header".into()),
    };
    let path = control_path(state_dir);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata)
            if metadata.is_file()
                && metadata.len() <= 2
                && metadata.permissions().mode() & 0o777 == 0o600 =>
        {
            if std::fs::read(&path).map_err(|error| format!("read site usage policy: {error}"))?
                == content
            {
                return Ok(());
            }
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("read site usage policy: {error}")),
    }
    crate::fsutil::atomic_write_private(&path, content)
}

/// A broken ancillary observation must not block billing delivery or managed shutdown.
pub(crate) fn observe(stats: &[XrayStat]) -> Option<SiteUsageReport> {
    match from_stats(stats) {
        Ok(report) => report,
        Err(error) => {
            eprintln!("site usage observation unavailable: {error}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_defaults_off_and_changes_atomically() {
        let dir = std::env::temp_dir().join(format!("brocade-site-policy-{}", std::process::id()));
        crate::create_private_dir(&dir).unwrap();
        apply_policy(&dir, None).unwrap();
        assert_eq!(std::fs::read(control_path(&dir)).unwrap(), b"0\n");
        apply_policy(&dir, Some("1")).unwrap();
        let modified = std::fs::metadata(control_path(&dir))
            .unwrap()
            .modified()
            .unwrap();
        apply_policy(&dir, Some("1")).unwrap();
        assert_eq!(
            std::fs::metadata(control_path(&dir))
                .unwrap()
                .modified()
                .unwrap(),
            modified
        );
        assert!(apply_policy(&dir, Some("true")).is_err());
        assert_eq!(std::fs::read(control_path(&dir)).unwrap(), b"1\n");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(control_path(&dir), std::fs::Permissions::from_mode(0o644))
            .unwrap();
        apply_policy(&dir, Some("1")).unwrap();
        assert_eq!(
            std::fs::metadata(control_path(&dir))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        apply_policy(&dir, None).unwrap();
        assert_eq!(std::fs::read(control_path(&dir)).unwrap(), b"0\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(control_path(&dir))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        std::fs::remove_file(control_path(&dir)).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn disabled_marker_skips_site_payload_but_not_billing() {
        let mut stats = vec![
            XrayStat {
                name: "site>>>enabled".into(),
                value: 0,
            },
            XrayStat {
                name: "site>>>invalid-observation".into(),
                value: 9,
            },
            XrayStat {
                name: "user>>>alice@root#entry>>>traffic>>>uplink".into(),
                value: 123,
            },
        ];
        assert!(from_stats(&stats).unwrap().is_none());
        assert_eq!(
            crate::usage_counters_from_stats(&stats)[0].uplink_bytes,
            123
        );
        stats[0].value = 2;
        assert!(from_stats(&stats).is_err());
    }

    #[test]
    fn unfinished_site_registration_is_reported_as_incomplete() {
        let mut stats = vec![
            XrayStat {
                name: format!("site>>>epoch:{}", "a".repeat(32)),
                value: 1,
            },
            XrayStat {
                name: "site>>>version".into(),
                value: 1,
            },
            XrayStat {
                name: "site>>>pending".into(),
                value: 1,
            },
            XrayStat {
                name: "site>>>limited".into(),
                value: 0,
            },
        ];
        assert!(from_stats(&stats).unwrap().unwrap().limited);
        stats[2].value = 0;
        assert!(!from_stats(&stats).unwrap().unwrap().limited);
        stats[2].value = -1;
        assert!(from_stats(&stats).is_err());
    }

    #[test]
    fn parses_categories_without_polluting_legacy_usage() {
        let stats = vec![
            XrayStat {
                name: format!("site>>>epoch:{}", "a".repeat(32)),
                value: 1,
            },
            XrayStat {
                name: "site>>>version".into(),
                value: 1,
            },
            XrayStat {
                name: "site>>>alice@root#in>>>sniffing-failed>>>traffic>>>uplink".into(),
                value: 42,
            },
            XrayStat {
                name: "site>>>alice@root#in>>>youtube>>>traffic>>>downlink".into(),
                value: 100,
            },
            XrayStat {
                name: "site>>>limited".into(),
                value: 1,
            },
        ];
        let report = from_stats(&stats).unwrap().unwrap();
        assert!(report.limited);
        assert_eq!(report.counters.len(), 2);
        assert_eq!(report.counters[0].uplink_bytes, 42);
        assert!(crate::usage_counters_from_stats(&stats).is_empty());
        assert!(from_stats(&[]).unwrap().is_none());
        assert!(from_stats(&stats[1..]).is_err());
    }

    #[test]
    #[ignore = "requires BROCADE_TEST_XRAY pointing to a newly built managed Xray"]
    fn native_xray_classifies_failures_and_preserves_site_epoch() {
        use std::{
            fs,
            io::{Read, Write},
            net::{TcpListener, TcpStream, UdpSocket},
            process::{Command, Stdio},
            thread,
            time::{Duration, Instant},
        };
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let binary = std::env::var("BROCADE_TEST_XRAY").expect("new Xray binary required");
        let dir = std::env::temp_dir().join(format!("brocade-native-site-{}", std::process::id()));
        crate::create_private_dir(&dir).unwrap();
        let port = || {
            TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port()
        };
        let api_address = std::net::SocketAddr::from(([127, 0, 0, 1], port()));
        let inbound_port = port();
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let target_port = target.local_addr().unwrap().port();
        let config = dir.join("xray.json");
        let uuid = "11111111-1111-4111-8111-111111111111";
        fs::write(&config,serde_json::to_vec(&serde_json::json!({
            "log":{"loglevel":"warning"},"stats":{},"api":{"tag":"api","services":["StatsService"]},
            "policy":{"levels":{"0":{"statsUserUplink":true,"statsUserDownlink":true}}},
            "inbounds":[
                {"tag":"api","listen":"127.0.0.1","port":api_address.port(),"protocol":"dokodemo-door","settings":{"address":"127.0.0.1"}},
                {"tag":"entry","listen":"127.0.0.1","port":inbound_port,"protocol":"vless","settings":{"decryption":"none","clients":[{"id":uuid,"email":"alice@root#entry"}]},"sniffing":{"enabled":true,"destOverride":["http","tls"],"routeOnly":true,"domainsExcluded":["www.netflix.com"]}}
            ],"outbounds":[{"protocol":"freedom","tag":"direct","settings":{"ipsBlocked":[]}}],
            "routing":{"rules":[{"type":"field","inboundTag":["api"],"outboundTag":"api"}]}
        })).unwrap()).unwrap();
        let launch = || {
            let mut child = Child(
                Command::new(&binary)
                    .args(["run", "-config", config.to_str().unwrap()])
                    .env(
                        "XRAY_BROCADE_ACCOUNTING_FILE",
                        crate::accounting::journal_path(&dir),
                    )
                    .env(
                        "XRAY_BROCADE_SITE_ACCOUNTING_FILE",
                        crate::accounting::site_journal_path(&dir),
                    )
                    .env("XRAY_BROCADE_SITE_USAGE_ENABLED", "1")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap(),
            );
            let deadline = Instant::now() + Duration::from_secs(5);
            while crate::xray_grpc::query_stats(api_address, "").is_err() {
                assert!(child.0.try_wait().unwrap().is_none(), "Xray exited");
                assert!(Instant::now() < deadline, "Xray API timeout");
                thread::sleep(Duration::from_millis(10));
            }
            child
        };
        let mut child = launch();
        let before = from_stats(&crate::xray_grpc::query_stats(api_address, "").unwrap())
            .unwrap()
            .unwrap();
        let payloads: [&[u8]; 3] = [
            b"GET / HTTP/1.1\r\nHost: www.youtube.com\r\n\r\n",
            b"not-an-http-or-tls-payload",
            b"GET / HTTP/1.1\r\nHost: www.netflix.com\r\n\r\n",
        ];
        for payload in payloads {
            let mut client = TcpStream::connect(("127.0.0.1", inbound_port)).unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            // VLESS version, UUID, no addons, TCP, target port, IPv4 loopback.
            let mut packet = vec![0];
            packet.extend(
                uuid.replace('-', "").as_bytes().chunks(2).map(|chunk| {
                    u8::from_str_radix(std::str::from_utf8(chunk).unwrap(), 16).unwrap()
                }),
            );
            packet.extend([0, 1]);
            packet.extend(target_port.to_be_bytes());
            packet.extend([1, 127, 0, 0, 1]);
            packet.extend(payload);
            client.write_all(&packet).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut server = loop {
                match target.accept() {
                    Ok((server, _)) => break server,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "target connect timeout");
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("target accept: {error}"),
                }
            };
            server
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut received = vec![0; payload.len()];
            server.read_exact(&mut received).unwrap();
            assert_eq!(received, payload);
            server.write_all(&[7; 512]).unwrap();
            let mut reply = [0; 514];
            client.read_exact(&mut reply).unwrap();
            assert_eq!(&reply[2..], &[7; 512]);
        }
        let udp = UdpSocket::bind("127.0.0.1:0").unwrap();
        udp.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let udp_payload = b"unidentified-udp";
        let mut client = TcpStream::connect(("127.0.0.1", inbound_port)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut packet = vec![0];
        packet.extend(
            uuid.replace('-', "")
                .as_bytes()
                .chunks(2)
                .map(|chunk| u8::from_str_radix(std::str::from_utf8(chunk).unwrap(), 16).unwrap()),
        );
        packet.extend([0, 2]); // VLESS UDP, then its length-prefixed datagram.
        packet.extend(udp.local_addr().unwrap().port().to_be_bytes());
        packet.extend([1, 127, 0, 0, 1]);
        packet.extend((udp_payload.len() as u16).to_be_bytes());
        packet.extend(udp_payload);
        client.write_all(&packet).unwrap();
        let mut datagram = [0; 128];
        let (count, source) = udp.recv_from(&mut datagram).unwrap();
        assert_eq!(&datagram[..count], udp_payload);
        udp.send_to(&[8; 64], source).unwrap();
        let mut reply = [0; 68];
        client.read_exact(&mut reply).unwrap();
        assert_eq!(&reply[4..], &[8; 64]);
        let deadline = Instant::now() + Duration::from_secs(5);
        let observed = loop {
            let stats = crate::xray_grpc::query_stats(api_address, "").unwrap();
            let report = from_stats(&stats).unwrap().unwrap();
            let pending = stats
                .iter()
                .any(|stat| stat.name == "site>>>pending" && stat.value != 0);
            if !pending && report.counters.len() >= 3 {
                break report;
            }
            assert!(
                Instant::now() < deadline,
                "asynchronous site registration timed out"
            );
            thread::sleep(Duration::from_millis(5));
        };
        for (id, payload) in ["youtube", "sniffing-failed", "netflix"]
            .into_iter()
            .zip(payloads)
        {
            let row = observed
                .counters
                .iter()
                .find(|row| row.site_id == id)
                .unwrap();
            let extra_up = if id == "sniffing-failed" {
                udp_payload.len() as u64
            } else {
                0
            };
            let extra_down = if id == "sniffing-failed" { 64 } else { 0 };
            assert_eq!(row.uplink_bytes, payload.len() as u64 + extra_up);
            assert_eq!(row.downlink_bytes, 512 + extra_down);
        }
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        let restarted = launch();
        let restored = from_stats(&crate::xray_grpc::query_stats(api_address, "").unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(before.epoch, restored.epoch);
        assert_eq!(observed.counters, restored.counters);
        drop(restarted);
        drop(child);
        fs::remove_dir_all(dir).unwrap();
    }
}
