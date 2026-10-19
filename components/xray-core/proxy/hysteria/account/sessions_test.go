package account

import (
	"sync/atomic"
	"testing"

	"github.com/xtls/xray-core/common/protocol"
)

func TestValidatorRevokesWholeSessionWithoutAffectingOtherUsersOrRegrant(t *testing.T) {
	v := NewValidator()
	if v.IsManaged() {
		t.Fatal("empty initial validator prevents static-auth compatibility")
	}
	alice := &protocol.MemoryUser{Email: "alice", Account: &MemoryAccount{Auth: "alice-auth"}}
	bob := &protocol.MemoryUser{Email: "bob", Account: &MemoryAccount{Auth: "bob-auth"}}
	for _, user := range []*protocol.MemoryUser{alice, bob} {
		if err := v.Add(user); err != nil {
			t.Fatal(err)
		}
	}
	old := v.Get("alice-auth")
	var closedA, closedB atomic.Int32
	endA, ok := v.RegisterConnection(old, func() { closedA.Add(1) })
	if !ok {
		t.Fatal("alice admission failed")
	}
	defer endA()
	endB, ok := v.RegisterConnection(v.Get("bob-auth"), func() { closedB.Add(1) })
	if !ok {
		t.Fatal("bob admission failed")
	}
	defer endB()
	if err := v.Del("alice"); err != nil {
		t.Fatal(err)
	}
	if closedA.Load() != 1 || closedB.Load() != 0 {
		t.Fatal("revocation was not per-user")
	}
	if err := v.Add(alice); err != nil {
		t.Fatal(err)
	}
	if _, ok := v.RegisterConnection(old, func() {}); ok {
		t.Fatal("old QUIC session authenticated after regrant")
	}
	endNew, ok := v.RegisterConnection(v.Get("alice-auth"), func() {})
	if !ok {
		t.Fatal("regrant did not allow new sessions")
	}
	endNew()
	if err := v.Add(&protocol.MemoryUser{Email: "duplicate", Account: alice.Account}); err == nil {
		t.Fatal("duplicate auth replaced an existing credential")
	}
	if err := v.Del("alice"); err != nil {
		t.Fatal(err)
	}
	if err := v.Del("bob"); err != nil {
		t.Fatal(err)
	}
	if !v.IsManaged() || v.GetCount() != 0 {
		t.Fatal("removing last user reopened static-password authentication")
	}
}
