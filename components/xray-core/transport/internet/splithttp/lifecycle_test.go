package splithttp

import (
	"bytes"
	"context"
	"errors"
	"io"
	stdnet "net"
	"net/http"
	"net/http/httptrace"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xtls/xray-core/common/buf"
	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/signal/done"
	"github.com/xtls/xray-core/transport/internet"
	"github.com/xtls/xray-core/transport/pipe"
)

type trackedBody struct{ closed atomic.Int32 }

func (b *trackedBody) Read([]byte) (int, error) { return 0, io.EOF }
func (b *trackedBody) Close() error             { b.closed.Add(1); return nil }

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestStreamReleasesUploadBody(t *testing.T) {
	for _, fail := range []bool{false, true} {
		body := &trackedBody{}
		a, b := stdnet.Pipe()
		defer a.Close()
		defer b.Close()
		client := &DefaultDialerClient{transportConfig: &Config{}, client: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if fail {
				return nil, errors.New("test failure")
			}
			httptrace.ContextClientTrace(r.Context()).GotConn(httptrace.GotConnInfo{Conn: a})
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(bytes.NewReader(nil))}, nil
		})}}
		reader, _, _, err := client.OpenStream(context.Background(), "http://example.com/", "test", body, true)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = reader.Read(make([]byte, 1)); !errors.Is(err, io.ErrClosedPipe) {
			t.Fatalf("Read: %v", err)
		}
		reader.Close()
		if body.closed.Load() == 0 {
			t.Fatal("upload body leaked")
		}
	}
}

func TestInvalidStreamURLClosesBody(t *testing.T) {
	body := &trackedBody{}
	client := &DefaultDialerClient{transportConfig: &Config{}}
	if _, _, _, err := client.OpenStream(context.Background(), "http://bad host/", "test", body, false); err == nil {
		t.Fatal("invalid host accepted")
	}
	if body.closed.Load() != 1 {
		t.Fatal("invalid request leaked its body")
	}
}

func TestWaitReadCloserConcurrentLifecycle(t *testing.T) {
	for range 1000 {
		wrapper := &WaitReadCloser{wait: done.New()}
		body := &trackedBody{}
		var group sync.WaitGroup
		group.Add(3)
		go func() { defer group.Done(); wrapper.Set(body) }()
		go func() { defer group.Done(); wrapper.Read(make([]byte, 1)) }()
		go func() { defer group.Done(); wrapper.Close() }()
		group.Wait()
		if body.closed.Load() != 1 {
			t.Fatalf("body closed %d times", body.closed.Load())
		}
	}
}

func TestUploadWriterCountsReleasedBuffers(t *testing.T) {
	payload := bytes.Repeat([]byte{'x'}, 3*int(buf.Size)+17)
	reader, pipeWriter := pipe.New(pipe.WithSizeLimit(0))
	defer pipeWriter.Close()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		for {
			packets, err := reader.ReadMultiBuffer()
			buf.ReleaseMulti(packets)
			if err != nil {
				return
			}
		}
	}()
	writer := uploadWriter{Writer: pipeWriter}
	for range 100 {
		if n, err := writer.Write(payload); err != nil || n != len(payload) {
			t.Fatalf("Write: %d, %v", n, err)
		}
	}
	pipeWriter.Close()
	<-finished
}

func TestPacketRequestCanReplayBody(t *testing.T) {
	payload := bytes.Repeat([]byte("hello"), int(buf.Size))
	request, err := http.NewRequest("POST", "https://example.com/", nil)
	if err != nil {
		t.Fatal(err)
	}
	config := &Config{}
	if err := config.FillPacketRequest(request, "test", "0", buf.MergeBytes(nil, payload)); err != nil {
		t.Fatal(err)
	}
	if request.GetBody == nil {
		t.Fatal("request cannot replay after GOAWAY")
	}
	for range 2 {
		reader, err := request.GetBody()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		reader.Close()
		if err != nil || !bytes.Equal(data, payload) {
			t.Fatal("replayed body differs")
		}
	}
	request.Body.Close()
}

type closingXmuxConn struct{ closed atomic.Int32 }

func (c *closingXmuxConn) IsClosed() bool { return c.closed.Load() > 0 }
func (c *closingXmuxConn) Close() error   { c.closed.Add(1); return nil }
func TestRetiredXmuxWaitsForRunningStream(t *testing.T) {
	conn := &closingXmuxConn{}
	client := &XmuxClient{XmuxConn: conn}
	client.AddRunning()
	client.NotUsed.Store(true)
	client.maybeClose()
	if conn.closed.Load() != 0 {
		t.Fatal("retirement closed an active stream")
	}
	client.DoneRunning()
	if conn.closed.Load() != 1 {
		t.Fatal("idle retired transport not closed")
	}
}

func TestUploadQueueCloseUnblocksFullQueue(t *testing.T) {
	queue := NewUploadQueue(1)
	if err := queue.Push(Packet{Payload: []byte("first")}); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- queue.Push(Packet{Payload: []byte("second"), Seq: 1}) }()
	queue.Close()
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("push to closed queue succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("close did not unblock producer")
	}
}

func TestUploadQueueConcurrentClose(t *testing.T) {
	for range 1000 {
		queue := NewUploadQueue(1)
		body := &trackedBody{}
		if err := queue.Push(Packet{Reader: body}); err != nil {
			t.Fatal(err)
		}
		var group sync.WaitGroup
		group.Add(3)
		go func() { defer group.Done(); queue.Read(make([]byte, 1)) }()
		go func() { defer group.Done(); queue.Close() }()
		go func() { defer group.Done(); queue.Close() }()
		group.Wait()
		if body.closed.Load() != 1 {
			t.Fatalf("body closed %d times", body.closed.Load())
		}
	}
}

func TestRetiredXmuxWaitsForPacketReferences(t *testing.T) {
	conn := &closingXmuxConn{}
	client := &XmuxClient{XmuxConn: conn}
	// One uploader reference and two outstanding packet requests.
	for range 3 {
		client.retain()
	}
	client.NotUsed.Store(true)
	client.maybeClose()
	client.release()
	if conn.closed.Load() != 0 {
		t.Fatal("retirement closed outstanding packets")
	}
	var group sync.WaitGroup
	group.Add(2)
	for range 2 {
		go func() { defer group.Done(); client.release() }()
	}
	group.Wait()
	if conn.closed.Load() != 1 {
		t.Fatalf("retired transport closed %d times", conn.closed.Load())
	}
}

func TestInvalidDialReleasesXmuxReservation(t *testing.T) {
	settings := &internet.MemoryStreamConfig{
		ProtocolName:     "splithttp",
		ProtocolSettings: &Config{Host: "bad host", Mode: "stream-one"},
	}
	dest := xnet.TCPDestination(xnet.LocalHostIP, 1)
	if conn, err := Dial(context.Background(), dest, settings); err == nil {
		conn.Close()
		t.Fatal("invalid host accepted")
	}
	globalDialerAccess.Lock()
	manager := globalDialerMap[dialerConf{dest, settings}]
	delete(globalDialerMap, dialerConf{dest, settings})
	globalDialerAccess.Unlock()
	if manager == nil || len(manager.xmuxClients) != 1 {
		t.Fatal("expected one acquired transport")
	}
	client := manager.xmuxClients[0]
	if client.Running.Load() != 0 || client.references.Load() != 0 {
		t.Fatalf("failed dial leaked running=%d references=%d", client.Running.Load(), client.references.Load())
	}
}
