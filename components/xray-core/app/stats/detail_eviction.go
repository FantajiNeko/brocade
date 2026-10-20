package stats

import (
	"strings"

	featurestats "github.com/xtls/xray-core/features/stats"
)

func (c *otherDomainCollector) forgetWindow(window *domainWindow) {
	if window == nil {
		return
	}
	window.pairs.Range(func(_, value any) bool {
		p := value.(*domainPair)
		if p.up.Load() != p.checkpointUp.Load() || p.down.Load() != p.checkpointDown.Load() {
			c.limited.Store(true)
		}
		delete(c.segments, p.id)
		return true
	})
}

func (c *otherDomainCounter) addCheckpointed(v int64) int64 {
	if v <= 0 {
		return c.Value()
	}
	for attempt := 0; attempt < 2; attempt++ {
		w := c.collector.current.Load()
		if w == nil {
			return c.Value()
		}
		p := c.pair.Load()
		if p.windowID != w.id || p.writers.Load() < 0 {
			if c.retryAt.Load() > c.collector.clock.Load() {
				return c.Value()
			}
			p, _ = c.collector.get(p.label, p.domain)
			if p == nil {
				c.retryAt.Store(c.collector.clock.Load() + 5)
				return c.Value()
			}
			c.pair.Store(p)
		}
		for {
			writers := p.writers.Load()
			if writers < 0 {
				break // Admission raced with retirement: rebind this same chunk once.
			}
			if !p.writers.CompareAndSwap(writers, writers+1) {
				continue
			}
			p.lastSeen.Store(c.collector.clock.Load())
			var value int64
			if c.uplink {
				value = p.up.Add(v)
			} else {
				value = p.down.Add(v)
			}
			p.writers.Add(-1)
			return value
		}
	}
	c.collector.limited.Store(true)
	return c.Value()
}

// evictIdle runs only on cold admission, under the collector mutex. A checkpoint means the
// Agent has fsynced these exact cumulative values, not merely read them or started an upload.
// The source-IP dimension retains its separate v1 window semantics.
func (c *otherDomainCollector) evictIdle(w *domainWindow, user string, wholeDomain bool) bool {
	type candidate struct {
		pairs []*domainPair
		seen  int64
		id    uint64
		clean bool
	}
	groups := make(map[string]*candidate)
	w.pairs.Range(func(key, value any) bool {
		p := value.(*domainPair)
		owner, _, _ := strings.Cut(p.label, "#")
		if user != "" && owner != user {
			return true
		}
		groupKey := key.(string)
		if wholeDomain {
			groupKey = owner + ">>>" + p.domain
		}
		group := groups[groupKey]
		if group == nil {
			group = &candidate{clean: true, id: p.id}
			groups[groupKey] = group
		}
		group.pairs = append(group.pairs, p)
		if p.id < group.id {
			group.id = p.id
		}
		if seen := p.lastSeen.Load(); seen > group.seen {
			group.seen = seen
		}
		group.clean = group.clean && p.writers.Load() == 0 &&
			p.up.Load() == p.checkpointUp.Load() && p.down.Load() == p.checkpointDown.Load()
		return true
	})
	var oldest *candidate
	for _, group := range groups {
		if group.clean && (oldest == nil || group.seen < oldest.seen || (group.seen == oldest.seen && group.id < oldest.id)) {
			oldest = group
		}
	}
	if oldest == nil {
		return false
	}
	// Freeze before rechecking so bytes already appended cannot disappear with an evicted
	// segment. A racing new writer rebinds; no blocking lock or IO is added to the data path.
	frozen := make([]*domainPair, 0, len(oldest.pairs))
	for _, p := range oldest.pairs {
		if !p.writers.CompareAndSwap(0, -1) {
			for _, previous := range frozen {
				previous.writers.Store(0)
			}
			return false
		}
		frozen = append(frozen, p)
		if p.up.Load() != p.checkpointUp.Load() || p.down.Load() != p.checkpointDown.Load() {
			for _, previous := range frozen {
				previous.writers.Store(0)
			}
			return false
		}
	}
	for _, p := range frozen {
		w.pairs.Delete(p.label + ">>>" + p.domain)
		delete(c.segments, p.id)
		w.count--
	}
	for _, p := range frozen {
		owner, _, _ := strings.Cut(p.label, "#")
		stillResident := false
		w.pairs.Range(func(_, value any) bool {
			other := value.(*domainPair)
			otherOwner, _, _ := strings.Cut(other.label, "#")
			stillResident = otherOwner == owner && other.domain == p.domain
			return !stillResident
		})
		if !stillResident {
			if _, exists := c.candidates[owner][p.domain]; exists {
				delete(c.candidates[owner], p.domain)
				c.candidateCount--
				if len(c.candidates[owner]) == 0 {
					delete(c.candidates, owner)
				}
			}
		}
	}
	return true
}

// AcknowledgeDetail is called through the loopback Stats API after durable Agent collection.
// An old epoch or a lost acknowledgement is harmless: later snapshots remain cumulative.
func (m *Manager) AcknowledgeDetail(pattern, epoch string, checkpoints []featurestats.DetailCheckpoint) {
	var collector *otherDomainCollector
	switch pattern {
	case featurestats.OtherDomainPattern:
		collector = &m.otherDomains
	case featurestats.SniffingFailedPattern:
		collector = &m.failedTargets
	default:
		return
	}
	collector.mu.Lock()
	defer collector.mu.Unlock()
	if !collector.durableEviction || collector.epoch != epoch {
		return
	}
	for _, checkpoint := range checkpoints {
		if p, ok := collector.segments[checkpoint.ID]; ok && checkpoint.Up <= p.up.Load() && checkpoint.Down <= p.down.Load() {
			if checkpoint.Up > p.checkpointUp.Load() {
				p.checkpointUp.Store(checkpoint.Up)
			}
			if checkpoint.Down > p.checkpointDown.Load() {
				p.checkpointDown.Store(checkpoint.Down)
			}
		}
	}
}
