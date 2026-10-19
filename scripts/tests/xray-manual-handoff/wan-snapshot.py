#!/usr/bin/env python3
"""Read-only evidence for the explicitly scoped WAWO forwarding canary."""
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import time


def run(*args):
    result = subprocess.run(args, text=True, capture_output=True, timeout=8)
    if result.returncode:
        raise RuntimeError(f"read-only command failed: {args[0]}")
    return result.stdout


def digest(path):
    with open(path, "rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


data = Path("/var/lib/brocade-agent/xray-accounting.bin").read_bytes()
if data[:8] != b"BRACCT02":
    raise RuntimeError("journal format changed")
count = struct.unpack_from("<I", data, 24)[0]
if count > 16384:
    raise RuntimeError("journal record count exceeds capacity")
counters = {}
for index in range(count):
    offset = 64 + index * 512
    length = struct.unpack_from("<I", data, offset + 8)[0]
    if not 0 < length <= 496:
        raise RuntimeError("invalid journal label")
    label = data[offset + 16:offset + 16 + length].decode()
    if label.startswith("inbound>>>fwd:18>>>traffic>>>"):
        counters[label.rsplit(">>>", 1)[1]] = struct.unpack_from("<q", data, offset)[0]
print(json.dumps({
    "unix_ms": round(time.time() * 1000), "old_pid": 527,
    "old_binary_sha256": digest("/proc/527/exe"),
    "installed_binary_sha256": digest("/usr/local/bin/xray"),
    "config_sha256": digest("/var/lib/brocade-agent/xray.json"),
    "forwarding_applied_sha256": digest("/var/lib/brocade-agent/forwarding-applied.json"),
    "tcp_listener": os.readlink("/proc/527/fd/11"),
    "udp_listener": os.readlink("/proc/527/fd/12"),
    "journal_header_sha256": hashlib.sha256(data[:64]).hexdigest(),
    "journal_writer": struct.unpack_from("<I", data, 28)[0],
    "counters": counters,
    "agent": run("systemctl", "show", "brocade-agent", "--property=MainPID,ActiveState"),
    "connections": run("ss", "-tnpe", "state", "established", "( sport = :39742 or sport = :40000 or sport = :39741 )"),
}))
