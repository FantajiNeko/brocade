use std::{
    fs::{self, File},
    io::Write,
    os::{fd::FromRawFd, unix::fs::PermissionsExt},
    path::Path,
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

const INSTALLER: &str = include_str!("../../../install.sh");

fn executable(path: &Path, source: &str) {
    fs::write(path, source).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn address_command_works_without_starting_a_database() {
    for (ip, port, expected) in [
        ("192.0.2.10", None, "http://192.0.2.10:8080"),
        ("2001:db8::10", None, "http://[2001:db8::10]:8080"),
        ("192.0.2.10", Some("8008"), "http://192.0.2.10:8008"),
        ("2001:db8::10", Some("9000"), "http://[2001:db8::10]:9000"),
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_brocade-launcher"));
        command.args(["address", "--public-ip", ip]);
        if let Some(port) = port {
            command.args(["--port", port]);
        }
        let output = command
            .env_remove("BROCADE_ADMIN_BIND")
            .env_remove("BROCADE_AGENT_PUBLIC_URL")
            .output()
            .unwrap();
        assert!(output.status.success(), "{:?}", output);
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), expected);
    }
}

fn installer_section(start: &str, end: &str) -> &'static str {
    let start = INSTALLER.find(start).expect("installer section starts");
    let end = INSTALLER.find(end).expect("installer section ends");
    assert!(start < end, "installer section markers must be ordered");
    &INSTALLER[start..end]
}

fn run_with_terminal_input(command: &mut Command, input: &str) -> Output {
    let (mut master, mut slave) = (-1, -1);
    // SAFETY: Both output pointers are valid and all optional openpty inputs are null.
    let result = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    assert_eq!(result, 0, "{}", std::io::Error::last_os_error());
    // SAFETY: openpty succeeded, returning distinct owned file descriptors.
    let (mut master, slave) = unsafe { (File::from_raw_fd(master), File::from_raw_fd(slave)) };
    let mut child = command
        .stdin(slave)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    master.write_all(input.as_bytes()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            let output = child.wait_with_output().unwrap();
            panic!("installer terminal interaction timed out: {output:?}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    child.wait_with_output().unwrap()
}

#[test]
fn interactive_port_selection_accepts_default_custom_and_explicit_ports() {
    // Execute the real argument parser and address selection against the real launcher, while
    // excluding privileged package/account/file installation from this terminal interaction test.
    let arguments = installer_section("public_ip=\n", "\n[ \"$(id -u)\" -eq 0 ]");
    let validation = installer_section("valid_port() {\n", "\nvalid_database_url() {");
    let selection = installer_section(
        "resolve_origin() {\n",
        "\n# The public command supplies system paths",
    );
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("select-port.sh");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\nset -eu\n\
             die() {{ printf '%s\\n' \"$*\" >&2; exit 1; }}\n\
             say() {{ printf '%s\\n' \"$*\"; }}\n\
             run_launcher() {{ \"$BROCADE_TEST_LAUNCHER\" \"$@\"; }}\n\
             {arguments}\n{validation}\n{selection}\n\
             printf '\\nRESULT=%s|%s\\n' \"$listen_address\" \"$public_url\"\n"
        ),
    )
    .unwrap();
    for (port_argument, input, expected_port) in [
        (None, "\n", "8080"),
        (None, "9000\n", "9000"),
        (None, "0\n65536\ninvalid\n\n", "8080"),
        (Some("9001"), "", "9001"),
    ] {
        let mut command = Command::new("sh");
        command
            .arg(&script)
            .args(["--public-ip", "192.0.2.10"])
            .env(
                "BROCADE_TEST_LAUNCHER",
                env!("CARGO_BIN_EXE_brocade-launcher"),
            )
            .env_remove("BROCADE_ADMIN_BIND")
            .env_remove("BROCADE_AGENT_PUBLIC_URL");
        if let Some(port) = port_argument {
            command.args(["--port", port]);
        }
        let output = run_with_terminal_input(&mut command, input);
        assert!(output.status.success(), "{output:?}");
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert_eq!(
            stdout.contains("HTTP 端口 [8080]："),
            port_argument.is_none()
        );
        assert!(stdout.contains(&format!(
            "RESULT=0.0.0.0:{expected_port}|http://192.0.2.10:{expected_port}"
        )));
        if input.starts_with('0') {
            assert_eq!(
                stdout.matches("端口必须是 1 至 65535 之间的整数。").count(),
                3
            );
        }
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
