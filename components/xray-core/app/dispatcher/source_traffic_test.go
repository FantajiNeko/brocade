package dispatcher

import (
	"context"
	"testing"
	"time"

	appstats "github.com/xtls/xray-core/app/stats"
	"github.com/xtls/xray-core/features/stats"
)

type sourceObserver struct {
	stats.Manager
	up, down appstats.Counter
}

func (m *sourceObserver) SourceTrafficCounters(string, string) (stats.Counter, stats.Counter) {
	return &m.up, &m.down
}

func TestSourceObservationSurvivesOnlineReferenceRemoval(t *testing.T) {
	m, err := appstats.NewManager(context.Background(), &appstats.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	observer := &sourceObserver{Manager: m}
	ctx, cancel := context.WithCancel(context.Background())
	up, down := trackOnlineIP(ctx, observer, "alice@example.test#i-main", "192.0.2.1", "vless")
	up.Add(123)
	down.Add(456)
	cancel()
	online := m.GetOnlineMap("user>>>alice@example.test#i-main>>>online")
	deadline := time.Now().Add(time.Second)
	for online.Count() != 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if online.Count() != 0 || observer.up.Value() != 123 || observer.down.Value() != 456 {
		t.Fatal("short connection source bytes were lost")
	}
}
