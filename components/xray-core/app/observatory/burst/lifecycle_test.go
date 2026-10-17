package burst

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/features/routing"
	"github.com/xtls/xray-core/transport"
	_ "github.com/xtls/xray-core/transport/internet/tagged/taggedimpl"
)

type cancelDispatcher struct {
	routing.Dispatcher
	started chan struct{}
	stopped chan struct{}
}

func (d *cancelDispatcher) Dispatch(ctx context.Context, _ net.Destination) (*transport.Link, error) {
	select {
	case d.started <- struct{}{}:
	default:
	}
	<-ctx.Done()
	select {
	case d.stopped <- struct{}{}:
	default:
	}
	return nil, ctx.Err()
}

func awaitSignal(t *testing.T, ch <-chan struct{}, label string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", label)
	}
}

func TestHealthPingMinimumInterval(t *testing.T) {
	for _, test := range []struct{ input, want time.Duration }{
		{0, time.Minute}, {time.Second, 10 * time.Second}, {10 * time.Second, 10 * time.Second}, {20 * time.Second, 20 * time.Second},
	} {
		h := NewHealthPing(context.Background(), nil, &HealthPingConfig{Interval: int64(test.input)})
		if h.Settings.Interval != test.want {
			t.Errorf("interval %s: got %s, want %s", test.input, h.Settings.Interval, test.want)
		}
		h.StopScheduler()
	}
}

func TestHealthPingCanceledBatchStopsActiveDial(t *testing.T) {
	dispatcher := &cancelDispatcher{started: make(chan struct{}, 1), stopped: make(chan struct{}, 1)}
	ctx := context.WithValue(context.Background(), core.XrayKey(1), &core.Instance{})
	h := NewHealthPing(ctx, dispatcher, &HealthPingConfig{Destination: "http://probe.test/", Timeout: int64(time.Minute)})
	defer h.StopScheduler()
	batchCtx, cancel := context.WithCancel(h.ctx)
	defer cancel()
	finished := make(chan struct{})
	go func() { defer close(finished); h.doCheck(batchCtx, []string{"test"}, 0, 1) }()
	awaitSignal(t, dispatcher.started, "active dial")
	cancel()
	awaitSignal(t, finished, "batch cancellation")
	awaitSignal(t, dispatcher.stopped, "dial cancellation")
	h.access.Lock()
	defer h.access.Unlock()
	if len(h.Results) != 0 {
		t.Fatal("canceled probe recorded a failure")
	}
}

func TestHealthPingSchedulerChecksImmediatelyAndStops(t *testing.T) {
	dispatcher := &cancelDispatcher{started: make(chan struct{}, 1), stopped: make(chan struct{}, 1)}
	ctx := context.WithValue(context.Background(), core.XrayKey(1), &core.Instance{})
	h := NewHealthPing(ctx, dispatcher, &HealthPingConfig{Destination: "http://probe.test/", Interval: int64(time.Hour), Timeout: int64(time.Minute), SamplingCount: 1})
	defer h.StopScheduler()
	h.StartScheduler(func() ([]string, error) { return []string{"test"}, nil })
	awaitSignal(t, dispatcher.started, "initial probe before the sampling interval")
	h.StopScheduler()
	awaitSignal(t, dispatcher.stopped, "scheduler cancellation")
}

func TestHealthPingCanceledBatchDoesNotDial(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	h := NewHealthPing(ctx, nil, nil)
	defer h.StopScheduler()
	// A canceled check must return before scheduling timers or using the dispatcher.
	h.doCheck(ctx, []string{"test"}, time.Hour, 10)
	if len(h.Results) != 0 {
		t.Fatal("canceled batch produced results")
	}
}

func TestPingCancellationReachesHTTPServer(t *testing.T) {
	started, stopped := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(stopped)
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := newDirectPingClient(ctx, server.URL, time.Minute)
	result := make(chan error, 1)
	go func() { _, err := client.MeasureDelay(http.MethodHead); result <- err }()
	awaitSignal(t, started, "HTTP request")
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("request error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("request did not stop on cancellation")
	}
	awaitSignal(t, stopped, "HTTP connection cancellation")
}

func TestHealthPingUntestedSlotsDoNotCount(t *testing.T) {
	result := NewHealthPingResult(10, time.Hour)
	result.Put(25 * time.Millisecond)
	stats := result.Get()
	if stats.All != 1 || stats.Fail != 0 || stats.Average != 25*time.Millisecond {
		t.Fatalf("unused slots affected statistics: %+v", stats)
	}
}
