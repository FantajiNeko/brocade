package stats

import (
	"fmt"
	"sync"
	"testing"

	featurestats "github.com/xtls/xray-core/features/stats"
)

func evictionTestManager(userCapacity, nodeCapacity int) *Manager {
	m := new(Manager)
	m.otherDomains.durableEviction = true
	m.otherDomains.update(otherDomainPolicy{Enabled: true, TopN: 1, MaxDomainsPerUser: userCapacity, NodeCapacity: nodeCapacity, ReportIntervalSecs: 30}, 7201)
	return m
}

func checkpointCurrent(m *Manager) {
	c := &m.otherDomains
	var checkpoints []featurestats.DetailCheckpoint
	c.current.Load().pairs.Range(func(_, value any) bool {
		p := value.(*domainPair)
		checkpoints = append(checkpoints, featurestats.DetailCheckpoint{ID: p.id, Up: p.up.Load(), Down: p.down.Load()})
		return true
	})
	m.AcknowledgeDetail(featurestats.OtherDomainPattern, c.epoch, checkpoints)
}

func TestDetailEvictsOnlyCheckpointedLeastRecentlyActiveDomain(t *testing.T) {
	m := evictionTestManager(2, 3)
	a, _ := m.OtherDomainCounters("a@t#one", "old.example")
	b, _ := m.OtherDomainCounters("a@t#one", "active.example")
	a.Add(10)
	b.Add(20)
	m.OtherDomainCounters("a@t#one", "new.example")
	if _, exists := m.otherDomains.current.Load().pairs.Load("a@t#one>>>new.example"); exists {
		t.Fatal("uncheckpointed bytes were discarded to make room")
	}
	checkpointCurrent(m)
	oldID := a.(*otherDomainCounter).pair.Load().id
	m.otherDomains.update(m.otherDomains.policy, 7210)
	b.Add(3) // Activity after the checkpoint makes this segment ineligible for eviction.
	c, _ := m.OtherDomainCounters("a@t#one", "new.example")
	if c == nil {
		t.Fatal("checkpointed cold domain pinned the user capacity")
	}
	c.Add(5)
	w := m.otherDomains.current.Load()
	if _, exists := w.pairs.Load("a@t#one>>>old.example"); exists || w.count != 2 {
		t.Fatal("cold entry was not replaced within the resident budget")
	}
	checkpointCurrent(m)
	m.otherDomains.update(m.otherDomains.policy, 7220)
	a.Add(7) // A still-open connection must rebind after its old segment was retired.
	newPair := a.(*otherDomainCounter).pair.Load()
	if newPair.id == oldID || newPair.up.Load() != 7 {
		t.Fatal("reappearing domain reused cumulative identity or lost its next bytes")
	}
	if m.otherDomains.candidateCount != 2 || w.count != 2 {
		t.Fatal("eviction exceeded resident capacity")
	}
}

func TestDetailNodeBudgetAndMultipleIngressesDoNotPinAdmission(t *testing.T) {
	m := evictionTestManager(1, 3)
	a, _ := m.OtherDomainCounters("a@t#one", "old.example")
	a2, _ := m.OtherDomainCounters("a@t#two", "old.example")
	b, _ := m.OtherDomainCounters("b@t#one", "busy.example")
	a.Add(1)
	a2.Add(2)
	b.Add(3)
	checkpointCurrent(m)
	if fresh, _ := m.OtherDomainCounters("a@t#one", "fresh.example"); fresh == nil {
		t.Fatal("multiple ingress labels prevented replacement of one user/domain candidate")
	}
	w := m.otherDomains.current.Load()
	if w.count != 2 || len(m.otherDomains.candidates["a@t"]) != 1 {
		t.Fatal("not all old ingress segments were retired")
	}
	// Fill the node budget with different users and admit another after checkpointing.
	x, _ := m.OtherDomainCounters("x@t#one", "x.example")
	x.Add(4)
	checkpointCurrent(m)
	if fresh, _ := m.OtherDomainCounters("new@t#one", "new.example"); fresh == nil || w.count != 3 {
		t.Fatal("node capacity remained pinned by checkpointed entries")
	}
}

func TestDetailCheckpointCannotAuthorizeUnobservedBytesOrAnotherEpoch(t *testing.T) {
	m := evictionTestManager(1, 1)
	a, _ := m.OtherDomainCounters("a@t#one", "a.example")
	a.Add(10)
	p := a.(*otherDomainCounter).pair.Load()
	m.AcknowledgeDetail(featurestats.OtherDomainPattern, "different-epoch", []featurestats.DetailCheckpoint{{ID: p.id, Up: 10}})
	m.OtherDomainCounters("a@t#one", "b.example")
	if _, exists := m.otherDomains.current.Load().pairs.Load("a@t#one>>>b.example"); exists {
		t.Fatal("stale checkpoint authorized an eviction")
	}
	checkpointCurrent(m)
	a.Add(5)
	m.OtherDomainCounters("a@t#one", "b.example")
	if _, exists := m.otherDomains.current.Load().pairs.Load("a@t#one>>>b.example"); exists {
		t.Fatal("bytes written after checkpoint were discarded")
	}
	if got := testing.AllocsPerRun(1000, func() { a.Add(1) }); got != 0 {
		t.Fatalf("checkpoint-aware hot counter allocates: %v", got)
	}
}

func TestDetailConnectionRecoversAfterItsFirstAdmissionWasFull(t *testing.T) {
	m := evictionTestManager(1, 1)
	a, _ := m.OtherDomainCounters("a@t#one", "a.example")
	a.Add(10)
	b, _ := m.OtherDomainCounters("a@t#one", "b.example")
	if b == nil || b.Add(3) != 0 {
		t.Fatal("failed admission should retain a bounded retry handle")
	}
	checkpointCurrent(m)
	m.otherDomains.update(m.otherDomains.policy, 7207)
	if b.Add(5) != 5 {
		t.Fatal("a long connection remained invisible after capacity became available")
	}
}

func TestDetailConcurrentAdmissionCheckpointAndSnapshot(t *testing.T) {
	m := evictionTestManager(2, 4)
	var workers sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		workers.Go(func() {
			for i := 0; i < 200; i++ {
				up, _ := m.OtherDomainCounters(fmt.Sprintf("u%d@t#i", worker), fmt.Sprintf("d%d.example", i%5))
				up.Add(1)
			}
		})
	}
	workers.Go(func() {
		for i := 0; i < 200; i++ {
			checkpointCurrent(m)
			m.DetailCheckpointSnapshot(featurestats.OtherDomainPattern)
		}
	})
	workers.Wait()
	if m.otherDomains.current.Load().count > 4 || m.otherDomains.candidateCount > 4 {
		t.Fatal("concurrent admission exceeded the resident budget")
	}
}

func TestDetailCheckpointIndexExpiresWithWindowsAndReportsUnsavedLoss(t *testing.T) {
	for _, saved := range []bool{false, true} {
		m := evictionTestManager(1, 1)
		a, _ := m.OtherDomainCounters("a@t#i", "a.example")
		a.Add(10)
		if saved {
			checkpointCurrent(m)
		}
		m.otherDomains.update(m.otherDomains.policy, 10801)
		if len(m.otherDomains.segments) != 1 {
			t.Fatal("previous window lost its acknowledgement index too early")
		}
		m.otherDomains.update(m.otherDomains.policy, 14401)
		if len(m.otherDomains.segments) != 0 || m.otherDomains.limited.Load() == saved {
			t.Fatal("expired index leaked memory or silently lost uncheckpointed data")
		}
	}
}
