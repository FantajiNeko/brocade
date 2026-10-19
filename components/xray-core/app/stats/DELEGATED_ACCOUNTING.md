# Experimental owner-resident delegated accounting

This capability is disabled unless `XRAY_BROCADE_ACCOUNTING_DELEGATE` names an
absolute, private JSON manifest. It is incompatible with
`XRAY_BROCADE_ACCOUNTING_FILE` in the same process. It is **not production-ready
handoff orchestration**, and the manual forwarding canary does not enable it.

The manifest has exactly these fields:

- `schema_version`: `1`.
- `journal_fd`: inherited read/write journal descriptor, at least `3`.
- `owner_pidfd`: inherited pidfd for the still-running owner, at least `3`.
- `owner_pid`, `owner_start_ticks`: the pinned owner's process identity.
- `owner_boot_id`: the journal's 16-byte boot identity as 32 lowercase hex digits,
  with no hyphens.
- `owner_executable_sha256`: 64 lowercase hex digits identifying its executable.
- `device`, `inode`: the existing journal's `fstat` identity.
- `epoch`: the existing journal's 16-byte epoch as 32 lowercase hex digits.
- `record_count`: the existing header's published record count.
- `tag`: a single canonical positive forwarding identity, for example `fwd:18`.

The supplied journal descriptor must share the owner's already-locked open file
description, for example through `pidfd_getfd` followed by descriptor inheritance.
Reopening the same path or inode does not qualify. No new file, label, header,
epoch, writer identity, or report stream is created. Only the two already-present
`inbound>>>TAG>>>traffic>>>uplink/downlink` slots are exposed. Their updates use
checked, nonnegative atomic additions. Counter resets are rejected by StatsService;
an internal Set, negative Add, or overflow is a programming error and panics before
changing the slot. All ordinary, non-delegated counter behavior is unchanged.

The mapping and descriptors remain pinned until process exit. Closing a delegated
view must never explicitly unlock the shared flock. The old process and its Agent
remain the sole accounting owner and publisher; the old process cannot be retired.

`Manager.DelegatedAccountingStatus()` rechecks the owner pidfd, owner process
identity, descriptor/lock identity, header, and selected labels. A detected change
produces a sticky `blocked` status. Already-established streams may still add their
tail bytes after blocking. **Status does not pause listeners by itself.** A future
controller must check it before admission and periodically, stop admitting new
traffic when blocked, and preserve existing streams and their accounting.

Before any live use, that controller must also prove the candidate is TCP-only,
uses exactly the delegated forwarding identity, has both inbound traffic counters
enabled, and cannot serve any other unmetered listener. Owner mutation and automatic
repair need an independent interlock. Stopping the Agent instead delays reporting
and is not a substitute for full multi-generation accounting or safe retirement.

Tests cover same-OFD descriptor inheritance between processes, concurrent additions,
unchanged header/other records, malformed identity and labels, rejected resets,
owner-exit blocking with preserved tail additions, and retaining the owner's flock.
They do not certify an Agent/Console/PostgreSQL reporting handoff or production
admission control.
