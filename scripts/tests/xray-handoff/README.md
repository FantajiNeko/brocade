# H9 isolated Xray lifecycle tests

These tests use the archived experimental v6 runtime source, whose control API
includes fenced listener transfer and the complete `RetireReady` certificate.
They do not add those experimental facilities to the production source tree.
The archive, its local Reality dependency, Go module inputs, fixed runtime and
their measured hashes must be prepared separately. The test preparer accepts
explicit paths and never changes the source archive or H8 evidence.

Prepare and compile from the restored v6 module (Go 1.26.0, Linux/amd64):

```sh
node scripts/tests/xray-handoff/prepare-integration.cjs ABS_V6_SOURCE ABS_NEW_PREPARE_DIR
mkdir -p ABS_GO_TMP
cd ABS_V6_SOURCE
GOTMPDIR=ABS_GO_TMP CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOAMD64=v1 \
  go test -buildvcs=false -overlay ABS_NEW_PREPARE_DIR/overlay.json \
  -c ./testing/handofflab -o ABS_NEW_HARNESS
```

The preparer overlays the topology and H9 tests, and replaces only the test
fixture's process startup helper. Every Xray process has one `Wait` collector;
failed-test cleanup is recorded separately from certified normal retirement.
Each invocation requires a fresh result directory:

```sh
node scripts/tests/xray-handoff/run-integration.cjs \
  --harness ABS_NEW_HARNESS --old ABS_OLD_XRAY --new ABS_FIXED_XRAY \
  --client ABS_FIXED_CLIENT --output ABS_NEW_RESULTS --pace 30
```

The runner independently hashes the binaries, records the real harness status,
requires the intended test to run, and invokes `verify.cjs`. Zero tests, missing
results, nonzero child statuses, forced cleanup, absent samples and missing
cross-transition progress cannot be accepted as successful lifecycle results.
Use the same fixed binary for `--old` and `--new` for a regression control; use
the preserved v6b and fixed v6d for a real cross-version case. An unpatched old
generation that does not drain within 150 seconds fails the test.

The initial 32 streams are divided equally between the real VLESS relay and
REALITY/Vision paths. Both paths include download, upload and simultaneous
duplex payloads. Six streams join on b1 and six on b2. The b2 streams remain open
and advance in every applicable direction after each old generation's exit.
Scheduled short requests continue through retirement. An explicit 100 ms
pause barrier launches one request per path during each accept transition;
that intentional barrier is a correctness test, not a latency benchmark.

Each payload frame is checked against its sequence, SHA-256 and deterministic
content at the receiving endpoint. Client-first and server-first duplex
shutdown require clean EOF and at least three opposite-direction frames after
that EOF. Byte totals must match the sent and verified frames.

Two real fault controls must return nonzero and preserve a failing result:

```sh
# Add one of these to a fresh runner invocation:
--negative corrupt-payload
--negative unexpected-exit
```

The first changes one synthetic frame; the second kills the owned b0 process.
Check the specific payload error or b0's signal status, not merely any failure.
Unknown control names are rejected.

An independent early-half-close boundary test keeps a download active for more
than 2.5 seconds after the client closes its write side:

```sh
# Add to a fresh runner invocation; run both transports and both client binaries:
--boundary early-download --half-close tls-only
--boundary early-download --half-close tls-and-tcp
```

These boundary results are not lifecycle results. The default Xray half-close
timeouts remain one second. Failures are retained, including when only TLS
close_notify succeeds but TCP FIN causes a continuing REALITY download to end.

For the private network namespace matrix, build a reproducible tooling image:

```sh
NETLAB_RESULTS=ABS_NETLAB_RESULTS NETLAB_IMAGE=brocade-h9-netlab:local \
  bash scripts/tests/xray-handoff/netlab/netlab.sh build
NETLAB_IMAGE=brocade-h9-netlab:local bash scripts/tests/xray-handoff/run-netlab.sh \
  ABS_TARGET_ROOT ABS_NETLAB_RESULTS h7-h9-100-01 100
NETLAB_IMAGE=brocade-h9-netlab:local bash scripts/tests/xray-handoff/run-netlab.sh \
  ABS_TARGET_ROOT ABS_NETLAB_RESULTS h7-h9-300-01 300
```

The wrapper currently expects the frozen binaries at `h9/integration/h9-v1.test`,
`h9/xray-lab-v6d` and `h7/xray-client-baseline` beneath `ABS_TARGET_ROOT`.
The Dockerfile starts from Ubuntu 24.04 and does not require a local parent
image. Reusing another existing image requires explicit `NETLAB_IMAGE`; its
actual image ID is retained in the result directory. The network fixture uses
four namespaces, 25 ms nominal full-path RTT, four allowed host CPUs and the
specified bandwidth ceiling. Before/after kernel readbacks and pairwise veth
conservation are checked. The dedicated container is removed on success or
failure using exact-name ownership and network-isolation checks.

The fixture does not certify saturation capacity, VM performance, MPTCP
negotiation, production Rust orchestration or Agent/Console/PostgreSQL billing.
Those require their own independently verified evidence.

## Timer and verifier CI gates

Main-tree timer tests are independent of the experimental runtime:

```sh
cd components/xray-core
go test -race ./common/signal -run '^TestActivityTimerConcurrent' -count=100 -timeout=1m
go test -race ./common/signal -run '^TestActivityTimerRealTimeShortTimeoutRace$' -count=20 -timeout=1m
go test -race ./common/signal -count=1 -timeout=1m
go vet ./common/signal
```

From the repository root:

```sh
node --test scripts/tests/xray-handoff/*.test.cjs
```

CI includes these fast gates, not the real-process/Docker integration matrix.
See [README-verifier.md](README-verifier.md) for acceptance rules and real-result
mutation tests. No production access or deployment is performed by this suite.

## Frozen runtime reconstruction

```sh
node scripts/tests/xray-handoff/build-runtime.cjs ISOLATED_V6_SOURCE TIMER_SOURCE NEW_BUILD_DIRECTORY
```

The complete H9 source archive includes the Xray prototype, its local REALITY
replacement, Go test helpers and isolated Rust Agent/Console/store sources.
Legacy baseline and v4 sources are in a separate archive. Preserve these with
the frozen timer and artifact manifest. A clean checkout alone does **not**
contain these external experimental inputs. Go/Cargo dependencies still need
their matching caches or registry access. A fresh-path archive reconstruction
was built successfully, without depending on the original `/tmp` source paths.

The builder records its timer snapshot, overlay, build log and executable hash.
Runtime builds use Go 1.26, linux/amd64 v1 and CGO enabled, without `-trimpath`.
Rebuilding from another source path can change the binary digest; recompute the
manifest for the exact executables selected rather than reusing a prior hash.
Scripts refuse existing output directories. Do not overwrite H6/H7/H8 evidence.

## Agent / Console / PostgreSQL accounting

This separate matrix uses the frozen isolated Rust test harness and Go manager
helper, not the Go lifecycle fixture above. Docker provides disposable
`postgres:16-alpine` databases. Actual Console HTTP/auth/JSON and PgStore paths
are exercised. The HTTP-only test build has placeholder embedded probe assets
and must never be deployed.

```sh
node scripts/tests/xray-handoff/run-accounting.cjs NEW_RESULT_DIRECTORY \
  FIXED_XRAY UNMODIFIED_CLIENT V4_GUARD_RUNTIME MANAGER_TEST AGENT_TEST
node scripts/tests/xray-handoff/verify-accounting.cjs RESULT_DIRECTORY
```

The complete expected set is 57 real PG accounting cases, two refusal guards
and one held-cover recovery case. The runner records input hashes and actual
exit statuses, then requires independent verification. Empty/partial results,
wrong totals and abnormal exit cannot pass. It bounds each security-mode
process to 15 minutes; `H9_ACCOUNTING_CASE_TIMEOUT_MS` permits a smaller bounded
deadline for failure-path tests. Timeout or interruption kills only its own
detached child groups and never becomes a successful retirement result.

Record external ECH exclusions, baseline race/vet failures and early TCP
half-close failures separately. This timer validation does not rerun or extend
the earlier legacy adoption/MPTCP kernel certification. No result here asserts
that the full production desired-state orchestration has been integrated.
