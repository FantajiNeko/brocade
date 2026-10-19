package inbound

import (
	"context"
	"errors"
	"net"
	"sync"
)

// Only dynamic fwd: listeners own this registry. Removing a forwarding rule (including quota
// suspension) must stop existing streams, not merely prevent new connections. Other inbounds
// retain their existing close/drain semantics and pay no per-connection registry cost.
type forwardingConnections struct {
	mu     sync.Mutex
	closed bool
	active map[*forwardingConnection]struct{}
}

type forwardingConnection struct {
	conn   net.Conn
	cancel context.CancelFunc
}

func (c *forwardingConnections) add(conn net.Conn, cancel context.CancelFunc) *forwardingConnection {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	if c.active == nil {
		c.active = make(map[*forwardingConnection]struct{})
	}
	entry := &forwardingConnection{conn: conn, cancel: cancel}
	c.active[entry] = struct{}{}
	return entry
}

func (c *forwardingConnections) remove(entry *forwardingConnection) {
	c.mu.Lock()
	delete(c.active, entry)
	c.mu.Unlock()
}

func (c *forwardingConnections) close() error {
	c.mu.Lock()
	c.closed = true
	active := c.active
	c.active = nil
	c.mu.Unlock()
	var errs []error
	for entry := range active {
		entry.cancel()
		if err := entry.conn.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
