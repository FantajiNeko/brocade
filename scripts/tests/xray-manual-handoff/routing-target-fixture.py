#!/usr/bin/env python3
"""Prove a fixed forwarding TCP target can change without removing tcp_udp.

Loopback-only actual-process test. This does not certify replacing arbitrary
production routing: appending is safe only when prior rules cannot intercept
the selected forwarding tag. All sockets and Xray processes are fixture-owned.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile


def load_fixture():
    spec = importlib.util.spec_from_file_location("legacy_fixture", Path(__file__).with_name("legacy-resident-fixture.py"))
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    return fixture


def reserve(address, family):
    with socket.socket(family, socket.SOCK_STREAM) as listener:
        listener.bind((address, 0))
        return listener.getsockname()[1]


def api(binary, api_port, operation, config=None, args=()):
    result = subprocess.run([str(binary), "api", operation, f"--server=127.0.0.1:{api_port}", *args], input=json.dumps(config) if config is not None else None, text=True, capture_output=True, timeout=8)
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout


def socket_identities(pid):
    # Exclude API request sockets by comparing only fds present before mutation.
    result = {}
    for entry in Path(f"/proc/{pid}/fd").iterdir():
        try:
            value = os.readlink(entry)
        except FileNotFoundError:
            continue
        if value.startswith("socket:["):
            result[int(entry.name)] = value
    return result


def run_case(binary, ipv6):
    fixture = load_fixture()
    address = "::1" if ipv6 else "127.0.0.1"
    family = socket.AF_INET6 if ipv6 else socket.AF_INET
    origins, downloads = [], []
    runtime = None
    with tempfile.TemporaryDirectory(prefix="routing-target-") as temporary:
        try:
            source_a, source_b = fixture.Origin(address, family, 65), fixture.Origin(address, family, 66)
            origins.extend((source_a, source_b))
            port, api_port = reserve(address, family), reserve("127.0.0.1", socket.AF_INET)
            config = fixture.configuration(address, port, source_a.port, True)
            config["api"] = {"tag": "api", "listen": f"127.0.0.1:{api_port}", "services": ["HandlerService", "RoutingService"]}
            config["routing"] = {"rules": []}
            runtime = fixture.OwnedXray(binary, config, Path(temporary), "old", mptcp=True)
            fixture.wait_until(lambda: len(fixture.listener_inodes(address, port, ipv6)) == 1)
            source, _ = fixture.duplicate_listener(runtime, address, port, ipv6, protocol=262)
            source.close()
            before = fixture.Download(address, port, family, 65, True)
            downloads.append(before)
            fixture.wait_until(lambda: before.frames > 20)
            # No RPC is active when this snapshot is taken.
            identities = socket_identities(runtime.pid)
            redirect = f"[{address}]:{source_b.port}" if ipv6 else f"{address}:{source_b.port}"
            api(binary, api_port, "ado", {"outbounds": [{"tag": "controlled-test-source", "protocol": "freedom", "settings": {"redirect": redirect}}]})
            api(binary, api_port, "adrules", {"routing": {"rules": [{"type": "field", "ruleTag": "manual-test-source", "inboundTag": ["fixture-forward"], "network": "tcp", "outboundTag": "controlled-test-source"}]}}, args=("--append",))
            after = fixture.Download(address, port, family, 66, True)
            downloads.append(after)
            fixture.wait_until(lambda: after.frames > 40)
            before.healthy(40)
            with socket.socket(family, socket.SOCK_DGRAM) as udp:
                udp.settimeout(3)
                for index in range(10):
                    payload = index.to_bytes(8, "big")
                    udp.sendto(payload, (address, port))
                    response, _ = udp.recvfrom(128)
                    assert response == b"A" + payload, "TCP target change altered UDP target"
            actual = socket_identities(runtime.pid)
            assert all(actual.get(fd) == identity for fd, identity in identities.items()), "an existing socket was closed/replaced"
            runtime.verify()
            results = [download.close() for download in downloads]
            downloads.clear()
            return {"family": "IPv6" if ipv6 else "IPv4", "binary_sha256": runtime.digest, "protocol": 262, "downloads": results, "inbound_removed": False, "original_sockets_preserved": True, "udp_echoes": 10, "old_download_origin": "A", "new_download_origin": "B", "production_certification": False}
        except BaseException:
            for log in Path(temporary).glob("*.log"):
                print(log.read_text(errors="replace")[-2000:], flush=True)
            raise
        finally:
            for download in downloads:
                try:
                    download.close()
                except BaseException:
                    pass
            if runtime:
                runtime.close()
            for origin in origins:
                origin.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xray", type=Path, required=True)
    arguments = parser.parse_args()
    print(json.dumps([run_case(arguments.xray.resolve(strict=True), ipv6) for ipv6 in (False, True)], indent=2))
