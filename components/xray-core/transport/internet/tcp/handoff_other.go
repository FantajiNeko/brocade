//go:build !linux

package tcp

import (
	"fmt"
	"net"
	"os"

	"github.com/xtls/xray-core/transport/internet"
)

// InitHandoff explicitly rejects opt-in on unsupported operating systems.
func InitHandoff() error {
	if os.Getenv("XRAY_TCP_HANDOFF_MANIFEST") != "" {
		return fmt.Errorf("TCP listener handoff is supported only on Linux")
	}
	return nil
}

func MarkHandoffReady() error { return nil }
func CloseHandoff() error     { return nil }

func RecordHandoffStartupFailure(error) {}

func openHandoffListener(_ string, _ bool, _ *internet.SocketConfig, bind func() (net.Listener, error)) (net.Listener, handoffGate, error) {
	l, err := bind()
	return l, nil, err
}
