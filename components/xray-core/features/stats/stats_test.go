package stats_test

import (
	"context"
	"sync"
	"testing"

	appstats "github.com/xtls/xray-core/app/stats"
	"github.com/xtls/xray-core/features/stats"
)

type racingCounters struct {
	stats.Manager
	ready sync.WaitGroup
}

func (m *racingCounters) RegisterCounter(name string) (stats.Counter, error) {
	m.ready.Done()
	m.ready.Wait()
	return m.Manager.RegisterCounter(name)
}

func TestConcurrentFirstConnectionsShareOneCounter(t *testing.T) {
	m, err := appstats.NewManager(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	race := &racingCounters{Manager: m}
	race.ready.Add(2)
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for range 2 {
		workers.Go(func() {
			counter, err := stats.GetOrRegisterCounter(race, "user>>>fixture>>>traffic>>>uplink")
			if counter != nil {
				counter.Add(5)
			}
			results <- err
		})
	}
	workers.Wait()
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if got := m.GetCounter("user>>>fixture>>>traffic>>>uplink").Value(); got != 10 {
		t.Fatal(got)
	}
}
