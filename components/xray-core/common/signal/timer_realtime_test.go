package signal

import (
	"context"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestActivityTimerRealTimeShortTimeoutRace(t *testing.T) {
	// Deliberately outside synctest: real deadlines must advance while workers
	// remain runnable. The deterministic gate test covers the required ordering;
	// this exercise additionally checks actual runtime scheduling under -race.
	watchdog := time.NewTimer(10 * time.Second)
	defer watchdog.Stop()
	for round := range 64 {
		var calls atomic.Int32
		expired := make(chan struct{})
		timer := CancelAfterInactivity(context.Background(), func() {
			if calls.Add(1) == 1 {
				close(expired)
			}
		}, time.Hour)
		start := make(chan struct{})
		var workers sync.WaitGroup
		workers.Go(func() {
			<-start
			for range 256 {
				timer.Update()
				runtime.Gosched()
			}
		})
		for worker := range 4 {
			workers.Go(func() {
				<-start
				for range 16 {
					timer.Update()
					timer.SetTimeout(time.Duration(worker+1) * time.Nanosecond)
					runtime.Gosched()
				}
			})
		}
		close(start)
		workersDone := make(chan struct{})
		go func() {
			workers.Wait()
			close(workersDone)
		}()
		select {
		case <-workersDone:
		case <-watchdog.C:
			stack := make([]byte, 64<<10)
			t.Fatalf("round %d: Update/SetTimeout workers blocked\n%s", round, stack[:runtime.Stack(stack, true)])
		}
		select {
		case <-expired:
		case <-watchdog.C:
			t.Fatalf("round %d: short deadline did not expire", round)
		}
		// Once every resetting worker is gone, neither later activity nor a
		// fresh deadline may revive the consumed timer.
		timer.Update()
		timer.SetTimeout(time.Nanosecond)
		timer.SetTimeout(0)
		if got := calls.Load(); got != 1 {
			t.Fatalf("round %d: callback calls = %d, want 1", round, got)
		}
	}
}
