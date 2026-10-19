package stats

import (
	"math"
	"sync/atomic"
)

// Counter is an implementation of stats.Counter.
type Counter struct {
	value int64
	// The managed Linux data plane can keep the same cumulative counter across process
	// replacement. The mapping stays alive until process exit: active connections may still
	// hold a counter after Manager.Close or UnregisterCounter.
	mapped *int64
	// addOnly is reserved for a delegated view of an existing owner's journal.
	// The owner remains responsible for publishing and retiring the namespace.
	addOnly bool
}

func (c *Counter) pointer() *int64 {
	if c.mapped != nil {
		return c.mapped
	}
	return &c.value
}

// Value implements stats.Counter.
func (c *Counter) Value() int64 {
	return atomic.LoadInt64(c.pointer())
}

// Set implements stats.Counter.
func (c *Counter) Set(newValue int64) int64 {
	if c.addOnly {
		panic("delegated accounting counter cannot be reset")
	}
	return atomic.SwapInt64(c.pointer(), newValue)
}

// Add implements stats.Counter.
func (c *Counter) Add(delta int64) int64 {
	if c.addOnly {
		if delta < 0 {
			panic("delegated accounting counter cannot decrease")
		}
		for {
			old := atomic.LoadInt64(c.pointer())
			if old < 0 || delta > math.MaxInt64-old {
				panic("delegated accounting counter overflow or invalid baseline")
			}
			if atomic.CompareAndSwapInt64(c.pointer(), old, old+delta) {
				return old + delta
			}
		}
	}
	return atomic.AddInt64(c.pointer(), delta)
}
