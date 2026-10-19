#!/usr/bin/env python3
"""Loopback-only process regression for opt-in native listener admission.

This verifies new-to-new same-FD handoff, not legacy adoption, accounting,
whole-process retirement, or a production deployment. Each stream connects once.
"""

import argparse
import array
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def binary_digest(binary):
    with binary.open("rb") as executable:
        return hashlib.file_digest(executable, "sha256").hexdigest()


def rpc(path, generation, operation="status", epoch=0, reject=False):
    request = {
        "operation": operation,
        "generation_id": generation,
        "epoch": epoch,
        "intent": f"native-fixture-intent-{epoch:08d}",
    }
    received = []
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as channel:
            channel.settimeout(4)
            channel.connect(str(path))
            channel.sendall(json.dumps(request).encode())
            data, ancillary, flags, _ = channel.recvmsg(16384, socket.CMSG_SPACE(128))
            for level, kind, body in ancillary:
                require(level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS, "unexpected ancillary message")
                descriptors = array.array("i")
                descriptors.frombytes(body[:len(body) - len(body) % descriptors.itemsize])
                received.extend(descriptors)
            require(not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC), "truncated control reply")
            response = json.loads(data)
        if reject:
            require(bool(response.get("error")), "unsafe request was accepted")
        else:
            require(not response.get("error"), response.get("error", ""))
            require(response["status"]["retirement_supported"] is False, "unexpected retirement claim")
            require(response["status"]["scope"] == "selected_tcp_listeners", "unexpected control scope")
            require(response["status"]["generation_id"] == generation, "control generation changed")
        if operation != "export" or reject:
            require(not received, "non-export operation unexpectedly transferred descriptors")
        return response, received
    except BaseException:
        for descriptor in received:
            os.close(descriptor)
        raise


class Echo(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(20)
        self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        try:
            while data := self.request.recv(65536):
                self.request.sendall(data)
        except (TimeoutError, ConnectionError):
            pass


class EchoServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def receive_exact(connection, length):
    result = bytearray()
    while len(result) < length:
        data = connection.recv(length - len(result))
        require(data, "established stream ended prematurely")
        result.extend(data)
    return bytes(result)


def exchange(connection, sequence):
    payload = sequence.to_bytes(8, "big") + bytes(range(256)) * 128
    connection.settimeout(5)
    connection.sendall(payload)
    require(receive_exact(connection, len(payload)) == payload, "stream sequence or content mismatch")
    return len(payload)


class ContinuousEcho:
    """One socket, one worker, no reconnect and no intentionally paced gaps.

    Gap measures time between fully verified 32 KiB echo exchanges, starting
    only after the first completed exchange. It excludes pre-activation waiting
    and post-worker manual checks; it is not a pure network-packet latency.
    """

    def __init__(self, connection, name, sequence):
        self.connection = connection
        self.name = name
        self.sequence = sequence
        self.stop_requested = threading.Event()
        self.condition = threading.Condition()
        self.error = None
        self.completed = 0
        self.verified_bytes = 0
        self.first_completion = None
        self.last_completion = None
        self.max_gap = 0.0
        self.thread = threading.Thread(target=self.run, name=name, daemon=True)
        self.thread.start()

    def run(self):
        try:
            while not self.stop_requested.is_set():
                size = exchange(self.connection, self.sequence)
                self.sequence += 1
                now = time.monotonic()
                with self.condition:
                    if self.last_completion is not None:
                        self.max_gap = max(self.max_gap, now - self.last_completion)
                    else:
                        self.first_completion = now
                    self.last_completion = now
                    self.completed += 1
                    self.verified_bytes += size
                    self.condition.notify_all()
        except BaseException as error:
            with self.condition:
                self.error = error
                self.condition.notify_all()

    def snapshot(self):
        with self.condition:
            if self.error is not None:
                raise RuntimeError(f"{self.name} continuous stream failed: {self.error}") from self.error
            return {
                "name": self.name,
                "completed_exchanges": self.completed,
                "verified_payload_bytes": self.verified_bytes,
                "max_completion_gap_ms": round(self.max_gap * 1000, 6),
                "observed_duration_ms": round(((self.last_completion or 0) - (self.first_completion or 0)) * 1000, 6),
                "connect_calls": 1,
                "reconnect_calls": 0,
                "intentional_pacing": False,
                "gap_scope": "between_completed_exchanges_only",
            }

    def wait_progress(self, after, timeout=5):
        deadline = time.monotonic() + timeout
        with self.condition:
            while self.completed <= after and self.error is None:
                remaining = deadline - time.monotonic()
                require(remaining > 0, f"{self.name} continuous stream made no progress")
                self.condition.wait(remaining)
        return self.snapshot()

    def finish(self):
        self.stop_requested.set()
        self.thread.join(timeout=6)
        require(not self.thread.is_alive(), f"{self.name} continuous stream did not stop")
        return self.snapshot()

    def wait_duration(self, minimum_seconds):
        deadline = time.monotonic() + minimum_seconds + 5
        with self.condition:
            while self.error is None:
                if self.first_completion is not None and self.last_completion - self.first_completion >= minimum_seconds:
                    break
                remaining = deadline - time.monotonic()
                require(remaining > 0, f"{self.name} continuous sample duration was not reached")
                self.condition.wait(remaining)
        return self.snapshot()


def mptcp_token(client):
    info = client.getsockopt(284, 1, 80)
    require(len(info) >= 16, "MPTCP_INFO is incomplete")
    flags = int.from_bytes(info[8:12], "little")
    token = int.from_bytes(info[12:16], "little")
    require(flags & 2 and not flags & 1 and token != 0, "MPTCP was not negotiated or fell back to TCP")
    return token


def connect(address, family, protocol):
    client = socket.socket(family, socket.SOCK_STREAM, protocol)
    client.settimeout(5)
    try:
        client.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        client.connect(address)
        require(client.getsockopt(socket.SOL_SOCKET, socket.SO_PROTOCOL) == protocol, "client socket protocol changed")
        if protocol == 262:
            mptcp_token(client)
        return client
    except BaseException:
        client.close()
        raise


def write_private(path, value):
    with path.open("x", encoding="utf-8") as output:
        os.chmod(path, 0o600)
        json.dump(value, output)


def runtime_environment(manifest):
    env = os.environ.copy()
    env.pop("XRAY_BROCADE_ACCOUNTING_FILE", None)
    env["XRAY_TCP_HANDOFF_MANIFEST"] = str(manifest)
    env["GODEBUG"] = "multipathtcp=0"
    return env


def start_runtime(binary, directory, name, host, port, target, protocol, endpoint=None, extra_endpoints=()):
    generation = f"native-runtime-{name}-0001"
    control = directory / f"{name}.sock"
    selected = endpoint or {"address": f"[{host}]:{port}" if ":" in host else f"{host}:{port}", "fd": 0, "protocol": protocol}
    manifest = directory / f"{name}-manifest.json"
    config = directory / f"{name}-config.json"
    write_private(manifest, {"version": 1, "generation_id": generation, "control_path": str(control), "listeners": [selected, *extra_endpoints]})
    write_private(config, {
        "log": {"loglevel": "warning"},
        "inbounds": [{
            "tag": "fwd:180", "listen": host, "port": port,
            "protocol": "dokodemo-door",
            "settings": {"address": host, "port": target, "network": "tcp"},
            "streamSettings": {"network": "tcp", "sockopt": {"tcpMptcp": protocol == 262}},
        }],
        "outbounds": [{"protocol": "freedom", "settings": {}}],
    })
    env = runtime_environment(manifest)
    descriptors = (selected["fd"],) if selected["fd"] else ()
    log = (directory / f"{name}.log").open("xb")
    try:
        process = subprocess.Popen([str(binary), "run", "-c", str(config)], env=env, pass_fds=descriptors, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
    finally:
        log.close()
    return process, control, generation


def wait_ready(process, control, generation, expected_digest):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if process.poll() is not None:
            detail = control.with_suffix(".log").read_text(errors="replace")[-2000:]
            raise RuntimeError(f"fixture Xray exited before readiness: {detail}")
        try:
            response, fds = rpc(control, generation)
            for descriptor in fds:
                os.close(descriptor)
            if response["status"]["ready"]:
                require(response["status"]["paused"], "candidate accepted before explicit activation")
                require(response["status"]["pid"] == process.pid, "control status does not identify its spawned process")
                require(binary_digest(Path(f"/proc/{process.pid}/exe")) == expected_digest, "running Xray executable differs from the frozen binary")
                return response["status"]
        except (FileNotFoundError, ConnectionRefusedError):
            pass
        time.sleep(0.01)
    raise RuntimeError("fixture Xray readiness timed out")


def check_config_only(binary, directory, processes):
    control = directory / "config-only.sock"
    manifest = directory / "config-only-invalid-manifest.json"
    write_private(manifest, {"version": 999, "control_path": str(control), "listeners": "invalid"})
    log_path = directory / "config-only.log"
    with log_path.open("xb") as log:
        process = subprocess.Popen(
            [str(binary), "run", "-test", "-c", str(directory / "first-config.json")],
            env=runtime_environment(manifest), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
        )
    processes.append(process)
    code = process.wait(timeout=10)
    require(code == 0 and "Configuration OK." in log_path.read_text(errors="replace"), "configuration-only mode consumed or validated the handoff manifest")
    require(not control.exists(), "configuration-only mode created a control socket")
    return {"case": "config_only_invalid_manifest", "pid": process.pid, "exit_code": code, "control_created": False}


def check_failed_candidate(runtime, expected_message, stream):
    process, control, _ = runtime
    before = stream.snapshot()["completed_exchanges"]
    code = process.wait(timeout=10)
    detail = control.with_suffix(".log").read_text(errors="replace")
    require(code == 23 and expected_message in detail, f"candidate did not fail at the expected boundary: exit={code}, log={detail[-2000:]}")
    require(not control.exists(), "failed candidate left its control socket behind")
    after = stream.wait_progress(before)
    return {
        "case": control.stem, "pid": process.pid, "exit_code": code, "control_removed": True,
        "old_stream_completed_before_failure": before,
        "old_stream_completed_after_failure": after["completed_exchanges"],
    }


def cleanup_case(clients, processes, streams, source, source_thread):
    failures = []
    for stream in streams:
        stream.stop_requested.set()
    for client in clients:
        try:
            client.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        client.close()
    for stream in streams:
        stream.thread.join(timeout=6)
        if stream.thread.is_alive():
            failures.append(f"continuous stream {stream.name} did not stop during cleanup")
    # Only fixture-owned processes, after their client streams close.
    for process in processes:
        try:
            if process.poll() is None:
                process.terminate()
        except ProcessLookupError:
            pass
        except OSError as error:
            failures.append(f"cannot signal owned fixture process {process.pid}: {error}")
    for process in processes:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            except OSError as error:
                failures.append(f"cannot stop owned fixture process {process.pid}: {error}")
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                failures.append(f"owned fixture process {process.pid} did not exit")
    if source is not None:
        if source_thread is not None and source_thread.ident is not None:
            source.shutdown()
        source.server_close()
    if source_thread is not None and source_thread.ident is not None:
        source_thread.join(timeout=2)
        if source_thread.is_alive():
            failures.append("fixture origin thread did not exit")
    return failures


def run_case(first_binary, first_digest, candidate_binary, candidate_digest, family, protocol):
    host = "127.0.0.1" if family == socket.AF_INET else "::1"
    server_type = type("FamilyEchoServer", (EchoServer,), {"address_family": family})
    source, source_thread = None, None
    clients, processes, inherited, streams = [], [], [], []
    directory = Path(tempfile.mkdtemp(prefix="native-handoff-", dir="/tmp"))
    result, failure = None, None
    try:
        require(binary_digest(first_binary) == first_digest, "first binary changed before fixture case")
        require(binary_digest(candidate_binary) == candidate_digest, "candidate binary changed before fixture case")
        source = server_type((host, 0), Echo)
        source_thread = threading.Thread(target=source.serve_forever, daemon=True)
        source_thread.start()
        with socket.socket(family, socket.SOCK_STREAM) as reservation:
            reservation.bind((host, 0))
            port = reservation.getsockname()[1]
        first = start_runtime(first_binary, directory, "first", host, port, source.server_address[1], protocol)
        processes.append(first[0])
        initial = wait_ready(*first, first_digest)
        identity = {key: initial["listeners"][0][key] for key in ("address", "socket_inode", "socket_cookie", "protocol", "socket_config_sha256")}
        require(identity["protocol"] == protocol, "listener protocol differs from requested protocol")
        client_a = connect((host, port), family, protocol)
        clients.append(client_a)
        token_a = mptcp_token(client_a) if protocol == 262 else None
        client_a.sendall(b"queued-before-ready")
        client_a.settimeout(0.05)
        try:
            client_a.recv(1)
            raise RuntimeError("paused listener returned application data")
        except TimeoutError:
            pass
        rpc(first[1], first[2], "resume", 1)
        client_a.settimeout(5)
        require(receive_exact(client_a, 19) == b"queued-before-ready", "pending data was lost")
        count = exchange(client_a, 1)
        stream_a = ContinuousEcho(client_a, "old-generation", 1000000)
        streams.append(stream_a)
        stream_a.wait_progress(1)
        stream_a.wait_duration(0.25)
        config_only = check_config_only(candidate_binary, directory, processes)
        stream_a.wait_progress(stream_a.snapshot()["completed_exchanges"])
        rpc(first[1], first[2], "export", 2, reject=True)
        rpc(first[1], first[2], "pause", 3)
        response, inherited = rpc(first[1], first[2], "export", 4)
        require(len(inherited) == 1, "export did not transfer exactly one descriptor")
        require(all(response["status"]["listeners"][0][key] == value for key, value in identity.items()), "export changed listener identity")
        selected = {**identity, "fd": inherited[0]}
        wrong_cookie = start_runtime(candidate_binary, directory, "wrong-cookie", host, port, source.server_address[1], protocol, {**selected, "socket_cookie": identity["socket_cookie"] + 1})
        processes.append(wrong_cookie[0])
        negative_cases = [check_failed_candidate(wrong_cookie, "Failed to initialize TCP handoff:", stream_a)]
        missing_endpoint = {"address": f"[{host}]:1" if ":" in host else f"{host}:1", "fd": 0, "protocol": protocol}
        incomplete = start_runtime(candidate_binary, directory, "incomplete-group", host, port, source.server_address[1], protocol, selected, (missing_endpoint,))
        processes.append(incomplete[0])
        negative_cases.append(check_failed_candidate(incomplete, "Failed to prepare TCP handoff:", stream_a))
        before_handoff = stream_a.snapshot()["completed_exchanges"]
        second = start_runtime(candidate_binary, directory, "second", host, port, source.server_address[1], protocol, selected)
        processes.append(second[0])
        for descriptor in inherited:
            os.close(descriptor)
        inherited.clear()
        successor = wait_ready(*second, candidate_digest)
        require(initial["pid"] != successor["pid"], "handoff did not create two distinct process generations")
        require(all(successor["listeners"][0][key] == value for key, value in identity.items()), "successor changed kernel listener identity")
        client_b = connect((host, port), family, protocol)
        clients.append(client_b)
        token_b = mptcp_token(client_b) if protocol == 262 else None
        rpc(second[1], second[2], "resume", 1)
        count += exchange(client_b, 3)
        stream_b = ContinuousEcho(client_b, "new-generation", 2000000)
        streams.append(stream_b)
        stream_b.wait_progress(1)
        stream_a.wait_progress(before_handoff)
        require(rpc(first[1], first[2])[0]["status"]["listeners"][0]["accepted"] == 1, "old generation accepted during handoff")
        require(rpc(second[1], second[2])[0]["status"]["listeners"][0]["accepted"] == 1, "candidate did not accept fresh connection")
        before_rollback = [stream.snapshot()["completed_exchanges"] for stream in streams]
        rpc(second[1], second[2], "pause", 2)
        rpc(second[1], second[2], "resume", 1, reject=True)
        rpc(first[1], first[2], "resume", 5)
        client_c = connect((host, port), family, protocol)
        clients.append(client_c)
        count += exchange(client_c, 7)
        for stream, before in zip(streams, before_rollback):
            stream.wait_progress(before)
            stream.wait_duration(1)
        continuous_results = [stream.finish() for stream in streams]
        count += exchange(client_a, 5) + exchange(client_b, 6)
        if protocol == 262:
            require(mptcp_token(client_a) == token_a and mptcp_token(client_b) == token_b, "MPTCP connection identity changed")
        for connection in clients:
            connection.shutdown(socket.SHUT_WR)
            connection.settimeout(5)
            require(connection.recv(1) == b"", "half-close did not complete cleanly")
        require(binary_digest(first_binary) == first_digest, "first binary changed during fixture case")
        require(binary_digest(candidate_binary) == candidate_digest, "candidate binary changed during fixture case")
        result = {
            "family": "ipv4" if family == socket.AF_INET else "ipv6", "protocol": protocol,
            "connections": len(clients), "connect_calls": len(clients), "reconnect_calls": 0,
            "verified_payload_bytes": count + 19 + sum(stream["verified_payload_bytes"] for stream in continuous_results),
            "same_listener_cookie_and_inode": True, "rollback_preserved_both_generations": True,
            "generation_pids": [initial["pid"], successor["pid"]], "running_binary_sha256_verified": True,
            "config_only": config_only, "failed_candidates": negative_cases,
            "continuous_streams": continuous_results, "scope": "native_selected_listener_only",
            "first_binary_sha256": first_digest, "candidate_binary_sha256": candidate_digest,
            "cross_version": first_digest != candidate_digest,
        }
    except BaseException as error:
        failure = error
    finally:
        for descriptor in inherited:
            try:
                os.close(descriptor)
            except OSError:
                pass
        try:
            cleanup_failures = cleanup_case(clients, processes, streams, source, source_thread)
        except BaseException as cleanup_error:
            cleanup_failures = [f"unexpected cleanup failure: {cleanup_error}"]
        if cleanup_failures and failure is None:
            failure = RuntimeError("; ".join(cleanup_failures))
        # Cleanup completes while logs/control paths still exist. Failure
        # directories are deliberately retained for reproduction and diagnosis.
        if failure is not None:
            write_private(directory / "failure.json", {
                "status": "failed", "error": str(failure), "family": family, "protocol": protocol,
                "first_binary_sha256_before": first_digest,
                "candidate_binary_sha256_before": candidate_digest,
                "owned_pids": [process.pid for process in processes],
                "cleanup_failures": cleanup_failures,
            })
            print(json.dumps({"status": "failed", "evidence_directory": str(directory), "error": str(failure)}), file=sys.stderr)
        else:
            shutil.rmtree(directory)
    if failure is not None:
        raise failure
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xray", type=Path, required=True)
    parser.add_argument("--candidate-xray", type=Path,
                        help="optional distinct successor binary; defaults to --xray")
    parser.add_argument("--output", type=Path,
                        help="write JSON only if the full matrix passes; refuses an existing path")
    arguments = parser.parse_args()
    first_binary = arguments.xray.resolve(strict=True)
    candidate_binary = (arguments.candidate_xray or arguments.xray).resolve(strict=True)
    first_digest_before = binary_digest(first_binary)
    candidate_digest_before = binary_digest(candidate_binary)
    cases = [
        run_case(first_binary, first_digest_before, candidate_binary, candidate_digest_before,
                 family, protocol)
        for family in (socket.AF_INET, socket.AF_INET6)
        for protocol in (6, 262)
    ]
    first_digest_after = binary_digest(first_binary)
    candidate_digest_after = binary_digest(candidate_binary)
    require(first_digest_before == first_digest_after, "first binary changed during the regression matrix")
    require(candidate_digest_before == candidate_digest_after, "candidate binary changed during the regression matrix")
    result = {
        "status": "passed",
        "first_binary_sha256": first_digest_before,
        "first_binary_sha256_after": first_digest_after,
        "candidate_binary_sha256": candidate_digest_before,
        "candidate_binary_sha256_after": candidate_digest_after,
        "cross_version": first_digest_before != candidate_digest_before,
        "cases": cases,
        "production_certification": False,
    }
    if arguments.output:
        write_private(arguments.output, result)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
