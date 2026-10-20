//go:build linux

package tcp

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"testing"

	"golang.org/x/sys/unix"
)

func TestHandoffLegacyMPTCPKeepAlive(t *testing.T) {
	for _, test := range []struct {
		name              string
		protocol, enabled int
		failure           error
		wantError         bool
	}{
		{"disabled_mptcp", unix.IPPROTO_MPTCP, 0, unix.EOPNOTSUPP, false},
		{"enabled_mptcp", unix.IPPROTO_MPTCP, 1, unix.EOPNOTSUPP, true},
		{"ordinary_tcp", unix.IPPROTO_TCP, 0, unix.EOPNOTSUPP, true},
		{"unexpected_error", unix.IPPROTO_MPTCP, 0, unix.EBADF, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			config, err := handoffKeepAliveFD(123, func(fd, level, option int) (int, error) {
				if fd != 123 {
					t.Fatalf("unexpected fd %d", fd)
				}
				if level == unix.SOL_SOCKET {
					switch option {
					case unix.SO_KEEPALIVE:
						return test.enabled, nil
					case unix.SO_PROTOCOL:
						return test.protocol, nil
					}
				}
				return 0, test.failure
			})
			if test.wantError {
				if !errors.Is(err, test.failure) {
					t.Fatalf("got %v, want %v", err, test.failure)
				}
			} else if err != nil || config.Enable || config.Idle != -1 || config.Interval != -1 || config.Count != -1 {
				t.Fatalf("disabled keepalive was not preserved without unsupported timer writes: %+v %v", config, err)
			}
		})
	}
}

func TestHandoffMPTCPDiagnosticBindsExactIdentity(t *testing.T) {
	identity := handoffSocketIdentity{Address: "[::]:14443", SocketInode: 456, Protocol: unix.IPPROTO_MPTCP}
	data := make([]byte, 80)
	data[0], data[1] = unix.AF_INET6, handoffTCPListen
	binary.BigEndian.PutUint16(data[4:6], 14443)
	binary.NativeEndian.PutUint32(data[68:72], 456)
	binary.NativeEndian.PutUint16(data[72:74], 5)
	binary.NativeEndian.PutUint16(data[74:76], handoffDiagV6Only)
	for _, value := range []byte{0, 1} {
		data[76] = value
		got, found, err := handoffMPTCPDiagV6Only(data, identity)
		if err != nil || !found || got != int(value) {
			t.Fatalf("v6only=%d: got %d found=%v err=%v", value, got, found, err)
		}
	}
	for _, offset := range []int{0, 1, 5, 8, 68} {
		changed := append([]byte(nil), data...)
		changed[offset]++
		if _, found, err := handoffMPTCPDiagV6Only(changed, identity); err != nil || found {
			t.Fatalf("accepted mismatched identity byte %d: found=%v err=%v", offset, found, err)
		}
	}
	for _, malformed := range [][]byte{data[:71], data[:72], data[:74], data[:79], append(append([]byte(nil), data[:76]...), 2, 0, 0, 0)} {
		if _, _, err := handoffMPTCPDiagV6Only(malformed, identity); err == nil {
			t.Fatalf("accepted malformed diagnostic: %x", malformed)
		}
	}
}

func TestHandoffMPTCPWildcardDiagnostic(t *testing.T) {
	for _, v6only := range []bool{false, true} {
		network := "tcp"
		if v6only {
			network = "tcp6"
		}
		var lc net.ListenConfig
		lc.SetMultipathTCP(true)
		listener, err := lc.Listen(context.Background(), network, "[::]:0")
		if err != nil {
			t.Skipf("MPTCP IPv6 listener unavailable: %v", err)
		}
		tcpListener := listener.(*net.TCPListener)
		defer tcpListener.Close()
		identity, err := inspectHandoffListener(tcpListener)
		if err != nil {
			t.Fatal(err)
		}
		if identity.Protocol != unix.IPPROTO_MPTCP {
			t.Skip("kernel does not support MPTCP")
		}
		got, err := handoffMPTCPV6Only(identity)
		if err != nil || (got != 0) != v6only {
			t.Fatalf("kernel diagnostic v6only=%v: got=%d err=%v", v6only, got, err)
		}
		logical := (&net.TCPAddr{IP: net.IPv4zero, Port: tcpListener.Addr().(*net.TCPAddr).Port}).String()
		if matched := handoffListenerMatchesRequestedAddress(tcpListener, identity.Address, logical); matched == v6only {
			t.Fatalf("v6only=%v matched IPv4 wildcard=%v", v6only, matched)
		}
	}
}
