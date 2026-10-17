package netstack

import (
	"context"
	"fmt"
	"io"
	"net/netip"
	"sync"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/tun"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
)

func TestTunnelStackTCPAndUDP(t *testing.T) {
	clientIPs := []netip.Addr{netip.MustParseAddr("172.16.0.2"), netip.MustParseAddr("fd00::2")}
	serverIPs := []netip.Addr{netip.MustParseAddr("172.16.0.1"), netip.MustParseAddr("fd00::1")}
	client, network, _, err := CreateNetTUN(clientIPs, nil, 1280, false)
	if err != nil {
		t.Fatal(err)
	}
	server, _, stack, err := CreateNetTUN(serverIPs, nil, 1280, false)
	if err != nil {
		client.Close()
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	pump := func(src, dst tun.Device) {
		defer wg.Done()
		b := make([]byte, 1500)
		sizes := make([]int, 1)
		for {
			n, err := src.Read([][]byte{b}, sizes, 0)
			if err != nil {
				return
			}
			if n > 0 {
				if _, err = dst.Write([][]byte{b[:sizes[0]]}, 0); err != nil {
					return
				}
			}
		}
	}
	wg.Add(2)
	go pump(client, server)
	go pump(server, client)
	defer func() { client.Close(); server.Close(); wg.Wait() }()
	for _, ip := range serverIPs {
		t.Run(ip.String(), func(t *testing.T) {
			addr, pn := convertToFullAddr(netip.AddrPortFrom(ip, 9000))
			listener, err := gonet.ListenTCP(stack, addr, pn)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			go func() {
				c, err := listener.Accept()
				if err != nil {
					return
				}
				defer c.Close()
				io.Copy(c, c)
			}()
			udp, err := gonet.DialUDP(stack, &addr, nil, pn)
			if err != nil {
				t.Fatal(err)
			}
			defer udp.Close()
			go func() {
				b := make([]byte, 1500)
				n, peer, err := udp.ReadFrom(b)
				if err == nil {
					udp.WriteTo(b[:n], peer)
				}
			}()
			for _, proto := range []string{"tcp", "udp"} {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				c, err := network.DialContext(ctx, proto, netip.AddrPortFrom(ip, 9000).String())
				if err != nil {
					t.Fatal(err)
				}
				c.SetDeadline(time.Now().Add(3 * time.Second))
				payload := fmt.Sprintf("MASQUE %s %s", proto, ip)
				if _, err = c.Write([]byte(payload)); err != nil {
					c.Close()
					t.Fatal(err)
				}
				b := make([]byte, len(payload))
				_, err = io.ReadFull(c, b)
				c.Close()
				if err != nil {
					t.Fatal(err)
				}
				if string(b) != payload {
					t.Fatalf("got %q", b)
				}
			}
		})
	}
}

func TestDNSCacheIsBoundedAndExpires(t *testing.T) {
	var c cache
	for i := 0; i < 4100; i++ {
		c.Cache(fmt.Sprint(i), []string{"1.1.1.1"}, 60)
	}
	if len(c.m) != 4096 {
		t.Fatalf("cache size %d", len(c.m))
	}
	c.Cache("0", []string{"1.0.0.1"}, 60)
	if got := c.LookupHost("0"); len(got) != 1 || got[0] != "1.0.0.1" {
		t.Fatalf("update lost: %v", got)
	}
	c.Cache("0", []string{"1.0.0.1"}, 0)
	if got := c.LookupHost("0"); got != nil {
		t.Fatalf("expired: %v", got)
	}
}
