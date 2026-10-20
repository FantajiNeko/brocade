package mtproto

import (
	"sync"
	"time"

	featurestats "github.com/xtls/xray-core/features/stats"
)

type onlineObservationKey struct {
	email    string
	sourceIP string
}

type onlineObservationLease struct {
	active     int
	generation uint64
	timer      *time.Timer
	touch      func()
	remove     func()
}

// onlineObservationTracker keeps a bounded MTProxy source observation visible long enough for the
// Agent's 30-second runtime snapshot to see it. Telegram may replace an otherwise continuously
// usable proxy transport with short TCP sessions, while the Console's existing product semantics
// deliberately retain a sampled source for 120 seconds as current and 30 days as history.
//
// One reference is held per user/source pair rather than per TCP connection. Reconnects cancel and
// renew the same lease, so a client cannot accumulate references by churning connections. The cap
// also prevents authenticated source churn from creating an unbounded timer/map tail; entries over
// the cap fall back to the ordinary connection-lifetime online semantics.
type onlineObservationTracker struct {
	mu          sync.Mutex
	grace       time.Duration
	maxRetained int
	leases      map[onlineObservationKey]*onlineObservationLease
}

func newOnlineObservationTracker(grace time.Duration, maxRetained int) *onlineObservationTracker {
	return &onlineObservationTracker{
		grace:       grace,
		maxRetained: maxRetained,
		leases:      make(map[onlineObservationKey]*onlineObservationLease),
	}
}

func (t *onlineObservationTracker) observe(
	manager featurestats.Manager,
	email string,
	sourceIP string,
) func() {
	_, _, release := t.observeWithTraffic(manager, email, sourceIP)
	return release
}

func (t *onlineObservationTracker) observeWithTraffic(
	manager featurestats.Manager,
	email string,
	sourceIP string,
) (featurestats.Counter, featurestats.Counter, func()) {
	if t == nil || manager == nil || email == "" || sourceIP == "" {
		return nil, nil, func() {}
	}

	online, _ := featurestats.GetOrRegisterOnlineMap(manager, "user>>>"+email+">>>online")
	if online == nil {
		return nil, nil, func() {}
	}
	add := func() { online.AddIP(sourceIP) }
	remove := func() { online.RemoveIP(sourceIP) }
	if protocols, ok := online.(featurestats.ProtocolOnlineMap); ok {
		add = func() { protocols.AddIPWithProtocol(sourceIP, protocolName) }
		remove = func() { protocols.RemoveIPWithProtocol(sourceIP, protocolName) }
	}
	touch := func() {
		add()
		remove()
	}
	key := onlineObservationKey{email: email, sourceIP: sourceIP}

	t.mu.Lock()
	if lease := t.leases[key]; lease != nil {
		lease.generation++
		if lease.timer != nil {
			lease.timer.Stop()
			lease.timer = nil
		}
		lease.active++
		lease.touch()
		t.mu.Unlock()
		uplink, downlink := sourceTrafficCounters(online, sourceIP)
		uplink, downlink = featurestats.WithSourceTraffic(manager, email, sourceIP, uplink, downlink)
		return uplink, downlink, t.releaseOnce(key, lease)
	}
	if t.maxRetained <= 0 || len(t.leases) >= t.maxRetained {
		t.mu.Unlock()
		add()
		uplink, downlink := sourceTrafficCounters(online, sourceIP)
		uplink, downlink = featurestats.WithSourceTraffic(manager, email, sourceIP, uplink, downlink)
		var once sync.Once
		return uplink, downlink, func() { once.Do(remove) }
	}

	add()
	lease := &onlineObservationLease{
		active: 1,
		touch:  touch,
		remove: remove,
	}
	t.leases[key] = lease
	t.mu.Unlock()
	uplink, downlink := sourceTrafficCounters(online, sourceIP)
	uplink, downlink = featurestats.WithSourceTraffic(manager, email, sourceIP, uplink, downlink)
	return uplink, downlink, t.releaseOnce(key, lease)
}

func sourceTrafficCounters(
	online featurestats.OnlineMap,
	sourceIP string,
) (featurestats.Counter, featurestats.Counter) {
	traffic, ok := online.(featurestats.SessionTrafficOnlineMap)
	if !ok {
		return nil, nil
	}
	uplink, downlink, ok := traffic.TrafficCounters(sourceIP)
	if !ok {
		return nil, nil
	}
	return uplink, downlink
}

func (t *onlineObservationTracker) releaseOnce(
	key onlineObservationKey,
	lease *onlineObservationLease,
) func() {
	var once sync.Once
	return func() {
		once.Do(func() { t.release(key, lease) })
	}
}

func (t *onlineObservationTracker) release(
	key onlineObservationKey,
	lease *onlineObservationLease,
) {
	t.mu.Lock()
	current := t.leases[key]
	if current != lease || lease.active <= 0 {
		t.mu.Unlock()
		return
	}
	lease.active--
	if lease.active > 0 {
		t.mu.Unlock()
		return
	}

	// Refresh last-seen at disconnect without adding another retained reference.
	lease.touch()
	lease.generation++
	generation := lease.generation
	lease.timer = time.AfterFunc(t.grace, func() {
		var remove func()
		t.mu.Lock()
		if t.leases[key] == lease && lease.active == 0 && lease.generation == generation {
			delete(t.leases, key)
			lease.timer = nil
			remove = lease.remove
		}
		t.mu.Unlock()
		if remove != nil {
			remove()
		}
	})
	t.mu.Unlock()
}
