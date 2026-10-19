package dispatcher

import (
	"github.com/xtls/xray-core/common"
	"github.com/xtls/xray-core/common/buf"
	"github.com/xtls/xray-core/features/stats"
)

type SizeStatWriter struct {
	Counter stats.Counter
	Writer  buf.Writer
}

// fanoutCounter keeps the existing billable counter authoritative while mirroring each byte into
// the current source-IP session. It is attached only to a live connection and is never registered
// in the stats manager, so Value/Set retain the primary counter's ordinary semantics.
type fanoutCounter struct {
	primary   stats.Counter
	secondary stats.Counter
}

func (c *fanoutCounter) Value() int64 {
	if c.primary != nil {
		return c.primary.Value()
	}
	return c.secondary.Value()
}

func (c *fanoutCounter) Set(value int64) int64 {
	var previous int64
	if c.primary != nil {
		previous = c.primary.Set(value)
	} else {
		previous = c.secondary.Value()
	}
	if c.secondary != nil {
		c.secondary.Set(value)
	}
	return previous
}

func (c *fanoutCounter) Add(value int64) int64 {
	var current int64
	if c.primary != nil {
		current = c.primary.Add(value)
	}
	if c.secondary != nil {
		secondary := c.secondary.Add(value)
		if c.primary == nil {
			current = secondary
		}
	}
	return current
}

func withSecondaryCounter(primary, secondary stats.Counter) stats.Counter {
	if primary == nil {
		return secondary
	}
	if secondary == nil {
		return primary
	}
	return &fanoutCounter{primary: primary, secondary: secondary}
}

func (w *SizeStatWriter) WriteMultiBuffer(mb buf.MultiBuffer) error {
	w.Counter.Add(int64(mb.Len()))
	return w.Writer.WriteMultiBuffer(mb)
}

func (w *SizeStatWriter) Close() error {
	return common.Close(w.Writer)
}

func (w *SizeStatWriter) Interrupt() {
	common.Interrupt(w.Writer)
}
