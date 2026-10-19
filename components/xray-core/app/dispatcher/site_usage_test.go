package dispatcher

import (
	"context"
	appstats "github.com/xtls/xray-core/app/stats"
	"github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/protocol"
	"github.com/xtls/xray-core/common/session"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestFailedSniffUsesOriginalEndpointOnly(t *testing.T) {
	for _, tc := range []struct {
		name, original, domain string
		sniff                  bool
		network                net.Network
		want                   string
	}{
		{"tcp-v4", "192.0.2.1", "", true, net.Network_TCP, "tcp://192.0.2.1:443"},
		{"udp-v6", "2001:db8::1", "", true, net.Network_UDP, "udp://[2001:db8::1]:443"},
		{"sniff-disabled", "192.0.2.1", "", false, net.Network_TCP, ""},
		{"identified", "192.0.2.1", "video-s.twimg.com", true, net.Network_TCP, ""},
		{"domain-target", "host.example", "", true, net.Network_TCP, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "policy.json")
			if err := os.WriteFile(path, []byte(`{"enabled":true}`), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("XRAY_BROCADE_SNIFFING_FAILED_CONTROL_FILE", path)
			manager, err := appstats.NewManager(context.Background(), &appstats.Config{})
			if err != nil {
				t.Fatal(err)
			}
			defer manager.Close()
			ctx := session.ContextWithInbound(context.Background(), &session.Inbound{User: &protocol.MemoryUser{Email: "a@t#i"}})
			ctx = session.ContextWithContent(ctx, &session.Content{SniffingRequest: session.SniffingRequest{Enabled: tc.sniff}})
			original := net.Destination{Network: tc.network, Address: net.ParseAddress(tc.original), Port: 443}
			ctx = session.ContextWithOutbounds(ctx, []*session.Outbound{{OriginalTarget: original}})
			ctx = withSiteUsage(ctx, manager)
			base := new(appstats.Counter)
			up := siteCounter(ctx, base, true)
			up.Add(13)
			recordSiteDomain(ctx, tc.domain)
			// The eventual egress next hop is intentionally not the user's target.
			destination := net.TCPDestination(net.ParseAddress("198.51.100.1"), 8443)
			if tc.domain != "" {
				destination.Address = net.ParseAddress(tc.domain)
			}
			(&DefaultDispatcher{stats: manager}).bindSiteUsage(ctx, destination)
			up.Add(5)
			found := false
			for _, row := range manager.SniffingFailedSnapshot() {
				if strings.Contains(row.Name, ">>>uplink") && row.Value > 0 {
					if tc.want == "" || !strings.Contains(row.Name, ">>>"+tc.want+">>>") || row.Value != 18 {
						t.Fatalf("unexpected attribution: %s=%d", row.Name, row.Value)
					}
					found = true
				}
			}
			if found != (tc.want != "") || base.Value() != 18 {
				t.Fatal("target observation or billing changed")
			}
		})
	}
}

func TestDeferredSiteCounterConcurrentBinding(t *testing.T) {
	for round := 0; round < 100; round++ {
		base, site := new(appstats.Counter), new(appstats.Counter)
		counter := &deferredSiteCounter{base: base}
		counter.Add(123) // The prefix was consumed by sniffing before classification.
		var wg sync.WaitGroup
		for worker := 0; worker < 8; worker++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := 0; i < 100; i++ {
					counter.Add(7)
				}
			}()
		}
		counter.bind(site)
		wg.Wait()
		if want := int64(123 + 8*100*7); base.Value() != want || site.Value() != want {
			t.Fatalf("billing=%d site=%d want=%d", base.Value(), site.Value(), want)
		}
	}
}

func TestUnavailableSiteCounterStopsAccumulatingWithoutAffectingBilling(t *testing.T) {
	base, late := new(appstats.Counter), new(appstats.Counter)
	counter := &deferredSiteCounter{base: base}
	counter.Add(5)
	counter.bind(nil)
	counter.Add(7)
	counter.bind(late) // Classification and publication are immutable per connection.
	counter.Add(11)
	if base.Value() != 23 || counter.pending.Load() != 0 || late.Value() != 0 {
		t.Fatal("unavailable observations interfered with billing or kept accumulating")
	}
}

func TestSiteDomainNormalizationMatchesAddressParsing(t *testing.T) {
	for _, raw := range []string{"www.youtube.com", "123.example.com", "127.0.0.1", "[::1]", "2001:db8::1", " 127.0.0.1 ", " [::1] ", " [www.youtube.com] ", "WWW.YOUTUBE.COM.", " "} {
		state := &connectionSiteUsage{}
		ctx := context.WithValue(context.Background(), siteUsageKey{}, state)
		recordSiteDomain(ctx, raw)
		address := net.ParseAddress(raw)
		want := ""
		if address.Family().IsDomain() {
			want = address.Domain()
		}
		if state.domain != want {
			t.Fatalf("normalization changed for %q: %q vs %q", raw, state.domain, want)
		}
	}
}
