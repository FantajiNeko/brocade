package proxy

import (
	"context"
	"io"
	"net"
	"runtime"
	"testing"
	"time"

	"github.com/xtls/xray-core/app/dispatcher"
	"github.com/xtls/xray-core/common/buf"
	"github.com/xtls/xray-core/common/session"
	"github.com/xtls/xray-core/common/signal"
)

// BenchmarkRawSpliceActivity measures sustained copying on one connection,
// not connection setup, VM scheduling, or end-to-end protocol performance.
func BenchmarkRawSpliceActivity(b *testing.B) {
	if runtime.GOOS != "linux" {
		b.Skip("requires Linux splice")
	}
	for _, metered := range []bool{false, true} {
		name := "unmetered"
		if metered {
			name = "metered"
		}
		b.Run(name, func(b *testing.B) {
			reader, input := spliceBenchmarkPair(b)
			writer, output := spliceBenchmarkPair(b)
			inbound := &session.Inbound{Conn: writer}
			inbound.CanSpliceCopy.Store(session.SpliceCopyDirect)
			outbound := &session.Outbound{}
			outbound.CanSpliceCopy.Store(session.SpliceCopyDirect)
			ctx := session.ContextWithInbound(context.Background(), inbound)
			ctx = session.ContextWithOutbounds(ctx, []*session.Outbound{outbound})
			var destination buf.Writer = buf.NewWriter(writer)
			if metered {
				destination = &dispatcher.SizeStatWriter{Writer: destination, Counter: new(spliceTestCounter)}
			}
			copied, received := make(chan error, 1), make(chan error, 1)
			go func() {
				err := CopyRawConnIfExist(ctx, reader, writer, destination, signal.NewNoopActivityTimer(), nil)
				_ = writer.CloseWrite()
				copied <- err
			}()
			var receivedBytes int64
			go func() {
				var err error
				receivedBytes, err = io.Copy(io.Discard, output)
				received <- err
			}()
			payload := make([]byte, 64<<10)
			b.SetBytes(int64(len(payload)))
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if n, err := input.Write(payload); err != nil || n != len(payload) {
					b.Fatalf("write = %d, %v", n, err)
				}
			}
			if err := input.CloseWrite(); err != nil {
				b.Fatal(err)
			}
			if err := <-copied; err != nil {
				b.Fatal(err)
			}
			if err := <-received; err != nil {
				b.Fatal(err)
			}
			b.StopTimer()
			if receivedBytes != int64(b.N)*int64(len(payload)) {
				b.Fatal("benchmark byte count mismatch")
			}
			if inbound.CanSpliceCopy.Load() != session.SpliceCopySplicing {
				b.Fatal("benchmark did not enter splice")
			}
		})
	}
}

func spliceBenchmarkPair(b *testing.B) (*net.TCPConn, *net.TCPConn) {
	b.Helper()
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		b.Fatal(err)
	}
	defer listener.Close()
	client, err := net.DialTCP("tcp4", nil, listener.Addr().(*net.TCPAddr))
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = client.Close() })
	server, err := listener.AcceptTCP()
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = server.Close() })
	for _, conn := range []*net.TCPConn{client, server} {
		if err := conn.SetDeadline(time.Now().Add(time.Minute)); err != nil {
			b.Fatal(err)
		}
	}
	return server, client
}
