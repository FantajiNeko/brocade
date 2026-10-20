# Rendered TCP inbound keepalive regression

This test uses a freshly selected Brocade Xray and socket options extracted from a real
`brocade-core` rendered node artifact. It tests VLESS and AnyTLS over both IPv4 and IPv6:

- completely dropping traffic in each client container must remove its online source after
  approximately `300 + 90 * 3 = 570` seconds;
- healthy clients remain idle for that entire window and then exchange data over the original
  connection, without reconnecting;
- application `connIdle` is raised to one hour in this fixture so it cannot mask TCP detection.

It takes approximately ten minutes. Docker needs IPv6 bridge support and a locally available
Linux image containing Python 3, nftables and `sleep`. The default image is the existing local
`brocade-manual-mptcp-fixture:20261015`; use `--image` to select another prepared image. No packages
are installed by the test. The host needs Python 3, OpenSSL and Docker access.

```sh
mkdir -p target/tcp-keepalive/rendered
(cd components/xray-core && CGO_ENABLED=0 go build -trimpath -o ../../target/tcp-keepalive/xray ./main)
BROCADE_DEMO_DUMP_DIR="$PWD/target/tcp-keepalive/rendered" \
  cargo test -p brocade-core --locked --test demo_raw
python3 scripts/tests/tcp-keepalive/run.py run \
  --xray target/tcp-keepalive/xray \
  --rendered target/tcp-keepalive/rendered/hk-01.xray.json \
  --output target/tcp-keepalive/results
```

The test creates a unique internal Docker network, publishes no ports and applies nftables only
inside its own containers. Containers have `NET_ADMIN` and container-local AppArmor confinement
disabled to permit the fixture's packet drops; no host network namespace or firewall is modified.
Owned containers and the network are removed in `finally`; results, fixture-only certificates,
JSON configs and logs remain under the explicit output directory. Interruptions that prevent
Python cleanup may require removing the exact `brocade-ka-<id>` resources printed in the log.

The separate Go regression `TestHandoffExplicitKeepAliveMatchesNormalAccept/brocade_inbound`
reads `SO_KEEPALIVE`, `TCP_KEEPIDLE`, `TCP_KEEPINTVL`, and `TCP_KEEPCNT` from normal and handed-off
accepted sockets; both must be `[1, 300, 90, 3]`, regardless of the host's probe count.

## MPTCP compatibility

Required keepalive takes priority over MPTCP, including explicit `tcpMptcp: true`.
Linux listener startup must apply and read back its socket policy. Go performs a bounded
MPTCP-to-TCP retry; TCP failures remain errors. An inherited listener is validated without
changing the shared socket, and its real protocol/identity/configuration remain pinned.

```sh
(cd components/xray-core && go test -race ./transport/internet ./transport/internet/tcp -count=3 -timeout=2m)
(cd components/xray-core && go vet ./transport/internet ./transport/internet/tcp)
```

`TestRequiredKeepAliveMPTCPFallback` injects an option failure only for the MPTCP attempt and
requires exactly one TCP retry, over IPv4/IPv6 and default/explicit MPTCP. It skips only this
fault-injection case when the kernel cannot create MPTCP sockets at all; ordinary TCP option
and fail-closed tests remain separate. `TestHandoffTCPFallbackWithMPTCPPreference` checks FD
import of the resulting TCP socket. `TestHandoffKeepAliveRebindFromMPTCP` also checks a changed
configuration binding a new listener while the old MPTCP listener exists: after retiring old
admission, the old accepted connection and a new connection must both exchange data.

Docker shares the host kernel and does not establish old-kernel compatibility. The additional
local KVM experiment used verified Ubuntu `5.15.0-25-generic` with no NIC, and first reproduced
`EOPNOTSUPP` on MPTCP keepalive set/get. The same socket tests then verified actual TCP fallback
and `[1,300,90,3]`, including handed-off accepted sockets. Evidence and the VM-only init program
are under `target/tcp-keepalive-20261020/legacy-kernel/`; these are local artifacts, not deployment
tools. The no-explicit-keepalive subcases of the older four-option comparison test were not run
in that VM: it assumes all timers are readable even with disabled legacy MPTCP. The distinct
legacy-MPTCP handoff regression covers that disabled state without inventing timer values.

This is an explicit external E2E, not a substitute for the ordinary tests against the Xray
embedded by the Console build. It does not exercise PostgreSQL, Agent reporting or browser
polling, nor does it turn keepalive into a hard timeout for connections with unacknowledged data.
