#!/usr/bin/env python3
"""Real-time, isolated Docker check of rendered inbound TCP keepalive policy."""

import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import select
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import uuid


def call(*args, timeout=20):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError(f"{args[:4]} failed: {result.stderr.strip()} {result.stdout.strip()}")
    return result.stdout.strip()


def exact(sock, length):
    result = b""
    while len(result) < length:
        data = sock.recv(length - len(result))
        if not data:
            raise RuntimeError("connection closed before the expected reply")
        result += data
    return result


def targets():
    listener = socket.socket()
    listener.bind(("127.0.0.1", 9000))
    listener.listen()

    def echo(conn):
        with conn:
            while data := conn.recv(4096):
                conn.sendall(data)

    while True:
        conn, _ = listener.accept()
        threading.Thread(target=echo, args=(conn,), daemon=True).start()


def client(args):
    host = args.server if args.protocol == "vless" else "127.0.0.1"
    port = 8443 if args.protocol == "vless" else 1080
    with socket.create_connection((host, port), timeout=10) as sock:
        sock.settimeout(10)
        if args.protocol == "vless":
            # VLESS version, fixture UUID, addons, TCP, target port, IPv4 address.
            sock.sendall(b"\0" + uuid.UUID(args.identity).bytes + b"\0\1\x23\x28\1\x7f\0\0\1ping")
            response = exact(sock, 2)
            exact(sock, response[1])
        else:
            sock.sendall(b"\5\1\0")
            assert exact(sock, 2) == b"\5\0"
            sock.sendall(b"\5\1\0\1\x7f\0\0\1\x23\x28")
            assert exact(sock, 10)[1] == 0
            sock.sendall(b"ping")
        assert exact(sock, 4) == b"ping"
        print("READY", flush=True)
        while not pathlib.Path("/lab/probe-healthy").exists():
            time.sleep(.5)
        if args.healthy:
            # Use the original connection after at least one complete failure window, not a
            # fresh TCP connection or a second AnyTLS stream that could mask a dead carrier.
            sock.sendall(b"after-idle")
            assert exact(sock, 10) == b"after-idle"
            print("HEALTHY", flush=True)


def run(args):
    output = pathlib.Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    lab = pathlib.Path(tempfile.mkdtemp(prefix="run-", dir=output))
    binary = pathlib.Path(args.xray).resolve(strict=True)
    script = pathlib.Path(__file__).resolve()
    rendered = json.loads(pathlib.Path(args.rendered).read_text())
    sockets = [item["streamSettings"]["sockopt"] for item in rendered["inbounds"] if item["protocol"] == "vless"]
    assert sockets, "rendered fixture must include a VLESS inbound"
    sockopt = sockets[0]
    assert all(value == sockopt for value in sockets), "managed TCP policies differ"
    assert sockopt["tcpKeepAliveIdle"] == 300 and sockopt["tcpKeepAliveInterval"] == 90
    assert sockopt["customSockopt"] == [{"system": "linux", "network": "tcp", "level": "6", "opt": "6", "type": "int", "value": "3"}]
    prefix = "brocade-ka-" + uuid.uuid4().hex[:8]
    network, server = prefix + "-net", prefix + "-server"
    owned, processes = [], []
    clock = time.monotonic()
    event_lock = threading.Lock()

    def event(kind, **values):
        value = {"event": kind, "elapsed": round(time.monotonic() - clock, 2), **values}
        with event_lock:
            print(json.dumps(value), flush=True)
            with (lab / "events.jsonl").open("a") as stream:
                stream.write(json.dumps(value) + "\n")

    def container(name):
        owned.append(name)
        call("docker", "run", "--pull=never", "-d", "--name", name, "--network", network,
             "--cap-add=NET_ADMIN", "--security-opt=apparmor=unconfined",
             "--label", f"brocade.keepalive={prefix}", "-v", f"{lab}:/lab:ro",
             "-v", f"{binary}:/xray:ro", "-v", f"{script}:/lab-code.py:ro",
             "--entrypoint", "sleep", args.image, "infinity")

    def execute(name, *command, log):
        process = subprocess.Popen(["docker", "exec", name, *command],
                                   stdout=(lab / log).open("w"), stderr=subprocess.STDOUT)
        processes.append(process)
        return process

    def stats():
        return json.loads(call("docker", "exec", server, "/xray", "api", "statsonlineiplist",
                               "--server=127.0.0.1:10085", "-all"))

    cases = [{"name": f"{protocol}-{family}-{state}", "protocol": protocol, "family": family,
              "healthy": state == "healthy", "identity": str(uuid.uuid4())}
             for protocol in ("vless", "anytls") for family in ("v4", "v6")
             for state in ("healthy", "blackhole")]
    try:
        call("docker", "network", "create", "--internal", "--ipv6", "--label", f"brocade.keepalive={prefix}", network)
        call("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
             "-subj", "/CN=keepalive.test", "-keyout", str(lab / "key.pem"), "-out", str(lab / "cert.pem"))
        pin = hashlib.sha256(ssl.PEM_cert_to_DER_cert((lab / "cert.pem").read_text())).hexdigest()
        inbounds = []
        for protocol, port in [("vless", 8443), ("anytls", 8444)]:
            stream = {"network": "tcp", "security": "none", "sockopt": sockopt}
            settings = {"clients" if protocol == "vless" else "users": [
                {"id" if protocol == "vless" else "password": case["identity"], "email": case["name"] + "@example.test#entry"}
                for case in cases if case["protocol"] == protocol]}
            if protocol == "vless":
                settings["decryption"] = "none"
            else:
                stream.update({"security": "tls", "tlsSettings": {"certificates": [{"certificateFile": "/lab/cert.pem", "keyFile": "/lab/key.pem"}]}})
            inbounds.append({"tag": protocol, "listen": "::", "port": port, "protocol": protocol,
                             "settings": settings, "streamSettings": stream})
        # Longer than this experiment: application connIdle must not hide whether TCP keepalive
        # itself detects loss or whether an idle-but-live client can reuse its original socket.
        config = {"log": {"loglevel": "info"}, "api": {"tag": "api", "listen": "127.0.0.1:10085", "services": ["StatsService"]},
                  "stats": {}, "policy": {"levels": {"0": {"connIdle": 3600, "statsUserOnline": True}}},
                  "inbounds": inbounds, "outbounds": [{"protocol": "freedom", "settings": {"ipsBlocked": []}}]}
        (lab / "server.json").write_text(json.dumps(config))
        container(server)
        call("docker", "exec", server, "/xray", "run", "-test", "-c", "/lab/server.json")
        execute(server, "/xray", "run", "-c", "/lab/server.json", log="server.log")
        execute(server, "python3", "/lab-code.py", "targets", log="targets.log")
        addresses = json.loads(call("docker", "inspect", server))[0]["NetworkSettings"]["Networks"][network]
        event("environment", sockopt=sockopt, addresses=addresses,
              sha256=hashlib.sha256(binary.read_bytes()).hexdigest(), kernel=call("uname", "-r"))
        time.sleep(1)
        stats()

        def setup(case):
            name = prefix + "-" + case["name"]
            container(name)
            address = addresses["IPAddress" if case["family"] == "v4" else "GlobalIPv6Address"]
            assert address, f"missing {case['family']} address"
            if case["protocol"] == "anytls":
                client_config = {"log": {"loglevel": "warning"}, "inbounds": [{"listen": "127.0.0.1", "port": 1080, "protocol": "socks", "settings": {"auth": "noauth"}}],
                                 "outbounds": [{"protocol": "anytls", "settings": {"address": address, "port": 8444, "password": case["identity"]},
                                                "streamSettings": {"network": "tcp", "security": "tls", "tlsSettings": {"serverName": "keepalive.test", "pinnedPeerCertSha256": pin}}}]}
                (lab / (case["name"] + ".json")).write_text(json.dumps(client_config))
                execute(name, "/xray", "run", "-c", "/lab/" + case["name"] + ".json", log=case["name"] + "-xray.log")
                time.sleep(.5)
            command = ["docker", "exec", name, "python3", "-u", "/lab-code.py", "client", "--protocol", case["protocol"], "--server", address, "--identity", case["identity"]]
            if case["healthy"]:
                command.append("--healthy")
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            processes.append(process)
            assert select.select([process.stdout], [], [], 15)[0], f"{case['name']}: readiness timeout"
            line = process.stdout.readline().strip()
            assert line == "READY", f"{case['name']}: {line}"
            case["process"] = process
            time.sleep(.3)  # Let the initial application bytes and their ACKs settle before loss.
            if not case["healthy"]:
                family = "ip" if case["family"] == "v4" else "ip6"
                rules = f"add table inet keepalive; add chain inet keepalive output {{ type filter hook output priority -300; }}; add rule inet keepalive output {family} daddr {address} counter drop; add chain inet keepalive input {{ type filter hook input priority -300; }}; add rule inet keepalive input {family} saddr {address} counter drop"
                call("docker", "exec", name, "nft", rules)
            case["at"] = time.monotonic()
            case["container"] = name
            event("started", name=case["name"])

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(setup, cases))
        first = stats()
        assert len(first.get("users", [])) == len(cases), first
        deadline, checkpoint = time.monotonic() + 620, 0
        while time.monotonic() < deadline:
            sample = stats()
            online = {user["email"] for user in sample.get("users", [])}
            for case in cases:
                present = case["name"] + "@example.test#entry" in online
                if case["healthy"]:
                    assert present, f"healthy idle connection incorrectly removed: {case['name']}"
                elif not present and "offline_secs" not in case:
                    case["offline_secs"] = round(time.monotonic() - case["at"], 2)
                    event("offline", name=case["name"], after_secs=case["offline_secs"])
            if time.monotonic() >= checkpoint:
                event("snapshot", users=sample)
                checkpoint = time.monotonic() + 45
            if all(case["healthy"] or "offline_secs" in case for case in cases):
                break
            time.sleep(1)
        for case in cases:
            if not case["healthy"]:
                assert 540 <= case.get("offline_secs", 0) <= 620, case["name"] + " failed expected disconnect window"
                (lab / (case["name"] + "-drops.txt")).write_text(call("docker", "exec", case["container"], "nft", "list", "table", "inet", "keepalive"))
        (lab / "probe-healthy").touch()
        for case in cases:
            if case["healthy"]:
                result, _ = case["process"].communicate(timeout=15)
                assert case["process"].returncode == 0 and "HEALTHY" in result, case["name"] + ": " + result
        event("passed", offline=[{key: case[key] for key in ("name", "offline_secs")} for case in cases if not case["healthy"]], healthy=[case["name"] for case in cases if case["healthy"]])
    finally:
        for name in owned:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=20, check=False)
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        subprocess.run(["docker", "network", "rm", network], capture_output=True, timeout=20, check=False)
        event("cleanup", containers=owned, network=network)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="role", required=True)
    actions.add_parser("targets")
    peer = actions.add_parser("client")
    peer.add_argument("--protocol", choices=["vless", "anytls"], required=True)
    peer.add_argument("--server", required=True)
    peer.add_argument("--identity", required=True)
    peer.add_argument("--healthy", action="store_true")
    lab = actions.add_parser("run")
    lab.add_argument("--xray", required=True)
    lab.add_argument("--rendered", required=True)
    lab.add_argument("--output", required=True)
    lab.add_argument("--image", default="brocade-manual-mptcp-fixture:20261015")
    args = parser.parse_args()
    {"targets": targets, "client": lambda: client(args), "run": lambda: run(args)}[args.role]()


if __name__ == "__main__":
    main()
