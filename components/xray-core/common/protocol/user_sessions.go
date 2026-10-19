package protocol

import "sync"

// UserSessions owns only active sessions of one inbound validator. Admission rechecks the
// authoritative credential under the registry lock: a handshake which raced with removal
// cannot attach after CloseUser drained its old authorization. No revoked-user tombstones are
// retained. A newly granted credential must have a distinct MemoryUser identity.
type UserSessions struct {
	mu     sync.Mutex
	active map[*MemoryUser]map[*userSession]struct{}
}

type userSession struct{ close func() }

func (s *UserSessions) Register(user *MemoryUser, current func() bool, close func()) (func(), bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if user == nil || current == nil || close == nil || !current() {
		return nil, false
	}
	if s.active == nil {
		s.active = make(map[*MemoryUser]map[*userSession]struct{})
	}
	if s.active[user] == nil {
		s.active[user] = make(map[*userSession]struct{})
	}
	entry := &userSession{close: close}
	s.active[user][entry] = struct{}{}
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.active[user], entry)
		if len(s.active[user]) == 0 {
			delete(s.active, user)
		}
	}, true
}

// CloseUser follows removal from the validator, and never closes a replacement credential.
// Callbacks may unregister themselves, so they must run outside the registry lock.
func (s *UserSessions) CloseUser(user *MemoryUser) {
	s.mu.Lock()
	active := s.active[user]
	delete(s.active, user)
	s.mu.Unlock()
	for entry := range active {
		entry.close()
	}
}
