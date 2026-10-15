package stats

import "sync/atomic"

// Counter is an implementation of stats.Counter.
type Counter struct {
	value int64
	// The managed Linux data plane can keep the same cumulative counter across process
	// replacement. The mapping stays alive until process exit: active connections may still
	// hold a counter after Manager.Close or UnregisterCounter.
	mapped *int64
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
	return atomic.SwapInt64(c.pointer(), newValue)
}

// Add implements stats.Counter.
func (c *Counter) Add(delta int64) int64 {
	return atomic.AddInt64(c.pointer(), delta)
}
