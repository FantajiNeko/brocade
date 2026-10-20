package internet

import (
	"context"
	"net"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
	"google.golang.org/protobuf/proto"
)

func requiredKeepAliveConfig() *SocketConfig {
	return &SocketConfig{
		TcpKeepAliveIdle: 300, TcpKeepAliveInterval: 90,
		CustomSockopt: []*CustomSockopt{{System: "linux", Network: "tcp", Level: "6", Opt: "6", Type: "int", Value: "3"}},
	}
}

func readKeepAliveOptions(t *testing.T, socket interface {
	SyscallConn() (syscall.RawConn, error)
}) [4]int {
	t.Helper()
	raw, err := socket.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var values [4]int
	var optionErr error
	err = raw.Control(func(fd uintptr) {
		for i, option := range []struct{ level, option int }{
			{unix.SOL_SOCKET, unix.SO_KEEPALIVE}, {unix.IPPROTO_TCP, unix.TCP_KEEPIDLE},
			{unix.IPPROTO_TCP, unix.TCP_KEEPINTVL}, {unix.IPPROTO_TCP, unix.TCP_KEEPCNT},
		} {
			values[i], optionErr = unix.GetsockoptInt(int(fd), option.level, option.option)
			if optionErr != nil {
				return
			}
		}
	})
	if err != nil || optionErr != nil {
		t.Fatalf("read socket: raw=%v option=%v", err, optionErr)
	}
	return values
}

func TestRequiredInboundKeepAlive(t *testing.T) {
	for _, address := range []string{"127.0.0.1:0", "[::1]:0"} {
		for _, explicitMPTCP := range []bool{false, true} {
			name := address
			if explicitMPTCP {
				name += "/explicit_mptcp"
			}
			t.Run(name, func(t *testing.T) {
				config := requiredKeepAliveConfig()
				config.TcpMptcp = explicitMPTCP
				addr, err := net.ResolveTCPAddr("tcp", address)
				if err != nil {
					t.Fatal(err)
				}
				listener, err := (&DefaultListener{}).Listen(context.Background(), addr, config)
				if err != nil {
					t.Fatal(err)
				}
				defer listener.Close()
				l := listener.(*net.TCPListener)
				raw, err := l.SyscallConn()
				if err != nil {
					t.Fatal(err)
				}
				var protocol int
				var optionErr error
				if err := raw.Control(func(fd uintptr) {
					protocol, optionErr = unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_PROTOCOL)
				}); err != nil || optionErr != nil {
					t.Fatalf("read listener protocol: raw=%v option=%v", err, optionErr)
				}
				t.Logf("actual listener protocol=%d (TCP=6, MPTCP=262)", protocol)
				if err := l.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
					t.Fatal(err)
				}
				if got := readKeepAliveOptions(t, l); got != [4]int{1, 300, 90, 3} {
					t.Fatalf("listener options: %v", got)
				}
				client, err := net.DialTimeout("tcp", l.Addr().String(), 3*time.Second)
				if err != nil {
					t.Fatal(err)
				}
				defer client.Close()
				accepted, err := l.AcceptTCP()
				if err != nil {
					t.Fatal(err)
				}
				defer accepted.Close()
				if got := readKeepAliveOptions(t, accepted); got != [4]int{1, 300, 90, 3} {
					t.Fatalf("accepted options: %v", got)
				}
			})
		}
	}
}

func TestRequiredKeepAliveErrorsFailClosed(t *testing.T) {
	// Linux rejects this value on ordinary TCP as well as MPTCP. No successful
	// listener may escape merely because the original error was only logged.
	config := requiredKeepAliveConfig()
	config.TcpKeepAliveIdle = 1 << 30
	l, err := (&DefaultListener{}).Listen(context.Background(), &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)}, config)
	if l != nil {
		l.Close()
		t.Fatal("invalid required keepalive returned a live listener")
	}
	if err == nil {
		t.Fatal("invalid required keepalive must fail")
	}
}

func TestRequiredKeepAliveMPTCPFallback(t *testing.T) {
	for _, network := range []string{"tcp4", "tcp6"} {
		for _, explicit := range []bool{false, true} {
			name := network + "/default"
			if explicit {
				name = network + "/explicit"
			}
			t.Run(name, func(t *testing.T) {
				t.Setenv("GODEBUG", "multipathtcp=1")
				config := requiredKeepAliveConfig()
				config.TcpMptcp = explicit
				var attempts []int
				var lc net.ListenConfig
				lc.KeepAlive = -1
				lc.KeepAliveConfig = net.KeepAliveConfig{Enable: true, Idle: 300 * time.Second, Interval: 90 * time.Second, Count: -1}
				if explicit {
					lc.SetMultipathTCP(true)
				}
				lc.Control = func(network, address string, raw syscall.RawConn) error {
					var protocol int
					var optionErr error
					if err := raw.Control(func(fd uintptr) {
						protocol, optionErr = unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_PROTOCOL)
					}); err != nil {
						return err
					}
					if optionErr != nil {
						return optionErr
					}
					attempts = append(attempts, protocol)
					options := config
					if protocol == unix.IPPROTO_MPTCP {
						// Inject an option-setting failure only for the MPTCP
						// attempt, without changing the host kernel or sysctl.
						bad := proto.Clone(config).(*SocketConfig)
						bad.TcpKeepAliveIdle = 1 << 30
						options = bad
					}
					return getControlFunc(context.Background(), options, nil)(network, address, raw)
				}
				address := "127.0.0.1:0"
				if network == "tcp6" {
					address = "[::1]:0"
				}
				listener, err := lc.Listen(context.Background(), network, address)
				if err != nil {
					t.Fatal(err)
				}
				defer listener.Close()
				if len(attempts) == 1 && attempts[0] == unix.IPPROTO_TCP {
					t.Skip("kernel has no MPTCP listener support; TCP path covered separately")
				}
				if len(attempts) != 2 || attempts[0] != unix.IPPROTO_MPTCP || attempts[1] != unix.IPPROTO_TCP {
					t.Fatalf("expected one bounded MPTCP to TCP fallback: %v", attempts)
				}
				if got := readKeepAliveOptions(t, listener.(*net.TCPListener)); got != [4]int{1, 300, 90, 3} {
					t.Fatalf("fallback lost keepalive: %v", got)
				}
			})
		}
	}
}

func TestValidateRequiredKeepAliveDoesNotMutateListener(t *testing.T) {
	config := requiredKeepAliveConfig()
	l, err := (&DefaultListener{}).Listen(context.Background(), &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)}, config)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	listener := l.(*net.TCPListener)
	before := readKeepAliveOptions(t, listener)
	config.CustomSockopt[0].Value = "4"
	if err := ValidateTCPListenerKeepAlive(listener, config); err == nil || !strings.Contains(err.Error(), "TCP_KEEPCNT mismatch") {
		t.Fatalf("wrong probe count must be rejected: %v", err)
	}
	if after := readKeepAliveOptions(t, listener); after != before {
		t.Fatalf("validation mutated the shared socket: before=%v after=%v", before, after)
	}
	config.TcpKeepAliveIdle, config.TcpKeepAliveInterval = 0, 0
	if err := ValidateTCPListenerKeepAlive(listener, config); err != nil {
		t.Fatalf("unspecified keepalive must preserve prior behavior: %v", err)
	}
}
