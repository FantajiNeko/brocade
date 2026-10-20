package stats

import (
	"fmt"
	"github.com/xtls/xray-core/features/stats"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestDetailPoliciesAcceptAdditionalFields(t *testing.T) {
	for _, targets := range []bool{false, true} {
		path := filepath.Join(t.TempDir(), "policy.json")
		body := []byte(`{"enabled":true,"future_metadata":1}`)
		if err := os.WriteFile(path, body, 0600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("BROCADE_TEST_DETAIL_POLICY", path)
		policy, err := readDetailPolicy("BROCADE_TEST_DETAIL_POLICY", targets)
		if err != nil || !policy.Enabled || policy.NodeCapacity != 4096 {
			t.Fatalf("additional field changed policy: %+v, %v", policy, err)
		}
	}
}

func domainTestManager() *Manager {
	m := new(Manager)
	m.otherDomains.update(otherDomainPolicy{Enabled: true, TopN: 128, MaxDomainsPerUser: 1024, NodeCapacity: 4096, ReportIntervalSecs: 30}, 7201)
	return m
}
func TestOtherDomainBudgetsAndContinuousCandidates(t *testing.T) {
	m := domainTestManager()
	for i := 0; i < 1024; i++ {
		up, _ := m.OtherDomainCounters("a@t#entry", fmt.Sprintf("d%d.example", i))
		if up == nil {
			t.Fatalf("candidate %d refused", i)
		}
		up.Add(10)
	}
	if up, _ := m.OtherDomainCounters("a@t#another-entry", "new.example"); up != nil {
		t.Fatal("per-user domain capacity bypassed through another ingress")
	}
	if !m.otherDomains.limited.Load() {
		t.Fatal("missing limit flag")
	}
	// Hour rollover retains the same user's candidate pool, not 1024 new names/hour.
	m.otherDomains.update(m.otherDomains.policy, 10801)
	if up, _ := m.OtherDomainCounters("a@t#entry", "new.example"); up != nil {
		t.Fatal("candidate pool reset at hour boundary")
	}
	if up, _ := m.OtherDomainCounters("b@t#entry", "new.example"); up == nil {
		t.Fatal("different user shares the per-user limit")
	}
	m.otherDomains.update(m.otherDomains.policy, 10801+24*3600)
	if up, _ := m.OtherDomainCounters("a@t#entry", "new.example"); up == nil {
		t.Fatal("idle candidate did not expire")
	}
}
func TestOtherDomainHoursOffAndNonblockingAdmission(t *testing.T) {
	m := domainTestManager()
	up, down := m.OtherDomainCounters("a@t#entry", "Video.Example.")
	up.Add(13)
	down.Add(29)
	m.otherDomains.update(m.otherDomains.policy, 10801)
	up.Add(7)
	down.Add(11)
	var sums [2]int64
	for _, s := range m.OtherDomainSnapshot() {
		if s.Name == "otherdomain>>>7200>>>a@t#entry>>>video.example>>>uplink" {
			sums[0] = s.Value
		}
		if s.Name == "otherdomain>>>10800>>>a@t#entry>>>video.example>>>uplink" {
			sums[1] = s.Value
		}
	}
	if sums != [2]int64{13, 7} {
		t.Fatalf("cross-hour values: %v", sums)
	}
	m.otherDomains.mu.Lock()
	if c, _ := m.OtherDomainCounters("a@t#entry", "cold.example"); c != nil {
		t.Fatal("busy optional admission must skip")
	}
	up.Add(5) // Warm forwarding must not take the snapshot lock.
	m.otherDomains.mu.Unlock()
	m.otherDomains.update(otherDomainPolicy{}, 10802)
	up.Add(100)
	if m.OtherDomainEnabled() || m.otherDomains.candidates != nil {
		t.Fatal("disabled state retained domain index")
	}
	if c, _ := m.OtherDomainCounters("a@t#entry", "secret.example"); c != nil {
		t.Fatal("off still allocated counters")
	}
}
func TestOtherDomainConcurrentRollover(t *testing.T) {
	m := domainTestManager()
	up, _ := m.OtherDomainCounters("a@t#i", "a.example")
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 1000; j++ {
				up.Add(1)
				_ = m.OtherDomainSnapshot()
			}
		}()
	}
	for i := 0; i < 8; i++ {
		m.otherDomains.update(m.otherDomains.policy, int64(7201+i*3600))
	}
	wg.Wait()
}

func TestOtherDomainClosedCollectorCannotBeReenabledByLatePoll(t *testing.T) {
	m := domainTestManager()
	m.otherDomains.closed.Store(true)
	m.otherDomains.update(m.otherDomains.policy, 7202)
	if m.OtherDomainEnabled() {
		t.Fatal("late policy poll reenabled closed collector")
	}
}

func TestOtherDomainMissDoesNotAllocateOnEveryChunk(t *testing.T) {
	m := domainTestManager()
	up, _ := m.OtherDomainCounters("a@t#i", "a.example")
	m.otherDomains.update(m.otherDomains.policy, 10801)
	m.otherDomains.mu.Lock()
	up.Add(1) // One transient miss establishes a bounded retry clock.
	if got := testing.AllocsPerRun(1000, func() { up.Add(1) }); got != 0 {
		t.Fatalf("limited hot path allocates: %v", got)
	}
	m.otherDomains.mu.Unlock()
	m.otherDomains.update(m.otherDomains.policy, 10807)
	up.Add(7)
	if up.Value() != 7 {
		t.Fatal("transient admission failure did not recover after backoff")
	}
}
func BenchmarkOtherDomainHotCounter(b *testing.B) {
	m := domainTestManager()
	up, _ := m.OtherDomainCounters("a@t#i", "a.example")
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		up.Add(32768)
	}
}
func BenchmarkOtherDomainOff(b *testing.B) {
	m := new(Manager)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		stats.OtherDomainUsageEnabled(m, "a@t#i")
	}
}

func BenchmarkOtherDomainFullSnapshot(b *testing.B) {
	m := domainTestManager()
	for i := 0; i < 4096; i++ {
		up, _ := m.OtherDomainCounters(fmt.Sprintf("u%d@t#i", i/1024), fmt.Sprintf("d%d.example", i))
		up.Add(1024)
	}
	m.otherDomains.update(m.otherDomains.policy, 10801)
	for i := 0; i < 4096; i++ {
		up, _ := m.OtherDomainCounters(fmt.Sprintf("u%d@t#i", i/1024), fmt.Sprintf("d%d.example", i))
		up.Add(1024)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_ = m.OtherDomainSnapshot()
	}
}
func BenchmarkOtherDomainBaseCounter(b *testing.B) {
	c := new(Counter)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		c.Add(32768)
	}
}
