//go:build linux

package stats

import (
	"encoding/hex"
	"fmt"
	"os"
)

// Site observations have their own bounded journal: exhausting it must never
// exhaust the billing journal or interrupt an authenticated connection.
func openSiteJournal() (counterJournal, string, error) {
	if os.Getenv("XRAY_BROCADE_SITE_USAGE_ENABLED") != "1" && os.Getenv("XRAY_BROCADE_SITE_USAGE_CONTROL_FILE") == "" {
		return nil, "", nil
	}
	path := os.Getenv("XRAY_BROCADE_SITE_ACCOUNTING_FILE")
	if path == "" {
		return nil, "", nil
	}
	mode := journalExclusive
	switch os.Getenv(accountingSharedEnv) {
	case "":
	case "owner":
		mode = journalSharedOwner
	case "join":
		mode = journalSharedJoin
	default:
		return nil, "", fmt.Errorf("invalid site accounting shared mode")
	}
	j, err := openMappedCounterJournalMode(path, mode)
	if err != nil && mode == journalSharedJoin {
		// An older/rolled-back binary does not own a site journal. The owner
		// path still validates permissions, flock and process identity, and
		// refuses to replace any live owner. Corrupt files remain errors.
		j, err = openMappedCounterJournalMode(path, journalSharedOwner)
	}
	if err != nil {
		return nil, "", err
	}
	return j, hex.EncodeToString(j.data[8:24]), nil
}
