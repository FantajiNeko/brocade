# Manual handoff experiments

The legacy fixtures below are **local experiments, not production deployment
tools**. They do not adopt an existing production PID, update Console/Agent, or
certify fleet readiness. The separately described WAN utilities were also used
for an explicitly authorized, narrowly scoped manual canary; they are not a
general production release mechanism.

`legacy-resident-fixture.py` starts two owned Xray children with different local
origins. The old generation owns TCP and UDP on one loopback endpoint. The new
generation owns TCP only. The old listener and process remain alive throughout
selection and rollback; `RemoveInbound` is never called.

## Assertions

- Exact executable digest, child PID/start identity, socket inode, endpoint,
  protocol, listening state, and `SO_REUSEPORT` are checked before manipulation.
- An old continuous stream stays on origin A. New connections after selection
  reach B; rollback sends new connections back to A without breaking either
  generation's existing streams. Each stream calls `connect` exactly once.
- Every 4,096-byte frame contains an increasing 64-bit sequence and a verified
  origin-specific payload; incremental SHA-256 values are compared independently.
- The fixture briefly stops its owned old child to create a known pending accept
  queue, then proves that historical connection is still accepted by old. This
  is fault injection, **not a production migration step or a latency benchmark**.
- UDP echo continues through old, and every datagram must retain origin A.
- Negative tests reject an unknown PID, changed hash, wrong protocol, mismatched
  group membership, and an unsupported selector index.
- MPTCP additionally verifies `SO_PROTOCOL=262`, `MPTCP_INFO` flags with no TCP
  fallback, nonzero unchanged connection tokens, actual SYN queue/release during
  gating, and rejection of an actual third listener in the reuseport group.
- All children, sockets, temporary directories, and any Docker container are
  owned by this invocation. IO, readiness, child exit, and helper calls are bounded.

## Pure TCP control

Linux, Python 3.11+, and permission to use `pidfd_getfd` on owned children are
required. Do not run Python with `-O` (assertions are test expectations).

```sh
python3 scripts/tests/xray-manual-handoff/legacy-resident-fixture.py \
  --old /absolute/path/to/old-xray \
  --candidate /absolute/path/to/candidate-xray \
  --repeat 3 --output /absolute/new/result.json
```

This explicitly launches both children with `GODEBUG=multipathtcp=0`; successful
TCP results must **not** be extrapolated to MPTCP listeners. A different origin
in candidate's configuration also proves configuration cutover without changing
existing streams. The candidate can be built from an immutable `git archive`
snapshot to avoid concurrent worktree edits.

## Frozen MPTCP gate

The original frozen gate is an optional local dependency in
`target/h6/prototype-sources-v6.tar.gz`, under
`brocade-xray-handoff.jdGoKV/bootstrap-mptcp-v6/frozen-v3/`. Extract it into a
fresh temporary directory, not over an existing experiment. The fixture checks:

- `gate-helper`: `98c75dfc88fd57289fbeee65c60d5fccd64d03e948f7fd5544e8e5587446811a`
- `gate.bpf.o`: `85e7959ad19d670d99ceced53bd50b03774903bf2bbf1390d0fd425f00f53da4`

The archived helper is unchanged. It marks unresolved handshakes using TC,
holds them in NFQUEUE, executes a global RCU synchronization barrier, briefly
adds a compatible plain-TCP control listener to install the reuseport selector,
closes the control listener, then releases the held packets. Established sockets
remain in their original Xray processes. The test invokes the helper's existing
`LAB_GATE_STOP_PHASE=gate` fault-injection point to prove one new MPTCP handshake
actually queues and is released to the selected candidate.

`Dockerfile.mptcp-fixture` combines the existing frozen MPTCP and netlab images
offline to add Python. Build with `docker build --pull=false --network none`.
Run the fixture as PID 1 in a **dedicated `--network none` container**, with only
`lo` present and enabled; it refuses an ordinary host invocation. The frozen
helper requires `NET_ADMIN`, `SYS_ADMIN`, `BPF`, `PERFMON`, and this fixture also
needs `SYS_PTRACE` for its child socket validation. Mount sources, binaries, and
the frozen helper read-only. Use writable private `/run` and `/tmp` tmpfs mounts
and a dedicated output directory. The invocation is:

```sh
ip link set lo up
exec python3 /fixture/legacy-resident-fixture.py \
  --old /old-xray --candidate /candidate-xray \
  --frozen-mptcp-gate /gate/gate-helper \
  --repeat 3 --output /evidence/mptcp-results.json
```

Do not run this shell fragment on the host; it is the command inside the private
container. Do not change the helper's loopback/namespace guards to use it on a
production interface. Its interface, nftables table, queue 442, TC priority/handle
442, and mark bit `0x40000000` are intentionally fixed for an isolated experiment.

### Private namespaces without Docker on the target

`private-netns-launcher.py` supports a separately prepared runtime bundle on a
host with Python 3.11+, `unshare`, `mount`, `ip`, `nft`, BTF and the required kernel
capabilities. It starts `unshare --fork --pid --net --mount --mount-proc` and keeps
an open ancestor `/proc` directory FD. The fixture checks the FD is actual procfs,
reads the multi-level ancestor-visible `NSpid`, requires PID 1 and different
PID/network/mount namespace identities, and permits only loopback. A private
`/run` tmpfs must also differ from the ancestor's runtime directory. These are
kernel-observed properties, not an environment-variable bypass of Docker checks.

The bundle contains the unchanged frozen gate/BPF, the two Python files, a SHA256
manifest, and only missing auxiliary `libnetfilter_queue`/`libnfnetlink` libraries.
It neither replaces system libraries nor installs packages. The helper uses the
system loader's `--library-path` option; Python and the helper's `nft` child keep
their system dependencies. The launcher uses a fixed system PATH including sbin.

The launcher imposes a 110-second owned-process-group deadline. On a remote test
host, run it in a separately named transient systemd service with CPU/memory/task
limits and a 120-second cgroup lifetime. The bundle README documents the exact
command. This mode is still a private-loopback experiment, not public-interface
adoption, safe retirement, or a production release tool.

## Scope of the October 15 experiment

The experiment uses the actual old executable digest
`9f83bcb21a17301e4ea3fdb9cb94dd2f66cc9a62a589f8d445464e528b46e293`
and a separate build of commit `cba5c1dbaf1b24b452f7b600464d54823b9c4c9b`,
candidate digest
`49b0f25a6637022b0b99acaa119a284a6b6ac17a7d09e7cff6231aa847a4bd18`.
Evidence belongs in ignored `target/manual-handoff-20261015/` and records the
fixture hash, kernel, executable hashes, per-stream bytes/hash/token, gate
statistics, and UDP counts.

This validates local IPv4/IPv6 loopback on kernel `7.0.0-38-generic`. It does not
validate the production NIC, public or wildcard binding, a different kernel,
existing firewall/mark policies, throughput, multi-path `MP_JOIN`, or accounting
handoff. It deliberately keeps the old generation resident and its UDP service
running: **it does not complete an upgrade or certify safe old-process exit**.
The older H6 safe-retirement proof is bound to another binary digest/configuration
and must not be applied to this executable.

## Real-network manual canary utilities

- `wan-download.py`: authenticated, bounded loopback origin and a one-connect
  client. Every 64 KiB frame includes an increasing sequence; the client checks
  all bytes, content length, SHA-256, and clean EOF without retries or resume.
- `wan-relay.py`: manually supervised, opt-in ordinary-TCP candidate. Only its
  own children participate in same-FD pause/export/import/resume and rollback.
  It keeps both generations alive and disables relay statistics. A downstream
  legacy forwarding process remains the sole meter. Explicit cleanup requires
  an independently verified drain; exiting the controller is not cleanup.
- `wan-conntrack.py`: bounded, read-only IPv6 CT_GET dump, filtered by exact
  original tuples. It cannot flush or delete entries. An empty dump is not an
  atomic lifetime proof; withdraw admission and also inspect actual sockets.

The October 15 WAN canary used a real public IPv6 forwarding endpoint and a
separate VPS client, not a network namespace. Exact client source ports selected
three ordinary-TCP test flows to a protected candidate port. An existing MPTCP
flow was excluded from selection. A and B shared the same candidate listener FD;
both forwarded through the unchanged legacy process for accounting. This proves
the tested relay upgrade path, **not replacement or retirement of the production
legacy process, full MPTCP bootstrap, or direct multi-generation accounting**.

Four downloads totaling 600 MiB passed with one connect each and no reconnect.
Independently regenerated frame hashes matched. The sole legacy journal advanced
by exactly 603 request bytes and 629,146,311 response bytes (payload plus 711
header bytes); its writer and header remained unchanged. This is not a fresh
Agent/Console/PostgreSQL cross-generation certification.

### Deployment lessons from the real network

1. Verify actual protocol, wildcard/v6-only binding, socket identity, existing
   NOTRACK rules, and accounting owner before choosing a first-adoption method.
   Do not apply the local MPTCP gate to a public interface by removing its guards.
2. Exact-tuple NAT is a narrow test mechanism, not a general MPTCP migration:
   MP_JOIN and path-MTU error handling need separate treatment. This canary's
   ordinary TCP sockets used MSS 1200 because existing ICMPv6 NOTRACK rules were
   intentionally left unchanged. The MPTCP baseline used its normal MSS.
3. Protect the candidate port before startup. Withdraw only new-flow selection
   first; preserve NAT hooks and candidates until sockets and conntrack drain.
   Never flush conntrack or kill a candidate to make cleanup appear successful.
4. Keep a single accounting owner/publisher unless an independently certified
   generation-aware accounting path is enabled. Do not open the same normal
   journal in a second owner or alternate cumulative-counter epochs.
5. Stage and verify artifacts before pausing admission. The simple manual
   controller currently copies/hashes/spawns after pause: server event logs show
   about 1.91 seconds between pause and successor resume. Established downloads
   succeeded, but new connections during that interval were not measured. This
   controller is therefore not ready to back an automatic zero-wait release.
6. Save process/socket evidence and use per-host monotonic durations. The two
   VPS wall clocks differed materially; do not derive handoff delay by subtracting
   timestamps from different hosts. The paced frame gaps are not RTT, maximum
   throughput, or a zero-stall certification.

Evidence is in ignored `target/wawo-manual-canary-20261015/` and
`target/wan-independent-review.json`. The hand-edited runtime target is not a
Console desired-state release. Production integration must separately implement
safe preparation/admission, mutation interlocks, recovery, and retirement.
