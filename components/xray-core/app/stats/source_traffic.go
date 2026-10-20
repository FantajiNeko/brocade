package stats

import (
	"net/netip"
	"os"

	featurestats "github.com/xtls/xray-core/features/stats"
)

// Managed nodes already opt into source tracking through their UserOnline policy. Keeping this
// dimension separate from online membership preserves bytes after a connection has closed.
func sourceTrafficPolicy() otherDomainPolicy {
	return otherDomainPolicy{Enabled: os.Getenv("XRAY_BROCADE_ACCOUNTING_FILE") != "", TopN: 64, MaxDomainsPerUser: 64, NodeCapacity: 4096, ReportIntervalSecs: 15}
}

func (m *Manager) SourceTrafficCounters(label, source string) (featurestats.Counter, featurestats.Counter) {
	address, err := netip.ParseAddr(source)
	if err != nil || address.Zone() != "" || address.IsUnspecified() || address.IsMulticast() {
		return nil, nil
	}
	return m.sourceTraffic.counters(label, address.Unmap().String())
}

func (m *Manager) SourceTrafficSnapshot() []featurestats.DetailUsageStat {
	return m.sourceTraffic.snapshot(featurestats.SourceTrafficPattern)
}
