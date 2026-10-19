//go:build !linux

package stats

import (
	"fmt"
	"os"
)

func openSiteJournal() (counterJournal, string, error) {
	if os.Getenv("XRAY_BROCADE_SITE_USAGE_ENABLED") == "1" && os.Getenv("XRAY_BROCADE_SITE_ACCOUNTING_FILE") != "" {
		return nil, "", fmt.Errorf("site accounting journal requires Linux")
	}
	return nil, "", nil
}
