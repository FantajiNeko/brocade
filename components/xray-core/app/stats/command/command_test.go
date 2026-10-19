package command_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
	"github.com/xtls/xray-core/app/stats"
	. "github.com/xtls/xray-core/app/stats/command"
	"github.com/xtls/xray-core/common"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type addOnlyManager struct{ *stats.Manager }

func TestFailedTargetsRequireDedicatedReadOnlyQuery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "failed-policy.json")
	common.Must(os.WriteFile(path, []byte(`{"enabled":true,"top_n":128,"max_targets_per_user":1024,"node_capacity":4096,"report_interval_secs":30}`), 0600))
	t.Setenv("XRAY_BROCADE_SNIFFING_FAILED_CONTROL_FILE", path)
	m, err := stats.NewManager(context.Background(), &stats.Config{})
	common.Must(err)
	defer m.Close()
	up, _ := m.SniffingFailedCounters("a@t#i", "tcp://192.0.2.1:443")
	up.Add(123)
	s := NewStatsServer(m)
	for _, pattern := range []string{"", "user>>>", "site>>>", "otherdomain>>>"} {
		result, err := s.QueryStats(context.Background(), &QueryStatsRequest{Pattern: pattern})
		common.Must(err)
		for _, row := range result.Stat {
			if strings.Contains(row.Name, "192.0.2.1") {
				t.Fatal("IP target leaked into another query")
			}
		}
	}
	result, err := s.QueryStats(context.Background(), &QueryStatsRequest{Pattern: "sniffingfailed>>>"})
	common.Must(err)
	found := false
	for _, row := range result.Stat {
		if strings.Contains(row.Name, "tcp://192.0.2.1:443") && row.Value == 123 {
			found = true
		}
	}
	if !found {
		t.Fatal("dedicated target snapshot missing")
	}
	_, err = s.QueryStats(context.Background(), &QueryStatsRequest{Pattern: "sniffingfailed>>>", Reset_: true})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatal("target reset accepted")
	}
}

func TestOtherDomainsRequireDedicatedReadOnlyQuery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "domain-policy.json")
	common.Must(os.WriteFile(path, []byte(`{"enabled":true,"top_n":128,"max_domains_per_user":1024,"node_capacity":4096,"report_interval_secs":30}`), 0600))
	t.Setenv("XRAY_BROCADE_OTHER_DOMAIN_CONTROL_FILE", path)
	m, err := stats.NewManager(context.Background(), &stats.Config{})
	common.Must(err)
	defer m.Close()
	up, _ := m.OtherDomainCounters("a@t#entry", "private.example")
	up.Add(123)
	s := NewStatsServer(m)
	ordinary, err := s.QueryStats(context.Background(), &QueryStatsRequest{})
	common.Must(err)
	for _, stat := range ordinary.Stat {
		if strings.Contains(stat.Name, "private.example") {
			t.Fatal("raw domain leaked into required billing query")
		}
	}
	dedicated, err := s.QueryStats(context.Background(), &QueryStatsRequest{Pattern: "otherdomain>>>"})
	common.Must(err)
	found := false
	for _, stat := range dedicated.Stat {
		if strings.Contains(stat.Name, "private.example") && stat.Value == 123 {
			found = true
		}
	}
	if !found {
		t.Fatal("dedicated snapshot did not include domain bytes")
	}
	_, err = s.QueryStats(context.Background(), &QueryStatsRequest{Pattern: "otherdomain>>>", Reset_: true})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatal("domain reset was accepted")
	}
}

func (*addOnlyManager) AccountingResetAllowed() bool { return false }

func TestDelegatedAccountingResetAPIsFailBeforeMutation(t *testing.T) {
	m, err := stats.NewManager(context.Background(), &stats.Config{})
	common.Must(err)
	counter, err := m.RegisterCounter("inbound>>>fwd:18>>>traffic>>>uplink")
	common.Must(err)
	counter.Add(41)
	s := NewStatsServer(&addOnlyManager{m})
	_, getErr := s.GetStats(context.Background(), &GetStatsRequest{Name: "inbound>>>fwd:18>>>traffic>>>uplink", Reset_: true})
	_, queryErr := s.QueryStats(context.Background(), &QueryStatsRequest{Reset_: true})
	_, usersErr := s.GetUsersStats(context.Background(), &GetUsersStatsRequest{IncludeTraffic: true, Reset_: true})
	for _, err := range []error{getErr, queryErr, usersErr} {
		if status.Code(err) != codes.FailedPrecondition {
			t.Fatalf("reset API did not explicitly reject delegated accounting: %v", err)
		}
	}
	if counter.Value() != 41 {
		t.Fatal("reset API changed a delegated counter before rejecting it")
	}
	result, err := s.GetStats(context.Background(), &GetStatsRequest{Name: "inbound>>>fwd:18>>>traffic>>>uplink"})
	common.Must(err)
	if result.Stat.Value != 41 {
		t.Fatal("read-only StatsService stopped working")
	}
}

func TestGetStats(t *testing.T) {
	m, err := stats.NewManager(context.Background(), &stats.Config{})
	common.Must(err)

	sc, err := m.RegisterCounter("test_counter")
	common.Must(err)

	sc.Set(1)

	s := NewStatsServer(m)

	testCases := []struct {
		name  string
		reset bool
		value int64
		err   bool
	}{
		{
			name: "counterNotExist",
			err:  true,
		},
		{
			name:  "test_counter",
			reset: true,
			value: 1,
		},
		{
			name:  "test_counter",
			value: 0,
		},
	}
	for _, tc := range testCases {
		resp, err := s.GetStats(context.Background(), &GetStatsRequest{
			Name:   tc.name,
			Reset_: tc.reset,
		})
		if tc.err {
			if err == nil {
				t.Error("nil error: ", tc.name)
			}
		} else {
			common.Must(err)
			if r := cmp.Diff(resp.Stat, &Stat{Name: tc.name, Value: tc.value}, cmpopts.IgnoreUnexported(Stat{})); r != "" {
				t.Error(r)
			}
		}
	}
}

func TestQueryStats(t *testing.T) {
	m, err := stats.NewManager(context.Background(), &stats.Config{})
	common.Must(err)

	sc1, err := m.RegisterCounter("test_counter")
	common.Must(err)
	sc1.Set(1)

	sc2, err := m.RegisterCounter("test_counter_2")
	common.Must(err)
	sc2.Set(2)

	sc3, err := m.RegisterCounter("test_counter_3")
	common.Must(err)
	sc3.Set(3)

	s := NewStatsServer(m)
	resp, err := s.QueryStats(context.Background(), &QueryStatsRequest{
		Pattern: "counter_",
	})
	common.Must(err)
	if r := cmp.Diff(resp.Stat, []*Stat{
		{Name: "test_counter_2", Value: 2},
		{Name: "test_counter_3", Value: 3},
	}, cmpopts.SortSlices(func(s1, s2 *Stat) bool { return s1.Name < s2.Name }),
		cmpopts.IgnoreUnexported(Stat{})); r != "" {
		t.Error(r)
	}
}
