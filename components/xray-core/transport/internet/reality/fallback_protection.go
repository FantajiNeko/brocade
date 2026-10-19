package reality

import (
	"context"
	"encoding/hex"
	stderrors "errors"
	gonet "net"
	"sync"
	"sync/atomic"
	"time"

	realitytls "github.com/xtls/reality"
)

const (
	// DefaultFallbackIdleTimeout bounds both an incomplete REALITY handshake and the camouflage
	// fallback which follows a rejected handshake. Successful REALITY sessions leave this guard
	// before application traffic starts.
	DefaultFallbackIdleTimeout = 30 * time.Second
	// DefaultMaxPendingFallbacks bounds pre-authentication work for one REALITY listener even when
	// callers rotate source addresses.
	DefaultMaxPendingFallbacks = 512
	// DefaultMaxPendingFallbacksPerSource prevents one IPv4 address or IPv6 /64 from retaining most
	// of the listener's goroutines and file descriptors.
	DefaultMaxPendingFallbacksPerSource = 32
)

var (
	ErrTooManyPendingFallbacks          = stderrors.New("REALITY: too many pending handshakes or fallbacks")
	ErrTooManyPendingFallbacksForSource = stderrors.New("REALITY: too many pending handshakes or fallbacks for source")
	defaultFallbackProtection           = NewFallbackProtection(DefaultFallbackProtectionOptions())
)

// FallbackProtectionOptions controls work which has not yet completed REALITY authentication.
// A zero field receives its production default; protection cannot be disabled accidentally by an
// omitted protobuf or JSON field.
type FallbackProtectionOptions struct {
	IdleTimeout         time.Duration
	MaxPending          uint32
	MaxPendingPerSource uint32
}

func DefaultFallbackProtectionOptions() FallbackProtectionOptions {
	return FallbackProtectionOptions{
		IdleTimeout:         DefaultFallbackIdleTimeout,
		MaxPending:          DefaultMaxPendingFallbacks,
		MaxPendingPerSource: DefaultMaxPendingFallbacksPerSource,
	}
}

// FallbackProtection accounts for pre-authentication work across the process. Valid handshakes
// occupy a slot only while authenticating; rejected handshakes retain it until their camouflage
// fallback closes or idles.
type FallbackProtection struct {
	idleTimeout         time.Duration
	maxPending          uint32
	maxPendingPerSource uint32

	mu       sync.Mutex
	pending  uint32
	bySource map[string]uint32
}

func NewFallbackProtection(options FallbackProtectionOptions) *FallbackProtection {
	defaults := DefaultFallbackProtectionOptions()
	if options.IdleTimeout <= 0 {
		options.IdleTimeout = defaults.IdleTimeout
	}
	if options.MaxPending == 0 {
		options.MaxPending = defaults.MaxPending
	}
	if options.MaxPendingPerSource == 0 {
		options.MaxPendingPerSource = defaults.MaxPendingPerSource
	}
	if options.MaxPendingPerSource > options.MaxPending {
		options.MaxPendingPerSource = options.MaxPending
	}
	return &FallbackProtection{
		idleTimeout:         options.IdleTimeout,
		maxPending:          options.MaxPending,
		maxPendingPerSource: options.MaxPendingPerSource,
		bySource:            make(map[string]uint32),
	}
}

// DefaultFallbackProtection returns the process-wide production guard. Sharing it across
// listeners prevents an address-rotating caller from multiplying the global allowance by the
// number of configured REALITY inbounds.
func DefaultFallbackProtection() *FallbackProtection {
	return defaultFallbackProtection
}

func (p *FallbackProtection) acquire(source gonet.Addr) (func(), error) {
	key := fallbackSourceKey(source)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.pending >= p.maxPending {
		return nil, ErrTooManyPendingFallbacks
	}
	if p.bySource[key] >= p.maxPendingPerSource {
		return nil, ErrTooManyPendingFallbacksForSource
	}
	p.pending++
	p.bySource[key]++
	return func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		p.pending--
		if p.bySource[key] == 1 {
			delete(p.bySource, key)
		} else {
			p.bySource[key]--
		}
	}, nil
}

func fallbackSourceKey(address gonet.Addr) string {
	var ip gonet.IP
	if tcp, ok := address.(*gonet.TCPAddr); ok {
		ip = tcp.IP
	} else if host, _, err := gonet.SplitHostPort(address.String()); err == nil {
		ip = gonet.ParseIP(host)
	}
	if ipv4 := ip.To4(); ipv4 != nil {
		return "4:" + hex.EncodeToString(ipv4)
	}
	if ipv6 := ip.To16(); ipv6 != nil {
		return "6:" + hex.EncodeToString(ipv6[:8])
	}
	return "other:" + address.Network() + ":" + address.String()
}

type fallbackIdleConn struct {
	gonet.Conn
	timeout time.Duration
	enabled atomic.Bool
	mu      sync.Mutex
}

func newFallbackIdleConn(conn gonet.Conn, timeout time.Duration) (*fallbackIdleConn, error) {
	guarded := &fallbackIdleConn{Conn: conn, timeout: timeout}
	guarded.enabled.Store(true)
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return nil, err
	}
	return guarded, nil
}

func (c *fallbackIdleConn) Read(buffer []byte) (int, error) {
	n, err := c.Conn.Read(buffer)
	if n > 0 {
		c.refreshDeadline()
	}
	return n, err
}

func (c *fallbackIdleConn) Write(buffer []byte) (int, error) {
	n, err := c.Conn.Write(buffer)
	if n > 0 {
		c.refreshDeadline()
	}
	return n, err
}

func (c *fallbackIdleConn) refreshDeadline() {
	if !c.enabled.Load() {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.enabled.Load() {
		_ = c.Conn.SetDeadline(time.Now().Add(c.timeout))
	}
}

func (c *fallbackIdleConn) disable() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.enabled.Store(false)
	return c.Conn.SetDeadline(time.Time{})
}

func (c *fallbackIdleConn) CloseWrite() error {
	if conn, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return conn.CloseWrite()
	}
	return c.Conn.Close()
}

func serverWithFallbackProtection(conn gonet.Conn, config *realitytls.Config, protection *FallbackProtection) (*Conn, error) {
	release, err := protection.acquire(conn.RemoteAddr())
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	defer release()

	guarded, err := newFallbackIdleConn(conn, protection.idleTimeout)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), protection.idleTimeout)
	defer cancel()
	realityConn, err := realitytls.Server(ctx, guarded, config)
	if err != nil {
		_ = guarded.Close()
		return &Conn{Conn: realityConn}, err
	}
	if err := guarded.disable(); err != nil {
		_ = guarded.Close()
		return nil, err
	}
	return &Conn{Conn: realityConn}, nil
}
