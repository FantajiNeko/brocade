package internet

import (
	"fmt"
	"net"
	"runtime"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// ValidateTCPListenerKeepAlive checks imported listeners without changing the
// shared socket. A matching configuration digest alone cannot prove that an old
// Xray successfully applied its keepalive options.
func ValidateTCPListenerKeepAlive(listener *net.TCPListener, config *SocketConfig) error {
	network := "tcp4"
	if listener.Addr().(*net.TCPAddr).IP.To4() == nil {
		network = "tcp6"
	}
	raw, err := listener.SyscallConn()
	if err != nil {
		return err
	}
	var optionErr error
	if err := raw.Control(func(fd uintptr) {
		optionErr = validateInboundKeepAlive(network, fd, config)
	}); err != nil {
		return err
	}
	return optionErr
}

func validateInboundKeepAlive(network string, fd uintptr, config *SocketConfig) error {
	if !isTCPSocket(network) || config == nil || (config.TcpKeepAliveIdle <= 0 && config.TcpKeepAliveInterval <= 0) {
		return nil
	}
	enabled, err := unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_KEEPALIVE)
	if err != nil {
		return fmt.Errorf("read required SO_KEEPALIVE: %w", err)
	}
	if enabled != 1 {
		return fmt.Errorf("required SO_KEEPALIVE is disabled")
	}
	// Read all three parameters even when only one was configured: enabled
	// legacy MPTCP must not pass startup only to fail during the next FD handoff.
	options := []struct {
		option int
		name   string
		want   int
	}{
		{unix.TCP_KEEPIDLE, "TCP_KEEPIDLE", int(config.TcpKeepAliveIdle)},
		{unix.TCP_KEEPINTVL, "TCP_KEEPINTVL", int(config.TcpKeepAliveInterval)},
		{unix.TCP_KEEPCNT, "TCP_KEEPCNT", 0},
	}
	for i := range options {
		// Custom options run last and may override the typed idle/interval
		// fields. Respect their existing platform, network and default-level
		// semantics; in Brocade this supplies TCP_KEEPCNT independently of sysctl.
		for _, custom := range config.CustomSockopt {
			if (custom.System != "" && custom.System != runtime.GOOS) || !strings.HasPrefix(network, custom.Network) {
				continue
			}
			level := unix.IPPROTO_TCP
			if custom.Level != "" {
				level, _ = strconv.Atoi(custom.Level)
			}
			option, _ := strconv.Atoi(custom.Opt)
			if level != unix.IPPROTO_TCP || option != options[i].option {
				continue
			}
			value, err := strconv.Atoi(custom.Value)
			if custom.Type != "int" || err != nil || value <= 0 {
				return fmt.Errorf("invalid required %s custom socket option", options[i].name)
			}
			options[i].want = value
		}
		got, err := unix.GetsockoptInt(int(fd), unix.IPPROTO_TCP, options[i].option)
		if err != nil {
			return fmt.Errorf("read required %s: %w", options[i].name, err)
		}
		if got <= 0 || (options[i].want > 0 && got != options[i].want) {
			return fmt.Errorf("required %s mismatch: got %d, want %d", options[i].name, got, options[i].want)
		}
	}
	return nil
}
