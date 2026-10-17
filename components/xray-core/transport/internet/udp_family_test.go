package internet_test

import (
	"bytes"
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/xtls/xray-core/common/net"
	. "github.com/xtls/xray-core/transport/internet"
)

func TestUDPDialUsesDestinationFamily(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "::1"} {
		for _, explicit := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/source=%t", host, explicit), func(t *testing.T) {
				ip := net.ParseIP(host)
				server, err := net.ListenUDP("udp", &net.UDPAddr{IP: ip})
				if err != nil {
					t.Fatal(err)
				}
				defer server.Close()
				server.SetDeadline(time.Now().Add(2 * time.Second))
				dest := net.UDPDestination(net.IPAddress(ip), net.Port(server.LocalAddr().(*net.UDPAddr).Port))
				var source net.Address
				if explicit {
					source = net.IPAddress(ip)
				}
				conn, err := (&DefaultSystemDialer{}).Dial(context.Background(), source, dest, nil)
				if err != nil {
					t.Fatal(err)
				}
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(2 * time.Second))
				local := conn.LocalAddr().(*net.UDPAddr).IP
				// Go can choose a dual-stack wildcard socket for IPv4 on Linux. An IPv6
				// destination must never be constrained to an IPv4-only local address.
				if ip.To4() == nil && local.To4() != nil {
					t.Fatalf("wrong socket family: %s for %s", local, ip)
				}
				if explicit && !local.Equal(ip) {
					t.Fatal("explicit source address lost")
				}
				payload := []byte("udp-family")
				if _, err := conn.Write(payload); err != nil {
					t.Fatal(err)
				}
				buffer := make([]byte, 64)
				n, peer, err := server.ReadFromUDP(buffer)
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(buffer[:n], payload) {
					t.Fatal("UDP payload mismatch")
				}
				if _, err := server.WriteToUDP(buffer[:n], peer); err != nil {
					t.Fatal(err)
				}
				n, err = conn.Read(buffer)
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(buffer[:n], payload) {
					t.Fatal("UDP response mismatch")
				}
			})
		}
	}
}
