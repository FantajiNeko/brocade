#!/usr/bin/env python3
"""Local-only experiment; NOT a deployment tool or a generic PID operator.

Starts only owned Xray processes and loopback sockets. The old process retains
its TCP/UDP listeners; a classic reuseport selector directs new TCP connections.
Requires Linux pidfd_getfd permission for this process's own children.
"""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import stat
import struct
import subprocess
import tempfile
import threading
import time


LIBC = ctypes.CDLL(None, use_errno=True)
FRAME_SIZE = 4096
SO_ATTACH_REUSEPORT_CBPF = 51


class Filter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
                ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint32)]


class Program(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ushort), ("filters", ctypes.POINTER(Filter))]


def checked(result, label):
    if result < 0:
        code = ctypes.get_errno()
        raise OSError(code, f"{label}: {os.strerror(code)}")
    return result


def sha256(path):
    with open(path, "rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def process_start(pid):
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]


class OwnedXray:
    def __init__(self, executable, config, directory, name, mptcp=False):
        self.path = Path(executable).resolve(strict=True)
        self.digest = sha256(self.path)
        config_path = directory / f"{name}.json"
        config_path.write_text(json.dumps(config))
        self.log = open(directory / f"{name}.log", "wb")
        self.process = subprocess.Popen([str(self.path), "run", "-c", str(config_path)],
                                        stdout=self.log, stderr=subprocess.STDOUT,
                                        env={"PATH": os.defpath, "GOMAXPROCS": "2",
                                             "GODEBUG": f"multipathtcp={int(mptcp)}"})
        self.pid = self.process.pid
        self.start = process_start(self.pid)
        self.stopped = False

    def verify(self):
        assert self.pid == self.process.pid, "unknown PID is not owned by this fixture"
        assert self.process.poll() is None, "owned Xray unexpectedly exited"
        assert process_start(self.pid) == self.start, "process identity changed"
        assert sha256(f"/proc/{self.pid}/exe") == self.digest, "executable changed"

    def close(self):
        if self.process.poll() is None:
            if self.stopped:
                self.process.send_signal(signal.SIGCONT)
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        self.log.close()


def listener_inodes(address, port, ipv6):
    packed = socket.inet_pton(socket.AF_INET6 if ipv6 else socket.AF_INET, address)
    encoded = "".join(packed[i:i+4][::-1].hex().upper() for i in range(0, len(packed), 4))
    key = f"{encoded}:{port:04X}"
    rows = Path("/proc/net/tcp6" if ipv6 else "/proc/net/tcp").read_text().splitlines()[1:]
    return {row.split()[9] for row in rows if row.split()[1] == key and row.split()[3] == "0A"}


def duplicate_listener(owner, address, port, ipv6, allowed_inodes=None, protocol=socket.IPPROTO_TCP):
    owner.verify()
    inodes = listener_inodes(address, port, ipv6)
    if allowed_inodes is not None:
        assert inodes == allowed_inodes, "unknown reuseport group member"
    matches = []
    for entry in Path(f"/proc/{owner.pid}/fd").iterdir():
        try:
            link = os.readlink(entry)
        except FileNotFoundError:
            continue
        if link.startswith("socket:[") and link[8:-1] in inodes:
            matches.append((int(entry.name), link[8:-1]))
    assert len(matches) == 1, f"expected exactly one owned TCP listener, got {matches}"
    pidfd = os.pidfd_open(owner.pid)
    try:
        # Linux x86_64 and aarch64 share syscall number 438.
        assert os.uname().machine in ("x86_64", "aarch64"), "unvalidated syscall ABI"
        fd = checked(LIBC.syscall(438, pidfd, matches[0][0], 0), "pidfd_getfd")
    finally:
        os.close(pidfd)
    result = socket.socket(fileno=fd)
    try:
        validate_listener(result, address, port, protocol)
        assert str(os.fstat(fd).st_ino) == matches[0][1]
    except BaseException:
        result.close()
        raise
    return result, matches[0][1]


def validate_listener(listener, address, port, expected_protocol=socket.IPPROTO_TCP):
    assert listener.type == socket.SOCK_STREAM, "not TCP stream"
    protocol = listener.getsockopt(socket.SOL_SOCKET, socket.SO_PROTOCOL)
    assert protocol == expected_protocol, f"unexpected protocol {protocol}"
    assert listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) == 1
    assert listener.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT) == 1
    assert listener.getsockname()[:2] == (address, port)


def rejected(action):
    try:
        action()
    except AssertionError:
        return
    raise AssertionError("invalid identity/protocol/group was not rejected")


def check_guards(owner, address, port, ipv6, udp):
    known_pid, known_digest = owner.pid, owner.digest
    try:
        owner.pid = 1
        rejected(owner.verify)
    finally:
        owner.pid = known_pid
    try:
        owner.digest = "0" * 64
        rejected(owner.verify)
    finally:
        owner.digest = known_digest
    rejected(lambda: validate_listener(udp, address, port))
    rejected(lambda: duplicate_listener(owner, address, port, ipv6, {"0"}))
    rejected(lambda: select_member(udp, 2))
    return ["unknown_pid", "unknown_hash", "wrong_protocol", "unknown_group", "invalid_index"]


def select_member(listener, index):
    assert index in (0, 1), "unvalidated group index"
    instruction = Filter(0x06, 0, 0, index)  # BPF_RET | BPF_K
    program = Program(1, ctypes.pointer(instruction))
    checked(LIBC.setsockopt(listener.fileno(), socket.SOL_SOCKET,
                            SO_ATTACH_REUSEPORT_CBPF, ctypes.byref(program),
                            ctypes.sizeof(program)), "SO_ATTACH_REUSEPORT_CBPF")


class FrozenMptcpGate:
    """Frozen loopback helper only. Deliberately unusable on a production host."""

    def __init__(self, path, ancestor_proc_fd=None, library_path=None):
        assert os.getpid() == 1, "MPTCP fixture must be PID 1 in its dedicated container"
        self.isolation = verify_private_namespaces(ancestor_proc_fd) if ancestor_proc_fd is not None else None
        if ancestor_proc_fd is None:
            assert Path("/.dockerenv").exists(), "dedicated Docker container required"
        assert [name for _, name in socket.if_nameindex()] == ["lo"], "network-none required"
        self.path = Path(path).resolve(strict=True)
        assert sha256(self.path) == "98c75dfc88fd57289fbeee65c60d5fccd64d03e948f7fd5544e8e5587446811a"
        assert sha256(self.path.parent / "gate.bpf.o") == "85e7959ad19d670d99ceced53bd50b03774903bf2bbf1390d0fd425f00f53da4"
        self.command = [str(self.path)]
        if library_path:
            assert os.uname().machine == "x86_64", "bundle loader ABI is x86_64 only"
            libraries = Path(library_path).resolve(strict=True)
            assert libraries.is_dir()
            self.command = ["/lib64/ld-linux-x86-64.so.2", "--library-path", str(libraries), str(self.path)]
        self.results = []

    def select(self, ipv6, port, index, during_gate=None):
        environment = {**os.environ, "BOOTSTRAP_MPTCP_ISOLATED": "1"}
        if during_gate:
            environment["LAB_GATE_STOP_PHASE"] = "gate"
        child = subprocess.Popen([*self.command, "ipv6" if ipv6 else "ipv4", str(port), str(index)],
                                 cwd=self.path.parent, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, env=environment)
        try:
            if during_gate:
                wait_until(lambda: Path(f"/proc/{child.pid}/stat").read_text().rsplit(")", 1)[1].split()[0] == "T")
                during_gate()

                def handshake_queued():
                    rows = Path("/proc/net/netfilter/nfnetlink_queue").read_text().splitlines()
                    return any(row.split()[0] == "442" and int(row.split()[2]) > 0 for row in rows)

                wait_until(handshake_queued, seconds=1)
                child.send_signal(signal.SIGCONT)
            stdout, stderr = child.communicate(timeout=15)
            assert child.returncode == 0, f"gated selector failed: {stdout} {stderr}"
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)
        messages = [json.loads(line) for line in stdout.splitlines() if line.startswith("{")]
        assert len(messages) == 2, stdout
        stats = messages[0]
        assert stats["ok"] and stats["applied"] and stats["unsupported"] == 0, stats
        assert stats["queue_dropped"] == stats["user_dropped"] == 0, stats
        assert stats["queued"] == stats["released"], stats
        if during_gate:
            assert stats["queued"] > 0 and stats["handshake"] > 0, stats
        self.results.append(messages)

    def reject_extra_member(self, address, port, ipv6):
        family = socket.AF_INET6 if ipv6 else socket.AF_INET
        invalid = subprocess.run([*self.command, "ipv6" if ipv6 else "ipv4", str(port), "2"],
                                 cwd=self.path.parent, capture_output=True, text=True, timeout=15,
                                 env={**os.environ, "BOOTSTRAP_MPTCP_ISOLATED": "1"})
        assert invalid.returncode == 2 and not invalid.stdout, "invalid selector was accepted"
        with socket.socket(family, socket.SOCK_STREAM, 262) as extra:
            extra.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            if ipv6:
                extra.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            extra.bind((address, port))
            extra.listen(1)
            assert len(listener_inodes(address, port, ipv6)) == 3
            invalid = subprocess.run([*self.command, "ipv6" if ipv6 else "ipv4", str(port), "1"],
                                     cwd=self.path.parent, capture_output=True, text=True, timeout=15,
                                     env={**os.environ, "BOOTSTRAP_MPTCP_ISOLATED": "1"})
            assert invalid.returncode == 1, "unexpected third group member was accepted"
            stats = json.loads(invalid.stdout.splitlines()[0])
            assert not stats["ok"] and not stats["applied"] and stats["queued"] == 0, stats
        assert len(listener_inodes(address, port, ipv6)) == 2


def verify_private_namespaces(ancestor_proc_fd, require_private_run=True):
    """Validate a retained ancestor procfs, not a user-supplied namespace string."""
    assert os.getpid() == 1, "fixture must be PID 1 in a fresh PID namespace"
    assert ancestor_proc_fd >= 3, "ancestor procfs must be an inherited directory FD"
    assert stat.S_ISDIR(os.fstat(ancestor_proc_fd).st_mode)
    fs = ctypes.create_string_buffer(256)
    checked(LIBC.fstatfs(ancestor_proc_fd, ctypes.byref(fs)), "ancestor procfs fstatfs")
    assert ctypes.cast(fs, ctypes.POINTER(ctypes.c_long))[0] == 0x9FA0, "FD is not real procfs"
    ancestor = Path(f"/proc/self/fd/{ancestor_proc_fd}")
    status = (ancestor / "self/status").read_text()
    nspid = [int(value) for line in status.splitlines() if line.startswith("NSpid:")
             for value in line.split()[1:]]
    assert len(nspid) >= 2 and nspid[-1] == 1, "ancestor procfs must prove nested NSpid"
    local_status = Path("/proc/self/status").read_text()
    local_nspid = [int(value) for line in local_status.splitlines() if line.startswith("NSpid:")
                   for value in line.split()[1:]]
    assert local_nspid == [1], "/proc must be mounted for this private PID namespace"
    namespaces = {}
    for name in ("pid", "net", "mnt"):
        current = os.readlink(f"/proc/self/ns/{name}")
        previous = os.readlink(ancestor / f"1/ns/{name}")
        assert current != previous, f"{name} namespace is not private"
        namespaces[name] = {"current": current, "ancestor": previous}
    if require_private_run:
        current_run = os.stat("/run")
        previous_run = os.stat(ancestor / "1/root/run")
        assert (current_run.st_dev, current_run.st_ino) != (previous_run.st_dev, previous_run.st_ino), \
            "/run must be a private tmpfs, not the ancestor runtime directory"
        mounts = Path("/proc/self/mountinfo").read_text().splitlines()
        assert any(row.split()[4] == "/run" and row.split(" - ", 1)[1].split()[0] == "tmpfs" for row in mounts)
    assert [name for _, name in socket.if_nameindex()] == ["lo"], "private network must contain only lo"
    return {"ancestor_nspid": nspid, "local_nspid": local_nspid,
            "namespaces": namespaces, "private_run": require_private_run}


class Origin:
    def __init__(self, address, family, marker):
        self.marker = marker
        self.stop = threading.Event()
        self.sockets = []
        self.threads = []
        self.listener = socket.socket(family, socket.SOCK_STREAM)
        self.listener.bind((address, 0))
        self.listener.listen(32)
        self.listener.settimeout(0.2)
        self.port = self.listener.getsockname()[1]
        self.udp = socket.socket(family, socket.SOCK_DGRAM)
        self.udp.bind((address, self.port))
        self.udp.settimeout(0.2)
        self.start(self.accept)
        self.start(self.echo)

    def start(self, target, *args):
        thread = threading.Thread(target=target, args=args, daemon=True)
        self.threads.append(thread)
        thread.start()

    def accept(self):
        while not self.stop.is_set():
            try:
                conn, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            self.sockets.append(conn)
            self.start(self.serve, conn)

    def serve(self, conn):
        try:
            conn.settimeout(3)
            assert conn.recv(1) == b"S"
            sequence = 0
            payload = bytes([self.marker]) * (FRAME_SIZE - 8)
            while not self.stop.is_set():
                conn.sendall(struct.pack("!Q", sequence) + payload)
                sequence += 1
                self.stop.wait(0.005)
        except (OSError, AssertionError):
            pass
        finally:
            conn.close()

    def echo(self):
        while not self.stop.is_set():
            try:
                message, peer = self.udp.recvfrom(1024)
                self.udp.sendto(bytes([self.marker]) + message, peer)
            except socket.timeout:
                continue
            except OSError:
                break

    def close(self):
        self.stop.set()
        self.listener.close()
        self.udp.close()
        for conn in self.sockets:
            conn.close()
        for thread in self.threads:
            thread.join(timeout=3)


class Download:
    def __init__(self, address, port, family, marker, mptcp=False):
        self.sock = socket.socket(family, socket.SOCK_STREAM, 262 if mptcp else socket.IPPROTO_TCP)
        self.sock.settimeout(3)
        self.sock.connect((address, port))
        self.sock.sendall(b"S")
        self.marker = marker
        self.frames = 0
        self.digest = hashlib.sha256()
        self.expected_digest = hashlib.sha256()
        self.error = None
        self.maximum_gap_seconds = 0
        self.mptcp = mptcp
        self.mptcp_flags = None
        self.token = self.mptcp_token() if mptcp else None
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.read, daemon=True)
        self.thread.start()

    def read(self):
        try:
            last_frame = time.monotonic()
            while not self.stop.is_set():
                data = bytearray()
                while len(data) < FRAME_SIZE:
                    part = self.sock.recv(FRAME_SIZE - len(data))
                    if not part:
                        raise AssertionError("download EOF before explicit client close")
                    data.extend(part)
                expected = struct.pack("!Q", self.frames) + bytes([self.marker]) * (FRAME_SIZE - 8)
                assert data == expected, f"sequence/origin/data mismatch at frame {self.frames}"
                self.digest.update(data)
                self.expected_digest.update(expected)
                self.frames += 1
                now = time.monotonic()
                self.maximum_gap_seconds = max(self.maximum_gap_seconds, now - last_frame)
                last_frame = now
        except BaseException as error:
            if not self.stop.is_set():
                self.error = repr(error)

    def healthy(self, minimum=1):
        assert self.error is None, self.error
        assert self.frames >= minimum, f"insufficient progress: {self.frames}"
        if self.mptcp:
            assert self.mptcp_token() == self.token, "original MPTCP connection token changed"

    def mptcp_token(self):
        assert self.sock.getsockopt(socket.SOL_SOCKET, socket.SO_PROTOCOL) == 262
        data = self.sock.getsockopt(284, 1, 256)
        flags, token = struct.unpack_from("=II", data, 8)
        assert flags & 2 and not flags & 1 and token != 0, f"MPTCP fallback flags={flags} token={token}"
        self.mptcp_flags = flags
        return token

    def close(self):
        failure = None
        try:
            self.healthy()
        except BaseException as error:
            failure = error
        self.stop.set()
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()
        self.thread.join(timeout=4)
        assert not self.thread.is_alive()
        if failure:
            raise failure
        assert self.error is None, self.error
        assert self.digest.digest() == self.expected_digest.digest()
        return {"frames": self.frames, "bytes": self.frames * FRAME_SIZE,
                "sha256": self.digest.hexdigest(), "connections": 1,
                "marker": self.marker, "error": self.error,
                "mptcp_token": self.token,
                "mptcp_flags": self.mptcp_flags,
                "maximum_gap_seconds": self.maximum_gap_seconds}


def wait_until(predicate, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise TimeoutError("bounded fixture readiness timeout")


def configuration(address, port, origin_port, udp):
    return {"log": {"loglevel": "warning"}, "inbounds": [
        {"listen": address, "port": port, "protocol": "dokodemo-door",
         "tag": "fixture-forward", "settings": {"address": address,
          "port": origin_port, "network": "tcp,udp" if udp else "tcp"}}],
        "outbounds": [{"protocol": "freedom", "tag": "direct"}]}


def run_case(old_binary, candidate_binary, ipv6, gate=None):
    address = "::1" if ipv6 else "127.0.0.1"
    family = socket.AF_INET6 if ipv6 else socket.AF_INET
    protocol = 262 if gate else socket.IPPROTO_TCP
    processes, origins, downloads, duplicate_sockets = [], [], [], []
    udp_stop, udp_errors, udp_count = threading.Event(), [], [0]
    udp_thread = None
    with tempfile.TemporaryDirectory(prefix="brocade-legacy-resident-") as temporary:
        directory = Path(temporary)
        try:
            old_origin = Origin(address, family, 65)
            new_origin = Origin(address, family, 66)
            origins.extend((old_origin, new_origin))
            reservation = socket.socket(family, socket.SOCK_STREAM)
            reservation.bind((address, 0))
            port = reservation.getsockname()[1]
            reservation.close()
            old = OwnedXray(old_binary, configuration(address, port, old_origin.port, True), directory, "old", bool(gate))
            processes.append(old)
            wait_until(lambda: len(listener_inodes(address, port, ipv6)) == 1)
            old_fd, old_inode = duplicate_listener(old, address, port, ipv6, protocol=protocol)
            duplicate_sockets.append(old_fd)
            guards = check_guards(old, address, port, ipv6, old_origin.udp)
            # Pin the old group before a second bind; prevents a random early cutover.
            def select(index):
                if gate:
                    gate.select(ipv6, port, index)
                else:
                    select_member(old_fd, index)

            select(0)
            before = Download(address, port, family, 65, bool(gate))
            downloads.append(before)
            wait_until(lambda: before.frames > 20)

            def udp_probe():
                with socket.socket(family, socket.SOCK_DGRAM) as udp:
                    udp.settimeout(2)
                    while not udp_stop.is_set():
                        payload = struct.pack("!Q", udp_count[0])
                        try:
                            udp.sendto(payload, (address, port))
                            answer, _ = udp.recvfrom(1024)
                            assert answer == b"A" + payload, "UDP changed owner or data"
                            udp_count[0] += 1
                        except BaseException as error:
                            udp_errors.append(repr(error))
                            break
                        udp_stop.wait(0.02)

            udp_thread = threading.Thread(target=udp_probe, daemon=True)
            udp_thread.start()
            wait_until(lambda: udp_count[0] > 5)
            candidate = OwnedXray(candidate_binary, configuration(address, port, new_origin.port, False), directory, "candidate", bool(gate))
            processes.append(candidate)
            wait_until(lambda: len(listener_inodes(address, port, ipv6)) == 2)
            candidate_fd, candidate_inode = duplicate_listener(candidate, address, port, ipv6, protocol=protocol)
            duplicate_sockets.append(candidate_fd)
            assert candidate_inode != old_inode
            expected_group = {old_inode, candidate_inode}
            assert listener_inodes(address, port, ipv6) == expected_group
            if gate:
                rejected(lambda: validate_listener(old_fd, address, port))
                gate.reject_extra_member(address, port, ipv6)
                guards.extend(("mptcp_as_plain_tcp", "helper_invalid_selector", "actual_third_member"))

            # Queue a TCP connection on old while its accept loop is paused. This
            # is fixture-only SIGSTOP, never part of the proposed production path.
            old.process.send_signal(signal.SIGSTOP)
            old.stopped = True
            wait_until(lambda: Path(f"/proc/{old.pid}/stat").read_text().rsplit(")", 1)[1].split()[0] == "T")
            pending = Download(address, port, family, 65, bool(gate))
            downloads.append(pending)
            time.sleep(0.1)
            assert pending.frames == 0
            old.verify()
            candidate.verify()
            assert listener_inodes(address, port, ipv6) == expected_group
            queued_results, queued_errors = [], []
            queued_thread = None
            if gate:
                def queued_connect():
                    try:
                        queued_results.append(Download(address, port, family, 66, True))
                    except BaseException as error:
                        queued_errors.append(repr(error))

                queued_thread = threading.Thread(target=queued_connect, daemon=True)
                gate.select(ipv6, port, 1, queued_thread.start)
            else:
                select(1)
            old.process.send_signal(signal.SIGCONT)
            old.stopped = False
            if queued_thread:
                queued_thread.join(timeout=4)
                assert not queued_thread.is_alive()
                assert not queued_errors, queued_errors
                assert len(queued_results) == 1
                downloads.extend(queued_results)
                wait_until(lambda: queued_results[0].frames > 10)
            wait_until(lambda: pending.frames > 10)
            after = Download(address, port, family, 66, bool(gate))
            downloads.append(after)
            wait_until(lambda: after.frames > 50)
            checkpoints = [download.frames for download in downloads]
            time.sleep(0.5)
            for download, checkpoint in zip(downloads, checkpoints):
                download.healthy(checkpoint + 20)
            old.verify()
            candidate.verify()
            assert listener_inodes(address, port, ipv6) == expected_group
            select(0)
            rolled_back = Download(address, port, family, 65, bool(gate))
            downloads.append(rolled_back)
            wait_until(lambda: rolled_back.frames > 50)
            checkpoints = [download.frames for download in downloads]
            time.sleep(0.5)
            for download, checkpoint in zip(downloads, checkpoints):
                download.healthy(checkpoint + 20)
            udp_stop.set()
            udp_thread.join(timeout=3)
            assert not udp_thread.is_alive()
            assert not udp_errors, udp_errors
            assert udp_count[0] > 20
            old.verify()
            candidate.verify()
            results = [download.close() for download in downloads]
            downloads.clear()
            return {"family": "IPv6" if ipv6 else "IPv4", "transport": "MPTCP" if gate else "TCP", "old_sha256": old.digest,
                    "kernel": os.uname().release, "fixture_sha256": sha256(__file__),
                    "candidate_sha256": candidate.digest, "cross_version": old.digest != candidate.digest,
                    "tcp_port": port, "old_pid": old.pid, "candidate_pid": candidate.pid,
                    "downloads": results, "udp_echoes": udp_count[0], "udp_errors": udp_errors,
                    "negative_guards_passed": guards,
                    "gated_selector_results": gate.results if gate else None,
                    "private_namespace_proof": gate.isolation if gate else None,
                    "fixture_paused_old_for_pending_queue": True,
                    "pending_accept_survived": True, "rollback_preserved_both_generations": True}
        except BaseException:
            for path in directory.glob("*.log"):
                print(path.name, path.read_text(errors="replace")[-4000:], flush=True)
            raise
        finally:
            udp_stop.set()
            if udp_thread:
                udp_thread.join(timeout=3)
            for download in downloads:
                try:
                    download.close()
                except BaseException:
                    pass
            for process in processes:
                process.close()
            for duplicate in duplicate_sockets:
                duplicate.close()
            for origin in origins:
                origin.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--family", choices=("ipv4", "ipv6", "both"), default="both")
    parser.add_argument("--frozen-mptcp-gate", help="exact frozen helper in dedicated network-none container only")
    parser.add_argument("--private-netns-ancestor-proc-fd", type=int,
                        help="retained ancestor /proc directory FD; requires verified nested PID/net/mount namespaces")
    parser.add_argument("--gate-library-path", help="optional x86_64 helper-only dynamic library directory")
    parser.add_argument("--output", help="write JSON only if all selected cases pass; refuses existing path")
    parser.add_argument("--repeat", type=int, default=1)
    args = parser.parse_args()
    assert os.uname().sysname == "Linux"
    assert 1 <= args.repeat <= 5, "repeat must be between 1 and 5"
    if args.private_netns_ancestor_proc_fd is not None or args.gate_library_path:
        assert args.frozen_mptcp_gate, "namespace/library options require the frozen MPTCP gate"
    results = []
    for iteration in range(args.repeat):
        for ipv6 in ([False, True] if args.family == "both" else [args.family == "ipv6"]):
            gate = FrozenMptcpGate(args.frozen_mptcp_gate, args.private_netns_ancestor_proc_fd,
                                  args.gate_library_path) if args.frozen_mptcp_gate else None
            result = run_case(args.old, args.candidate, ipv6, gate)
            result["iteration"] = iteration + 1
            results.append(result)
            print(json.dumps(result, sort_keys=True), flush=True)
    if args.output:
        with open(args.output, "x") as output:
            json.dump(results, output, indent=2)
            output.write("\n")
