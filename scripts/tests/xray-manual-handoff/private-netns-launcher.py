#!/usr/bin/env python3
"""Launch the local-only fixture in fresh PID/network/mount namespaces."""

import argparse
import hashlib
import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys


SYSTEM_PATH = "/usr/sbin:/usr/bin:/sbin:/bin"


def verify_manifest(directory):
    seen = set()
    for line in (directory / "SHA256SUMS").read_text().splitlines():
        digest, name = line.split("  ", 1)
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts or name in seen:
            raise ValueError("unsafe or duplicate manifest entry")
        seen.add(name)
        path = directory / relative
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"manifest entry is not an ordinary file: {name}")
        with open(path, "rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != digest:
                raise ValueError(f"manifest digest mismatch: {name}")
    required = {"legacy-resident-fixture.py", "private-netns-launcher.py", "gate-helper", "gate.bpf.o"}
    if not required.issubset(seen):
        raise ValueError("runtime manifest is incomplete")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--repeat", type=int, default=1, choices=range(1, 6))
    parser.add_argument("--inside-ancestor-proc-fd", type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    directory = Path(__file__).resolve().parent
    verify_manifest(directory)
    old = Path(args.old).resolve(strict=True)
    candidate = Path(args.candidate).resolve(strict=True)
    output = Path(args.output).absolute()
    if output.exists() or not output.parent.is_dir():
        raise ValueError("output must be a new file in an existing directory")
    for path in (directory, old, candidate, output):
        if path == Path("/run") or Path("/run") in path.parents:
            raise ValueError("inputs and evidence cannot reside under the private /run mount")
    common = ["--old", str(old), "--candidate", str(candidate), "--output", str(output),
              "--repeat", str(args.repeat)]
    if args.inside_ancestor_proc_fd is None:
        ancestor = os.open("/proc", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        child = None
        try:
            command = ["unshare", "--fork", "--pid", "--net", "--mount", "--mount-proc",
                       sys.executable, str(Path(__file__).resolve()), *common,
                       "--inside-ancestor-proc-fd", str(ancestor)]
            child = subprocess.Popen(command, pass_fds=(ancestor,), start_new_session=True,
                                     env={"PATH": SYSTEM_PATH, "PYTHONDONTWRITEBYTECODE": "1"})

            def interrupted(signum, frame):
                del frame
                raise InterruptedError(f"launcher interrupted by signal {signum}")

            signal.signal(signal.SIGTERM, interrupted)
            signal.signal(signal.SIGINT, interrupted)
            return child.wait(timeout=110)
        finally:
            if child is not None and child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
            os.close(ancestor)

    ancestor = args.inside_ancestor_proc_fd
    spec = importlib.util.spec_from_file_location("resident_fixture", directory / "legacy-resident-fixture.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # These checks happen before even mounting /run or enabling loopback. An
    # --inside flag alone is not authority to mutate an existing namespace.
    module.verify_private_namespaces(ancestor, require_private_run=False)
    subprocess.run(["mount", "--make-rprivate", "/"], check=True, timeout=5)
    subprocess.run(["mount", "-t", "tmpfs", "-o", "mode=755,nosuid,nodev,size=16m",
                    "brocade-fixture-run", "/run"], check=True, timeout=5)
    module.verify_private_namespaces(ancestor)
    temporary = Path("/run/brocade-fixture-tmp")
    temporary.mkdir(mode=0o700)
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True, timeout=5)
    os.set_inheritable(ancestor, True)
    os.execve(sys.executable,
              [sys.executable, str(directory / "legacy-resident-fixture.py"), *common,
               "--frozen-mptcp-gate", str(directory / "gate-helper"),
               "--gate-library-path", str(directory / "lib"),
               "--private-netns-ancestor-proc-fd", str(ancestor)],
              {"PATH": SYSTEM_PATH, "TMPDIR": str(temporary), "PYTHONDONTWRITEBYTECODE": "1"})


if __name__ == "__main__":
    sys.exit(main())
