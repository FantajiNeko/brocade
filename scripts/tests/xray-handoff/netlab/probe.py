#!/usr/bin/env python3
"""Bounded lab plumbing checks; payload accounting is not Xray accounting."""

import hashlib
import json
import os
from pathlib import Path
import select
import socket
import statistics
import subprocess
import sys
import time

ROLES = ("client", "forward", "access", "origin")
LINKS = (("client", "c0", "forward", "f0"),
         ("forward", "f1", "access", "a0"),
         ("access", "a1", "origin", "o0"))
CHUNK = bytes(range(256)) * 256
PORT = 19090


def run(*args, timeout=5):
    return subprocess.check_output(args, text=True, timeout=timeout).strip()


def ns(role, *args):
    return run("ip", "netns", "exec", "h7-" + role, *args)


def read_optional(path):
    candidate = Path(path)
    return candidate.read_text().strip() if candidate.exists() else None


def snapshot():
    result = {"monotonic_ns": time.monotonic_ns(), "kernel": os.uname().release,
              "profile": json.loads(Path("/run/h7-profile.json").read_text()),
              "allowed_cpus": sorted(os.sched_getaffinity(0)), "roles": {}}
    result["cgroup"] = {name: read_optional("/sys/fs/cgroup/" + name) for name in
                        ("cpu.stat", "cpu.max", "cpu.pressure", "cpuset.cpus.effective",
                         "memory.current", "memory.max", "memory.events", "pids.current")}
    result["cpu_note"] = "cgroup usage_usec is all roles combined; /proc/softirqs is host-global, not attributed to this netlab"
    for role in ROLES:
        role_pids = ns(role, "ip", "netns", "pids", "h7-" + role).split()
        result["roles"][role] = {
            "netns": ns(role, "readlink", "/proc/self/ns/net"),
            "links": json.loads(ns(role, "ip", "-s", "-j", "link", "show")),
            "addresses": json.loads(ns(role, "ip", "-j", "addr", "show")),
            "qdiscs": json.loads(ns(role, "tc", "-s", "-j", "qdisc", "show")),
            "netstat": ns(role, "cat", "/proc/net/netstat"),
            "snmp": ns(role, "cat", "/proc/net/snmp"),
            "offloads": {entry[1 if entry[0] == role else 3]: ns(role, "ethtool", "-k", entry[1 if entry[0] == role else 3])
                         for entry in LINKS if role in (entry[0], entry[2])},
            "namespace_pids": role_pids,
        }
    result["container_processes"] = run("ps", "-eo", "pid,ppid,psr,pcpu,rss,comm")
    return result


def validate_profile(state):
    rate = state["profile"]["rate_mbps"] * 1000000 // 8
    rtt = state["profile"]["rtt_ms"]
    delays = {("client", "c0"): 0.16, ("forward", "f0"): 0.16,
              ("forward", "f1"): 0.26, ("access", "a0"): 0.26,
              ("access", "a1"): 0.08, ("origin", "o0"): 0.08}
    for (role, interface), fraction in delays.items():
        qdiscs = state["roles"][role]["qdiscs"]
        tbf = next(item for item in qdiscs if item["dev"] == interface and item["kind"] == "tbf")
        netem = next(item for item in qdiscs if item["dev"] == interface and item["kind"] == "netem")
        if tbf["options"]["rate"] != rate:
            raise RuntimeError("kernel rate readback differs")
        if abs(netem["options"]["delay"]["delay"] - rtt * fraction / 1000) > 0.000001:
            raise RuntimeError("kernel delay readback differs")
        features = state["roles"][role]["offloads"][interface].splitlines()
        if any(feature + ": off" not in features for feature in
               ("tcp-segmentation-offload", "generic-segmentation-offload", "generic-receive-offload")):
            raise RuntimeError("offload readback differs")


def exact_read(conn, size):
    data = bytearray()
    while len(data) < size:
        part = conn.recv(size - len(data))
        if not part:
            raise RuntimeError("unexpected EOF at %d/%d" % (len(data), size))
        data.extend(part)
    return bytes(data)


def read_json(conn):
    size = int.from_bytes(exact_read(conn, 4), "big")
    if size > 4096:
        raise RuntimeError("oversized control frame")
    return json.loads(exact_read(conn, size))


def write_json(conn, value):
    body = json.dumps(value, separators=(",", ":")).encode()
    conn.sendall(len(body).to_bytes(4, "big") + body)


def payload(conn, size, send):
    checksum = hashlib.sha256()
    count = 0
    while count < size:
        length = min(len(CHUNK), size - count)
        if send:
            part = CHUNK[:length]
            conn.sendall(part)
        else:
            part = conn.recv(length)
            if not part:
                raise RuntimeError("payload EOF at %d/%d" % (count, size))
        checksum.update(part)
        count += len(part)
    return {"bytes": count, "sha256": checksum.hexdigest()}


def serve():
    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        listener.bind(("::", PORT))
        listener.listen(4)
        listener.settimeout(30)
        print("READY", flush=True)
        for _ in range(2):
            conn, _ = listener.accept()
            with conn:
                conn.settimeout(15)
                conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                request = read_json(conn)
                size = request["bytes"]
                if not isinstance(size, int) or not 1 <= size <= 64 * 1024 * 1024:
                    raise RuntimeError("payload out of bounds")
                for _ in range(12):
                    conn.sendall(exact_read(conn, 64))
                uploaded = payload(conn, size, False)
                write_json(conn, uploaded)
                downloaded = payload(conn, size, True)
                write_json(conn, downloaded)


def client(address):
    size = 8 * 1024 * 1024
    with socket.create_connection((address, PORT), timeout=15) as conn:
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        write_json(conn, {"bytes": size})
        rtt = []
        for _ in range(12):
            started = time.monotonic_ns()
            conn.sendall(CHUNK[:64])
            if exact_read(conn, 64) != CHUNK[:64]:
                raise RuntimeError("echo differs")
            rtt.append((time.monotonic_ns() - started) / 1e6)
        started = time.monotonic_ns()
        sent = payload(conn, size, True)
        server_received = read_json(conn)
        upload_seconds = (time.monotonic_ns() - started) / 1e9
        started = time.monotonic_ns()
        received = payload(conn, size, False)
        server_sent = read_json(conn)
        download_seconds = (time.monotonic_ns() - started) / 1e9
        if sent != server_received or received != server_sent or sent != received:
            raise RuntimeError("endpoints disagree on exact bytes/SHA256")
        return {"address": address, "connections": 1, "reconnects": 0,
                "rtt_ms": {"samples": rtt, "min": min(rtt), "median": statistics.median(rtt), "max": max(rtt)},
                "upload": {"client": sent, "server": server_received, "seconds": upload_seconds,
                           "payload_mbps": size * 8 / upload_seconds / 1e6},
                "download": {"client": received, "server": server_sent, "seconds": download_seconds,
                             "payload_mbps": size * 8 / download_seconds / 1e6}}


def link_stats(state, role, interface):
    entry = next(item for item in state["roles"][role]["links"] if item["ifname"] == interface)
    return entry.get("stats64", entry.get("stats"))


def counter_delta(before, after):
    results = []
    for left_role, left_if, right_role, right_if in LINKS:
        endpoints = []
        for role, interface in ((left_role, left_if), (right_role, right_if)):
            old, new = link_stats(before, role, interface), link_stats(after, role, interface)
            endpoints.append({direction: {key: new[direction][key] - old[direction][key]
                                         for key in ("bytes", "packets", "errors", "dropped")}
                              for direction in ("rx", "tx")})
        a, b = endpoints
        conserved = all(a["tx"][key] == b["rx"][key] and a["rx"][key] == b["tx"][key]
                        for key in ("bytes", "packets"))
        if not conserved:
            raise RuntimeError("veth counters not conserved: %s/%s" % (left_if, right_if))
        if any(endpoint[direction][key] for endpoint in endpoints for direction in ("rx", "tx")
               for key in ("errors", "dropped")):
            raise RuntimeError("unexpected veth errors/drops")
        results.append({"pair": [left_role + "/" + left_if, right_role + "/" + right_if],
                        "deltas": endpoints, "packet_and_byte_conservation": conserved})
    return results


def smoke():
    # Warm both neighbor tables before taking interval counters.
    for target in ("10.77.3.2", "fd77:3::2"):
        ns("client", "ping", "-n", "-c", "2", "-W", "2", "-i", "0.1", target)
    server = subprocess.Popen(["ip", "netns", "exec", "h7-origin", "python3", "/netlab/probe.py", "serve"],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        if not select.select([server.stdout], [], [], 5)[0] or server.stdout.readline().strip() != "READY":
            raise RuntimeError("origin did not become ready")
        before = snapshot()
        validate_profile(before)
        clients = []
        for target in ("10.77.3.2", "fd77:3::2"):
            clients.append(json.loads(run("ip", "netns", "exec", "h7-client", "python3", "/netlab/probe.py", "client", target, timeout=25)))
        _, server_errors = server.communicate(timeout=5)
        if server.returncode != 0:
            raise RuntimeError(server_errors)
        time.sleep(0.25)
        after = snapshot()
        validate_profile(after)
        deltas = counter_delta(before, after)
        configured = before["profile"]["rtt_ms"]
        for result in clients:
            median = result["rtt_ms"]["median"]
            if not configured * 0.9 <= median <= configured + max(10, configured * 0.25):
                raise RuntimeError("RTT outside smoke tolerance: %f" % median)
            for direction in ("upload", "download"):
                if result[direction]["payload_mbps"] > before["profile"]["rate_mbps"] * 1.1:
                    raise RuntimeError("rate ceiling not enforced")
        report = {"status": "passed", "scope": "short plumbing check, not sustained Xray upgrade or accounting proof",
                  "clients": clients, "interface_deltas": deltas, "before": before, "after": after,
                  "accounting_note": "Payload bytes/SHA256 are exact and separate from NIC bytes including headers/control/retransmits. Do not compare them as equal."}
        print(json.dumps(report, indent=2))
    finally:
        if server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=2)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=2)


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    if action == "snapshot":
        print(json.dumps(snapshot(), indent=2))
    elif action == "serve":
        serve()
    elif action == "client" and len(sys.argv) == 3:
        print(json.dumps(client(sys.argv[2])))
    elif action == "smoke":
        smoke()
    else:
        raise SystemExit("usage: probe.py snapshot|serve|client ADDRESS|smoke")
