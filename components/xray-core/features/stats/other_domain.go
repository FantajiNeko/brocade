package stats

import "strings"

const OtherDomainPattern = "otherdomain>>>"

// OtherDomainStat is returned only through the dedicated optional query pattern.
type DetailUsageStat struct {
	Name  string
	Value int64
}
type OtherDomainStat = DetailUsageStat

type DetailCheckpoint struct {
	ID       uint64
	Up, Down int64
}

const SniffingFailedPattern = "sniffingfailed>>>"

func validDetailLabel(label string) bool {
	return len(label) <= 256 && strings.Contains(label, "@") && strings.Contains(label, "#") && !strings.HasPrefix(label, "probe#") && !strings.Contains(label, ">>>")
}

func OtherDomainUsageEnabled(manager Manager, label string) bool {
	provider, ok := manager.(interface{ OtherDomainEnabled() bool })
	return ok && provider.OtherDomainEnabled() && validDetailLabel(label)
}

func SniffingFailedUsageEnabled(manager Manager, label string) bool {
	provider, ok := manager.(interface{ SniffingFailedEnabled() bool })
	return ok && provider.SniffingFailedEnabled() && validDetailLabel(label)
}

func GetSniffingFailedCounters(manager Manager, label, target string) (Counter, Counter) {
	if provider, ok := manager.(interface {
		SniffingFailedCounters(string, string) (Counter, Counter)
	}); ok {
		return provider.SniffingFailedCounters(label, target)
	}
	return nil, nil
}

func GetOtherDomainCounters(manager Manager, label, domain string) (Counter, Counter) {
	if provider, ok := manager.(interface {
		OtherDomainCounters(string, string) (Counter, Counter)
	}); ok {
		return provider.OtherDomainCounters(label, domain)
	}
	return nil, nil
}
