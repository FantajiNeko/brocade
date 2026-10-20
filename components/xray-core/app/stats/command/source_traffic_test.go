package command_test

import (
	"context"
	"strings"
	"testing"

	"github.com/xtls/xray-core/app/stats"
	. "github.com/xtls/xray-core/app/stats/command"
	featurestats "github.com/xtls/xray-core/features/stats"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type sourceQueryManager struct{ *stats.Manager }

func (m *sourceQueryManager) SourceTrafficSnapshot() []featurestats.DetailUsageStat {
	return []featurestats.DetailUsageStat{{Name: "sourcetraffic>>>1800000000>>>a@t#i>>>192.0.2.1>>>uplink", Value: 123}}
}
func TestSourceTrafficRequiresDedicatedReadOnlyQuery(t *testing.T) {
	m, err := stats.NewManager(context.Background(), &stats.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	s := NewStatsServer(&sourceQueryManager{m})
	for _, pattern := range []string{"", "user>>>", "sourcetraffic"} {
		result, err := s.QueryStats(context.Background(), &QueryStatsRequest{Pattern: pattern})
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range result.Stat {
			if strings.Contains(row.Name, "192.0.2.1") {
				t.Fatal("source leaked into broad query")
			}
		}
	}
	result, err := s.QueryStats(context.Background(), &QueryStatsRequest{Pattern: featurestats.SourceTrafficPattern})
	if err != nil || len(result.Stat) != 1 || result.Stat[0].Value != 123 {
		t.Fatal("source query failed", err)
	}
	_, err = s.QueryStats(context.Background(), &QueryStatsRequest{Pattern: featurestats.SourceTrafficPattern, Reset_: true})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatal("source counter reset accepted")
	}
}
