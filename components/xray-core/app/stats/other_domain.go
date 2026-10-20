package stats

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/xtls/xray-core/common/errors"
	"github.com/xtls/xray-core/common/siteusage"
	featurestats "github.com/xtls/xray-core/features/stats"
)

type otherDomainPolicy struct {
	Enabled            bool `json:"enabled"`
	TopN               int  `json:"top_n"`
	MaxDomainsPerUser  int  `json:"max_domains_per_user"`
	NodeCapacity       int  `json:"node_capacity"`
	ReportIntervalSecs int  `json:"report_interval_secs"`
}

func readOtherDomainPolicy() (otherDomainPolicy, error) {
	return readDetailPolicy("XRAY_BROCADE_OTHER_DOMAIN_CONTROL_FILE", false)
}

func readDetailPolicy(environment string, targets bool) (otherDomainPolicy, error) {
	p := otherDomainPolicy{TopN: 128, MaxDomainsPerUser: 1024, NodeCapacity: 4096, ReportIntervalSecs: 30}
	path := os.Getenv(environment)
	if path == "" {
		return p, nil
	}
	if !filepath.IsAbs(path) {
		return p, fmt.Errorf("domain policy path must be absolute")
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return p, nil
	}
	if err != nil {
		return p, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return p, fmt.Errorf("domain policy must be private")
	}
	f, err := os.Open(path)
	if err != nil {
		return p, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 1025))
	if err != nil || len(data) > 1024 {
		return p, fmt.Errorf("invalid domain policy size")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if targets {
		var wire struct {
			Enabled            bool `json:"enabled"`
			TopN               int  `json:"top_n"`
			MaxTargetsPerUser  int  `json:"max_targets_per_user"`
			NodeCapacity       int  `json:"node_capacity"`
			ReportIntervalSecs int  `json:"report_interval_secs"`
		}
		wire.Enabled, wire.TopN, wire.MaxTargetsPerUser, wire.NodeCapacity, wire.ReportIntervalSecs = p.Enabled, p.TopN, p.MaxDomainsPerUser, p.NodeCapacity, p.ReportIntervalSecs
		if err := decoder.Decode(&wire); err != nil {
			return p, fmt.Errorf("invalid optional target policy")
		}
		p = otherDomainPolicy{wire.Enabled, wire.TopN, wire.MaxTargetsPerUser, wire.NodeCapacity, wire.ReportIntervalSecs}
	} else if err := decoder.Decode(&p); err != nil {
		return p, fmt.Errorf("invalid optional domain policy")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return p, fmt.Errorf("trailing optional policy content")
	}
	if p.TopN < 1 || p.TopN > 512 || p.MaxDomainsPerUser < p.TopN || p.MaxDomainsPerUser > 4096 || p.NodeCapacity < p.MaxDomainsPerUser || p.NodeCapacity > 4096 || p.ReportIntervalSecs < 15 || p.ReportIntervalSecs > 300 {
		return p, fmt.Errorf("domain policy exceeds budget")
	}
	return p, nil
}

type domainPair struct {
	windowID      uint64
	label, domain string
	up, down      atomic.Int64
}
type domainWindow struct {
	bucket int64
	id     uint64
	pairs  sync.Map
	count  int
}
type otherDomainCollector struct {
	bucketSeconds int64 // Zero preserves the existing hourly detail dimensions.
	mu            sync.Mutex
	current       atomic.Pointer[domainWindow]
	previous      *domainWindow
	limited       atomic.Bool
	closed        atomic.Bool
	clock         atomic.Int64
	epoch         string
	activation    int64
	serial        uint64
	policy        otherDomainPolicy
	// Persistent candidate registry survives hour changes, but expires idle names.
	candidates     map[string]map[string]int64
	candidateCount int
}

func (c *otherDomainCollector) bucketSize() int64 {
	if c.bucketSeconds > 0 {
		return c.bucketSeconds
	}
	return 3600
}

func (m *Manager) OtherDomainEnabled() bool    { return m.otherDomains.current.Load() != nil }
func (m *Manager) SniffingFailedEnabled() bool { return m.failedTargets.current.Load() != nil }

func (c *otherDomainCollector) update(policy otherDomainPolicy, now int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed.Load() {
		policy.Enabled = false
	}
	c.clock.Store(now)
	seconds := c.bucketSize()
	bucket := now / seconds * seconds
	w := c.current.Load()
	if !policy.Enabled {
		c.current.Store(nil)
		c.previous = nil
		c.candidates = nil
		c.candidateCount = 0
		c.policy = policy
		return
	}
	if c.policy.MaxDomainsPerUser != policy.MaxDomainsPerUser || c.policy.NodeCapacity != policy.NodeCapacity {
		w = nil
		c.previous = nil
		c.candidates = nil
		c.candidateCount = 0
	}
	c.policy = policy
	if w == nil {
		var identity [16]byte
		if _, err := rand.Read(identity[:]); err != nil {
			errors.LogWarning(context.Background(), "other-domain identity unavailable; collection disabled")
			return
		} // Ancillary only; leave disabled.
		c.epoch = hex.EncodeToString(identity[:])
		c.activation = now
		c.limited.Store(false)
		c.candidates = make(map[string]map[string]int64)
	} else if w.bucket == bucket {
		return
	}
	c.previous = w
	if w != nil && w.bucket != bucket-seconds {
		c.previous = nil
	}
	for user, domains := range c.candidates {
		for domain, seen := range domains {
			if seen < bucket-23*seconds {
				delete(domains, domain)
				c.candidateCount--
			}
		}
		if len(domains) == 0 {
			delete(c.candidates, user)
		}
	}
	c.serial++
	c.current.Store(&domainWindow{bucket: bucket, id: c.serial})
}

func (c *otherDomainCollector) get(label, domain string) (*domainPair, bool) {
	w := c.current.Load()
	if w == nil {
		return nil, false
	}
	key := label + ">>>" + domain
	if pair, ok := w.pairs.Load(key); ok {
		return pair.(*domainPair), false
	}
	// Cold observation admission must never wait behind a query or another connection.
	if !c.mu.TryLock() {
		c.limited.Store(true)
		return nil, false
	}
	defer c.mu.Unlock()
	if c.current.Load() != w {
		c.limited.Store(true)
		return nil, false
	}
	if pair, ok := w.pairs.Load(key); ok {
		return pair.(*domainPair), false
	}
	user, _, _ := strings.Cut(label, "#")
	domains := c.candidates[user]
	_, known := domains[domain]
	if w.count >= c.policy.NodeCapacity || (!known && (len(domains) >= c.policy.MaxDomainsPerUser || c.candidateCount >= c.policy.NodeCapacity)) {
		c.limited.Store(true)
		return nil, true
	}
	if domains == nil {
		domains = make(map[string]int64)
		c.candidates[user] = domains
	}
	if !known {
		c.candidateCount++
	}
	domains[domain] = w.bucket
	p := &domainPair{windowID: w.id, label: label, domain: domain}
	w.pairs.Store(key, p)
	w.count++
	return p, false
}

type otherDomainCounter struct {
	collector    *otherDomainCollector
	pair         atomic.Pointer[domainPair]
	uplink       bool
	retryAt      atomic.Int64
	deniedWindow atomic.Uint64
}

func (c *otherDomainCounter) Value() int64 {
	p := c.pair.Load()
	if c.uplink {
		return p.up.Load()
	}
	return p.down.Load()
}
func (c *otherDomainCounter) Set(int64) int64 { return c.Value() }
func (c *otherDomainCounter) Add(v int64) int64 {
	w := c.collector.current.Load()
	if w == nil || v <= 0 {
		return c.Value()
	}
	p := c.pair.Load()
	if p.windowID != w.id {
		if c.deniedWindow.Load() == w.id || c.retryAt.Load() > c.collector.clock.Load() {
			return c.Value()
		}
		var full bool
		p, full = c.collector.get(p.label, p.domain)
		if p == nil {
			// Full windows cannot recover until rotation. Transient contention retries
			// at most once per five-second worker clock, never once per byte chunk.
			if full {
				c.deniedWindow.Store(w.id)
			} else {
				c.retryAt.Store(c.collector.clock.Load() + 5)
			}
			return c.Value()
		}
		c.pair.Store(p)
	}
	if c.uplink {
		return p.up.Add(v)
	}
	return p.down.Add(v)
}

func (m *Manager) OtherDomainCounters(label, domain string) (featurestats.Counter, featurestats.Counter) {
	if !featurestats.OtherDomainUsageEnabled(m, label) {
		return nil, nil
	}
	domain = siteusage.NormalizeOtherDomain(domain)
	if domain == "" {
		return nil, nil
	}
	return m.otherDomains.counters(label, domain)
}

func (m *Manager) SniffingFailedCounters(label, target string) (featurestats.Counter, featurestats.Counter) {
	if !featurestats.SniffingFailedUsageEnabled(m, label) {
		return nil, nil
	}
	target = siteusage.NormalizeFailedTarget(target)
	if target == "" {
		return nil, nil
	}
	return m.failedTargets.counters(label, target)
}

// Both optional dimensions share bounded admission, rollover and allocation-free hot handles.
func (c *otherDomainCollector) counters(label, key string) (featurestats.Counter, featurestats.Counter) {
	pair, _ := c.get(label, key)
	if pair == nil {
		return nil, nil
	}
	up := &otherDomainCounter{collector: c, uplink: true}
	down := &otherDomainCounter{collector: c}
	up.pair.Store(pair)
	down.pair.Store(pair)
	return up, down
}

func (m *Manager) OtherDomainSnapshot() []featurestats.OtherDomainStat {
	return m.otherDomains.snapshot("otherdomain>>>")
}
func (m *Manager) SniffingFailedSnapshot() []featurestats.DetailUsageStat {
	return m.failedTargets.snapshot(featurestats.SniffingFailedPattern)
}
func (c *otherDomainCollector) snapshot(pattern string) []featurestats.DetailUsageStat {
	c.mu.Lock()
	result := []featurestats.OtherDomainStat{{Name: pattern + "version", Value: 1}}
	w := c.current.Load()
	previous, epoch, activation := c.previous, c.epoch, c.activation
	sampledAt := c.clock.Load()
	wasLimited := c.limited.Load()
	c.mu.Unlock()
	// Formatting/sorting a large snapshot must not lock out cold admission.
	if w == nil {
		return append(result, featurestats.OtherDomainStat{Name: pattern + "enabled", Value: 0})
	}
	result = append(result, featurestats.OtherDomainStat{Name: pattern + "enabled", Value: 1}, featurestats.OtherDomainStat{Name: pattern + "epoch:" + epoch, Value: 1}, featurestats.OtherDomainStat{Name: pattern + "activation", Value: activation})
	if pattern == featurestats.SourceTrafficPattern {
		result = append(result, featurestats.DetailUsageStat{Name: pattern + "sampled_at", Value: sampledAt})
	}
	limited := int64(0)
	if wasLimited {
		limited = 1
	}
	result = append(result, featurestats.OtherDomainStat{Name: pattern + "limited", Value: limited})
	for _, window := range []*domainWindow{previous, w} {
		if window == nil {
			continue
		}
		window.pairs.Range(func(_, value any) bool {
			p := value.(*domainPair)
			prefix := fmt.Sprintf("%s%d>>>%s>>>%s>>>", pattern, window.bucket, p.label, p.domain)
			result = append(result, featurestats.OtherDomainStat{Name: prefix + "uplink", Value: p.up.Load()}, featurestats.OtherDomainStat{Name: prefix + "downlink", Value: p.down.Load()})
			return true
		})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

func (m *Manager) watchOtherDomains(stop <-chan struct{}) {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	failed := [2]bool{}
	for {
		select {
		case <-stop:
			return
		case now := <-tick.C:
			m.sourceTraffic.update(sourceTrafficPolicy(), now.Unix())
			for i, entry := range m.detailCollectors() {
				policy, err := readDetailPolicy(entry.environment, i == 1)
				if err != nil {
					if !failed[i] {
						errors.LogWarning(context.Background(), "optional detail policy unavailable; collection disabled: ", entry.environment)
					}
					policy.Enabled = false
				}
				failed[i] = err != nil
				entry.collector.update(policy, now.Unix())
			}
		}
	}
}

func (m *Manager) initOtherDomains() {
	for i, entry := range m.detailCollectors() {
		policy, err := readDetailPolicy(entry.environment, i == 1)
		if err != nil {
			errors.LogWarning(context.Background(), "other-domain policy unavailable; collection disabled")
			policy.Enabled = false
		}
		entry.collector.update(policy, time.Now().Unix())
	}
}

func (m *Manager) detailCollectors() [2]struct {
	collector   *otherDomainCollector
	environment string
} {
	return [2]struct {
		collector   *otherDomainCollector
		environment string
	}{
		{&m.otherDomains, "XRAY_BROCADE_OTHER_DOMAIN_CONTROL_FILE"},
		{&m.failedTargets, "XRAY_BROCADE_SNIFFING_FAILED_CONTROL_FILE"},
	}
}
