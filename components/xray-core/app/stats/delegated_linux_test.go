//go:build linux

package stats

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

const delegatedUp = "inbound>>>fwd:18>>>traffic>>>uplink"
const delegatedDown = "inbound>>>fwd:18>>>traffic>>>downlink"

func delegatedFixture(t *testing.T) (*mappedCounterJournal, delegatedJournalManifest) {
	t.Helper()
	owner, err := openMappedCounterJournal(filepath.Join(t.TempDir(), "owner.bin"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = unix.Munmap(owner.data); _ = owner.file.Close() })
	for _, name := range []string{delegatedUp, delegatedDown, "user>>>untouched>>>traffic>>>uplink"} {
		if _, err := owner.Register(name); err != nil {
			t.Fatal(err)
		}
	}
	pidfd, err := unix.PidfdOpen(os.Getpid(), 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = unix.Close(pidfd) })
	var st unix.Stat_t
	if err := unix.Fstat(int(owner.file.Fd()), &st); err != nil {
		t.Fatal(err)
	}
	exe, err := os.ReadFile("/proc/self/exe")
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(exe)
	manifest := delegatedJournalManifest{SchemaVersion: 1, JournalFD: int(owner.file.Fd()), OwnerPIDFD: pidfd, OwnerPID: os.Getpid(), OwnerStartTicks: binary.LittleEndian.Uint64(owner.data[32:40]), OwnerBootID: hex.EncodeToString(owner.data[40:56]), OwnerExecutableSHA256: hex.EncodeToString(hash[:]), Device: uint64(st.Dev), Inode: st.Ino, Epoch: hex.EncodeToString(owner.data[8:24]), RecordCount: uint32(owner.count), Tag: "fwd:18"}
	return owner, manifest
}

func closeDelegated(j *delegatedMappedJournal) {
	_ = unix.Munmap(j.data)
	_ = j.file.Close()
	_ = j.owner.Close()
}

func TestDelegatedJournalAddsOnlyToExistingSlots(t *testing.T) {
	owner, manifest := delegatedFixture(t)
	owner.counters[delegatedUp].Add(123)
	before := bytes.Clone(owner.data)
	j, err := mapDelegatedJournal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDelegated(j)
	var workers sync.WaitGroup
	for range 4 {
		workers.Go(func() {
			for range 10000 {
				owner.counters[delegatedUp].Add(1)
			}
		})
		workers.Go(func() {
			for range 10000 {
				j.counters[delegatedUp].Add(1)
			}
		})
	}
	workers.Wait()
	j.counters[delegatedDown].Add(37)
	if got := owner.counters[delegatedUp].Value(); got != 80123 {
		t.Fatalf("lost concurrent increments: %d", got)
	}
	if owner.counters[delegatedDown].Value() != 37 || len(j.Counters()) != 2 {
		t.Fatal("delegated counters did not share the two owner slots")
	}
	for index, value := range owner.data {
		if (index >= 64 && index < 72) || (index >= 576 && index < 584) {
			continue
		}
		if value != before[index] {
			t.Fatalf("non-counter byte changed at %d", index)
		}
	}
	if status := j.Status(); !status.Enabled || status.Blocked || status.Tag != "fwd:18" {
		t.Fatalf("unexpected delegated status: %+v", status)
	}
	m := &Manager{journal: j, counters: j.counters}
	if _, err := m.RegisterCounter("outbound>>>unexpected>>>traffic>>>uplink"); err == nil {
		t.Fatal("delegated manager created an unapproved in-memory counter")
	}
	if _, err := m.RegisterCounter("inbound>>>fwd:19>>>traffic>>>uplink"); err == nil {
		t.Fatal("delegated manager created a new journal label")
	}
	if err := m.UnregisterCounter(delegatedUp); err == nil || m.AccountingResetAllowed() {
		t.Fatal("delegated manager allowed an identity mutation or reset")
	}
}

func TestDelegatedJournalNeverUnlocksOwner(t *testing.T) {
	owner, manifest := delegatedFixture(t)
	j, err := mapDelegatedJournal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	closeDelegated(j)
	probe, err := os.OpenFile(owner.file.Name(), os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer probe.Close()
	if err := unix.Flock(int(probe.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != unix.EWOULDBLOCK {
		t.Fatalf("closing delegated view released owner's flock: %v", err)
	}
	if owner.counters[delegatedUp].Add(9) != 9 {
		t.Fatal("owner counter stopped working")
	}
}

func TestDelegatedJournalRejectsWrongCapabilities(t *testing.T) {
	owner, manifest := delegatedFixture(t)
	for name, mutate := range map[string]func(*delegatedJournalManifest){
		"schema":             func(m *delegatedJournalManifest) { m.SchemaVersion = 2 },
		"journal descriptor": func(m *delegatedJournalManifest) { m.JournalFD = 1 },
		"pidfd descriptor":   func(m *delegatedJournalManifest) { m.OwnerPIDFD = m.JournalFD },
		"owner pid":          func(m *delegatedJournalManifest) { m.OwnerPID++ },
		"owner ticks":        func(m *delegatedJournalManifest) { m.OwnerStartTicks++ },
		"inode":              func(m *delegatedJournalManifest) { m.Inode++ },
		"device":             func(m *delegatedJournalManifest) { m.Device++ },
		"epoch":              func(m *delegatedJournalManifest) { m.Epoch = strings.Repeat("0", 32) },
		"boot":               func(m *delegatedJournalManifest) { m.OwnerBootID = strings.Repeat("0", 32) },
		"executable":         func(m *delegatedJournalManifest) { m.OwnerExecutableSHA256 = strings.Repeat("0", 64) },
		"count":              func(m *delegatedJournalManifest) { m.RecordCount++ },
		"label":              func(m *delegatedJournalManifest) { m.Tag = "fwd:19" },
		"noncanonical tag":   func(m *delegatedJournalManifest) { m.Tag = "fwd:018" },
	} {
		t.Run(name, func(t *testing.T) {
			invalid := manifest
			mutate(&invalid)
			if j, err := mapDelegatedJournal(invalid); err == nil {
				closeDelegated(j)
				t.Fatal("accepted mismatched capability")
			}
		})
	}
	t.Run("reopened same inode is not inherited OFD", func(t *testing.T) {
		file, err := os.OpenFile(owner.file.Name(), os.O_RDWR, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		invalid := manifest
		invalid.JournalFD = int(file.Fd())
		if j, err := mapDelegatedJournal(invalid); err == nil {
			closeDelegated(j)
			t.Fatal("accepted a reopened journal descriptor")
		}
	})
}

func TestDelegatedCounterRejectsResetDecreaseAndOverflow(t *testing.T) {
	value := int64(7)
	c := &Counter{mapped: &value, addOnly: true}
	for name, operation := range map[string]func(){"reset": func() { c.Set(0) }, "negative": func() { c.Add(-1) }, "overflow": func() { c.Add(math.MaxInt64) }} {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Error("mutation did not fail explicitly")
				}
				if c.Value() != 7 {
					t.Error("rejected mutation changed the slot")
				}
			}()
			operation()
		})
	}
	if c.Add(0) != 7 || c.Add(5) != 12 {
		t.Fatal("ordinary increments failed")
	}
}

func TestDelegatedJournalRejectsMalformedOwnerRecords(t *testing.T) {
	owner, manifest := delegatedFixture(t)
	for name, mutate := range map[string]func(){
		"magic":             func() { owner.data[0] ^= 1 },
		"empty label":       func() { binary.LittleEndian.PutUint32(owner.data[72:76], 0) },
		"oversize label":    func() { binary.LittleEndian.PutUint32(owner.data[72:76], journalRecordSize) },
		"missing direction": func() { owner.data[576+16] = 'x' },
		"duplicate label": func() {
			binary.LittleEndian.PutUint32(owner.data[576+8:576+12], uint32(len(delegatedUp)))
			copy(owner.data[576+16:], delegatedUp)
		},
		"negative baseline": func() { binary.LittleEndian.PutUint64(owner.data[64:72], math.MaxUint64) },
	} {
		t.Run(name, func(t *testing.T) {
			before := bytes.Clone(owner.data)
			defer copy(owner.data, before)
			mutate()
			if j, err := mapDelegatedJournal(manifest); err == nil {
				closeDelegated(j)
				t.Fatal("accepted malformed owner records")
			}
		})
	}
	if err := owner.file.Chmod(0644); err != nil {
		t.Fatal(err)
	}
	defer owner.file.Chmod(0600)
	if j, err := mapDelegatedJournal(manifest); err == nil {
		closeDelegated(j)
		t.Fatal("accepted non-private owner journal")
	}
}

func TestDelegatedJournalBlocksIdentityChangesWithoutDroppingTail(t *testing.T) {
	owner, manifest := delegatedFixture(t)
	j, err := mapDelegatedJournal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDelegated(j)
	owner.data[56] ^= 1
	if status := j.Status(); !status.Blocked || !strings.Contains(status.Reason, "header changed") {
		t.Fatalf("not blocked: %+v", status)
	}
	owner.data[56] ^= 1
	if !j.Status().Blocked {
		t.Fatal("blocked state recovered without explicit intervention")
	}
	j.counters[delegatedUp].Add(91)
	if owner.counters[delegatedUp].Value() != 91 {
		t.Fatal("blocked handoff lost in-flight tail accounting")
	}
}

func TestDelegatedJournalChild(t *testing.T) {
	raw := os.Getenv("BROCADE_DELEGATED_TEST_MANIFEST")
	if raw == "" {
		return
	}
	var manifest delegatedJournalManifest
	if err := json.Unmarshal([]byte(raw), &manifest); err != nil {
		t.Fatal(err)
	}
	j, err := mapDelegatedJournal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDelegated(j)
	for range 10000 {
		j.counters[delegatedUp].Add(1)
	}
	j.counters[delegatedDown].Add(73)
	if j.Status().Blocked {
		t.Fatal("live inherited owner unexpectedly blocked")
	}
	fmt.Println("delegated-ready")
	if _, err := bufio.NewReader(os.Stdin).ReadString('\n'); err != nil {
		t.Fatal(err)
	}
}

func TestDelegatedJournalAcrossProcessesKeepsOwnerIdentity(t *testing.T) {
	owner, manifest := delegatedFixture(t)
	before := bytes.Clone(owner.data[:journalHeaderSize])
	manifest.JournalFD, manifest.OwnerPIDFD = 3, 4
	encoded, _ := json.Marshal(manifest)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestDelegatedJournalChild$")
	cmd.Env = append(os.Environ(), "BROCADE_DELEGATED_TEST_MANIFEST="+string(encoded))
	pidfd, err := unix.PidfdOpen(os.Getpid(), 0)
	if err != nil {
		t.Fatal(err)
	}
	pidFile := os.NewFile(uintptr(pidfd), "test-owner-pidfd")
	defer pidFile.Close()
	cmd.ExtraFiles = []*os.File{owner.file, pidFile}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})
	for range 10000 {
		owner.counters[delegatedUp].Add(1)
	}
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "delegated-ready" {
		t.Fatalf("delegated child failed: %q %v", line, err)
	}
	if !bytes.Equal(before, owner.data[:journalHeaderSize]) || owner.counters[delegatedUp].Value() != 20000 || owner.counters[delegatedDown].Value() != 73 {
		t.Fatal("cross-process accounting changed owner identity or lost bytes")
	}
	if _, err := fmt.Fprintln(in, "exit"); err != nil {
		t.Fatal(err)
	}
	_ = in.Close()
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if owner.counters[delegatedUp].Add(1) != 20001 {
		t.Fatal("candidate exit broke owner accounting")
	}
}

func TestDelegatedOwnerChild(t *testing.T) {
	if os.Getenv("BROCADE_DELEGATED_OWNER_CHILD") != "1" {
		return
	}
	owner, manifest := delegatedFixture(t)
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.Sendmsg(3, []byte{1}, unix.UnixRights(int(owner.file.Fd())), nil, 0); err != nil {
		t.Fatal(err)
	}
	fmt.Println(string(encoded))
	if _, err := bufio.NewReader(os.Stdin).ReadString('\n'); err != nil {
		t.Fatal(err)
	}
}

func TestDelegatedOwnerDeathReportsBlockedButKeepsTailMapping(t *testing.T) {
	sockets, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	parentSocket := os.NewFile(uintptr(sockets[0]), "delegated-parent-socket")
	childSocket := os.NewFile(uintptr(sockets[1]), "delegated-child-socket")
	defer parentSocket.Close()
	defer childSocket.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestDelegatedOwnerChild$")
	cmd.Env = append(os.Environ(), "BROCADE_DELEGATED_OWNER_CHILD=1")
	cmd.ExtraFiles = []*os.File{childSocket}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	var manifest delegatedJournalManifest
	if err := json.Unmarshal([]byte(line), &manifest); err != nil {
		t.Fatalf("owner did not publish a valid manifest: %q %v", line, err)
	}
	poll := []unix.PollFd{{Fd: int32(parentSocket.Fd()), Events: unix.POLLIN}}
	if n, err := unix.Poll(poll, 1000); err != nil || n != 1 {
		t.Fatalf("owner journal descriptor was not received: %d %v", n, err)
	}
	data, control := make([]byte, 1), make([]byte, unix.CmsgSpace(4))
	_, n, flags, _, err := unix.Recvmsg(int(parentSocket.Fd()), data, control, unix.MSG_CMSG_CLOEXEC)
	if err != nil || flags&unix.MSG_CTRUNC != 0 {
		t.Fatalf("receive owner journal descriptor: %v", err)
	}
	messages, err := unix.ParseSocketControlMessage(control[:n])
	if err != nil || len(messages) != 1 {
		t.Fatalf("invalid owner descriptor message: %v", err)
	}
	rights, err := unix.ParseUnixRights(&messages[0])
	if err != nil || len(rights) != 1 {
		t.Fatalf("invalid owner descriptor count: %v", err)
	}
	manifest.JournalFD = rights[0]
	defer unix.Close(manifest.JournalFD)
	pidfd, err := unix.PidfdOpen(cmd.Process.Pid, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(pidfd)
	manifest.OwnerPIDFD = pidfd
	j, err := mapDelegatedJournal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	defer closeDelegated(j)
	if j.Status().Blocked {
		t.Fatal("live owner was blocked")
	}
	j.counters[delegatedUp].Add(19)
	if _, err := fmt.Fprintln(in, "exit"); err != nil {
		t.Fatal(err)
	}
	_ = in.Close()
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if status := j.Status(); !status.Enabled || !status.Blocked || status.Reason == "" {
		t.Fatalf("owner exit was not explicitly blocked: %+v", status)
	}
	if value := j.counters[delegatedUp].Add(23); value != 42 {
		t.Fatalf("owner death discarded an established stream's tail: %d", value)
	}
}

func TestDelegatedManifestBoundedAndMutuallyExclusive(t *testing.T) {
	_, manifest := delegatedFixture(t)
	file := filepath.Join(t.TempDir(), "manifest.json")
	data, _ := json.Marshal(manifest)
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(delegatedAccountingEnv, file)
	t.Setenv(accountingJournalEnv, "/unrelated-owner-journal")
	if _, err := openCounterJournal(); err == nil {
		t.Fatal("accepted two accounting ownership modes")
	}
	t.Setenv(accountingJournalEnv, "")
	j, err := openCounterJournal()
	if err != nil {
		t.Fatal(err)
	}
	closeDelegated(j.(*delegatedMappedJournal))
	if err := os.WriteFile(file, append([]byte(`{"future_field":true,`), data[1:]...), 0600); err != nil {
		t.Fatal(err)
	}
	j, err = openCounterJournal()
	if err != nil {
		t.Fatalf("additional manifest fields rejected: %v", err)
	}
	closeDelegated(j.(*delegatedMappedJournal))
	for name, value := range map[string][]byte{"trailing JSON": append(bytes.Clone(data), []byte(`{}`)...), "oversize": bytes.Repeat([]byte(" "), 4097)} {
		t.Run(name, func(t *testing.T) {
			if err := os.WriteFile(file, value, 0600); err != nil {
				t.Fatal(err)
			}
			if j, err := openCounterJournal(); err == nil {
				closeDelegated(j.(*delegatedMappedJournal))
				t.Fatal("accepted invalid manifest")
			}
		})
	}
}
