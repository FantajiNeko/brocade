package stats

import "testing"

type enabledSiteStats struct{ NoopManager }

func (enabledSiteStats) SiteStatsEnabled() bool { return true }

func TestSiteUsageOnlyAuthenticatesEntryIdentities(t *testing.T) {
	for _, label := range []string{"relay@n2", "probe#entry", "probe#test@root", "", "anonymous"} {
		if SiteUsageEnabled(enabledSiteStats{}, label) {
			t.Fatalf("non-user identity counted: %q", label)
		}
	}
	if !SiteUsageEnabled(enabledSiteStats{}, "alice@root#entry") {
		t.Fatal("entry grant excluded")
	}
	if SiteUsageEnabled(NoopManager{}, "alice@root#entry") {
		t.Fatal("standalone Xray unexpectedly enabled site accounting")
	}
}
