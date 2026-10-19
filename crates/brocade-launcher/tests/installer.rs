use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

const INSTALLER: &str = include_str!("../../../install.sh");

fn executable(path: &Path, source: &str) {
    fs::write(path, source).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn address_command_works_without_starting_a_database() {
    for (ip, port, expected) in [
        ("192.0.2.10", "8008", "http://192.0.2.10:8008"),
        ("2001:db8::10", "9000", "http://[2001:db8::10]:9000"),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_brocade-launcher"))
            .args(["address", "--public-ip", ip, "--port", port])
            .env_remove("BROCADE_ADMIN_BIND")
            .env_remove("BROCADE_AGENT_PUBLIC_URL")
            .output()
            .unwrap();
        assert!(output.status.success(), "{:?}", output);
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), expected);
    }
}

#[test]
fn explicit_port_overrides_installed_listener_and_origin() {
    let output = Command::new(env!("CARGO_BIN_EXE_brocade-launcher"))
        .args(["address", "--port", "9000"])
        .env("BROCADE_ADMIN_BIND", "0.0.0.0:8008")
        .env("BROCADE_AGENT_PUBLIC_URL", "http://192.0.2.10:8008")
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output);
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "http://192.0.2.10:9000"
    );
}

#[test]
fn installed_command_keeps_ip_port_and_database_selection_across_restarts() {
    let marker = "cat >\"$command_stage\" <<'EOF'\n";
    let start = INSTALLER
        .find(marker)
        .expect("installer writes the public command")
        + marker.len();
    let end = INSTALLER[start..]
        .find("\nEOF\n")
        .expect("public command heredoc ends")
        + start;
    assert!(start < end);
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let config = root.path().join("config");
    fs::create_dir(&config).unwrap();
    fs::write(config.join("agent-public-url"), "http://192.0.2.10:9000\n").unwrap();
    fs::write(config.join("listen-address"), "0.0.0.0:9000\n").unwrap();
    fs::write(config.join("database-type"), "managed\n").unwrap();
    let runtime = bin.join("runtime");
    executable(
        &runtime,
        "#!/bin/sh\nprintf '%s\\n' \"$BROCADE_AGENT_PUBLIC_URL\" \"$BROCADE_ADMIN_BIND\" \"$*\"\n",
    );
    // Exercise the installed wrapper as its service account without requiring root on the test host.
    executable(&bin.join("id"), "#!/bin/sh\nprintf '1000\\n'\n");
    let script = INSTALLER[start..end]
        .replace(
            "runtime=/opt/brocade/brocade-launcher",
            &format!("runtime='{}'", runtime.display()),
        )
        .replace("/etc/brocade/", &format!("{}/", config.display()));
    let wrapper = bin.join("brocade");
    executable(&wrapper, &script);
    for _ in 0..2 {
        for (command, args) in [("up", "up --managed-db"), ("url", "url")] {
            let output = Command::new("sh")
                .arg(&wrapper)
                .arg(command)
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .env_remove("BROCADE_AGENT_PUBLIC_URL")
                .env_remove("BROCADE_ADMIN_BIND")
                .output()
                .unwrap();
            assert!(output.status.success(), "{:?}", output);
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                format!("http://192.0.2.10:9000\n0.0.0.0:9000\n{args}\n")
            );
        }
    }
}
