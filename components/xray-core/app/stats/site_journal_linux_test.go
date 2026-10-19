//go:build linux

package stats

import (
	"context"
	featurestats "github.com/xtls/xray-core/features/stats"
	"path/filepath"
	"testing"
)

func TestSiteJournalIsIndependentAndShared(t *testing.T) {
	t.Setenv("XRAY_BROCADE_SITE_USAGE_ENABLED", "1")
	dir := t.TempDir()
	t.Setenv(accountingJournalEnv, filepath.Join(dir, "billing.bin"))
	t.Setenv("XRAY_BROCADE_SITE_ACCOUNTING_FILE", filepath.Join(dir, "sites.bin"))
	t.Setenv(accountingSharedEnv, "owner")
	owner, err := NewManager(context.Background(), &Config{})
	if err != nil {
		t.Fatal(err)
	}
	owner.sitePending.Add(1)
	t.Setenv(accountingSharedEnv, "join")
	joined, err := NewManager(context.Background(), &Config{})
	if err != nil {
		t.Fatal(err)
	}
	if joined.sitePending.Value() != 1 {
		t.Fatal("joining manager reset unfinished registration marker")
	}
	joined.sitePending.Add(-1)
	if owner.sitePending.Value() != 0 {
		t.Fatal("registration marker is not shared")
	}
	name := "site>>>alice@root#entry>>>sniffing-failed>>>traffic>>>uplink"
	counter, err := owner.RegisterCounter(name)
	if err != nil {
		t.Fatal(err)
	}
	counter.Add(123)
	seen := int64(0)
	joined.VisitCounters(func(key string, c featurestats.Counter) bool {
		if key == name {
			seen = c.Value()
		}
		return true
	})
	if seen != 123 {
		t.Fatalf("late shared counter missing: %d", seen)
	}
	if _, found := owner.journal.Counters()[name]; found {
		t.Fatal("site counter consumed billing capacity")
	}
	full := *owner.siteJournal.(*mappedCounterJournal)
	full.count = journalCapacity
	full.registrationLock = nil // Exercise the capacity guard without 32K test fsyncs.
	owner.siteJournal = &full
	if _, err := owner.RegisterCounter("site>>>alice@root#entry>>>other>>>traffic>>>uplink"); err == nil {
		t.Fatal("expected capacity error")
	}
	if owner.siteLimited.Value() != 1 {
		t.Fatal("capacity loss must be visible")
	}
	if _, err := owner.RegisterCounter("user>>>alice@root#entry>>>traffic>>>uplink"); err != nil {
		t.Fatalf("site capacity broke billing: %v", err)
	}
}
