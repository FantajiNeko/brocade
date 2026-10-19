package handofflab

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Only the H9 test uses this overlay. Each process has exactly one Wait caller;
// normal retirement and forced cleanup consume the same recorded result.
var h9Current *h9Run

type h9Wait struct {
	ExitCode int    `json:"exit_code"`
	Signal   string `json:"signal"`
	Error    string `json:"error"`
	AtUS     int64  `json:"at_us"`
}

type h9Process struct {
	Name         string `json:"name"`
	PID          int    `json:"pid"`
	BinarySHA256 string `json:"binary_sha256"`
	Wait         h9Wait `json:"wait"`
	Cleanup      struct {
		Forced bool   `json:"forced"`
		Reason string `json:"reason"`
	} `json:"cleanup"`
	cmd  *exec.Cmd
	done chan struct{}
	mu   sync.Mutex
}

func h9Command(role, binary string, args ...string) *exec.Cmd {
	if os.Getenv("H7_NETNS") == "1" {
		return exec.Command("ip", append([]string{"netns", "exec", "h7-" + role, binary}, args...)...)
	}
	return exec.Command(binary, args...)
}

func h9ForwardAddress() string {
	if os.Getenv("H7_NETNS") == "1" {
		return "10.77.1.1"
	}
	return "127.0.0.1"
}

func (f *fixture) startProcess(cmd *exec.Cmd, logPath string) {
	f.t.Helper()
	h := h9Current
	if h == nil {
		f.t.Fatal("H9 process collector was not initialized")
	}
	log, err := os.Create(logPath)
	if err != nil {
		f.t.Fatal(err)
	}
	cmd.Stdout, cmd.Stderr = log, log
	if err = cmd.Start(); err != nil {
		log.Close()
		f.t.Fatal(err)
	}
	name := strings.TrimSuffix(filepath.Base(logPath), ".log")
	if name == "xray" {
		name = filepath.Base(filepath.Dir(logPath))
	}
	bin := cmd.Path
	if os.Getenv("H7_NETNS") == "1" {
		bin = cmd.Args[4]
	}
	p := &h9Process{Name: name, PID: cmd.Process.Pid, BinarySHA256: fileDigest(f.t, bin), cmd: cmd, done: make(chan struct{})}
	h.processes = append(h.processes, p)
	go func() {
		err := cmd.Wait()
		w := h9Wait{ExitCode: cmd.ProcessState.ExitCode(), AtUS: time.Since(h.base.start).Microseconds()}
		if err != nil {
			w.Error = err.Error()
		}
		if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			w.Signal = status.Signal().String()
		}
		p.Wait = w
		_ = log.Close()
		close(p.done)
	}()
	f.t.Cleanup(func() {
		select {
		case <-p.done:
			return
		default:
		}
		p.Cleanup.Forced, p.Cleanup.Reason = true, "test cleanup: process not normally stopped"
		_ = cmd.Process.Kill()
		select {
		case <-p.done:
		case <-time.After(5 * time.Second):
			f.t.Errorf("cleanup Wait timeout for %s", name)
		}
	})
}

func (h *h9Run) process(name string) *h9Process {
	for _, p := range h.processes {
		if p.Name == name {
			return p
		}
	}
	h.base.t.Fatalf("missing process %s", name)
	return nil
}

func (h *h9Run) terminate(name string) h9Wait {
	t := h.base.t
	p := h.process(name)
	select {
	case <-p.done:
		t.Fatalf("%s exited before requested termination: %+v", name, p.Wait)
	default:
	}
	h.base.event(name+"-retirement-signaled", object{"pid": p.PID})
	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.done:
	case <-time.After(5 * time.Second):
		t.Fatalf("%s did not exit after SIGTERM", name)
	}
	w := p.Wait
	h.base.event(name+"-exit-observed", object{"pid": p.PID, "exit_code": w.ExitCode, "exit_signal": w.Signal, "wait_error": w.Error})
	if w.ExitCode != 0 || w.Signal != "" || w.Error != "" {
		t.Fatal(fmt.Errorf("%s did not exit cleanly: %+v", name, w))
	}
	return w
}
