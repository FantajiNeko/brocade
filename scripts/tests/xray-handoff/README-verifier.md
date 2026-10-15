# H9 result verification

Run the validator regression tests from the repository root:

```sh
node --test scripts/tests/xray-handoff/*.test.cjs
```

The tests use only Node's standard library. Their fixture is synthetic, contains
no credentials or real system identities, and does not certify a runtime.

Validate real evidence with an independently prepared binary manifest:

```sh
node scripts/tests/xray-handoff/verify.cjs --manifest hashes.json path/to/result.json
```

Run the same acceptance check plus destructive **in-memory** mutations of a real
completed result (the evidence files remain unchanged):

```sh
H9_REAL_RESULT=path/to/result.json H9_REAL_MANIFEST=hashes.json \
  node --test scripts/tests/xray-handoff/verify.test.cjs
```

The manifest contains `binary_sha256` with SHA-256 values for `b0`, `b1`, `b2`, and
`client`, calculated from the exact executables the runner selected. Each result
directory must also contain `exit-code.txt`, written by the runner from the test
process's actual exit status. A result's own expected-hash fields do not substitute
for this manifest. Exit status zero from the test process does not substitute for
the recorded `Wait` status of each child process.

`verifyResult(result, { expectedBinarySha256, harnessExitCode })` provides the same
checks to callers without filesystem access. It throws on invalid evidence and
returns a finite correctness summary on success. It accepts only `schema_version:
9`; historical H8 files and unknown versions require their own validators. Extra
diagnostic fields are retained by producers, but cannot replace mandatory H9
evidence. Any nonfinite numeric diagnostic is rejected.
Positive lifecycle evidence must have empty `boundary` and `negative_control`
fields and `half_close_transport: "tls-and-tcp"`; TLS-only experiments cannot
certify TCP half-close behavior.

The required evidence covers both `via-A` and `direct-REALITY` paths, with 32
original streams and six new streams in each later generation. Every path and
generation includes download, upload, and duplex transfers. Every verified frame
has a contiguous sequence, an exact 16-KiB payload length, and matching actual and
expected SHA-256 digests recorded by the receiver; the checker independently
recomputes the deterministic sequence payload digest. Per-direction byte totals and
sent/received upload counts must reconcile. Original flows span both handoffs;
the second generation spans the route handoff; the candidate spans retirement
of both previous generations and continues progressing in both required
directions. Duplex shutdown requires at least three observed frames in the other
direction after the receiving peer observes clean EOF from the first half close.
Both peers must observe clean EOF for all streams. Flow completion must precede its own
generation's drain certificate.

Regular requests cover each path in the baseline, first-handoff post, route post,
and retirement phases. Separate pause probes cover both paths inside each actual
accept-pause window, without relying on a periodic request to happen to land in a
sub-millisecond window. Ready events bind binary/config digests, process PIDs,
and the same two listener inode/cookie identities across three generations.
Retirement requires a drain-protocol-version-1 certificate for the right config with all active
scopes zero, quiescent listeners, no unsupported scopes, followed by a signal and
an identity-matched successful child wait. Forced cleanup is never success.

Request phases classify client dispatch, not server Accept. A response whose
headers completed before the observed route-pause barrier must name the old
origin. A request dispatched at or after that barrier must name the new origin.
Only requests whose interval actually overlaps the barrier may name either.
Each path must include unambiguous old-window and new-window observations;
network delay cannot make all requests exempt from origin checks.

These checks validate consistency and completeness of recorded observations;
they do not authenticate an adversarially fabricated result. They do not turn
same-binary evidence into an old-to-fixed upgrade result, certify production
Rust/Agent/Console/PostgreSQL integration, or infer negotiated MPTCP from a socket
protocol number. Throughput and latency remain observations, without an invented
performance SLO.

## Accounting evidence

Validate the complete isolated Rust/Console/PostgreSQL matrix, or opt into
in-memory mutations of its frozen results:

```sh
node scripts/tests/xray-handoff/verify-accounting.cjs path/to/accounting-results
H9_ACCOUNTING_ROOT=path/to/accounting-results \
  node --test scripts/tests/xray-handoff/verify-accounting.test.cjs
```

The directory must contain the exact 60-case matrix (57 actual Console/PG
cases, two fail-closed guards, and held-cover recovery), successful harness
exits, input executable hashes, matching per-case runtime hashes, and complete
case evidence. Exit zero with no selected tests is rejected. Both generation
totals, native final reports, source heads, durable totals, and PG totals must
match the scenario's exact bytes. Numeric receipt fields must be finite safe
nonnegative integers, with positive sequence/generation identities. Source,
operation, control socket, listener, process, and configuration bindings cannot
be empty or silently compare as two missing values.

The dropped-ACK HTTP response must be HTTP 200 and exactly match a persisted
original receipt. The corresponding mode log must contain a duplicate HTTP
retry with the same node/instance/sequence and unchanged receipt values. Stored
PG receipts must remain `duplicate: false`: the retry response is evidence of
deduplication, not permission to overwrite the original record or bill twice.

The frozen Rust `RuntimeStatus` durable projection omits the
`public_quiescent` summary on recovery paths. The checker reconstructs it from
mandatory paused admission, no accepting/active work, and every listener being
idle and outside `Accept`; an explicitly false summary is always rejected.
It never treats an absent summary as proof by itself.

After the old process has died, the recovery attempt advances its fence but
retains the pre-signal drain proof. Only `crash-signal`, `crash-finalized`,
`io-accounting_finalize`, `io-finalized`, and `io-committed` accept a proof
exactly one epoch behind the final attempt, with a distinct nonempty intent.
Every other scenario requires equal epoch and intent. Two-epoch-old proofs,
same-epoch wrong intents, changed PID/start/config/listener identities, active
scopes, and incomplete held-cover/guard predicates are rejected.

The first frozen runner predates the optional `timed_out` exit diagnostic;
absence does not waive successful code/signal requirements. When present it
must be false. Current runners record it explicitly. These checks verify the
recorded isolated experiment, not production deployment readiness.
