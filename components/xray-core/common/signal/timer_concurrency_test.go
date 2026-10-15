package signal

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestActivityTimerConcurrentCallbackReentry(t *testing.T) {
	for _, immediate := range []bool{false, true} {
		name := "scheduled"
		if immediate {
			name = "immediate"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var calls atomic.Int32
				ready := make(chan struct{})
				var timer *ActivityTimer
				timer = CancelAfterInactivity(context.Background(), func() {
					<-ready
					calls.Add(1)
					// A cancellation callback may synchronously notify code that
					// updates the same connection's half-close deadline.
					timer.Update()
					timer.SetTimeout(time.Hour)
					timer.SetTimeout(0)
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
				time.Sleep(2 * time.Hour)
				synctest.Wait()
				if got := calls.Load(); got != 1 {
					t.Fatalf("callback reentry revived the timer: calls = %d", got)
				}
			})
		})
	}
}

func TestActivityTimerConcurrentZeroTimeoutExactlyOnce(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int32
		timer := CancelAfterInactivity(context.Background(), func() {
			calls.Add(1)
		}, time.Hour)
		start := make(chan struct{})
		var workers sync.WaitGroup
		for range 32 {
			workers.Go(func() {
				<-start
				timer.SetTimeout(0)
				timer.Update()
				timer.SetTimeout(time.Hour)
			})
		}
		close(start)
		workers.Wait()
		synctest.Wait()
		if got := calls.Load(); got != 1 {
			t.Fatalf("concurrent expiration calls = %d, want 1", got)
		}
		time.Sleep(2 * time.Hour)
		synctest.Wait()
		if got := calls.Load(); got != 1 {
			t.Fatalf("reset after concurrent expiration revived timer: calls = %d", got)
		}
	})
}

func TestActivityTimerConcurrentExpiredCallbackDoesNotBlockReset(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		entered := make(chan struct{})
		release := make(chan struct{})
		var calls atomic.Int32
		timer := CancelAfterInactivity(context.Background(), func() {
			calls.Add(1)
			close(entered)
			<-release
		}, time.Second)
		time.Sleep(time.Second)
		<-entered
		var workers sync.WaitGroup
		for _, timeout := range []time.Duration{0, time.Hour} {
			workers.Go(func() {
				timer.SetTimeout(timeout)
				timer.Update()
			})
		}
		// These calls must not wait for the already-selected cancellation
		// callback, which can itself be waiting for a connection owner.
		workers.Wait()
		close(release)
		synctest.Wait()
		time.Sleep(2 * time.Hour)
		synctest.Wait()
		if got := calls.Load(); got != 1 {
			t.Fatalf("callback calls = %d, want 1", got)
		}
	})
}

func TestActivityTimerConcurrentActivityAndReset(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int32
		timer := CancelAfterInactivity(context.Background(), func() {
			calls.Add(1)
		}, time.Second)
		time.Sleep(500 * time.Millisecond)
		timer.Update()
		time.Sleep(500 * time.Millisecond)
		synctest.Wait()
		if got := calls.Load(); got != 0 {
			t.Fatalf("activity did not defer expiration: calls = %d", got)
		}
		start := make(chan struct{})
		var workers sync.WaitGroup
		for _, timeout := range []time.Duration{10 * time.Second, 20 * time.Second} {
			workers.Go(func() {
				<-start
				timer.SetTimeout(timeout)
			})
		}
		close(start)
		workers.Wait()
		synctest.Wait()
		// Either reset may win, but neither permits the replaced one-second
		// deadline to cancel this connection.
		time.Sleep(9 * time.Second)
		synctest.Wait()
		if got := calls.Load(); got != 0 {
			t.Fatalf("replaced deadline expired: calls = %d", got)
		}
		time.Sleep(12 * time.Second)
		synctest.Wait()
		if got := calls.Load(); got != 1 {
			t.Fatalf("latest deadline calls = %d, want 1", got)
		}
	})
}

func TestActivityTimerConcurrentNoop(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		timer := NewNoopActivityTimer()
		var workers sync.WaitGroup
		for range 32 {
			workers.Go(func() {
				for range 16 {
					timer.Update()
					timer.SetTimeout(0)
					timer.SetTimeout(time.Nanosecond)
					timer.SetTimeout(time.Hour)
				}
			})
		}
		workers.Wait()
		time.Sleep(2 * time.Hour)
		synctest.Wait()
		if !timer.consumed.Load() || activityTimerTestPeriod(timer) != nil {
			t.Fatal("noop timer acquired a cancellation deadline")
		}
	})
}

func TestActivityTimerConcurrentStalePeriodCannotConsumeActivity(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int32
		timer := CancelAfterInactivity(context.Background(), func() {
			calls.Add(1)
		}, time.Hour)
		timer.mu.Lock()
		oldPeriod := timer.period
		timer.mu.Unlock()
		timer.SetTimeout(10 * time.Second)
		timer.mu.Lock()
		middlePeriod := timer.period
		timer.mu.Unlock()
		timer.SetTimeout(20 * time.Second)
		timer.mu.Lock()
		currentPeriod := timer.period
		currentTimer := currentPeriod.timer
		timer.mu.Unlock()
		if oldPeriod == middlePeriod || middlePeriod == currentPeriod || oldPeriod == currentPeriod {
			t.Fatal("replacement deadlines must have distinct period identities")
		}

		timer.Update()
		// AfterFunc.Stop cannot retract a callback that was already dispatched.
		// Use the actual captured period identities to model two such callbacks
		// resuming after both resets; do not alter channels or fabricate state.
		timer.check(oldPeriod)
		timer.check(middlePeriod)
		if got := calls.Load(); got != 0 {
			t.Fatalf("stale callback canceled the replacement deadline: calls = %d", got)
		}
		time.Sleep(20 * time.Second)
		synctest.Wait()
		if got := calls.Load(); got != 0 {
			t.Fatalf("stale callback consumed replacement activity: calls = %d", got)
		}
		timer.mu.Lock()
		reused := timer.period == currentPeriod && currentPeriod.timer == currentTimer
		timer.mu.Unlock()
		if !reused {
			t.Fatal("activity check replaced the current period or timer instead of reusing it")
		}
		time.Sleep(20*time.Second - time.Nanosecond)
		synctest.Wait()
		if got := calls.Load(); got != 0 {
			t.Fatalf("replacement deadline expired early: calls = %d", got)
		}
		time.Sleep(time.Nanosecond)
		synctest.Wait()
		if got := calls.Load(); got != 1 {
			t.Fatalf("replacement deadline calls = %d, want 1", got)
		}

		// Even a duplicate callback from the last period cannot resurrect an
		// expired timer or invoke its owner a second time.
		timer.check(oldPeriod)
		timer.check(middlePeriod)
		timer.check(currentPeriod)
		timer.SetTimeout(time.Hour)
		timer.Update()
		time.Sleep(2 * time.Hour)
		synctest.Wait()
		if got := calls.Load(); got != 1 {
			t.Fatalf("late callbacks revived the expired timer: calls = %d", got)
		}
	})
}

func TestActivityTimerConcurrentObservationWindows(t *testing.T) {
	for _, active := range []bool{false, true} {
		name := "initial"
		if active {
			name = "active"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var calls atomic.Int32
				timer := CancelAfterInactivity(context.Background(), func() {
					calls.Add(1)
				}, time.Second)
				time.Sleep(500 * time.Millisecond)
				if active {
					timer.Update()
				}
				time.Sleep(500*time.Millisecond - time.Nanosecond)
				synctest.Wait()
				if got := calls.Load(); got != 0 {
					t.Fatalf("timer expired before its initial interval: calls = %d", got)
				}
				time.Sleep(time.Nanosecond)
				synctest.Wait()
				if active {
					if got := calls.Load(); got != 0 {
						t.Fatalf("activity did not preserve the next interval: calls = %d", got)
					}
					time.Sleep(time.Second - time.Nanosecond)
					synctest.Wait()
					if got := calls.Load(); got != 0 {
						t.Fatalf("extended interval expired early: calls = %d", got)
					}
					time.Sleep(time.Nanosecond)
					synctest.Wait()
				}
				if got := calls.Load(); got != 1 {
					t.Fatalf("callback calls = %d, want 1", got)
				}
			})
		})
	}
}

func TestActivityTimerConcurrentNegativeTimeoutIsAsynchronous(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		entered := make(chan struct{})
		release := make(chan struct{})
		var calls atomic.Int32
		timer := CancelAfterInactivity(context.Background(), func() {
			calls.Add(1)
			close(entered)
			<-release
		}, -time.Nanosecond)
		// A negative duration schedules asynchronous expiration. Construction
		// must return even when the cancellation callback cannot yet return.
		<-entered
		timer.SetTimeout(time.Hour)
		timer.Update()
		close(release)
		synctest.Wait()
		time.Sleep(2 * time.Hour)
		synctest.Wait()
		if got := calls.Load(); got != 1 {
			t.Fatalf("negative timeout calls = %d, want 1", got)
		}
	})
}

func TestActivityTimerConcurrentUpdateAllocations(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		timer := CancelAfterInactivity(context.Background(), func() {}, time.Hour)
		defer timer.SetTimeout(0)
		// Exercise both channel branches without changing its production shape.
		if got := testing.AllocsPerRun(1000, func() {
			timer.Update()
			<-timer.updated
		}); got != 0 {
			t.Fatalf("Update with an empty activity slot allocated %v times", got)
		}
		timer.Update()
		if got := testing.AllocsPerRun(1000, timer.Update); got != 0 {
			t.Fatalf("Update with a full activity slot allocated %v times", got)
		}
	})
}

func TestActivityTimerConcurrentActiveUpdatesResetsAndExpiration(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int32
		timer := CancelAfterInactivity(context.Background(), func() {
			calls.Add(1)
		}, time.Hour)
		start := make(chan struct{})
		var workers sync.WaitGroup
		for worker := range 32 {
			workers.Go(func() {
				<-start
				for range 32 {
					timer.Update()
					timer.SetTimeout(time.Hour + time.Duration(worker)*time.Second)
					timer.Update()
				}
			})
		}
		close(start)
		workers.Wait()
		synctest.Wait()
		if got := calls.Load(); got != 0 {
			t.Fatalf("active Update/SetTimeout competition canceled timer: calls = %d", got)
		}

		expire := make(chan struct{})
		for worker := range 32 {
			workers.Go(func() {
				<-expire
				for range 32 {
					timer.Update()
					if worker%2 == 0 {
						timer.SetTimeout(0)
					} else {
						timer.SetTimeout(time.Hour)
					}
				}
			})
		}
		close(expire)
		workers.Wait()
		synctest.Wait()
		if got := calls.Load(); got != 1 {
			t.Fatalf("Update/reset/expiration competition calls = %d, want 1", got)
		}
		time.Sleep(2 * time.Hour)
		synctest.Wait()
		if got := calls.Load(); got != 1 {
			t.Fatalf("competing updates revived expired timer: calls = %d", got)
		}
	})
}

func TestActivityTimerConcurrentDispatchedCallbackAfterReset(t *testing.T) {
	for _, active := range []bool{false, true} {
		name := "idle"
		if active {
			name = "active"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var calls atomic.Int32
				timer := CancelAfterInactivity(context.Background(), func() {
					calls.Add(1)
				}, time.Hour)
				entered := make(chan struct{})
				release := make(chan struct{})
				returned := make(chan struct{})
				var dispatches atomic.Int32
				// Use a real AfterFunc, gating the actual production closure
				// before it reads any period state. Calling check(oldPeriod)
				// directly would miss a closure that incorrectly reads t.period.
				timer.setTimeout(time.Second, func(delay time.Duration, callback func()) *time.Timer {
					return time.AfterFunc(delay, func() {
						first := dispatches.Add(1) == 1
						if first {
							close(entered)
							<-release
						}
						callback()
						if first {
							close(returned)
						}
					})
				})
				dispatched := activityTimerTestPeriod(timer).timer
				time.Sleep(time.Second)
				<-entered
				if dispatched.Stop() {
					t.Fatal("callback had not been dispatched before reset")
				}
				timer.SetTimeout(10 * time.Second)
				timer.SetTimeout(20 * time.Second)
				if active {
					timer.Update()
				}
				close(release)
				<-returned
				synctest.Wait()
				if got := calls.Load(); got != 0 {
					t.Fatalf("dispatched callback canceled replacement: calls = %d", got)
				}
				time.Sleep(20*time.Second - time.Nanosecond)
				synctest.Wait()
				if got := calls.Load(); got != 0 {
					t.Fatalf("replacement expired early: calls = %d", got)
				}
				time.Sleep(time.Nanosecond)
				synctest.Wait()
				if active {
					if got := calls.Load(); got != 0 {
						t.Fatalf("dispatched callback consumed replacement activity: calls = %d", got)
					}
					time.Sleep(20 * time.Second)
					synctest.Wait()
				}
				if got := calls.Load(); got != 1 {
					t.Fatalf("replacement callback calls = %d, want 1", got)
				}
				if got := dispatches.Load(); got != 1 {
					t.Fatalf("superseded timer dispatched %d callbacks, want 1", got)
				}
			})
		})
	}

}

func TestActivityTimerConcurrentStopsSupersededTimers(t *testing.T) {
	for _, rearmed := range []bool{false, true} {
		name := "pending"
		if rearmed {
			name = "rearmed"
		}
		t.Run(name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var calls atomic.Int32
				timer := CancelAfterInactivity(context.Background(), func() {
					calls.Add(1)
				}, time.Hour)
				if rearmed {
					timer.Update()
					time.Sleep(time.Hour)
					synctest.Wait()
				}
				superseded := activityTimerTestPeriod(timer).timer
				timer.SetTimeout(2 * time.Hour)
				// No time has advanced to these deadlines. A true return
				// therefore proves the old AfterFunc was left scheduled.
				if superseded.Stop() {
					t.Error("superseded AfterFunc was still scheduled")
				}
				finished := activityTimerTestPeriod(timer).timer
				timer.SetTimeout(0)
				if finished.Stop() {
					t.Error("finished AfterFunc was still scheduled")
				}
				if activityTimerTestPeriod(timer) != nil {
					t.Error("finished timer retained its period")
				}
				if got := calls.Load(); got != 1 {
					t.Fatalf("callback calls = %d, want 1", got)
				}
			})
		})
	}

}

func TestActivityTimerConcurrentShortActivePeriodsReuseTimer(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int32
		const interval = 10 * time.Nanosecond
		timer := CancelAfterInactivity(context.Background(), func() {
			calls.Add(1)
		}, interval)
		period := activityTimerTestPeriod(timer)
		scheduled := period.timer
		for round := range 64 {
			timer.Update()
			time.Sleep(interval)
			synctest.Wait()
			if got := calls.Load(); got != 0 {
				t.Fatalf("active period %d expired: calls = %d", round, got)
			}
			if activityTimerTestPeriod(timer) != period || period.timer != scheduled {
				t.Fatalf("active period %d replaced its timer", round)
			}
		}
		time.Sleep(interval - time.Nanosecond)
		synctest.Wait()
		if got := calls.Load(); got != 0 {
			t.Fatalf("idle interval expired early: calls = %d", got)
		}
		time.Sleep(time.Nanosecond)
		synctest.Wait()
		if got := calls.Load(); got != 1 {
			t.Fatalf("idle interval callback calls = %d, want 1", got)
		}
	})
}

func TestActivityTimerConcurrentResetDiscardsPreviousActivity(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int32
		timer := CancelAfterInactivity(context.Background(), func() {
			calls.Add(1)
		}, time.Hour)
		timer.Update()
		timer.SetTimeout(10 * time.Nanosecond)
		time.Sleep(9 * time.Nanosecond)
		synctest.Wait()
		if got := calls.Load(); got != 0 {
			t.Fatalf("replacement expired early: calls = %d", got)
		}
		time.Sleep(time.Nanosecond)
		synctest.Wait()
		if got := calls.Load(); got != 1 {
			t.Fatalf("activity before reset extended the fresh window: calls = %d", got)
		}
	})
}

func activityTimerTestPeriod(timer *ActivityTimer) *activityTimerPeriod {
	timer.mu.Lock()
	defer timer.mu.Unlock()
	return timer.period
}
