package netstack

import (
	"sync"
	"time"
)

type entry struct {
	saddr    []string
	deadline time.Time
}

type cache struct {
	running bool
	m       map[string]entry
	mu      sync.Mutex
}

func (c *cache) run() {
	if c.running {
		return
	}
	c.running = true
	if c.m == nil {
		c.m = make(map[string]entry)
	}
	go c.gc()
}

func (c *cache) gc() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for now := range ticker.C {
		c.mu.Lock()
		for key, entry := range c.m {
			if now.After(entry.deadline) {
				delete(c.m, key)
			}
		}
		if len(c.m) == 0 {
			c.running = false
			c.mu.Unlock()
			return
		}
		c.mu.Unlock()
	}
}

func (c *cache) LookupHost(host string) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.run()
	if entry, ok := c.m[host]; ok {
		if time.Now().Before(entry.deadline) {
			return entry.saddr
		}
		delete(c.m, host)
	}
	return nil
}

func (c *cache) Cache(host string, saddr []string, ttl uint32) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.run()
	if _, exists := c.m[host]; !exists && len(c.m) >= 4096 {
		return
	}
	c.m[host] = entry{
		saddr:    saddr,
		deadline: time.Now().Add(time.Second * time.Duration(ttl)),
	}
}
