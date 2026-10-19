#!/usr/bin/env python3
"""Manual native TCP relay supervisor; never touches an existing Xray process.

Run start in a separately supervised foreground session. Exiting this controller
does NOT stop its children. Only cleanup --confirm-drained may terminate owned
children, after the operator independently proves every generation is drained.
This deliberately has no legacy-process adoption, firewall or accounting API.
"""

import argparse
import array
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import subprocess
import sys
import time
import uuid


LIMIT = 65536
MAX_GENERATIONS = 32


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    with open(path, "rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def endpoint(value):
    if value.startswith("["):
        host, separator, port = value[1:].partition("]:")
    else:
        host, separator, port = value.rpartition(":")
    require(separator and host and port.isdecimal(), "expected numeric IP:port endpoint")
    address = ipaddress.ip_address(host)
    require(0 < int(port) < 65536, "invalid endpoint port")
    return str(address), int(port)


def address_text(host, port):
    return f"[{host}]:{port}" if ":" in host else f"{host}:{port}"


def private_directory(path, create=False):
    require(path.is_absolute(), "state directory must be absolute")
    if create:
        path.mkdir(mode=0o700, parents=False, exist_ok=True)
    for item in [path, *path.parents]:
        info = item.lstat()
        require(stat.S_ISDIR(info.st_mode), f"not a real directory: {item}")
        require(info.st_uid in (0, os.getuid()), f"unsafe directory owner: {item}")
        require(not info.st_mode & 0o022 or info.st_mode & stat.S_ISVTX, f"unsafe writable ancestor: {item}")
    info = path.stat()
    require(info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700, "state directory must be owned mode 0700")
    require(len(os.fsencode(path / "controller.sock")) < 104, "state path too long for Unix sockets")


def write_json(path, value, replace=False):
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(value, output, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            os.link(temporary, path)
            temporary.unlink()
    finally:
        temporary.unlink(missing_ok=True)


def process_identity(pid):
    raw = Path(f"/proc/{pid}/stat").read_text()
    fields = raw[raw.rfind(")") + 2:].split()
    return {
        "pid": pid,
        "pid_start_ticks": fields[19],
        "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
    }


def relay_config(listen, target):
    host, port = endpoint(listen)
    target_host, target_port = endpoint(target)
    return {
        "log": {"loglevel": "none"},
        "policy": {
            "levels": {"0": {"statsUserUplink": False, "statsUserDownlink": False, "statsUserOnline": False}},
            "system": {name: False for name in (
                "statsInboundUplink", "statsInboundDownlink", "statsOutboundUplink", "statsOutboundDownlink")},
        },
        "inbounds": [{
            "tag": "manual-wan-relay", "listen": host, "port": port,
            "protocol": "dokodemo-door",
            "settings": {"address": target_host, "port": target_port, "network": "tcp"},
            "streamSettings": {"network": "tcp", "sockopt": {"tcpMptcp": False}},
            "sniffing": {"enabled": False},
        }],
        "outbounds": [{"protocol": "freedom", "settings": {}}],
    }


def native_rpc(generation, operation="status"):
    fds = []
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as channel:
            channel.settimeout(4)
            channel.connect(generation["control_path"])
            peer_pid, peer_uid, _ = struct.unpack("3i", channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            require(peer_pid == generation["pid"] and peer_uid == os.getuid(), "native control peer identity mismatch")
            request = {"generation_id": generation["id"], "operation": operation,
                       "epoch": generation["epoch"], "intent": f"wan-relay-intent-{generation['epoch']:016d}"}
            channel.sendall(json.dumps(request).encode())
            data, ancillary, flags, _ = channel.recvmsg(LIMIT, socket.CMSG_SPACE(64))
            for level, kind, body in ancillary:
                require(level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS, "unexpected ancillary control data")
                received = array.array("i")
                received.frombytes(body[:len(body) - len(body) % received.itemsize])
                fds.extend(received)
            require(not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC), "truncated native reply")
            result = json.loads(data)
        require(not result.get("error"), result.get("error", "native request failed"))
        status = result["status"]
        require(status["generation_id"] == generation["id"], "wrong native generation")
        require(status["scope"] == "selected_tcp_listeners" and not status["retirement_supported"], "unexpected native control scope")
        for key in ("pid", "pid_start_ticks", "boot_id"):
            require(status[key] == generation[key], f"native {key} identity mismatch")
        require(operation == "export" or not fds, "unexpected exported descriptors")
        return status, fds
    except BaseException:
        for fd in fds:
            os.close(fd)
        raise


class Supervisor:
    def __init__(self, state, listen, target):
        self.state = state
        self.listen = address_text(*endpoint(listen))
        self.target = address_text(*endpoint(target))
        self.generations = []
        self.processes = {}
        self.active = None
        self.previous = None
        self.stopping = False
        self.initial_error = None

    def event(self, event, **details):
        path = self.state / "events.jsonl"
        if path.exists() and path.stat().st_size > 10 * 1024 * 1024:
            os.replace(path, self.state / "events.previous.jsonl")
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as output:
            output.write(json.dumps({"time_unix_ns": time.time_ns(), "event": event, **details}, sort_keys=True) + "\n")
            output.flush()
            os.fsync(output.fileno())

    def save(self):
        write_json(self.state / "controller.json", {
            "controller": process_identity(os.getpid()), "listen": self.listen, "target": self.target,
            "active": self.active, "previous": self.previous, "generations": self.generations,
            "retirement_supported": False, "accounting": "disabled_in_relay",
        }, replace=True)

    def find(self, identity):
        return next(item for item in self.generations if item["id"] == identity)

    def check(self, generation):
        process = self.processes[generation["id"]]
        require(process.poll() is None, f"owned generation exited: {generation['id']} code={process.returncode}")
        require(process_identity(process.pid) == {key: generation[key] for key in ("pid", "pid_start_ticks", "boot_id")}, "owned process identity changed")
        require(digest(f"/proc/{process.pid}/exe") == generation["sha256"], "running binary SHA256 changed")
        status, fds = native_rpc(generation)
        require(not fds, "status exported a descriptor")
        require(len(status["listeners"]) == 1, "expected exactly one selected listener")
        listener = status["listeners"][0]
        require(listener["address"] == self.listen and listener["protocol"] == 6, "not the expected ordinary TCP listener")
        if generation.get("listener"):
            for key in ("address", "socket_inode", "socket_cookie", "protocol", "socket_config_sha256"):
                require(listener[key] == generation["listener"][key], f"listener {key} changed")
        return status

    def mutate(self, generation, operation):
        status = self.check(generation)
        generation["epoch"] = max(status["epoch"], generation["epoch"]) + 1
        self.save()
        status, fds = native_rpc(generation, operation)
        self.event("native_operation", generation=generation["id"], operation=operation, status=status)
        return status, fds

    def pause(self, generation):
        status, fds = self.mutate(generation, "pause")
        require(not fds and status["paused"] and not status["accepting"], "pause barrier incomplete")
        return status

    def resume(self, generation):
        status, fds = self.mutate(generation, "resume")
        require(not fds and status["ready"] and status["accepting"] and not status["pause_requested"], "resume not confirmed")
        return status

    def spawn(self, binary, expected_sha, inherited=None):
        require(len(self.generations) < MAX_GENERATIONS, "generation limit reached; externally drain before cleanup")
        require(re.fullmatch(r"[0-9a-f]{64}", expected_sha) is not None, "expected lowercase SHA256")
        source = Path(binary)
        require(source.is_absolute(), "binary path must be absolute")
        generation_id = "wan-relay-" + uuid.uuid4().hex
        require(digest(source) == expected_sha, "candidate binary SHA256 mismatch")
        directory = self.state / f"g{len(self.generations):02d}-{uuid.uuid4().hex[:6]}"
        directory.mkdir(mode=0o700)
        executable = directory / "xray"
        source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            require(stat.S_ISREG(os.fstat(source_fd).st_mode), "binary must be a regular file")
            destination = os.open(executable, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700)
            with os.fdopen(destination, "wb") as output, os.fdopen(source_fd, "rb", closefd=False) as input_file:
                while block := input_file.read(1024 * 1024):
                    output.write(block)
                output.flush()
                os.fsync(output.fileno())
        finally:
            os.close(source_fd)
        require(digest(executable) == expected_sha, "candidate binary SHA256 mismatch")
        selected = dict(inherited or {"address": self.listen, "fd": 0, "protocol": 6})
        control = directory / "ctl.sock"
        manifest = directory / "manifest.json"
        config = directory / "config.json"
        write_json(manifest, {"version": 1, "generation_id": generation_id, "control_path": str(control), "listeners": [selected]})
        write_json(config, relay_config(self.listen, self.target))
        # Do not inherit credentials, journal paths or delegation variables from
        # the deployment shell. The old relay target remains the sole meter.
        environment = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "GODEBUG": "multipathtcp=0",
                       "XRAY_TCP_HANDOFF_MANIFEST": str(manifest)}
        process = subprocess.Popen([str(executable), "run", "-c", str(config)],
                                   env=environment, pass_fds=(selected["fd"],) if selected["fd"] else (),
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   start_new_session=True)
        generation = {"id": generation_id, "sha256": expected_sha, "binary": str(executable),
                      "control_path": str(control), "epoch": 0, **process_identity(process.pid)}
        self.generations.append(generation)
        self.processes[generation_id] = process
        self.save()
        self.event("spawned", generation=generation)
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            require(process.poll() is None, f"candidate exited before readiness: code={process.returncode}")
            try:
                status = self.check(generation)
                if status["ready"]:
                    require(status["paused"] and not status["accepting"], "candidate was not initially paused")
                    generation["listener"] = status["listeners"][0]
                    if inherited:
                        for key in ("address", "socket_inode", "socket_cookie", "protocol", "socket_config_sha256"):
                            require(generation["listener"][key] == inherited[key], f"imported {key} differs")
                    self.save()
                    self.event("ready", generation=generation["id"], status=status)
                    return generation
            except (FileNotFoundError, ConnectionRefusedError):
                pass
            time.sleep(0.02)
        raise RuntimeError("candidate readiness timed out; owned process retained")

    def activate_initial(self, binary, expected_sha):
        # Refuse an already occupied endpoint. This is not a kernel admission
        # selector and is never used to join a production SO_REUSEPORT group.
        host, port = endpoint(self.listen)
        with socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM, 6) as probe:
            if ":" in host:
                probe.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            probe.bind((host, port))
        generation = self.spawn(binary, expected_sha)
        self.resume(generation)
        self.active = generation["id"]
        self.save()
        self.event("initial_active", generation=self.active)

    def switch(self, binary, expected_sha, expected_active):
        require(self.active and self.active == expected_active, "active generation changed; refresh status")
        old = self.find(self.active)
        previous_count = len(self.generations)
        descriptors = []
        try:
            self.pause(old)
            status, descriptors = self.mutate(old, "export")
            require(len(descriptors) == 1 and status["paused"], "export did not return one paused listener")
            selected = {key: status["listeners"][0][key] for key in (
                "address", "socket_inode", "socket_cookie", "protocol", "socket_config_sha256")}
            selected["fd"] = descriptors[0]
            successor = self.spawn(binary, expected_sha, selected)
            self.resume(successor)
            self.previous, self.active = old["id"], successor["id"]
            self.save()
            self.event("switch_complete", previous=self.previous, active=self.active)
        except Exception as error:
            self.event("switch_failed", error=str(error))
            # A failed resume response is ambiguous. Prove every new child is
            # stopped/paused before restoring old admission, never assume it.
            for generation in self.generations[previous_count:]:
                if self.processes[generation["id"]].poll() is None:
                    self.pause(generation)
            self.resume(old)
            self.event("switch_restored_old", generation=old["id"])
            raise
        finally:
            for descriptor in descriptors:
                os.close(descriptor)

    def rollback(self, expected_active):
        require(self.active == expected_active and self.previous is not None, "no matching rollback generation")
        current, previous = self.find(self.active), self.find(self.previous)
        self.check(previous)
        self.pause(current)
        try:
            self.resume(previous)
        except Exception:
            self.pause(previous)
            self.resume(current)
            raise
        self.active, self.previous = previous["id"], current["id"]
        self.save()
        self.event("rollback_complete", active=self.active, previous=self.previous)

    def status(self):
        generations = []
        for generation in self.generations:
            item = dict(generation)
            try:
                item["native"] = self.check(generation)
            except Exception as error:
                item["error"] = str(error)
                item["exit_code"] = self.processes[generation["id"]].poll()
            generations.append(item)
        return {"controller": process_identity(os.getpid()), "listen": self.listen, "target": self.target,
                "active": self.active, "previous": self.previous, "generations": generations,
                "retirement_supported": False, "accounting": "disabled_in_relay", "initial_error": self.initial_error}

    def cleanup(self, confirmed):
        require(confirmed is True, "cleanup requires explicit externally-confirmed drain")
        live = [item for item in self.generations if self.processes[item["id"]].poll() is None]
        for generation in live:
            self.pause(generation)
        self.event("cleanup_explicitly_confirmed", generations=[item["id"] for item in live])
        for generation in live:
            # These are this supervisor's unreaped child handles only; no
            # arbitrary PID or legacy process can enter this set.
            self.processes[generation["id"]].terminate()
        for generation in live:
            self.processes[generation["id"]].wait(timeout=8)
        self.stopping = True
        self.active = None
        self.previous = None
        self.save()
        self.event("cleanup_complete")

    def dispatch(self, request):
        operation = request.get("operation")
        if operation == "switch":
            self.switch(request["binary"], request["sha256"], request["expected_active"])
        elif operation == "rollback":
            self.rollback(request["expected_active"])
        elif operation == "cleanup":
            self.cleanup(request.get("confirm_drained"))
        else:
            require(operation == "status", "unsupported controller operation")
        return self.status()

    def serve(self, binary, expected_sha):
        lock_fd = os.open(self.state / "controller.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(not (self.state / "controller.json").exists(), "state already used; do not recreate children or overwrite evidence")
        control = self.state / "controller.sock"
        with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as server:
            server.bind(str(control))
            os.chmod(control, 0o600)
            server.listen(8)
            try:
                try:
                    self.activate_initial(binary, expected_sha)
                except Exception as error:
                    self.initial_error = str(error)
                    self.event("initial_failed", error=str(error))
                    # Keep RPC available so explicit cleanup remains possible.
                self.save()
                while not self.stopping:
                    connection, _ = server.accept()
                    with connection:
                        connection.settimeout(30)
                        try:
                            _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                            require(uid == os.getuid(), "controller requires same-UID peer")
                            data, _, flags, _ = connection.recvmsg(LIMIT)
                            require(data and not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC), "empty or truncated request")
                            response = {"status": self.dispatch(json.loads(data))}
                        except Exception as error:
                            self.event("request_failed", error=str(error))
                            response = {"error": str(error), "status": self.status()}
                        encoded = json.dumps(response).encode()
                        if len(encoded) > LIMIT:
                            encoded = json.dumps({"error": "status exceeds bounded reply size"}).encode()
                        try:
                            connection.sendall(encoded)
                        except (BrokenPipeError, ConnectionResetError, TimeoutError):
                            self.event("response_peer_disconnected")
            finally:
                self.event("controller_exit", owned_children_retained=not self.stopping)
                control.unlink(missing_ok=True)
                os.close(lock_fd)


def controller_rpc(state, request):
    private_directory(state)
    control = state / "controller.sock"
    info = control.lstat()
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o600, "unsafe controller socket")
    with socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET) as channel:
        channel.settimeout(45)
        channel.connect(str(control))
        _, uid, _ = struct.unpack("3i", channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        require(uid == os.getuid(), "controller peer owner differs")
        channel.sendall(json.dumps(request).encode())
        response, _, flags, _ = channel.recvmsg(LIMIT)
        require(not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC), "truncated controller reply")
        return json.loads(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("init", "start", "status", "switch", "rollback", "cleanup"))
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--listen", help="unused numeric IPv6:port, e.g. [::1]:39742")
    parser.add_argument("--target", default="127.0.0.1:40000")
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--sha256")
    parser.add_argument("--expected-active")
    parser.add_argument("--confirm-drained", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    if args.operation in ("start", "init"):
        require(args.listen and args.binary and args.sha256, "start requires --listen, --binary and --sha256")
        private_directory(args.state_dir, create=True)
        Supervisor(args.state_dir, args.listen, args.target).serve(str(args.binary), args.sha256)
        return
    request = {"operation": args.operation}
    if args.operation == "switch":
        require(args.binary and args.sha256, "switch requires --binary and --sha256")
        request.update(binary=str(args.binary), sha256=args.sha256)
    if args.operation in ("switch", "rollback"):
        request["expected_active"] = args.expected_active or controller_rpc(args.state_dir, {"operation": "status"})["status"]["active"]
    if args.operation == "cleanup":
        request["confirm_drained"] = args.confirm_drained
    response = controller_rpc(args.state_dir, request)
    print(json.dumps(response, sort_keys=True))
    if response.get("error"):
        raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({"error": str(error), "note": "owned children are not automatically terminated"}), file=sys.stderr)
        raise SystemExit(1)
