package stats

const SourceTrafficPattern = "sourcetraffic>>>"

// WithSourceTraffic adds optional source observations without replacing online-session or billing
// counters. The collector retains completed short connections until the next bounded snapshot.
func WithSourceTraffic(manager Manager, label, ip string, up, down Counter) (Counter, Counter) {
	provider, ok := manager.(interface {
		SourceTrafficCounters(string, string) (Counter, Counter)
	})
	if !ok || !validDetailLabel(label) {
		return up, down
	}
	sourceUp, sourceDown := provider.SourceTrafficCounters(label, ip)
	return pairSource(up, sourceUp), pairSource(down, sourceDown)
}

func pairSource(primary, secondary Counter) Counter {
	if secondary == nil {
		return primary
	}
	if primary == nil {
		return secondary
	}
	return &sitePairedCounter{Counter: primary, secondary: secondary}
}
