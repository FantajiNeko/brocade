package stats

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/xtls/xray-core/common/errors"
	featurestats "github.com/xtls/xray-core/features/stats"
)

const (
	siteRegistrationBacklog = 256
	maxSiteCounterPairs     = 8192
	siteShutdownBudget      = 2 * time.Second
	siteRegistrationRetry   = 5 * time.Second
)

type siteCounterKey struct{ label, site string }

type siteCounterPair struct {
	key      siteCounterKey
	up, down pendingSiteCounter
	retryAt  atomic.Int64
}

// Only cold registration uses pending RAM totals; payloads are never queued.
// Publishing a durable counter drains the prefix exactly once, even when Add
// races registration. A process crash before publication can lose observations,
// not billing. Once published every Add goes directly to the persistent mapping.
type pendingSiteCounter struct {
	counter atomic.Pointer[Counter]
	pending atomic.Int64
	enabled *atomic.Bool
	failed  atomic.Bool
}

func (c *pendingSiteCounter) Value() int64 {
	if target := c.counter.Load(); target != nil {
		return target.Value()
	}
	return c.pending.Load()
}

func (c *pendingSiteCounter) Set(value int64) int64 {
	if target := c.counter.Load(); target != nil {
		return target.Set(value)
	}
	return c.pending.Swap(value)
}

func (c *pendingSiteCounter) Add(value int64) int64 {
	if !c.enabled.Load() {
		return c.Value()
	}
	if target := c.counter.Load(); target != nil {
		return target.Add(value)
	}
	return c.addPending(value)
}

func (c *pendingSiteCounter) addPending(value int64) int64 {
	if c.failed.Load() {
		return 0
	}
	current := c.pending.Add(value)
	if target := c.counter.Load(); target != nil {
		return target.Add(c.pending.Swap(0))
	}
	return current
}

func (c *pendingSiteCounter) publish(counter *Counter) {
	c.counter.Store(counter)
	if pending := c.pending.Swap(0); pending != 0 {
		counter.Add(pending)
	}
}

func (c *pendingSiteCounter) fail() {
	c.failed.Store(true)
	c.pending.Store(0)
}

// SiteCounters is an optional, bounded, non-blocking cold-registration provider.
// Warm cache hits are lock-free and allocate nothing. A miss only takes a short
// cache lock and never waits for I/O, the statistics snapshot or the billing lock.
func (m *Manager) SiteCounters(label, site string) (featurestats.Counter, featurestats.Counter, bool) {
	if m.siteJournal == nil {
		return nil, nil, false
	}
	// Bound retained key bytes as well as entry count, before hashing or enqueue.
	const nameOverhead = len("site>>>") + len(">>>") + len(">>>traffic>>>downlink")
	if label == "" || site == "" || len(site) > 32 || nameOverhead+len(label)+len(site) > 496 {
		m.siteLimited.Set(1)
		return nil, nil, true
	}
	key := siteCounterKey{label, site}
	if pair, ok := m.sitePairs.Load(key); ok {
		p := pair.(*siteCounterPair)
		if retry := p.retryAt.Load(); retry != 0 && time.Now().UnixNano() >= retry {
			m.retrySiteRegistration(p, retry)
		}
		return &p.up, &p.down, true
	}
	m.siteCacheMu.Lock()
	defer m.siteCacheMu.Unlock()
	if pair, ok := m.sitePairs.Load(key); ok {
		p := pair.(*siteCounterPair)
		return &p.up, &p.down, true
	}
	if m.siteClosing || m.sitePairCount >= maxSiteCounterPairs || len(m.siteQueue) == cap(m.siteQueue) {
		m.siteLimited.Set(1)
		return nil, nil, true
	}
	pair := &siteCounterPair{key: key}
	pair.up.enabled, pair.down.enabled = &m.siteEnabled, &m.siteEnabled
	m.sitePending.Add(1)
	select {
	case m.siteQueue <- pair:
		m.sitePairs.Store(key, pair)
		m.sitePairCount++
		return &pair.up, &pair.down, true
	default:
		m.sitePending.Add(-1)
		m.siteLimited.Set(1)
		return nil, nil, true
	}
}

func (m *Manager) retrySiteRegistration(pair *siteCounterPair, retry int64) {
	m.siteCacheMu.Lock()
	defer m.siteCacheMu.Unlock()
	if m.siteClosing || !pair.retryAt.CompareAndSwap(retry, 0) {
		return
	}
	m.sitePending.Add(1)
	select {
	case m.siteQueue <- pair:
	default:
		m.sitePending.Add(-1)
		pair.retryAt.Store(time.Now().Add(siteRegistrationRetry).UnixNano())
	}
}

func (m *Manager) startSiteWorker() {
	m.siteWorkerOnce.Do(func() {
		go func() {
			defer close(m.siteDone)
			var lastWarning time.Time
			for pair := range m.siteQueue {
				failed := false
				for _, direction := range []struct {
					name string
					view *pendingSiteCounter
				}{{"uplink", &pair.up}, {"downlink", &pair.down}} {
					counter, err := m.registerSiteCounter("site>>>"+pair.key.label+">>>"+pair.key.site+">>>traffic>>>"+direction.name, true)
					if err != nil {
						direction.view.fail()
						failed = true
						if time.Since(lastWarning) >= time.Minute {
							errors.LogWarning(context.Background(), "site counter registration failed; observations incomplete: ", err)
							lastWarning = time.Now()
						}
						continue
					}
					if direction.view.counter.Load() == nil {
						direction.view.publish(counter)
					}
				}
				if failed {
					pair.retryAt.Store(time.Now().Add(siteRegistrationRetry).UnixNano())
				}
				m.sitePending.Add(-1)
			}
		}()
	})
}

// The site journal's writer/refresh lock is deliberately independent of access.
// Required billing GetCounter/RegisterCounter operations never wait for its fsync.
func (m *Manager) registerSiteCounter(name string, existingOK bool) (*Counter, error) {
	m.siteRegistration.Lock()
	defer m.siteRegistration.Unlock()
	m.access.RLock()
	counter := m.counters[name]
	m.access.RUnlock()
	if counter != nil {
		if existingOK {
			return counter, nil
		}
		return nil, errors.New("Counter ", name, " already registered.")
	}
	counter, err := m.siteJournal.Register(name)
	if err != nil {
		m.siteLimited.Set(1)
		return nil, err
	}
	m.access.Lock()
	m.counters[name] = counter
	m.access.Unlock()
	return counter, nil
}

func (m *Manager) closeSiteUsage() {
	if m.siteQueue == nil {
		return
	}
	m.siteCloseOnce.Do(func() {
		m.siteCacheMu.Lock()
		m.siteClosing = true
		close(m.siteQueue)
		m.siteCacheMu.Unlock()
		m.startSiteWorker()
	})
	timer := time.NewTimer(siteShutdownBudget)
	defer timer.Stop()
	select {
	case <-m.siteDone:
	case <-timer.C:
		m.siteLimited.Set(1)
		errors.LogWarning(context.Background(), "site registration did not drain within shutdown budget; observations may be incomplete")
	}
}
