# Opt-in listener admission handoff

This Linux-only interface has two deliberately different contracts. Manifest v1
controls selected TCP/MPTCP listeners and can never certify process retirement.
Manifest v2 registers the complete inbound generation, including TCP/MPTCP,
ordinary UDP, Hysteria2/QUIC and private REALITY cover listeners. It preserves
accepted TCP connections while treating UDP as reconnect-only: UDP sessions are
not migrated or drained. Accounting ownership, configuration reconciliation and
signalling the old PID remain the Agent's responsibility. The normal startup path is unchanged unless
`XRAY_TCP_HANDOFF_MANIFEST` is set.

The environment variable points to an absolute, private JSON manifest. The file
must be an owned, singly linked regular file with mode `0600`; its immediate
parent and the control socket's parent must be owned directories with mode `0700`.
Symlink path components and unsafe writable ancestors are rejected. Use a fresh
generation ID and control path; an existing control path is never overwritten.

```json
{
  "version": 1,
  "generation_id": "example-generation-0001",
  "control_path": "/private/runtime/generation-0001.sock",
  "listeners": [
    {
      "address": "[::1]:18080",
      "fd": 3,
      "socket_inode": 123456,
      "socket_cookie": 789012,
      "socket_config_sha256": "replace-with-the-exported-64-character-socket-configuration-digest",
      "protocol": 262
    }
  ]
}
```

A complete generation uses v2. TCP/MPTCP listeners are inherited through
`SCM_RIGHTS`. UDP is never shared as one FD between processes: each generation
binds the same public `address` with `SO_REUSEPORT`. The Agent resumes and verifies
the candidate before closing the old generation's UDP sockets. Existing UDP and
QUIC sessions may be interrupted and must reconnect; there is deliberately no
conntrack/NAT handoff contract.

```json
{
  "version": 2,
  "scope": "whole-generation",
  "generation_id": "example-generation-0002",
  "control_path": "/private/runtime/generation-0002.sock",
  "listeners": [
    {
      "network": "tcp",
      "role": "public",
      "address": "[::]:8448",
      "bind_address": "[::]:8448",
      "fd": 3,
      "socket_inode": 123456,
      "socket_cookie": 789012,
      "socket_config_sha256": "replace-with-the-exported-64-character-socket-configuration-digest",
      "protocol": 6
    },
    {
      "network": "udp",
      "role": "public",
      "address": "[::]:8449",
      "bind_address": "[::]:8449",
      "fd": 0,
      "socket_inode": 0,
      "socket_cookie": 0,
      "protocol": 17
    },
    {
      "network": "tcp",
      "role": "cover",
      "address": "127.0.0.1:61101",
      "bind_address": "127.0.0.1:61101",
      "depends_on": "",
      "fd": 0,
      "socket_inode": 0,
      "socket_cookie": 0,
      "protocol": 6
    }
  ]
}
```

All inbounds must appear in v2. Encountering an unregistered supported listener
sets an `unsupported_reasons` entry and keeps `retirement_supported` false. The
manager must likewise reject configurations containing an inbound transport it
cannot route and account for; the marker is not a substitute for that check.

One loopback TCP API endpoint uses `role: "control"` and `prepare: true`. It is
the Agent-only Xray API used to restore dynamic inbounds and grants after
`Core.Start` but before public admission. During this bounded preparation phase
all other listeners remain paused. The Agent must issue a fenced `seal` after
every manifest listener is registered; `resume` is rejected until sealing
succeeds. Direct `api.listen` and `metrics.listen` servers also register through
the handoff controller instead of independently binding sockets outside the
manifest. A loopback metrics endpoint uses `role: "control"` without `prepare`;
it opens only after admission and never contributes to business drain counts.
Even a fully static v2 process stays in preparation until the manager explicitly
seals it, so grants can be restored before public admission.

The example identity values and digest placeholder must be replaced with the
actual exported metadata. Protocol `6` is TCP and `262` is MPTCP. Do not infer the protocol
from `/proc/net/tcp*` or an omitted `tcpMptcp` setting: Go's default listener can
be MPTCP. An explicit `tcpMptcp: true` requires MPTCP. Import never silently binds
a new socket or falls back to a different protocol.

An inherited TCP descriptor must be at least `3`, nonblocking, listening, and match
the address, inode, cookie and protocol. The runtime consumes that descriptor
after duplicating it into a Go listener. It preserves kernel socket options;
this interface must not be used to change listener options. The inherited
manifest's deterministic socket-configuration digest must match the candidate's
effective `SocketConfig`; changes fail before import. The manager builds the
expected set from the candidate configuration, not by copying the entire old
manifest: matching TCP endpoints with unchanged socket settings inherit verified
FDs; changed socket settings create a new socket rather than disabling the import
digest check. New endpoints bind with
`fd: 0`, and removed endpoints remain only in the draining generation. API,
routing, policy and inbound JSON equality is not an inheritance requirement. PROXY
protocol, TCP masks and transport header wrapping are not supported for selected
listeners. Accepted connections retain their concrete TCP type, including raw
splice and half-close support.

For a newly bound listener, use `fd: 0` and omit inode/cookie/digest. TCP may use
protocol `0` during managed bootstrap or when adding a new endpoint so the runtime records whether
Go and the kernel selected TCP or MPTCP; UDP remains explicitly `17`. This is only
for a new endpoint in the candidate generation; it is **not** an
adoption mechanism for an already-running legacy process. A separately bound UDP
`SO_REUSEPORT` socket immediately joins kernel packet selection even while its
user-space admission gate is paused. The candidate startup window can therefore
queue or lose UDP datagrams; this interface promises continuity only for TCP.

## Control protocol

The control socket is Unix `SOCK_SEQPACKET` (`unixpacket` in Go), mode `0600`.
Only same-UID peers are accepted. Each connection carries one bounded JSON
request and response. A selected listener starts paused; startup readiness does
not enable admission.

```json
{
  "operation": "resume",
  "generation_id": "example-generation-0001",
  "epoch": 1,
  "intent": "example-activation-0001"
}
```

- `status` observes the selected group without mutation.
- `seal` certifies that `Core.Start` completed and every static and dynamic
  listener in the v2 manifest registered successfully. It never opens public
  admission.
- `pause` stops future accepts and waits for outstanding Accept calls to return.
  Already accepted connections, including handshakes, continue in their process.
- `resume` permits accepts only after the whole selected group is ready.
- `export` requires the complete group to be ready and paused, with no pending
  Accept call. Its response includes only TCP/MPTCP `SCM_RIGHTS` descriptors in
  sorted TCP listener-address order; UDP entries never export a descriptor.
- `drop_udp` exists only for v2 and requires the generation to be ready and
  paused. It closes every UDP/QUIC listener in that generation and sets
  `udp_dropped: true`; it does not wait for UDP session lifetimes.
- `drop_tcp` requires `config-listener-handoff-v1` and a ready, paused v2
  generation. After candidate admission it closes the old public/control
  listening descriptors, but preserves accepted TCP sockets and cover admission.
  Closed admission sockets retain their active counts and retirement proof;
  this irreversible generation cannot resume or export again. Duplicate FDs in
  manager/logging processes must not keep removed ports bound. The Agent must
  inherit listener FDs only into Xray, not into a shell waiter or log sink.
- `drain` exists only for v2. Public TCP admission must already be paused. If the
  manifest contains UDP, `drop_udp` must have completed first. `drain` rejects
  while public TCP connections remain, then pauses private cover admission.
  `retire_ready` becomes true only after cover work also reaches zero.

Every mutation/export requires a positive monotonic epoch and a 16–128-character
ASCII alphanumeric/underscore/hyphen intent. Repeating the same epoch, operation
and intent is idempotent; stale or conflicting intents fail. An error does not
authorize a caller to guess the current state: query status and reconcile.

The response reports generation, PID, boot ID, process start ticks, readiness,
pause state, fencing intent and per-listener kernel identities/configuration
digests. `pause_requested` means the gate was requested to stop; `paused` also
requires every outstanding Accept call to finish. A timeout with
`pause_requested: true` must not be treated as a completed pause barrier.
Manifest v1 explicitly reports `scope: "selected_tcp_listeners"` and
`retirement_supported: false`. A complete v2 runtime reports
`scope: "whole-generation"` and `retirement_supported: true`; this means the
runtime implements the contract, not that it is already safe to kill. Only
`retire_ready: true` is the connection-lifecycle retirement proof for that exact
PID, boot ID, process start time, generation ID and fencing intent.
`accepted` is a cumulative acceptance count, **not** a live-connection count.
For a manifest containing UDP, that proof additionally requires
`udp_dropped: true`; it proves that the old UDP sockets are gone, not that their
sessions survived.

Managers must close their temporary exported descriptor copies when no longer
needed: a retained duplicate can keep a listener alive after its process exits.
Closing the private control interface does not drain or terminate accepted
connections. Never use a quiet interval, paused state or successful export as a
reason to kill the old process.

Each listener reports both `accepted` (a cumulative admission count) and `active`.
For TCP this ends after proxyman and nested AnyTLS delivery/downlink work finish;
for ordinary UDP it is the worker session lifetime; for Hysteria2 it includes the
accepted QUIC connection and its datagram workers. Before `drop_udp`, v2 reports
these values in aggregate `public_active`, `cover_active` and `active`. Once UDP
is deliberately dropped, its old session counters no longer block TCP retirement.
None of these transfers accounting ownership by itself.

The preparation listener with role `control` is deliberately excluded from
`accepting`, `accepted`, `active`, `public_active` and `cover_active`. Its API
traffic is management traffic, not a business connection: a status request must
never make an unsealed candidate look publicly accepting, and an open control
request must never delay or certify business retirement.

`run -test` and `run -dump` remain configuration-only commands and do not consume
the handoff manifest or create its control socket. They are not listener-import
validation. A real candidate startup plus explicit readiness/control checks is
required. See `scripts/tests/xray-manual-handoff/` at the repository root for the
loopback-only process fixtures and their narrower certification boundaries.
