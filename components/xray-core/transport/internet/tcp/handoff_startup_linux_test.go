//go:build linux

package tcp

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"syscall"
	"testing"

	xerrors "github.com/xtls/xray-core/common/errors"
	"golang.org/x/sys/unix"
)

func TestHandoffStartupFailurePreservesRealListenErrno(t *testing.T) {
	occupied := handoffTestListener(t)
	c := handoffTestControl(t, handoffTestManifest(t, occupied))
	_, _, err := c.open(occupied.Addr().String(), false, nil, func() (net.Listener, error) {
		return net.Listen("tcp4", occupied.Addr().String())
	})
	if !errors.Is(err, syscall.EADDRINUSE) {
		t.Fatalf("expected actual bind conflict, got %v", err)
	}
	if err := c.recordStartupFailure(xerrors.New("test-context-marker").Base(err)); err != nil {
		t.Fatal(err)
	}
	path := c.manifest.ControlPath + ".startup-error.json"
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record handoffStartupFailure
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatal(err)
	}
	if record.Version != 1 || record.GenerationID != c.manifest.GenerationID || record.PID != os.Getpid() || record.PIDStartTicks != c.pidStartTicks || record.BootID != c.bootID || record.Network != "tcp" || record.Address != occupied.Addr().String() || record.Errno != int(syscall.EADDRINUSE) {
		t.Fatalf("wrong root cause: %+v", record)
	}
	if strings.Contains(string(data), "test-context-marker") || len(data) > 4096 {
		t.Fatalf("unexpected free-form error data: %s", data)
	}
	var st unix.Stat_t
	if err := unix.Lstat(path, &st); err != nil || st.Mode&0777 != 0600 || st.Nlink != 1 {
		t.Fatalf("unsafe diagnostic file: %+v, %v", st, err)
	}
	// A second diagnostic cannot overwrite the first root cause.
	second := &net.OpError{Op: "listen", Net: "tcp", Addr: occupied.Addr(), Err: syscall.EACCES}
	if err := c.recordStartupFailure(second); !errors.Is(err, os.ErrExist) {
		t.Fatalf("overwrote first error: %v", err)
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != string(data) {
		t.Fatalf("root error changed: %s, %v", after, err)
	}
	if err := c.close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("teardown discarded startup evidence: %v", err)
	}
}

func TestHandoffStartupFailureTypedErrorsOnly(t *testing.T) {
	for _, network := range []string{"tcp4", "tcp6", "udp4", "udp6"} {
		t.Run(network, func(t *testing.T) {
			listener := handoffTestListener(t)
			c := handoffTestControl(t, handoffTestManifest(t, listener))
			address := &net.TCPAddr{IP: net.ParseIP("::1"), Port: 14444}
			err := fmt.Errorf("wrapped: %w", &net.OpError{Op: "listen", Net: network, Addr: address, Err: os.NewSyscallError("bind", syscall.EACCES)})
			if err := c.recordStartupFailure(err); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(c.manifest.ControlPath + ".startup-error.json")
			if err != nil {
				t.Fatal(err)
			}
			var record handoffStartupFailure
			if err := json.Unmarshal(data, &record); err != nil || record.Network != network[:3] || record.Address != "[::1]:14444" || record.Errno != int(syscall.EACCES) {
				t.Fatalf("wrong typed failure: %+v, %v", record, err)
			}
		})
	}
	for _, err := range []error{
		errors.New("bind: address already in use"),
		syscall.EADDRINUSE,
		&net.OpError{Op: "dial", Net: "tcp", Addr: &net.TCPAddr{IP: net.IPv4zero, Port: 14444}, Err: syscall.EADDRINUSE},
		&net.OpError{Op: "listen", Net: "unix", Addr: &net.UnixAddr{Name: "/test/socket"}, Err: syscall.EACCES},
	} {
		listener := handoffTestListener(t)
		c := handoffTestControl(t, handoffTestManifest(t, listener))
		if recordErr := c.recordStartupFailure(err); recordErr != nil {
			t.Fatal(recordErr)
		}
		if _, statErr := os.Stat(c.manifest.ControlPath + ".startup-error.json"); !os.IsNotExist(statErr) {
			t.Fatalf("classified a non-listen or text-only error: %v, %v", err, statErr)
		}
	}
}

func TestHandoffStartupFailureDoesNotFollowSymlink(t *testing.T) {
	listener := handoffTestListener(t)
	c := handoffTestControl(t, handoffTestManifest(t, listener))
	target := c.manifest.ControlPath + ".untouched"
	if err := os.WriteFile(target, []byte("unchanged"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, c.manifest.ControlPath+".startup-error.json"); err != nil {
		t.Fatal(err)
	}
	err := c.recordStartupFailure(&net.OpError{Op: "listen", Net: "tcp", Addr: listener.Addr(), Err: syscall.EADDRINUSE})
	if !errors.Is(err, os.ErrExist) {
		t.Fatalf("unexpected publication result: %v", err)
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "unchanged" {
		t.Fatalf("symlink target changed: %s, %v", data, err)
	}
	response, fds := handoffTestRPC(t, c, "status", 0, "")
	for _, fd := range fds {
		unix.Close(fd)
	}
	if response.Error != "" || response.Status == nil {
		t.Fatalf("optional diagnostic failure broke control recovery: %+v", response)
	}
}
