package stats

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFailedTargetPolicyIgnoresOtherDimensionsAndRejectsInvalidValues(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	t.Setenv("XRAY_BROCADE_SNIFFING_FAILED_CONTROL_FILE", path)
	if err := os.WriteFile(path, []byte(`{"enabled":true,"max_domains_per_user":2}`), 0600); err != nil {
		t.Fatal(err)
	}
	policy, err := readDetailPolicy("XRAY_BROCADE_SNIFFING_FAILED_CONTROL_FILE", true)
	if err != nil || !policy.Enabled || policy.MaxDomainsPerUser != 1024 {
		t.Fatalf("additional dimension changed target policy: %+v, %v", policy, err)
	}
	for _, value := range []string{`{"enabled":true} {}`, `{"enabled":true,"max_targets_per_user":5000}`} {
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readDetailPolicy("XRAY_BROCADE_SNIFFING_FAILED_CONTROL_FILE", true); err == nil {
			t.Fatal("invalid target policy accepted")
		}
	}
}

func BenchmarkFailedTargetHotCounter(b *testing.B) {
	m := domainTestManager()
	m.failedTargets.update(m.otherDomains.policy, 7201)
	up, _ := m.SniffingFailedCounters("a@t#i", "tcp://192.0.2.1:443")
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		up.Add(32768)
	}
}

func TestFailedTargetsAreIndependentBoundedAndReusable(t *testing.T) {
	m := domainTestManager()
	if m.SniffingFailedEnabled() {
		t.Fatal("not default off")
	}
	if up, _ := m.SniffingFailedCounters("a@t#i", "tcp://192.0.2.1:443"); up != nil {
		t.Fatal("off allocates")
	}
	m.failedTargets.update(m.otherDomains.policy, 7201)
	for i := 0; i < 1024; i++ {
		up, _ := m.SniffingFailedCounters("a@t#i", fmt.Sprintf("tcp://192.0.2.1:%d", i+1))
		if up == nil {
			t.Fatalf("target %d refused", i)
		}
		up.Add(10)
	}
	if up, _ := m.SniffingFailedCounters("a@t#other", "udp://192.0.2.1:53"); up != nil {
		t.Fatal("per-user capacity bypassed")
	}
	up, _ := m.SniffingFailedCounters("b@t#i", "udp://[2001:0db8::1]:53")
	if up == nil {
		t.Fatal("different user shares budget")
	}
	up.Add(13)
	if got := testing.AllocsPerRun(1000, func() { up.Add(1) }); got != 0 {
		t.Fatalf("hot path allocates %v", got)
	}
	m.failedTargets.update(m.failedTargets.policy, 10801)
	up.Add(7)
	m.failedTargets.mu.Lock()
	up.Add(2)
	m.failedTargets.mu.Unlock()
	found := false
	for _, row := range m.SniffingFailedSnapshot() {
		if strings.Contains(row.Name, "10800>>>b@t#i>>>udp://[2001:db8::1]:53>>>uplink") && row.Value == 9 {
			found = true
		}
	}
	if !found {
		t.Fatal("canonical key or cross-hour reusable handle lost")
	}
	if domain, _ := m.OtherDomainCounters("a@t#i", "still-available.example"); domain == nil {
		t.Fatal("failed targets consumed domain capacity")
	}
	for _, bad := range []string{"tcp://host.example:443", "https://192.0.2.1:443", "tcp://192.0.2.1:0"} {
		if c, _ := m.SniffingFailedCounters("b@t#i", bad); c != nil {
			t.Fatal("invalid endpoint accepted")
		}
	}
	m.failedTargets.update(otherDomainPolicy{}, 10802)
	up.Add(100)
	if m.SniffingFailedEnabled() || m.failedTargets.candidates != nil || !m.OtherDomainEnabled() {
		t.Fatal("independent disable failed")
	}
}
