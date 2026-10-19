package dispatcher

import (
	"context"
	appstats "github.com/xtls/xray-core/app/stats"
	"github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/protocol"
	"github.com/xtls/xray-core/common/session"
	"github.com/xtls/xray-core/common/siteusage"
	"github.com/xtls/xray-core/features/stats"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// Synthetic counter capacity, not network throughput. Fixed chunk sizes allow
// translating ns/op into the extra CPU cost per GiB at each I/O granularity.
func BenchmarkSiteCounter(b *testing.B) {
	for _, enabled := range []bool{false, true} {
		name := "off"
		if enabled {
			name = "on"
		}
		b.Run(name, func(b *testing.B) {
			manager := siteBenchmarkManager(b, enabled)
			base, err := manager.RegisterCounter("user>>>alice@root#entry>>>traffic>>>uplink")
			if err != nil {
				b.Fatal(err)
			}
			var counter stats.Counter = base
			if enabled {
				c := &deferredSiteCounter{base: base}
				site, _ := warmSiteBenchmark(b, manager)
				c.bind(site)
				counter = c
			}
			b.ReportAllocs()
			b.SetBytes(16384)
			b.ResetTimer()
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					counter.Add(16384)
				}
			})
		})
	}
}

// Metadata-only steady-state connection cost: no socket or fresh category fsync.
func BenchmarkSiteConnection(b *testing.B) {
	for _, enabled := range []bool{false, true} {
		name := "off"
		if enabled {
			name = "on"
		}
		b.Run(name, func(b *testing.B) {
			manager := siteBenchmarkManager(b, enabled)
			if enabled {
				warmSiteBenchmark(b, manager)
			}
			base := new(appstats.Counter)
			ctx := session.ContextWithInbound(context.Background(), &session.Inbound{User: &protocol.MemoryUser{Email: "alice@root#entry"}})
			ctx = session.ContextWithContent(ctx, &session.Content{SniffingRequest: session.SniffingRequest{Enabled: true}})
			d := &DefaultDispatcher{stats: manager}
			dest := net.TCPDestination(net.LocalHostIP, 443)
			prepare := func() {
				connection := withSiteUsage(ctx, manager)
				_ = siteCounter(connection, base, true)
				_ = siteCounter(connection, base, false)
				recordSiteDomain(connection, "www.youtube.com")
				d.bindSiteUsage(connection, dest)
			}
			prepare()
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				prepare()
			}
		})
	}
}

func siteBenchmarkManager(b *testing.B, enabled bool) *appstats.Manager {
	b.Helper()
	if runtime.GOOS != "linux" {
		b.Skip("persistent production journal requires Linux")
	}
	dir := b.TempDir()
	b.Setenv("XRAY_BROCADE_ACCOUNTING_SHARED", "")
	b.Setenv("XRAY_BROCADE_ACCOUNTING_FILE", filepath.Join(dir, "billing.bin"))
	b.Setenv("XRAY_BROCADE_SITE_ACCOUNTING_FILE", filepath.Join(dir, "sites.bin"))
	b.Setenv("XRAY_BROCADE_SITE_USAGE_ENABLED", "")
	control := filepath.Join(dir, "enabled")
	value := "0\n"
	if enabled {
		value = "1\n"
	}
	if err := os.WriteFile(control, []byte(value), 0600); err != nil {
		b.Fatal(err)
	}
	b.Setenv("XRAY_BROCADE_SITE_USAGE_CONTROL_FILE", control)
	manager, err := appstats.NewManager(context.Background(), &appstats.Config{})
	if err != nil {
		b.Fatal(err)
	}
	if err := manager.Start(); err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = manager.Close() })
	return manager
}

func warmSiteBenchmark(b *testing.B, manager *appstats.Manager) (stats.Counter, stats.Counter) {
	b.Helper()
	up, down := stats.GetSiteCounters(manager, "alice@root#entry", "youtube")
	if up == nil || down == nil {
		b.Fatal("site counter pair unavailable")
	}
	up.Add(1)
	down.Add(1)
	deadline := time.Now().Add(5 * time.Second)
	for _, direction := range []string{"uplink", "downlink"} {
		for {
			counter := manager.GetCounter("site>>>alice@root#entry>>>youtube>>>traffic>>>" + direction)
			if counter != nil && counter.Value() > 0 {
				break
			}
			if time.Now().After(deadline) {
				b.Fatal("async site registration did not complete")
			}
			runtime.Gosched()
		}
	}
	return up, down
}

func BenchmarkSiteClassify(b *testing.B) {
	for _, domain := range []string{"www.youtube.com", "cdn.apple.com", "unknown.example", ""} {
		b.Run(domain, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				siteusage.Classify(domain, true)
			}
		})
	}
}
