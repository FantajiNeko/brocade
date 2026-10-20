//! Prefer the candidate's typed root cause to a secondary control-socket error.
//! Old Xray versions and unclassified failures retain a bounded log fallback.

use super::{
    read_handoff_manifest_identity, validate_handoff_manifest_path, HandoffManifestIdentity,
};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom},
    net::SocketAddr,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
};

const MAX_FAILURE_BYTES: u64 = 4096;
const MAX_LOG_TAIL: u64 = 4096;

#[cfg(test)]
mod tests;

#[derive(serde::Deserialize)]
struct StartupFailure {
    version: u32,
    generation_id: String,
    pid: i32,
    pid_start_ticks: String,
    boot_id: String,
    network: String,
    address: String,
    errno: i32,
}

pub(crate) fn failure(
    log_path: &Path,
    reason: &str,
    manifest_path: Option<&Path>,
    expected_process: Option<crate::ProcessRef>,
) -> String {
    let root = manifest_path.and_then(|path| {
        validate_handoff_manifest_path(path).ok()?;
        let manifest = read_handoff_manifest_identity(path).ok()?;
        root_failure(&manifest, expected_process)
    });
    // Do not even open the log if a trusted root errno is available.
    root.unwrap_or_else(|| with_log_tail(log_path, reason))
}

pub(super) fn root_failure(
    manifest: &HandoffManifestIdentity,
    expected_process: Option<crate::ProcessRef>,
) -> Option<String> {
    // This is optional diagnostic evidence, not a convergence checkpoint. Invalid,
    // missing, or older-version evidence falls back without blocking recovery.
    validate_handoff_manifest_path(&manifest.control_path).ok()?;
    let path = manifest.control_path.with_file_name(format!(
        "{}.startup-error.json",
        manifest.control_path.file_name()?.to_str()?
    ));
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
        || metadata.mode() & 0o077 != 0
        || metadata.len() == 0
        || metadata.len() > MAX_FAILURE_BYTES
    {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_FAILURE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 != metadata.len() {
        return None;
    }
    let record: StartupFailure = serde_json::from_slice(&bytes).ok()?;
    let ticks = record.pid_start_ticks.parse::<u64>().ok()?;
    if record.version != 1
        || record.generation_id != manifest.generation_id
        || record.pid <= 0
        || ticks == 0
        || expected_process
            .is_some_and(|process| process.pid != record.pid || process.start_ticks != ticks)
        || record.boot_id
            != fs::read_to_string("/proc/sys/kernel/random/boot_id")
                .ok()?
                .trim()
        || !matches!(record.network.as_str(), "tcp" | "udp")
    {
        return None;
    }
    let address = record.address.parse::<SocketAddr>().ok()?;
    if address.port() == 0
        || !manifest.listeners.iter().any(|endpoint| {
            endpoint.network == record.network
                && [&endpoint.address, &endpoint.bind_address]
                    .iter()
                    .any(|value| value.parse::<SocketAddr>().ok() == Some(address))
        })
    {
        return None;
    }
    let (code, detail) = listen_errno(record.errno)?;
    Some(format!(
        "Xray 监听失败：{} {address}；{code}（errno={}，{detail}）",
        record.network.to_ascii_uppercase(),
        record.errno
    ))
}

fn listen_errno(errno: i32) -> Option<(&'static str, &'static str)> {
    Some(match errno {
        libc::EADDRINUSE => ("EADDRINUSE", "地址或端口已被占用"),
        libc::EADDRNOTAVAIL => ("EADDRNOTAVAIL", "监听地址在本机不可用"),
        libc::EACCES => ("EACCES", "监听权限不足"),
        libc::EPERM => ("EPERM", "系统策略不允许监听"),
        libc::EMFILE => ("EMFILE", "进程文件描述符已耗尽"),
        libc::ENFILE => ("ENFILE", "系统文件描述符已耗尽"),
        libc::ENOBUFS => ("ENOBUFS", "内核网络缓冲不足"),
        libc::ENOMEM => ("ENOMEM", "内存不足"),
        libc::EAFNOSUPPORT => ("EAFNOSUPPORT", "内核不支持该地址族"),
        libc::EPROTONOSUPPORT => ("EPROTONOSUPPORT", "内核不支持该协议"),
        libc::ENOPROTOOPT => ("ENOPROTOOPT", "内核不支持该套接字选项"),
        libc::EOPNOTSUPP => ("EOPNOTSUPP", "套接字不支持该操作"),
        libc::EINVAL => ("EINVAL", "监听参数无效"),
        _ => return None,
    })
}

fn with_log_tail(log_path: &Path, reason: &str) -> String {
    let tail = (|| {
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(log_path)
            .ok()?;
        let metadata = file.metadata().ok()?;
        if !metadata.is_file() {
            return None;
        }
        let length = metadata.len().min(MAX_LOG_TAIL);
        file.seek(SeekFrom::End(-(length as i64))).ok()?;
        let mut bytes = Vec::new();
        file.take(MAX_LOG_TAIL).read_to_end(&mut bytes).ok()?;
        let tail = String::from_utf8_lossy(&bytes).trim().to_owned();
        (!tail.is_empty()).then_some(tail)
    })();
    match tail {
        Some(tail) => format!("{reason}；Xray 日志末尾：{tail}"),
        None => reason.to_owned(),
    }
}
