package inbound

import (
	"context"
	"net"
	"sync"
	"testing"
	"time"

	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/features/routing"
	"github.com/xtls/xray-core/transport/internet"
	"github.com/xtls/xray-core/transport/internet/stat"
	"github.com/xtls/xray-core/transport/internet/tcp"
)

func TestForwardingConnectionsCloseRacesWithLateAdmission(t *testing.T) {
	registry := &forwardingConnections{}
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			left, right := net.Pipe()
			defer left.Close()
			defer right.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			entry := registry.add(left, cancel)
			if entry != nil {
				defer registry.remove(entry)
			}
			if err := registry.close(); err != nil {
				t.Error(err)
			}
			if entry != nil {
				select {
				case <-ctx.Done():
				case <-time.After(time.Second):
					t.Error("active forwarding context was not canceled")
				}
			}
		}()
	}
	wg.Wait()
	left, right := net.Pipe()
	defer left.Close()
	defer right.Close()
	if registry.add(left, func() {}) != nil {
		t.Fatal("removed forwarding listener admitted a late connection")
	}
}

type quotaTestProxy struct {
	started chan struct{}
	done    chan struct{}
}

func (p *quotaTestProxy) Network() []xnet.Network { return []xnet.Network{xnet.Network_TCP} }
func (p *quotaTestProxy) Process(_ context.Context, _ xnet.Network, conn stat.Connection, _ routing.Dispatcher) error {
	close(p.started)
	defer close(p.done)
	var b [1]byte
	_, err := conn.Read(b[:])
	return err
}

func TestRemovingForwardingWorkerClosesExistingTCPButOrdinaryWorkersDrain(t *testing.T) {
	for _, tag := range []string{"fwd:7", "ordinary-entry"} {
		t.Run(tag, func(t *testing.T) {
			reservation, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			port := reservation.Addr().(*net.TCPAddr).Port
			_ = reservation.Close()
			proxy := &quotaTestProxy{started: make(chan struct{}), done: make(chan struct{})}
			worker := &tcpWorker{tag: tag, ctx: context.Background(), address: xnet.LocalHostIP, port: xnet.Port(port), proxy: proxy,
				stream: &internet.MemoryStreamConfig{ProtocolName: "tcp", ProtocolSettings: &tcp.Config{}}}
			if err := worker.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = worker.Close() })
			conn, err := net.DialTimeout("tcp", worker.hub.Addr().String(), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			select {
			case <-proxy.started:
			case <-time.After(time.Second):
				t.Fatal("connection not accepted")
			}
			if err := worker.Close(); err != nil {
				t.Fatal(err)
			}
			if tag == "fwd:7" {
				select {
				case <-proxy.done:
				case <-time.After(time.Second):
					t.Fatal("quota removal left forwarding TCP alive")
				}
			} else {
				select {
				case <-proxy.done:
					t.Fatal("ordinary ingress connection was interrupted")
				default:
				}
				_ = conn.Close()
				select {
				case <-proxy.done:
				case <-time.After(time.Second):
					t.Fatal("ordinary connection did not finish on client close")
				}
			}
		})
	}
}
