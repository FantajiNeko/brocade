package pubsub

import (
	"fmt"
	"testing"
)

func TestCleanupCapacityTracksSubscribers(t *testing.T) {
	service := NewService()
	defer service.ctask.Close()
	const topics = 128
	for i := range topics {
		name := fmt.Sprint(i)
		service.Subscribe(name)
		service.Subscribe(name).Close()
	}
	if err := service.Cleanup(); err != nil {
		t.Fatal(err)
	}
	service.RLock()
	defer service.RUnlock()
	capacity := 0
	for _, subscribers := range service.subs {
		if len(subscribers) != 1 {
			t.Fatal("closed subscriber survived cleanup")
		}
		capacity += cap(subscribers)
	}
	if capacity > topics*4 {
		t.Fatalf("cleanup allocated %d subscriber slots for %d active subscriptions", capacity, topics)
	}
}
