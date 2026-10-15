package signal

import (
	"context"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

// Keep this test independent of the scheduler representation so the same test
// can run against the historical Periodic implementation without an adapter.
func TestActivityTimerConcurrentCallbackOutsideLock(t *testing.T) {
	for _, immediate := range []bool{false, true} {
		name := "scheduled"
		if immediate {
			name = "immediate"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ready := make(chan struct{})
				var calls atomic.Int32
				var held atomic.Bool
				var timer *ActivityTimer
				timer = CancelAfterInactivity(context.Background(), func() {
					<-ready
					calls.Add(1)
					// Public SetTimeout reentry alone cannot prove this invariant:
					// consumed is already true and bypasses its lock entirely.
					if timer.mu.TryLock() {
						timer.mu.Unlock()
					} else {
						held.Store(true)
					}
				}, time.Second)
				close(ready)
				if immediate {
					timer.SetTimeout(0)
				} else {
					time.Sleep(time.Second)
				}
				synctest.Wait()
				if got := calls.Load(); got != 1 {
					t.Fatalf("callback calls = %d, want 1", got)
				}
				if held.Load() {
					t.Fatal("onTimeout ran while ActivityTimer.mu was held")
				}
			})
		})
	}
}
