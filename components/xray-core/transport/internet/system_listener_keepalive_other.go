//go:build !linux

package internet

// Linux readback is required for Linux MPTCP compatibility and FD handoff.
// Other platforms still propagate errors while applying required keepalive.
func validateInboundKeepAlive(string, uintptr, *SocketConfig) error { return nil }
