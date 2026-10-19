#!/usr/bin/env python3
"""Real-process, loopback-only tests of the manual WAN relay controller."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import select
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


relay = load("relay", "wan-relay.py")
fixture = load("fixture", "native-runtime-fixture.py")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def wait_controller(process, state):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        require(process.poll() is None, "controller exited during startup")
        try:
            result = relay.controller_rpc(state, {"operation": "status"})
            require(not result.get("error"), result.get("error"))
            status = result["status"]
            require(not status.get("initial_error"), status.get("initial_error"))
            if status["active"]:
                return status
        except (FileNotFoundError, ConnectionRefusedError):
            pass
        time.sleep(0.02)
    raise RuntimeError("controller startup timed out")


def run(binary, successor):
    directory = Path(tempfile.mkdtemp(prefix="wan-relay-test-"))
    os.chmod(directory, 0o700)
    state = directory / "state"
    source = fixture.EchoServer(("127.0.0.1", 0), fixture.Echo)
    server_thread = threading.Thread(target=source.serve_forever, daemon=True)
    server_thread.start()
    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM, 6) as reservation:
        reservation.bind(("::1", 0))
        port = reservation.getsockname()[1]
    binary_sha = relay.digest(binary)
    successor_sha = relay.digest(successor)
    process = None
    clients, streams = [], []
    result = None
    try:
        process = subprocess.Popen([
            sys.executable, str(Path(__file__).with_name("wan-relay.py")), "start",
            "--state-dir", str(state), "--listen", f"[::1]:{port}",
            "--target", f"127.0.0.1:{source.server_address[1]}", "--binary", str(binary), "--sha256", binary_sha,
        ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        initial = wait_controller(process, state)
        first = initial["active"]
        client = fixture.connect(("::1", port), socket.AF_INET6, 6)
        clients.append(client)
        streams.append(fixture.ContinuousEcho(client, "old", 1))
        streams[0].wait_progress(10)
        rejected = relay.controller_rpc(state, {"operation": "switch", "expected_active": first,
            "binary": str(binary), "sha256": "0" * 64})
        require(rejected.get("error") and rejected["status"]["active"] == first, "bad SHA not rejected")
        streams[0].wait_progress(streams[0].snapshot()["completed_exchanges"])
        switched = relay.controller_rpc(state, {"operation": "switch", "expected_active": first,
            "binary": str(successor), "sha256": successor_sha})
        require(not switched.get("error"), switched.get("error"))
        second = switched["status"]["active"]
        require(second != first, "successor not activated")
        generations = switched["status"]["generations"]
        for key in ("socket_inode", "socket_cookie", "socket_config_sha256", "protocol"):
            require(generations[0]["listener"][key] == generations[1]["listener"][key], f"changed {key}")
        client = fixture.connect(("::1", port), socket.AF_INET6, 6)
        clients.append(client)
        streams.append(fixture.ContinuousEcho(client, "new", 10000000))
        streams[1].wait_progress(10)
        stale = relay.controller_rpc(state, {"operation": "rollback", "expected_active": first})
        require(stale.get("error") and stale["status"]["active"] == second, "stale mutation accepted")
        refused_cleanup = relay.controller_rpc(state, {"operation": "cleanup", "confirm_drained": False})
        require(refused_cleanup.get("error"), "cleanup without explicit drain accepted")
        rolled_back = relay.controller_rpc(state, {"operation": "rollback", "expected_active": second})
        require(not rolled_back.get("error") and rolled_back["status"]["active"] == first, "rollback failed")
        client = fixture.connect(("::1", port), socket.AF_INET6, 6)
        clients.append(client)
        fixture.exchange(client, 999)
        for stream in streams:
            stream.wait_duration(1)
        stream_results = [stream.finish() for stream in streams]
        for client in clients:
            fixture.exchange(client, 777)
            client.shutdown(socket.SHUT_WR)
            require(client.recv(1) == b"", "half-close not propagated")
            client.close()
        clients.clear()
        config_paths = list(state.glob("g*/config.json"))
        for path in config_paths:
            config = json.loads(path.read_text())
            require("stats" not in config, "relay enabled stats manager")
            require(not any(config["policy"]["system"].values()), "relay enabled system accounting")
            require(not any(config["policy"]["levels"]["0"].values()), "relay enabled user accounting")
        cleaned = relay.controller_rpc(state, {"operation": "cleanup", "confirm_drained": True})
        require(not cleaned.get("error"), cleaned.get("error"))
        require(process.wait(timeout=10) == 0, "controller cleanup failed")
        result = {"status": "passed", "binary_sha256": binary_sha,
                  "successor_sha256": successor_sha,
                  "generations": [{key: generation[key] for key in ("id", "pid", "sha256", "listener")}
                                  for generation in generations],
                  "connections": 3, "reconnect_calls": 0, "continuous_streams": stream_results,
                  "checks": ["same_fd_import", "rollback", "bad_sha_restores_old", "stale_request_rejected",
                             "cleanup_requires_explicit_confirmation", "old_and_new_connections_survive", "half_close", "accounting_disabled"]}
    finally:
        for stream in streams:
            stream.stop_requested.set()
        for client in clients:
            client.close()
        for stream in streams:
            stream.thread.join(timeout=6)
        if process is not None and process.poll() is None:
            # Test-created streams have all closed; invoke the same explicitly
            # confirmed cleanup as a real operator, never signal arbitrary PIDs.
            try:
                cleaned = relay.controller_rpc(state, {"operation": "cleanup", "confirm_drained": True})
                require(not cleaned.get("error"), cleaned.get("error"))
                process.wait(timeout=10)
            except Exception as error:
                print(f"test cleanup failed; retained state {directory}: {error}", file=sys.stderr)
        source.shutdown()
        source.server_close()
        server_thread.join(timeout=2)
        if result is not None:
            shutil.rmtree(directory)
        else:
            print(f"failure evidence retained: {directory}", file=sys.stderr)
            if process is not None and process.poll() is not None:
                print(process.stderr.read().decode(errors="replace"), file=sys.stderr)
    return result


def controller_exit_case(binary):
    """Only this test terminates its controller and drained child via pidfds."""
    directory = Path(tempfile.mkdtemp(prefix="wan-relay-exit-"))
    os.chmod(directory, 0o700)
    state = directory / "state"
    source = fixture.EchoServer(("127.0.0.1", 0), fixture.Echo)
    worker = threading.Thread(target=source.serve_forever, daemon=True)
    worker.start()
    with socket.socket(socket.AF_INET6, socket.SOCK_STREAM, 6) as reservation:
        reservation.bind(("::1", 0))
        port = reservation.getsockname()[1]
    controller = subprocess.Popen([
        sys.executable, str(Path(__file__).with_name("wan-relay.py")), "start", "--state-dir", str(state),
        "--listen", f"[::1]:{port}", "--target", f"127.0.0.1:{source.server_address[1]}",
        "--binary", str(binary), "--sha256", relay.digest(binary),
    ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    pidfd = None
    generation = None
    clients = []
    passed = False
    try:
        status = wait_controller(controller, state)
        generation = status["generations"][0]
        pidfd = os.pidfd_open(generation["pid"])
        require(relay.process_identity(generation["pid"]) == {key: generation[key] for key in ("pid", "pid_start_ticks", "boot_id")}, "test child identity changed")
        client = fixture.connect(("::1", port), socket.AF_INET6, 6)
        clients.append(client)
        fixture.exchange(client, 1)
        controller.send_signal(signal.SIGINT)
        require(controller.wait(timeout=10) == 1, "controller did not exit through interruption handler")
        fixture.exchange(client, 2)
        second = fixture.connect(("::1", port), socket.AF_INET6, 6)
        clients.append(second)
        fixture.exchange(second, 3)
        native, fds = relay.native_rpc(generation)
        require(not fds and native["accepting"], "controller exit stopped candidate admission")
        for client in clients:
            client.shutdown(socket.SHUT_WR)
            require(client.recv(1) == b"", "exit-case half-close failed")
            client.close()
        clients.clear()
        passed = True
        return {"status": "passed", "owned_child_pid": generation["pid"],
                "established_connection_survived": True, "new_admission_survived": True,
                "controller_signal": "SIGINT", "child_cleanup": "explicit_test_cleanup_after_all_test_streams_closed"}
    finally:
        for client in clients:
            client.close()
        if controller.poll() is None:
            cleaned = relay.controller_rpc(state, {"operation": "cleanup", "confirm_drained": True})
            require(not cleaned.get("error"), cleaned.get("error"))
            controller.wait(timeout=10)
        elif pidfd is not None:
            # This explicit fixture cleanup happens only after its owned test
            # streams close. The production controller has no exit-kill path.
            native, fds = relay.native_rpc(generation)
            require(not fds, "unexpected export during fixture cleanup")
            generation["epoch"] = native["epoch"] + 1
            paused, fds = relay.native_rpc(generation, "pause")
            require(not fds and paused["paused"], "test child did not pause before cleanup")
            signal.pidfd_send_signal(pidfd, signal.SIGTERM)
            poller = select.poll()
            poller.register(pidfd, select.POLLIN)
            require(poller.poll(8000), "owned fixture child did not exit after explicit cleanup")
        if pidfd is not None:
            os.close(pidfd)
        source.shutdown()
        source.server_close()
        worker.join(timeout=2)
        if passed:
            shutil.rmtree(directory)
        else:
            print(f"controller-exit evidence retained: {directory}", file=sys.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xray", type=Path, required=True)
    parser.add_argument("--successor", type=Path)
    args = parser.parse_args()
    result = run(args.xray.resolve(), (args.successor or args.xray).resolve())
    result["controller_exit_case"] = controller_exit_case(args.xray.resolve())
    print(json.dumps(result, indent=2))
