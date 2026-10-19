package stats

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/xtls/xray-core/common/errors"
	featurestats "github.com/xtls/xray-core/features/stats"
)

func siteUsagePolicy() (bool, error) {
	path := os.Getenv("XRAY_BROCADE_SITE_USAGE_CONTROL_FILE")
	if path == "" {
		return os.Getenv("XRAY_BROCADE_SITE_USAGE_ENABLED") == "1", nil
	}
	if !filepath.IsAbs(path) {
		return false, fmt.Errorf("site policy path must be absolute")
	}
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return false, fmt.Errorf("site policy must be a private regular file")
	}
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 3))
	if err != nil {
		return false, err
	}
	switch string(data) {
	case "1", "1\n":
		return true, nil
	case "0", "0\n":
		return false, nil
	default:
		return false, fmt.Errorf("invalid site policy value")
	}
}

// Called under Manager.access, or before the manager is published. The generation
// marker lets Console detect even an off/on cycle between two Agent samples.
func (m *Manager) setSiteEnabled(enabled bool) {
	flag := int64(0)
	if enabled {
		flag = 1
	}
	previous := m.counters["site>>>enabled"].Set(flag)
	if enabled && previous == 0 {
		m.counters["site>>>activation"].Set(time.Now().UnixNano())
	}
	m.siteEnabled.Store(enabled)
}

func (m *Manager) watchSiteUsage(stop <-chan struct{}) {
	if os.Getenv("XRAY_BROCADE_SITE_USAGE_CONTROL_FILE") == "" {
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	failed := false
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			enabled, err := siteUsagePolicy()
			if err != nil && !failed {
				errors.LogWarning(context.Background(), "site usage policy unavailable; collection disabled")
			}
			failed = err != nil
			if err != nil {
				enabled = false
			}
			if enabled != m.siteEnabled.Load() {
				m.access.Lock()
				m.setSiteEnabled(enabled)
				m.access.Unlock()
			}
		}
	}
}

type gatedSiteCounter struct {
	counter *Counter
	enabled *atomic.Bool
}

func (c *gatedSiteCounter) Value() int64      { return c.counter.Value() }
func (c *gatedSiteCounter) Set(v int64) int64 { return c.counter.Set(v) }
func (c *gatedSiteCounter) Add(v int64) int64 {
	if c.enabled.Load() {
		return c.counter.Add(v)
	}
	return c.counter.Value()
}
func (m *Manager) siteCounter(name string, c *Counter) featurestats.Counter {
	if m.siteJournal != nil && strings.HasPrefix(name, "site>>>") && strings.Contains(name, ">>>traffic>>>") {
		return &gatedSiteCounter{counter: c, enabled: &m.siteEnabled}
	}
	return c
}
