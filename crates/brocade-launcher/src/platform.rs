use anyhow::{bail, Context, Result};
use std::{path::Path, process::Stdio, time::Duration};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Libc {
    Gnu,
    Musl,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Platform {
    pub(crate) arch: &'static str,
    pub(crate) libc: Libc,
}

impl Platform {
    pub(crate) async fn current() -> Result<Self> {
        if std::env::consts::OS != "linux" {
            bail!(
                "brocade up 当前只支持 Linux，检测到 {}",
                std::env::consts::OS
            );
        }
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x86_64",
            "aarch64" => "aarch64",
            other => bail!("brocade up 当前只支持 x86_64 和 aarch64，检测到 {other}"),
        };
        let libc = if cfg!(target_env = "gnu") {
            Libc::Gnu
        } else if cfg!(target_env = "musl") {
            // Static musl launchers also run on glibc hosts. PostgreSQL is a separate
            // executable and needs the host's loader rather than the launcher's libc.
            detect_runtime_libc(Path::new("ldd"), Duration::from_secs(5)).await?
        } else {
            bail!("当前 launcher 不是 GNU 或 musl Linux 构建")
        };
        Ok(Self { arch, libc })
    }

    pub(crate) fn postgres_artifact(self) -> &'static str {
        match (self.arch, self.libc) {
            ("x86_64", Libc::Gnu) => "embedded-postgres-binaries-linux-amd64",
            ("x86_64", Libc::Musl) => "embedded-postgres-binaries-linux-amd64-alpine",
            ("aarch64", Libc::Gnu) => "embedded-postgres-binaries-linux-arm64v8",
            ("aarch64", Libc::Musl) => "embedded-postgres-binaries-linux-arm64v8-alpine",
            _ => unreachable!("Platform::current validates the supported matrix"),
        }
    }
}

async fn detect_runtime_libc(program: &Path, deadline: Duration) -> Result<Libc> {
    let output = tokio::time::timeout(
        deadline,
        tokio::process::Command::new(program)
            .arg("--version")
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("ldd --version 超时，无法选择受管 PostgreSQL")?
    .context("无法执行 ldd --version，无法选择受管 PostgreSQL")?;
    let banner = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
    .to_ascii_lowercase();
    // Alpine's musl loader prints its version to stderr and exits nonzero.
    if banner.contains("musl") {
        return Ok(Libc::Musl);
    }
    if output.status.success() && (banner.contains("glibc") || banner.contains("gnu")) {
        return Ok(Libc::Gnu);
    }
    bail!("无法从 ldd --version 识别 GNU libc 或 musl，未选择受管 PostgreSQL")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, time::Instant};

    fn probe_script(root: &Path, body: &str) -> std::path::PathBuf {
        let script = root.join("ldd");
        fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    #[tokio::test]
    async fn static_launcher_selects_postgres_for_the_runtime_libc() {
        let root = tempfile::tempdir().unwrap();
        for (body, expected, artifact) in [
            (
                "printf 'ldd (Ubuntu GLIBC 2.35) 2.35\\n'",
                Libc::Gnu,
                "embedded-postgres-binaries-linux-amd64",
            ),
            (
                "printf 'musl libc (x86_64)\\nVersion 1.2.5\\n' >&2; exit 1",
                Libc::Musl,
                "embedded-postgres-binaries-linux-amd64-alpine",
            ),
        ] {
            let script = probe_script(root.path(), body);
            let libc = detect_runtime_libc(&script, Duration::from_secs(1))
                .await
                .unwrap();
            assert_eq!(libc, expected);
            assert_eq!(
                Platform {
                    arch: "x86_64",
                    libc
                }
                .postgres_artifact(),
                artifact
            );
        }
    }

    #[tokio::test]
    async fn unknown_or_broken_runtime_does_not_guess_a_postgres_asset() {
        let root = tempfile::tempdir().unwrap();
        for body in [
            "printf 'unknown libc\\n'",
            "printf 'GNU error\\n' >&2; exit 1",
        ] {
            let script = probe_script(root.path(), body);
            assert!(detect_runtime_libc(&script, Duration::from_secs(1))
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn runtime_libc_probe_has_a_deadline() {
        let root = tempfile::tempdir().unwrap();
        let script = probe_script(root.path(), "exec sleep 10");
        let start = Instant::now();
        let error = detect_runtime_libc(&script, Duration::from_millis(50))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("超时"));
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn supported_matrix_maps_to_upstream_asset_names() {
        for (arch, libc, postgres) in [
            (
                "x86_64",
                Libc::Gnu,
                "embedded-postgres-binaries-linux-amd64",
            ),
            (
                "x86_64",
                Libc::Musl,
                "embedded-postgres-binaries-linux-amd64-alpine",
            ),
            (
                "aarch64",
                Libc::Gnu,
                "embedded-postgres-binaries-linux-arm64v8",
            ),
            (
                "aarch64",
                Libc::Musl,
                "embedded-postgres-binaries-linux-arm64v8-alpine",
            ),
        ] {
            let platform = Platform { arch, libc };
            assert_eq!(platform.postgres_artifact(), postgres);
        }
    }
}
