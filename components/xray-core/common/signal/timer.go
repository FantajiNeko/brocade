package signal

import (
	"context"
	"sync"
	"sync/atomic"
	"time"
)

type ActivityUpdater interface {
	Update()
}

type ActivityTimer struct {
	mu        sync.Mutex
	updated   chan struct{}
	period    *activityTimerPeriod
	onTimeout func()
	consumed  atomic.Bool
}

// Each timeout change owns a distinct period. Stopping a timer does not stop a
// callback that has already started, so callbacks must verify this identity.
type activityTimerPeriod struct {
	timer   *time.Timer
	timeout time.Duration
}

// NewNoopActivityTimer returns an updater that never owns cancellation or
// half-close deadlines. It is used by long-lived control transports whose
// lifecycle is governed by their own protocol state machine.
func NewNoopActivityTimer() *ActivityTimer {
	timer := &ActivityTimer{
		updated:   make(chan struct{}, 1),
		onTimeout: func() {},
	}
	timer.consumed.Store(true)
	return timer
}

func (t *ActivityTimer) Update() {
	select {
	case t.updated <- struct{}{}:
	default:
	}
}

func (t *ActivityTimer) check(period *activityTimerPeriod) {
	t.mu.Lock()
	if t.consumed.Load() || t.period != period {
		t.mu.Unlock()
		return
	}
	select {
	case <-t.updated:
		period.timer.Reset(period.timeout)
		t.mu.Unlock()
	default:
		onTimeout := t.finishLocked()
		t.mu.Unlock()
		onTimeout()
	}
}

// finishLocked claims cancellation under mu. The caller invokes the callback
// after unlocking, so cancellation may safely call back into the timer.
func (t *ActivityTimer) finishLocked() func() {
	t.consumed.Store(true)
	if t.period != nil {
		t.period.timer.Stop()
		t.period = nil
	}
	return t.onTimeout
}

func (t *ActivityTimer) SetTimeout(timeout time.Duration) {
	if t.consumed.Load() {
		return
	}
	t.setTimeout(timeout, time.AfterFunc)
}

// The scheduler parameter permits controlled callback dispatch in concurrency
// tests without mutable global hooks or per-connection scheduler state.
func (t *ActivityTimer) setTimeout(timeout time.Duration, afterFunc func(time.Duration, func()) *time.Timer) {
	t.mu.Lock()
	if t.consumed.Load() {
		t.mu.Unlock()
		return
	}
	if timeout == 0 {
		onTimeout := t.finishLocked()
		t.mu.Unlock()
		onTimeout()
		return
	}
	if t.period != nil {
		t.period.timer.Stop()
	}
	// A timeout change starts a fresh observation window. Superseded callbacks
	// must not consume activity from this window or cancel it.
	select {
	case <-t.updated:
	default:
	}
	period := &activityTimerPeriod{timeout: timeout}
	t.period = period
	period.timer = afterFunc(timeout, func() { t.check(period) })
	t.mu.Unlock()
}

func CancelAfterInactivity(ctx context.Context, cancel context.CancelFunc, timeout time.Duration) *ActivityTimer {
	timer := &ActivityTimer{
		updated:   make(chan struct{}, 1),
		onTimeout: cancel,
	}
	timer.SetTimeout(timeout)
	return timer
}
