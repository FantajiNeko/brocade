package stats

const delegatedAccountingEnv = "XRAY_BROCADE_ACCOUNTING_DELEGATE"

// DelegatedAccountingStatus describes a restricted, owner-resident accounting
// view. Blocked is sticky: callers must stop admitting new work, but must not
// kill existing streams or stop their counter additions. This is not permission
// to retire the owner or to publish a second report stream.
type DelegatedAccountingStatus struct {
	Enabled  bool   `json:"enabled"`
	Blocked  bool   `json:"blocked"`
	Reason   string `json:"reason,omitempty"`
	OwnerPID int    `json:"owner_pid,omitempty"`
	Tag      string `json:"tag,omitempty"`
}

type delegatedCounterJournal interface {
	counterJournal
	Status() DelegatedAccountingStatus
}

// DelegatedAccountingStatus rechecks the pinned owner and journal identity.
// The handoff controller must check it before admission and periodically while
// delegated traffic is active; this package deliberately does not own listeners.
func (m *Manager) DelegatedAccountingStatus() DelegatedAccountingStatus {
	if journal, ok := m.journal.(delegatedCounterJournal); ok {
		return journal.Status()
	}
	return DelegatedAccountingStatus{}
}

// AccountingResetAllowed lets StatsService reject a reset before touching any
// counter. The ordinary statistics manager retains its original reset semantics.
func (m *Manager) AccountingResetAllowed() bool {
	_, delegated := m.journal.(delegatedCounterJournal)
	return !delegated
}
