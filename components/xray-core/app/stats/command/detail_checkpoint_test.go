package command_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/xtls/xray-core/app/stats"
	. "github.com/xtls/xray-core/app/stats/command"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestDetailCheckpointQueryEnablesSafeEviction(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(path, []byte(`{"enabled":true,"top_n":1,"max_domains_per_user":1,"node_capacity":1,"report_interval_secs":30}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XRAY_BROCADE_OTHER_DOMAIN_CONTROL_FILE", path)
	m, err := stats.NewManager(context.Background(), &stats.Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	a, _ := m.OtherDomainCounters("a@t#i", "a.example")
	a.Add(10)
	server := NewStatsServer(m)
	snapshot, err := server.QueryStats(context.Background(), &QueryStatsRequest{Pattern: "otherdomain>>>v2"})
	if err != nil {
		t.Fatal(err)
	}
	var epoch, id string
	for _, row := range snapshot.Stat {
		if suffix, ok := strings.CutPrefix(row.Name, "otherdomain>>>epoch:"); ok {
			epoch = suffix
		}
		if parts := strings.Split(row.Name, ">>>"); len(parts) == 6 && parts[5] == "uplink" {
			id = parts[4]
		}
	}
	if epoch == "" || id == "" {
		t.Fatal("v2 snapshot lacks an epoch or segment identity")
	}
	pattern := "otherdomain>>>ack>>>" + epoch + ">>>" + id + ":10:0"
	for _, request := range []*QueryStatsRequest{
		{Pattern: pattern, Reset_: true},
		{Pattern: "otherdomain>>>ack>>>" + epoch + ">>>" + id + ":10:-1"},
		{Pattern: pattern + ",invalid"},
	} {
		if _, err := server.QueryStats(context.Background(), request); status.Code(err) != codes.InvalidArgument {
			t.Fatal("invalid checkpoint accepted", err)
		}
	}
	blocked, _ := m.OtherDomainCounters("a@t#i", "b.example")
	if blocked.Add(1) != 0 {
		t.Fatal("invalid checkpoint allowed old bytes to be discarded")
	}
	if _, err := server.QueryStats(context.Background(), &QueryStatsRequest{Pattern: pattern}); err != nil {
		t.Fatal(err)
	}
	if b, _ := m.OtherDomainCounters("a@t#i", "b.example"); b == nil {
		t.Fatal("durable checkpoint did not release a cold slot")
	}
}
