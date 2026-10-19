package stats

import "strings"

// SiteUsageEnabled accepts authenticated entry identities only. Hop and probe
// credentials cannot expose a final user and must not duplicate entry bytes.
func SiteUsageEnabled(manager Manager, label string) bool {
	enabled, ok := manager.(interface{ SiteStatsEnabled() bool })
	return ok && enabled.SiteStatsEnabled() && strings.Contains(label, "@") && strings.Contains(label, "#") && !strings.HasPrefix(label, "probe#")
}

// GetSiteCounters obtains a reusable pair. Managed implementations register cold
// categories asynchronously; a nil direction means observations are limited,
// never that an authenticated connection should fail.
func GetSiteCounters(manager Manager, label, site string) (Counter, Counter) {
	if provider, ok := manager.(interface {
		SiteCounters(string, string) (Counter, Counter, bool)
	}); ok {
		if up, down, supported := provider.SiteCounters(label, site); supported {
			return up, down
		}
	}
	up, _ := GetOrRegisterCounter(manager, "site>>>"+label+">>>"+site+">>>traffic>>>uplink")
	down, _ := GetOrRegisterCounter(manager, "site>>>"+label+">>>"+site+">>>traffic>>>downlink")
	return up, down
}

// WithSiteCounter is for a protocol whose service is intrinsically known (MTProxy).
// Observability failures leave the required billing counter intact; the manager
// exposes its persistent limited marker separately.
func WithSiteCounter(manager Manager, label, site, direction string, base Counter) Counter {
	if base == nil || !SiteUsageEnabled(manager, label) {
		return base
	}
	up, down := GetSiteCounters(manager, label, site)
	secondary := up
	if direction == "downlink" {
		secondary = down
	}
	if secondary == nil {
		return base
	}
	return &sitePairedCounter{Counter: base, secondary: secondary}
}

type sitePairedCounter struct {
	Counter
	secondary Counter
}

func (c *sitePairedCounter) Add(value int64) int64 {
	previous := c.Counter.Add(value)
	c.secondary.Add(value)
	return previous
}
