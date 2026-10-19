//go:build !linux

package stats

import (
	"fmt"
	"os"
)

func openCounterJournal() (counterJournal, error) {
	if os.Getenv(accountingJournalEnv) != "" || os.Getenv(delegatedAccountingEnv) != "" {
		return nil, fmt.Errorf("managed accounting journal requires Linux")
	}
	return nil, nil
}
