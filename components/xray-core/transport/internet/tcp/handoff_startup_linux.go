//go:build linux

package tcp

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type handoffStartupFailure struct {
	Version       int    `json:"version"`
	GenerationID  string `json:"generation_id"`
	PID           int    `json:"pid"`
	PIDStartTicks string `json:"pid_start_ticks"`
	BootID        string `json:"boot_id"`
	Network       string `json:"network"`
	Address       string `json:"address"`
	Errno         int    `json:"errno"`
}

// RecordHandoffStartupFailure preserves a typed listen failure before teardown
// removes the control socket. It deliberately never serializes err.Error(): that
// chain can contain configuration or credentials, and is not an errno protocol.
// Diagnostics are best-effort and must never delay or prevent startup recovery.
func RecordHandoffStartupFailure(err error) {
	handoffRegistry.Lock()
	c := handoffRegistry.control
	handoffRegistry.Unlock()
	if c != nil {
		_ = c.recordStartupFailure(err)
	}
}

func (c *tcpHandoff) recordStartupFailure(err error) error {
	var op *net.OpError
	var errno syscall.Errno
	if !errors.As(err, &op) || op.Op != "listen" || op.Addr == nil || !errors.As(op.Err, &errno) || errno == 0 {
		return nil
	}
	network := strings.TrimSuffix(strings.TrimSuffix(op.Net, "4"), "6")
	if network != "tcp" && network != "udp" {
		return nil
	}
	// Only numeric listening endpoints belong in this diagnostic, never a URL,
	// hostname, socket path, or free-form error message.
	host, _, parseErr := net.SplitHostPort(op.Addr.String())
	if parseErr != nil || net.ParseIP(host) == nil {
		return nil
	}
	record := handoffStartupFailure{
		Version: 1, GenerationID: c.manifest.GenerationID,
		PID: os.Getpid(), PIDStartTicks: c.pidStartTicks, BootID: c.bootID,
		Network: network, Address: op.Addr.String(), Errno: int(errno),
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	path := c.manifest.ControlPath + ".startup-error.json"
	if err := checkHandoffParent(path); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".startup-error-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	_, writeErr := temporary.Write(data)
	closeErr := temporary.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	// Publish atomically without overwriting a pre-existing record (or symlink).
	// Each attempt has a fresh private generation directory; keep its first root cause.
	return os.Link(temporary.Name(), path)
}
