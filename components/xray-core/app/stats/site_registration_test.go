//go:build linux

package stats

import (
	"context"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	featurestats "github.com/xtls/xray-core/features/stats"
)

func newSiteTestManager(t *testing.T) *Manager {
	t.Helper()
	dir := t.TempDir()
	t.Setenv(accountingJournalEnv, filepath.Join(dir, "billing.bin"))
	t.Setenv(accountingSharedEnv, "")
	t.Setenv("XRAY_BROCADE_SITE_USAGE_ENABLED", "1")
	t.Setenv("XRAY_BROCADE_SITE_USAGE_CONTROL_FILE", "")
	t.Setenv("XRAY_BROCADE_SITE_ACCOUNTING_FILE", filepath.Join(dir, "sites.bin"))
	m, err := NewManager(context.Background(), &Config{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	return m
}

func awaitSiteRegistrations(t *testing.T, m *Manager) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for m.sitePending.Value() != 0 && time.Now().Before(deadline) {
		runtime.Gosched()
	}
	if m.sitePending.Value() != 0 {
		t.Fatal("site registrations did not drain")
	}
}

type blockedSiteJournal struct {
	counterJournal
	entered, release chan struct{}
	once             sync.Once
}

func (j *blockedSiteJournal) Register(name string) (*Counter, error) {
	j.once.Do(func() { close(j.entered) })
	<-j.release
	return j.counterJournal.Register(name)
}

func TestSlowSiteRegistrationDoesNotBlockTrafficBillingOrSnapshots(t *testing.T) {
	m := newSiteTestManager(t)
	j := &blockedSiteJournal{counterJournal: m.siteJournal, entered: make(chan struct{}), release: make(chan struct{})}
	m.siteJournal = j
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	var release sync.Once
	defer release.Do(func() { close(j.release) })
	up, down, ok := m.SiteCounters("alice@root#entry", "youtube")
	if !ok || up == nil || down == nil {
		t.Fatal("no pending pair")
	}
	select {
	case <-j.entered:
	case <-time.After(time.Second):
		t.Fatal("worker did not start")
	}
	up.Add(123)
	down.Add(456)
	up2, down2, _ := m.SiteCounters("alice@root#entry", "youtube")
	if up != up2 || down != down2 {
		t.Fatal("cold concurrent connections did not reuse a pair")
	}
	finished := make(chan error, 1)
	go func() {
		counter, err := m.RegisterCounter("user>>>bob@root#entry>>>traffic>>>uplink")
		if err != nil {
			finished <- err
			return
		}
		counter.Add(99)
		seen, pending := int64(0), int64(0)
		m.VisitCounters(func(name string, c featurestats.Counter) bool {
			if name == "user>>>bob@root#entry>>>traffic>>>uplink" {
				seen = c.Value()
			}
			if name == "site>>>pending" {
				pending = c.Value()
			}
			return true
		})
		if seen != 99 || pending != 1 {
			finished <- fmt.Errorf("snapshot billing=%d pending=%d", seen, pending)
			return
		}
		finished <- nil
	}()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("optional disk I/O blocked billing or stats")
	}
	release.Do(func() { close(j.release) })
	awaitSiteRegistrations(t, m)
	if m.GetCounter("site>>>alice@root#entry>>>youtube>>>traffic>>>uplink").Value() != 123 || down.Value() != 456 {
		t.Fatal("pending bytes lost")
	}
	if m.siteLimited.Value() != 0 {
		t.Fatal("healthy asynchronous registration marked permanently limited")
	}
}

func TestSiteRegistrationBacklogAndCacheAreBounded(t *testing.T) {
	m := newSiteTestManager(t) // No worker until Start: fill the exact bounded backlog.
	for i := 0; i < siteRegistrationBacklog; i++ {
		up, down, _ := m.SiteCounters(fmt.Sprintf("u%d@root#entry", i), "other")
		if up == nil || down == nil {
			t.Fatal("queue filled too early")
		}
	}
	up, down, _ := m.SiteCounters("overflow@root#entry", "other")
	if up != nil || down != nil || m.siteLimited.Value() != 1 {
		t.Fatal("full queue was not reported")
	}
	if m.sitePairCount != siteRegistrationBacklog || m.sitePending.Value() != siteRegistrationBacklog {
		t.Fatal("unbounded or inconsistent backlog")
	}
	// Drain for cleanup, without exercising hundreds of unrelated fsyncs.
	for len(m.siteQueue) > 0 {
		<-m.siteQueue
		m.sitePending.Add(-1)
	}
	m.sitePairCount = maxSiteCounterPairs
	up, down, _ = m.SiteCounters("cache-full@root#entry", "other")
	if up != nil || down != nil {
		t.Fatal("cache budget ignored")
	}
}

func TestConcurrentColdConnectionsReuseOneSitePair(t *testing.T) {
	m := newSiteTestManager(t)
	const connections = 64
	type handles struct{ up, down featurestats.Counter }
	results := make(chan handles, connections)
	for i := 0; i < connections; i++ {
		go func() {
			up, down, _ := m.SiteCounters("alice@root#entry", "youtube")
			up.Add(1)
			results <- handles{up, down}
		}()
	}
	first := <-results
	for i := 1; i < connections; i++ {
		if pair := <-results; pair != first {
			t.Fatal("concurrent cold miss created duplicate handles")
		}
	}
	if m.sitePairCount != 1 || m.sitePending.Value() != 1 {
		t.Fatal("concurrent cold miss created duplicate registration jobs")
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if first.up.Value() != connections {
		t.Fatal("coalesced registration lost observations")
	}
}

func TestInvalidSiteKeysAreRejectedBeforeRetention(t *testing.T) {
	m := newSiteTestManager(t)
	for _, key := range []siteCounterKey{{strings.Repeat("x", 497), "other"}, {"alice@root#entry", strings.Repeat("x", 33)}, {"", "other"}} {
		up, down, _ := m.SiteCounters(key.label, key.site)
		if up != nil || down != nil {
			t.Fatal("invalid key retained")
		}
	}
	if m.sitePairCount != 0 || m.sitePending.Value() != 0 || len(m.siteQueue) != 0 {
		t.Fatal("invalid keys consumed queue or cache")
	}
}

func TestPendingCounterPublicationPreservesConcurrentAdds(t *testing.T) {
	for round := 0; round < 100; round++ {
		var enabled atomic.Bool
		enabled.Store(true)
		counter := &pendingSiteCounter{enabled: &enabled}
		mapped := new(Counter)
		counter.Add(17)
		var wg sync.WaitGroup
		for worker := 0; worker < 8; worker++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := 0; i < 1000; i++ {
					counter.Add(3)
				}
			}()
		}
		counter.publish(mapped)
		wg.Wait()
		if mapped.Value() != 24017 || counter.pending.Load() != 0 {
			t.Fatalf("publication lost bytes: %d", mapped.Value())
		}
		enabled.Store(false)
		counter.Add(99)
		if mapped.Value() != 24017 {
			t.Fatal("disabled counter kept collecting")
		}
	}
}

func TestSiteRegistrationCloseDrainsPendingBytes(t *testing.T) {
	m := newSiteTestManager(t)
	up, down, _ := m.SiteCounters("alice@root#entry", "youtube")
	up.Add(10)
	down.Add(20)
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if m.sitePending.Value() != 0 || up.Value() != 10 || down.Value() != 20 {
		t.Fatal("graceful shutdown lost pending observations")
	}
}

func TestSiteRegistrationShutdownHasAHardBudget(t *testing.T) {
	m := newSiteTestManager(t)
	j := &blockedSiteJournal{counterJournal: m.siteJournal, entered: make(chan struct{}), release: make(chan struct{})}
	m.siteJournal = j
	var release sync.Once
	defer release.Do(func() { close(j.release) })
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	up, _, _ := m.SiteCounters("alice@root#entry", "youtube")
	up.Add(9)
	select {
	case <-j.entered:
	case <-time.After(time.Second):
		t.Fatal("worker did not start")
	}
	finished := make(chan error, 1)
	go func() { finished <- m.Close() }()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(siteShutdownBudget + time.Second):
		t.Fatal("shutdown blocked on optional disk I/O")
	}
	if m.siteLimited.Value() != 1 || m.sitePending.Value() == 0 {
		t.Fatal("timed-out observations were not marked incomplete")
	}
	release.Do(func() { close(j.release) })
	awaitSiteRegistrations(t, m)
}

type flakySiteJournal struct {
	counterJournal
	fail atomic.Bool
}

func (j *flakySiteJournal) Register(name string) (*Counter, error) {
	if j.fail.Load() {
		return nil, fmt.Errorf("test disk unavailable")
	}
	return j.counterJournal.Register(name)
}

func TestSiteRegistrationRetriesWithBackoffAndReusesTheSameHandles(t *testing.T) {
	m := newSiteTestManager(t)
	j := &flakySiteJournal{counterJournal: m.siteJournal}
	j.fail.Store(true)
	m.siteJournal = j
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	up, down, _ := m.SiteCounters("alice@root#entry", "youtube")
	up.Add(1)
	down.Add(2)
	awaitSiteRegistrations(t, m)
	value, _ := m.sitePairs.Load(siteCounterKey{"alice@root#entry", "youtube"})
	pair := value.(*siteCounterPair)
	if m.siteLimited.Value() != 1 || pair.retryAt.Load() <= time.Now().UnixNano() {
		t.Fatal("failed registration lacked backoff or incomplete marker")
	}
	up2, down2, _ := m.SiteCounters("alice@root#entry", "youtube")
	if up != up2 || down != down2 || m.sitePending.Value() != 0 {
		t.Fatal("failed pair was replaced or retried immediately")
	}
	j.fail.Store(false)
	pair.retryAt.Store(1) // Advance the logical backoff without sleeping five seconds.
	m.SiteCounters("alice@root#entry", "youtube")
	awaitSiteRegistrations(t, m)
	up.Add(11)
	down.Add(13)
	if up.Value() != 11 || down.Value() != 13 || m.sitePairCount != 1 {
		t.Fatal("retry did not reuse and recover the pair")
	}
}
