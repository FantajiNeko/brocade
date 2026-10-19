package stats

import (
	"slices"
	"sync"
	"sync/atomic"
	"time"

	featurestats "github.com/xtls/xray-core/features/stats"
)

const (
	localhostIPv4 = "127.0.0.1"
	localhostIPv6 = "[::1]"
)

type ipEntry struct {
	refCount    int
	lastSeen    int64
	onlineSince int64
	protocols   map[string]int
	uplink      Counter
	downlink    Counter
}

// OnlineMap is a refcount-based implementation of stats.OnlineMap.
// IPs are tracked by reference counting: AddIP increments, RemoveIP decrements.
// An IP is removed from the map when its reference count reaches zero.
type OnlineMap struct {
	entries map[string]*ipEntry
	access  sync.Mutex
	count   atomic.Int64
}

// NewOnlineMap creates a new OnlineMap instance.
func NewOnlineMap() *OnlineMap {
	return &OnlineMap{
		entries: make(map[string]*ipEntry),
	}
}

// AddIP implements stats.OnlineMap.
func (om *OnlineMap) AddIP(ip string) {
	om.AddIPWithProtocol(ip, "")
}

func (om *OnlineMap) AddIPWithProtocol(ip, protocol string) {
	if ip == localhostIPv4 || ip == localhostIPv6 {
		return
	}
	now := time.Now().Unix()
	om.access.Lock()
	defer om.access.Unlock()
	if e, ok := om.entries[ip]; ok {
		e.refCount++
		e.lastSeen = now
		e.protocols[protocol]++
	} else {
		om.entries[ip] = &ipEntry{
			refCount:    1,
			lastSeen:    now,
			onlineSince: now,
			protocols:   map[string]int{protocol: 1},
		}
		om.count.Add(1)
	}
}

// RemoveIP implements stats.OnlineMap.
func (om *OnlineMap) RemoveIP(ip string) {
	om.RemoveIPWithProtocol(ip, "")
}

func (om *OnlineMap) RemoveIPWithProtocol(ip, protocol string) {
	om.access.Lock()
	defer om.access.Unlock()
	e, ok := om.entries[ip]
	if !ok || e.protocols[protocol] == 0 {
		return
	}
	if e.protocols[protocol]--; e.protocols[protocol] == 0 {
		delete(e.protocols, protocol)
	}
	e.refCount--
	if e.refCount <= 0 {
		delete(om.entries, ip)
		om.count.Add(-1)
	}
}

// Count implements stats.OnlineMap.
func (om *OnlineMap) Count() int {
	return int(om.count.Load())
}

// ForEach calls fn for each online IP. If fn returns false, iteration stops.
func (om *OnlineMap) ForEach(fn func(string, int64) bool) {
	om.access.Lock()
	defer om.access.Unlock()
	for ip, e := range om.entries {
		if !fn(ip, e.lastSeen) {
			break
		}
	}
}

// Snapshot all protocol references under the same lock as the IP membership, so a protocol
// disappearing cannot leave a detached label on an otherwise still-online source address.
func (om *OnlineMap) ForEachWithProtocols(fn func(string, int64, []string) bool) {
	om.access.Lock()
	defer om.access.Unlock()
	for ip, e := range om.entries {
		protocols := protocolSnapshot(e)
		if !fn(ip, e.lastSeen, protocols) {
			break
		}
	}
}

func protocolSnapshot(e *ipEntry) []string {
	protocols := make([]string, 0, len(e.protocols))
	for protocol := range e.protocols {
		protocols = append(protocols, protocol)
	}
	slices.Sort(protocols)
	return protocols
}

// TrafficCounters returns the current epoch's two counters for an already-online source. The
// entry pointer stays valid for the connection that obtained it even if a concurrent final close
// removes the address from future snapshots.
func (om *OnlineMap) TrafficCounters(ip string) (uplink, downlink featurestats.Counter, ok bool) {
	om.access.Lock()
	defer om.access.Unlock()
	e, ok := om.entries[ip]
	if !ok {
		return nil, nil, false
	}
	return &e.uplink, &e.downlink, true
}

// ForEachWithSessionTraffic snapshots membership, protocol references and session counters under
// one lock so the command API never combines byte totals from one epoch with another epoch's
// online-since timestamp.
func (om *OnlineMap) ForEachWithSessionTraffic(
	fn func(string, int64, int64, int64, int64, []string) bool,
) {
	om.access.Lock()
	defer om.access.Unlock()
	for ip, e := range om.entries {
		if !fn(
			ip,
			e.lastSeen,
			e.onlineSince,
			e.uplink.Value(),
			e.downlink.Value(),
			protocolSnapshot(e),
		) {
			break
		}
	}
}
