package stats

import (
	"sync"
	"testing"

	featurestats "github.com/xtls/xray-core/features/stats"
)

func sourceValue(m *Manager, name string) int64 {
	for _, row := range m.SourceTrafficSnapshot() {
		if row.Name == name {
			return row.Value
		}
	}
	return -1
}

func TestSourceTrafficRetainsShortConnectionsAndRotatesLongHandles(t *testing.T) {
	m := &Manager{}
	m.sourceTraffic.bucketSeconds = 30
	p := otherDomainPolicy{Enabled: true, TopN: 2, MaxDomainsPerUser: 2, NodeCapacity: 4, ReportIntervalSecs: 15}
	m.sourceTraffic.update(p, 1800000001)
	up, down := featurestats.WithSourceTraffic(m, "alice@t#i", "::ffff:192.0.2.1", nil, nil)
	up.Add(11)
	down.Add(22)
	// No online map/reference exists: closing a short connection cannot delete its bytes.
	if got := sourceValue(m, "sourcetraffic>>>1800000000>>>alice@t#i>>>192.0.2.1>>>uplink"); got != 11 {
		t.Fatalf("short source lost: %d", got)
	}
	m.sourceTraffic.update(p, 1800000031)
	up.Add(3)
	down.Add(4)
	if got := sourceValue(m, "sourcetraffic>>>1800000030>>>alice@t#i>>>192.0.2.1>>>downlink"); got != 4 {
		t.Fatalf("long handle did not rotate: %d", got)
	}
	if got := sourceValue(m, "sourcetraffic>>>1800000000>>>alice@t#i>>>192.0.2.1>>>downlink"); got != 22 {
		t.Fatalf("previous window changed: %d", got)
	}
	m.sourceTraffic.update(p, 1800000061)
	if sourceValue(m, "sourcetraffic>>>1800000000>>>alice@t#i>>>192.0.2.1>>>uplink") != -1 {
		t.Fatal("expired window retained")
	}
}

func TestSourceTrafficBudgetAndConcurrentAdds(t *testing.T) {
	m := &Manager{}
	m.sourceTraffic.bucketSeconds = 30
	m.sourceTraffic.update(otherDomainPolicy{Enabled: true, MaxDomainsPerUser: 1, NodeCapacity: 1}, 1800000001)
	up, _ := m.SourceTrafficCounters("alice@t#i", "192.0.2.1")
	if next, _ := m.SourceTrafficCounters("alice@t#i", "192.0.2.2"); next != nil {
		t.Fatal("source budget exceeded")
	}
	var workers sync.WaitGroup
	for range 8 {
		workers.Go(func() {
			for range 1000 {
				up.Add(1)
			}
		})
	}
	workers.Wait()
	if up.Value() != 8000 || sourceValue(m, "sourcetraffic>>>limited") != 1 {
		t.Fatal("existing source or limited marker lost")
	}
	if invalid, _ := m.SourceTrafficCounters("alice@t#i", "fe80::1%eth0"); invalid != nil {
		t.Fatal("scoped IP accepted")
	}
	if probe, _ := featurestats.WithSourceTraffic(m, "probe#test", "192.0.2.1", nil, nil); probe != nil {
		t.Fatal("probe observed as a user")
	}
}
