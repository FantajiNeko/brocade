package internet

import (
	"context"
	"net"
	"testing"
	"time"

	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/session"
)

func TestIPBlockerChecksTheResolvedSocketBeforeConnect(t *testing.T) {
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx := ContextWithIPBlocker(context.Background(), func(ip xnet.IP) bool { return ip.IsLoopback() })
	port := xnet.Port(listener.Addr().(*net.TCPAddr).Port)
	for _, address := range []string{"127.0.0.1", "::ffff:127.0.0.1", "localhost"} {
		for _, network := range []xnet.Network{xnet.Network_TCP, xnet.Network_UDP} {
			t.Run(address+network.String(), func(t *testing.T) {
				dest := xnet.Destination{Network: network, Address: xnet.ParseAddress(address), Port: port}
				conn, err := (&DefaultSystemDialer{}).Dial(ctx, nil, dest, nil)
				if conn != nil {
					conn.Close()
					t.Fatal("blocked destination produced a socket")
				}
				if err == nil {
					t.Fatal("blocked destination accepted")
				}
			})
		}
	}
	listener.SetDeadline(time.Now().Add(30 * time.Millisecond))
	if c, err := listener.Accept(); err == nil {
		c.Close()
		t.Fatal("blocked target received a TCP connection")
	}
	// A different outbound without the context policy can still dial the same address.
	conn, err := (&DefaultSystemDialer{}).Dial(context.Background(), nil, xnet.TCPDestination(xnet.LocalHostIP, port), nil)
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
}

func TestIPBlockerDoesNotApplyToAnotherOutboundsProxyEndpoint(t *testing.T) {
	owner := &session.Outbound{}
	ctx := session.ContextWithOutbounds(context.Background(), []*session.Outbound{owner})
	ctx = ContextWithIPBlocker(ctx, func(ip xnet.IP) bool { return ip.IsLoopback() })
	if checkDialIP(ctx, net.IPv4(127, 0, 0, 1)) == nil {
		t.Fatal("owner's private target was accepted")
	}
	proxyCtx := session.ContextWithOutbounds(ctx, []*session.Outbound{owner, {}})
	if err := checkDialIP(proxyCtx, net.IPv4(127, 0, 0, 1)); err != nil {
		t.Fatal("target policy leaked into the proxy's transport:", err)
	}
}

func TestIPBlockerNormalizesMappedAddressesAndRejectsUnresolvedNames(t *testing.T) {
	ctx := ContextWithIPBlocker(context.Background(), func(ip xnet.IP) bool { return ip.IsLoopback() })
	for _, address := range []string{"127.0.0.1:80", "[::ffff:127.0.0.1]:80", "localhost:80"} {
		if err := checkDialAddress(ctx, address); err == nil {
			t.Fatalf("accepted %s", address)
		}
	}
	for _, address := range []string{"1.1.1.1:443", "[2606:4700:4700::1111]:443"} {
		if err := checkDialAddress(ctx, address); err != nil {
			t.Fatal(err)
		}
	}
}
