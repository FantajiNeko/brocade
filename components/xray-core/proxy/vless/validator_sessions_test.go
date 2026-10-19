package vless

import (
	"sync/atomic"
	"testing"

	"github.com/xtls/xray-core/common/protocol"
	"github.com/xtls/xray-core/common/uuid"
)

func TestValidatorRemovalClosesOnlyItsCredentialAndRegrantRejectsStaleAuth(t *testing.T) {
	alice := &protocol.MemoryUser{Email: "Alice", Account: &MemoryAccount{ID: protocol.NewID(uuid.New())}}
	bob := &protocol.MemoryUser{Email: "bob", Account: &MemoryAccount{ID: protocol.NewID(uuid.New())}}
	var first, other MemoryValidator
	for _, v := range []*MemoryValidator{&first, &other} {
		if err := v.Add(alice); err != nil {
			t.Fatal(err)
		}
	}
	if err := first.Add(bob); err != nil {
		t.Fatal(err)
	}
	old := first.GetByEmail("alice")
	var closedAlice, closedBob, closedOther atomic.Int32
	endA, ok := first.RegisterConnection(old, func() { closedAlice.Add(1) })
	if !ok {
		t.Fatal("alice admission failed")
	}
	defer endA()
	endB, ok := first.RegisterConnection(first.GetByEmail("bob"), func() { closedBob.Add(1) })
	if !ok {
		t.Fatal("bob admission failed")
	}
	defer endB()
	endOther, ok := other.RegisterConnection(other.GetByEmail("Alice"), func() { closedOther.Add(1) })
	if !ok {
		t.Fatal("other inbound admission failed")
	}
	defer endOther()
	if err := first.Del("ALICE"); err != nil {
		t.Fatal(err)
	}
	if closedAlice.Load() != 1 || closedBob.Load() != 0 || closedOther.Load() != 0 {
		t.Fatal("removal was not scoped to the exact inbound/user")
	}
	// Reuse even the same caller's input: the granted identity must still be new.
	if err := first.Add(alice); err != nil {
		t.Fatal(err)
	}
	if _, ok := first.RegisterConnection(old, func() {}); ok {
		t.Fatal("stale authenticated carrier survived regrant")
	}
	var restoredClosed atomic.Bool
	endNew, ok := first.RegisterConnection(first.GetByEmail("Alice"), func() { restoredClosed.Store(true) })
	if !ok {
		t.Fatal("restored user cannot connect")
	}
	defer endNew()
	if err := first.Add(&protocol.MemoryUser{Email: "duplicate", Account: alice.Account}); err == nil {
		t.Fatal("duplicate credential replaced current user")
	}
	if restoredClosed.Load() {
		t.Fatal("rejected duplicate interrupted valid traffic")
	}
}
