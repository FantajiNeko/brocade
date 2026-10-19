# Xray restart recovery integration

This fixture runs the real Agent and Xray on loopback and verifies two destructive boundaries:

1. after the managed Xray is killed, the resident Agent's one-second guard starts a new process and
   restores dynamic forwarding and grants without waiting for the control plane;
2. a candidate configuration that passes `xray -test` but fails to bind at runtime rolls back to
   the prior configuration, forwarding listener, and grants.

Build the Agent first, then run:

```sh
cargo build -p brocade-agent --locked
node scripts/tests/xray-recovery/run.mjs
```

`BROCADE_AGENT_BIN` and `BROCADE_XRAY_BIN` select explicit binaries. Set
`BROCADE_KEEP_RECOVERY_STATE=1` to retain the generated state directory printed in the result.
