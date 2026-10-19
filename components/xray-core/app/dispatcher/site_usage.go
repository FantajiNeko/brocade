package dispatcher

import (
	"context"
	stdnet "net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/session"
	"github.com/xtls/xray-core/common/siteusage"
	"github.com/xtls/xray-core/features/stats"
)

type siteCounterTarget struct{ counter, other stats.Counter }

func (t *siteCounterTarget) add(v int64) {
	if t.counter != nil {
		t.counter.Add(v)
	}
	if t.other != nil {
		t.other.Add(v)
	}
}

// deferredSiteCounter preserves the existing accounting interface (including
// splice), while holding sniffed prefix bytes until their category is known.
type deferredSiteCounter struct {
	base    stats.Counter
	pending atomic.Int64
	target  atomic.Pointer[siteCounterTarget]
	bound   siteCounterTarget
	once    sync.Once
}

func (c *deferredSiteCounter) Value() int64      { return c.base.Value() }
func (c *deferredSiteCounter) Set(v int64) int64 { return c.base.Set(v) }
func (c *deferredSiteCounter) Add(v int64) int64 {
	result := c.base.Add(v)
	if target := c.target.Load(); target != nil {
		target.add(v)
	} else {
		c.pending.Add(v)
		if target := c.target.Load(); target != nil {
			pending := c.pending.Swap(0)
			if pending != 0 {
				target.add(pending)
			}
		}
	}
	return result
}
func (c *deferredSiteCounter) bind(target stats.Counter) {
	c.bindBoth(target, nil)
}
func (c *deferredSiteCounter) bindBoth(target, other stats.Counter) {
	c.once.Do(func() {
		c.bound.counter = target
		c.bound.other = other
		c.target.Store(&c.bound)
		pending := c.pending.Swap(0)
		if pending != 0 {
			c.bound.add(pending)
		}
	})
}

type siteUsageKey struct{}
type connectionSiteUsage struct {
	label    string
	domain   string
	up, down deferredSiteCounter
}

// Classification uses discovered metadata even when routing deliberately
// declines to override the destination (for example domainsExcluded).
func recordSiteDomain(ctx context.Context, domain string) {
	state, _ := ctx.Value(siteUsageKey{}).(*connectionSiteUsage)
	if state == nil || domain == "" {
		return
	}
	// Match ParseAddress normalization without allocating a boxed Address.
	if len(domain) > 1 && domain[0] == '[' && domain[len(domain)-1] == ']' {
		domain = domain[1 : len(domain)-1]
	}
	domain = strings.TrimSpace(domain)
	// Ordinary DNS names cannot be IP literals. Avoid ParseIP's error object
	// on that common path; digit-leading domains still receive the full check.
	ipCandidate := len(domain) > 0 && ((domain[0] >= '0' && domain[0] <= '9') || strings.IndexByte(domain, ':') >= 0)
	if !ipCandidate || stdnet.ParseIP(domain) == nil {
		state.domain = domain
	}
}

func withSiteUsage(ctx context.Context, manager stats.Manager) context.Context {
	var state *connectionSiteUsage
	inbound := session.InboundFromContext(ctx)
	if inbound != nil && inbound.User != nil && (stats.SiteUsageEnabled(manager, inbound.User.Email) || stats.OtherDomainUsageEnabled(manager, inbound.User.Email) || stats.SniffingFailedUsageEnabled(manager, inbound.User.Email)) {
		state = &connectionSiteUsage{label: inbound.User.Email}
	}
	if inherited, _ := ctx.Value(siteUsageKey{}).(*connectionSiteUsage); state == nil && inherited == nil {
		return ctx
	}
	// Always shadow an inherited Mux/dispatch context with a fresh state.
	return context.WithValue(ctx, siteUsageKey{}, state)
}

func siteCounter(ctx context.Context, base stats.Counter, uplink bool) stats.Counter {
	state, _ := ctx.Value(siteUsageKey{}).(*connectionSiteUsage)
	if state == nil {
		return base
	}
	counter := &state.down
	if uplink {
		counter = &state.up
	}
	counter.base = base
	return counter
}

func (d *DefaultDispatcher) bindSiteUsage(ctx context.Context, destination net.Destination) {
	state, _ := ctx.Value(siteUsageKey{}).(*connectionSiteUsage)
	if state == nil {
		return
	}
	domain := state.domain
	if destination.Address.Family().IsDomain() {
		if domain == "" {
			domain = destination.Address.Domain()
		}
	}
	content := session.ContentFromContext(ctx)
	site := siteusage.Classify(domain, content != nil && content.SniffingRequest.Enabled)
	var up, down, domainUp, domainDown stats.Counter
	if stats.SiteUsageEnabled(d.stats, state.label) {
		up, down = stats.GetSiteCounters(d.stats, state.label, site)
	}
	if site == "other" {
		domainUp, domainDown = stats.GetOtherDomainCounters(d.stats, state.label, domain)
	}
	if site == "sniffing-failed" && stats.SniffingFailedUsageEnabled(d.stats, state.label) {
		outbounds := session.OutboundsFromContext(ctx)
		if len(outbounds) > 0 {
			original := outbounds[len(outbounds)-1].OriginalTarget
			if original.IsValid() && original.Address.Family().IsIP() && (original.Network == net.Network_TCP || original.Network == net.Network_UDP) {
				target := original.Network.SystemString() + "://" + stdnet.JoinHostPort(original.Address.IP().String(), strconv.Itoa(int(original.Port)))
				domainUp, domainDown = stats.GetSniffingFailedCounters(d.stats, state.label, target)
			}
		}
	}
	if state.up.base != nil {
		state.up.bindBoth(up, domainUp)
	}
	if state.down.base != nil {
		state.down.bindBoth(down, domainDown)
	}
}
