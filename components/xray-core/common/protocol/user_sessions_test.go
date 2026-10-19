package protocol

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestUserSessionsRevocationIsolationAndNoRetainedTombstones(t *testing.T) {
	var sessions UserSessions
	alice, bob := &MemoryUser{Email: "alice"}, &MemoryUser{Email: "bob"}
	var aliceCurrent atomic.Bool
	aliceCurrent.Store(true)
	var aliceClosed, bobClosed atomic.Int32
	var releaseAlice func()
	releaseAlice, _ = sessions.Register(alice, aliceCurrent.Load, func() { aliceClosed.Add(1); releaseAlice() })
	releaseBob, ok := sessions.Register(bob, func() bool { return true }, func() { bobClosed.Add(1) })
	if !ok {
		t.Fatal("bob was not admitted")
	}
	aliceCurrent.Store(false)
	sessions.CloseUser(alice)
	sessions.CloseUser(alice)
	if aliceClosed.Load() != 1 || bobClosed.Load() != 0 {
		t.Fatal("revocation affected another user or closed twice")
	}
	if _, ok := sessions.Register(alice, aliceCurrent.Load, func() { t.Error("revoked session admitted") }); ok {
		t.Fatal("late handshake admitted")
	}
	releaseAlice()
	releaseBob()
	if len(sessions.active) != 0 {
		t.Fatal("completed sessions retained registry state")
	}
}

func TestUserSessionsConcurrentAdmissionAndRemoval(t *testing.T) {
	for range 50 {
		var sessions UserSessions
		user := &MemoryUser{Email: "alice"}
		var current atomic.Bool
		current.Store(true)
		var admitted, closed atomic.Int32
		var group sync.WaitGroup
		start := make(chan struct{})
		for range 20 {
			group.Add(1)
			go func() {
				defer group.Done()
				<-start
				if _, ok := sessions.Register(user, current.Load, func() { closed.Add(1) }); ok {
					admitted.Add(1)
				}
			}()
		}
		group.Add(1)
		go func() { defer group.Done(); <-start; current.Store(false); sessions.CloseUser(user) }()
		close(start)
		group.Wait()
		if admitted.Load() != closed.Load() {
			t.Fatalf("admitted %d but closed %d", admitted.Load(), closed.Load())
		}
		if len(sessions.active) != 0 {
			t.Fatal("removed user retained")
		}
	}
}
