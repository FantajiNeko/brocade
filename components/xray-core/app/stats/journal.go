package stats

import "strings"

// counterJournal is opt-in, local to the managed data plane, and bounded. It preserves
// cumulative values, not network packets or session state. Process restarts retain all
// completed Add operations; sudden power loss still depends on filesystem durability.
type counterJournal interface {
	Counters() map[string]*Counter
	Register(string) (*Counter, error)
}

const accountingJournalEnv = "XRAY_BROCADE_ACCOUNTING_FILE"
const accountingSharedEnv = "XRAY_BROCADE_ACCOUNTING_SHARED"

func journalCounterName(name string) bool {
	return (strings.HasPrefix(name, "user>>>") || strings.HasPrefix(name, "inbound>>>fwd:")) && strings.Contains(name, ">>>traffic>>>")
}
