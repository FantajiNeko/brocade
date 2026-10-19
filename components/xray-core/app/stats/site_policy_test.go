//go:build linux

package stats

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSitePolicyDefaultsOffAndValidatesPrivateControl(t *testing.T) {
	t.Setenv("XRAY_BROCADE_SITE_USAGE_ENABLED", "")
	t.Setenv("XRAY_BROCADE_SITE_USAGE_CONTROL_FILE", "")
	if on, err := siteUsagePolicy(); err != nil || on {
		t.Fatalf("must default off: %v %v", on, err)
	}
	path := filepath.Join(t.TempDir(), "enabled")
	t.Setenv("XRAY_BROCADE_SITE_USAGE_CONTROL_FILE", path)
	if on, err := siteUsagePolicy(); err != nil || on {
		t.Fatalf("absent control: %v %v", on, err)
	}
	for _, value := range []string{"0\n", "1\n", "garbage", "1\nextra"} {
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		on, err := siteUsagePolicy()
		if value == "0\n" || value == "1\n" {
			if err != nil || on != (value == "1\n") {
				t.Fatalf("policy %q: %v %v", value, on, err)
			}
		} else if err == nil {
			t.Fatalf("accepted invalid policy %q", value)
		}
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := siteUsagePolicy(); err == nil {
		t.Fatal("accepted non-private policy")
	}
}

func TestSitePolicyStopsExistingCountersWithoutInterruptingBilling(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "enabled")
	t.Setenv("XRAY_BROCADE_SITE_USAGE_ENABLED", "")
	t.Setenv("XRAY_BROCADE_SITE_USAGE_CONTROL_FILE", path)
	t.Setenv("XRAY_BROCADE_SITE_ACCOUNTING_FILE", filepath.Join(dir, "sites.bin"))
	m, err := NewManager(context.Background(), &Config{})
	if err != nil {
		t.Fatal(err)
	}
	if m.SiteStatsEnabled() {
		t.Fatal("default enabled")
	}
	if err := m.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close() })
	change := func(value string, want bool) {
		t.Helper()
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(tmp, path); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(3 * time.Second)
		for m.SiteStatsEnabled() != want && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if m.SiteStatsEnabled() != want {
			t.Fatalf("watcher failed for %q", value)
		}
	}
	change("1\n", true)
	activation := m.GetCounter("site>>>activation").Value()
	site, err := m.RegisterCounter("site>>>alice@root#entry>>>youtube>>>traffic>>>uplink")
	if err != nil {
		t.Fatal(err)
	}
	billing, err := m.RegisterCounter("user>>>alice@root#entry>>>traffic>>>uplink")
	if err != nil {
		t.Fatal(err)
	}
	site.Add(100)
	billing.Add(100)
	change("0\n", false)
	site.Add(200)
	billing.Add(200)
	if site.Value() != 100 || billing.Value() != 300 {
		t.Fatal("disable affected billing or kept collecting")
	}
	change("1\n", true)
	if m.GetCounter("site>>>activation").Value() <= activation {
		t.Fatal("off/on cycle lost activation boundary")
	}
	site.Add(50)
	billing.Add(50)
	if site.Value() != 150 || billing.Value() != 350 {
		t.Fatal("resume failed")
	}
}

func TestDamagedSiteJournalDoesNotBlockBilling(t *testing.T) {
	t.Setenv("XRAY_BROCADE_SITE_USAGE_ENABLED", "1")
	t.Setenv("XRAY_BROCADE_SITE_USAGE_CONTROL_FILE", "")
	t.Setenv("XRAY_BROCADE_SITE_ACCOUNTING_FILE", filepath.Join(t.TempDir(), "missing", "sites.bin"))
	m, err := NewManager(context.Background(), &Config{})
	if err != nil {
		t.Fatal(err)
	}
	if m.SiteStatsEnabled() {
		t.Fatal("broken observation enabled")
	}
	counter, err := m.RegisterCounter("user>>>alice@root#entry>>>traffic>>>uplink")
	if err != nil {
		t.Fatal(err)
	}
	if counter.Add(100) != 100 {
		t.Fatal("billing interrupted")
	}
}
