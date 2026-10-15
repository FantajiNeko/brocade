//go:build linux

package proxy

import (
	"bytes"
	"context"
	"io"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xtls/xray-core/app/dispatcher"
	"github.com/xtls/xray-core/common/buf"
	"github.com/xtls/xray-core/common/session"
	"github.com/xtls/xray-core/common/signal"
)

// Small transfers never fill the former 64 MiB ReadFrom chunk. Resetting the
// deadline after the first received byte reproduces uplink EOF racing with an
// already-active raw downlink. The early-deadline case checks the opposite order:
// entering splice must not replace a real half-close policy with a 24-hour one.
func TestCopyRawConnActivitySurvivesHalfClose(t *testing.T) {
	for _, tc := range []struct {
		name           string
		outbound       bool
		inbound        bool
		metered        bool
		early          bool
		copyState      uint32
		noRawWriter    bool
		helperFallback bool
	}{
		{name: "unmetered-outbound", outbound: true},
		{name: "unmetered-inbound", inbound: true},
		{name: "unmetered-both", outbound: true, inbound: true},
		{name: "metered-both", outbound: true, inbound: true, metered: true},
		{name: "deadline-before-splice", outbound: true, inbound: true, early: true},
		{name: "waiting-buffered-both", outbound: true, inbound: true, copyState: uint32(session.SpliceCopyWaiting)},
		{name: "fallback-buffered-both", outbound: true, inbound: true, noRawWriter: true},
		{name: "splice-helper-fallback-both", outbound: true, inbound: true, metered: true, helperFallback: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reader, input := tcpConnPair(t)
			writer, output := tcpConnPair(t)
			for _, conn := range []*net.TCPConn{reader, input, writer, output} {
				t.Cleanup(func() { _ = conn.Close() })
				if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
					t.Fatal(err)
				}
			}
			inbound := &session.Inbound{Conn: writer}
			inbound.CanSpliceCopy.Store(session.SpliceCopyDirect)
			if tc.copyState != 0 {
				inbound.CanSpliceCopy.Store(session.SpliceCopyState(tc.copyState))
			}
			outbound := &session.Outbound{}
			outbound.CanSpliceCopy.Store(session.SpliceCopyDirect)
			ctx := session.ContextWithInbound(context.Background(), inbound)
			ctx = session.ContextWithOutbounds(ctx, []*session.Outbound{outbound})

			var watched []*spliceActivityDeadline
			newTimer := func(name string) *signal.ActivityTimer {
				d := &spliceActivityDeadline{name: name, fired: make(chan struct{})}
				d.timer = signal.CancelAfterInactivity(ctx, func() {
					if d.calls.Add(1) == 1 {
						close(d.fired)
					}
				}, time.Minute)
				watched = append(watched, d)
				return d.timer
			}
			timer := signal.NewNoopActivityTimer()
			var inTimer *signal.ActivityTimer
			if tc.outbound {
				timer = newTimer("outbound")
			}
			if tc.inbound {
				inTimer = newTimer("inbound")
			}
			const idle = 150 * time.Millisecond
			setHalfClose := func() {
				for _, d := range watched {
					d.timer.SetTimeout(idle)
				}
			}
			if tc.early {
				setHalfClose()
			}
			var sink buf.Writer = buf.NewWriter(writer)
			if tc.metered {
				sink = &dispatcher.SizeStatWriter{Writer: sink, Counter: new(spliceTestCounter)}
			}
			var rawWriter net.Conn = writer
			if tc.noRawWriter {
				rawWriter = nil
			}
			var rawReader net.Conn = reader
			if tc.helperFallback {
				// Keep a working TCP stream but hide its concrete type from
				// copyAccountedSplice, so its handled=false fallback is exercised.
				rawReader = struct{ net.Conn }{reader}
			}
			finished := make(chan struct{})
			var copyErr error
			go func() {
				copyErr = CopyRawConnIfExist(ctx, rawReader, rawWriter, sink, timer, inTimer)
				close(finished)
			}()
			t.Cleanup(func() {
				_ = reader.Close()
				_ = writer.Close()
				for _, d := range watched {
					d.timer.SetTimeout(0)
				}
				select {
				case <-finished:
				case <-time.After(2 * time.Second):
					t.Error("raw copy goroutine did not exit after socket close")
				}
			})
			assertAlive := func() {
				t.Helper()
				for _, d := range watched {
					select {
					case <-d.fired:
						t.Fatalf("%s half-close deadline canceled an active small transfer", d.name)
					default:
					}
				}
				select {
				case <-finished:
					t.Fatalf("copy ended before input EOF: %v", copyErr)
				default:
				}
			}
			payload := bytes.Repeat([]byte{0xa7}, 1024)
			transfer := func() {
				t.Helper()
				assertAlive()
				if _, err := input.Write(payload); err != nil {
					t.Fatal(err)
				}
				got := make([]byte, len(payload))
				if _, err := io.ReadFull(output, got); err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(got, payload) {
					t.Fatal("raw copy changed payload")
				}
			}
			transfer()
			if !tc.early {
				// Receipt proves splice's old 24-hour assignment has happened.
				setHalfClose()
			}
			until := time.Now().Add(3 * idle)
			for time.Now().Before(until) {
				time.Sleep(5 * time.Millisecond)
				transfer()
			}
			assertAlive()
			if !tc.noRawWriter && tc.copyState == 0 && inbound.CanSpliceCopy.Load() != session.SpliceCopySplicing {
				t.Fatal("did not enter the raw splice branch")
			}
			// Do not close either direction: only inactivity may end these timers.
			deadline := time.NewTimer(3 * idle)
			defer deadline.Stop()
			for _, d := range watched {
				select {
				case <-d.fired:
				case <-deadline.C:
					t.Fatalf("%s half-close deadline did not expire after traffic stopped", d.name)
				}
				if got := d.calls.Load(); got != 1 {
					t.Fatalf("%s cancellation count = %d, want 1", d.name, got)
				}
			}
		})
	}
}

type spliceActivityDeadline struct {
	name  string
	timer *signal.ActivityTimer
	fired chan struct{}
	calls atomic.Int32
}

// Closing the socket owning a blocked poll operation must release the copy
// goroutine. Neither case supplies EOF nor drains a blocked destination.
func TestCopyRawConnCloseWakesBlockedSplice(t *testing.T) {
	for _, blocked := range []string{"read", "write"} {
		t.Run(blocked, func(t *testing.T) {
			reader, input := tcpConnPair(t)
			writer, output := tcpConnPair(t)
			for _, conn := range []*net.TCPConn{reader, input, writer, output} {
				t.Cleanup(func() { _ = conn.Close() })
				if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
					t.Fatal(err)
				}
			}
			if err := writer.SetWriteBuffer(1024); err != nil {
				t.Fatal(err)
			}
			if err := output.SetReadBuffer(1024); err != nil {
				t.Fatal(err)
			}
			metrics := new(spliceTestMetrics)
			inbound := &session.Inbound{Conn: writer, SpliceMetrics: metrics}
			inbound.CanSpliceCopy.Store(session.SpliceCopyDirect)
			outbound := &session.Outbound{}
			outbound.CanSpliceCopy.Store(session.SpliceCopyDirect)
			ctx := session.ContextWithInbound(context.Background(), inbound)
			ctx = session.ContextWithOutbounds(ctx, []*session.Outbound{outbound})
			finished := make(chan struct{})
			var copyErr error
			go func() {
				copyErr = CopyRawConnIfExist(ctx, reader, writer, buf.NewWriter(writer), signal.NewNoopActivityTimer(), nil)
				close(finished)
			}()
			var sent chan struct{}
			var sendErr error
			if blocked == "write" {
				sent = make(chan struct{})
				go func() {
					_, sendErr = input.Write(make([]byte, 8<<20))
					close(sent)
				}()
			}
			t.Cleanup(func() {
				for _, conn := range []*net.TCPConn{reader, input, writer, output} {
					_ = conn.Close()
				}
				select {
				case <-finished:
				case <-time.After(time.Second):
					t.Error("copy goroutine survived test cleanup")
				}
				if sent != nil {
					select {
					case <-sent:
					case <-time.After(time.Second):
						t.Error("writer goroutine survived test cleanup")
					}
				}
			})
			until := time.Now().Add(time.Second)
			for metrics.spliced.Load() == 0 || (blocked == "write" && metrics.bytes.Load() == 0) {
				if time.Now().After(until) {
					t.Fatal("splice did not begin its poll operation")
				}
				time.Sleep(time.Millisecond)
			}
			// With no source bytes (read) or no draining peer (write), the
			// entered splice must remain unfinished until its socket closes.
			time.Sleep(30 * time.Millisecond)
			select {
			case <-finished:
				t.Fatalf("copy unexpectedly finished before socket close: %v", copyErr)
			default:
			}
			if blocked == "write" {
				select {
				case <-sent:
					t.Fatalf("write unexpectedly completed without a reader: %v", sendErr)
				default:
				}
				_ = writer.Close()
			} else {
				_ = reader.Close()
			}
			select {
			case <-finished:
				if copyErr == nil {
					t.Fatal("blocked copy returned clean EOF without peer half-close")
				}
			case <-time.After(time.Second):
				t.Fatal("socket close did not wake blocked splice")
			}
			if sent != nil {
				_ = input.Close()
				select {
				case <-sent:
				case <-time.After(time.Second):
					t.Fatal("input writer did not exit after close")
				}
			}
		})
	}
}
