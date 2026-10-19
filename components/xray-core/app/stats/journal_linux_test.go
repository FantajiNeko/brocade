//go:build linux

package stats

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestJournalProcessHelper(t *testing.T) {
	role := os.Getenv("BROCADE_JOURNAL_TEST_ROLE")
	if role == "" {
		return
	}
	j, err := openMappedCounterJournal(os.Getenv(accountingJournalEnv))
	if err != nil {
		t.Fatal(err)
	}
	c, err := j.Register("user>>>fixture>>>traffic>>>downlink")
	if err != nil {
		t.Fatal(err)
	}
	if role == "writer" {
		c.Add(123456789)
		fmt.Println(c.Value())
		for {
			time.Sleep(time.Hour)
		}
	}
	if c.Value() != 123456789 {
		t.Fatalf("lost pre-exit increments: %d", c.Value())
	}
	c.Add(17)
	fmt.Println(c.Value())
}

func TestJournalSurvivesKilledWriterWithoutFinalQueryOrSync(t *testing.T) {
	path := filepath.Join(t.TempDir(), "accounting.bin")
	run := func(role string) (*exec.Cmd, string) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		t.Cleanup(cancel)
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestJournalProcessHelper$")
		cmd.Env = append(os.Environ(), accountingJournalEnv+"="+path, "BROCADE_JOURNAL_TEST_ROLE="+role)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		reader := bufio.NewReader(stdout)
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(line, "--- FAIL") {
			rest, _ := io.ReadAll(reader)
			_ = cmd.Wait()
			t.Fatalf("journal child failed: %s%s", line, rest)
		}
		return cmd, strings.TrimSpace(line)
	}
	writer, first := run("writer")
	if first != "123456789" {
		t.Fatal(first)
	}
	if err := writer.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := writer.Wait(); err == nil {
		t.Fatal("writer was not killed")
	}
	reader, second := run("reader")
	if second != "123456806" {
		t.Fatal(second)
	}
	if err := reader.Wait(); err != nil {
		t.Fatal(err)
	}
}

func TestJournalCountersStayAtomicAndWriterIsExclusive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "accounting.bin")
	j, err := openMappedCounterJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer j.file.Close()
	defer unix.Munmap(j.data)
	if _, err := openMappedCounterJournal(path); err == nil {
		t.Fatal("accepted a second writer")
	}
	c, err := j.Register("user>>>fixture>>>traffic>>>uplink")
	if err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	for range 16 {
		workers.Go(func() {
			for range 1000 {
				c.Add(1)
			}
		})
	}
	workers.Wait()
	if c.Value() != 16000 {
		t.Fatal(c.Value())
	}
	if _, err := j.Register(strings.Repeat("x", journalRecordSize)); err == nil {
		t.Fatal("accepted oversized label")
	}
	if err := j.file.Sync(); err != nil {
		t.Fatal(err)
	}
	if err := j.file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := unix.Munmap(j.data); err != nil {
		t.Fatal(err)
	}
	reopened, err := openMappedCounterJournal(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.file.Close()
	defer unix.Munmap(reopened.data)
	if reopened.Counters()["user>>>fixture>>>traffic>>>uplink"].Value() != 16000 {
		t.Fatal("reset counter")
	}
}

func TestSharedJournalGenerationsRegisterAndAddCounters(t *testing.T) {
	path := filepath.Join(t.TempDir(), "accounting.bin")
	owner, err := openMappedCounterJournalMode(path, journalSharedOwner)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.file.Close()
	defer owner.registrationLock.Close()
	defer unix.Munmap(owner.data)
	owned, err := owner.Register("user>>>fixture>>>traffic>>>downlink")
	if err != nil {
		t.Fatal(err)
	}
	owned.Add(40)

	joined, err := openMappedCounterJournalMode(path, journalSharedJoin)
	if err != nil {
		t.Fatal(err)
	}
	defer joined.file.Close()
	defer joined.registrationLock.Close()
	defer unix.Munmap(joined.data)
	shared, err := joined.Register("user>>>fixture>>>traffic>>>downlink")
	if err != nil {
		t.Fatal(err)
	}
	shared.Add(2)
	if got := owned.Value(); got != 42 {
		t.Fatalf("shared atomic addition = %d, want 42", got)
	}
	joinedNew, err := joined.Register("user>>>new>>>traffic>>>downlink")
	if err != nil {
		t.Fatal(err)
	}
	joinedNew.Add(7)
	ownerNew, err := owner.Register("user>>>new>>>traffic>>>downlink")
	if err != nil {
		t.Fatal(err)
	}
	ownerNew.Add(5)
	if got := joinedNew.Value(); got != 12 {
		t.Fatalf("counter created by join generation = %d, want 12", got)
	}
	if _, err := openMappedCounterJournal(path); err == nil {
		t.Fatal("legacy exclusive owner entered an active shared generation")
	}
}

func TestSharedJournalSerializesCrossGenerationRegistration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "accounting.bin")
	owner, err := openMappedCounterJournalMode(path, journalSharedOwner)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.file.Close()
	defer owner.registrationLock.Close()
	defer unix.Munmap(owner.data)
	joined, err := openMappedCounterJournalMode(path, journalSharedJoin)
	if err != nil {
		t.Fatal(err)
	}
	defer joined.file.Close()
	defer joined.registrationLock.Close()
	defer unix.Munmap(joined.data)

	start := make(chan struct{})
	errors := make(chan error, 2)
	register := func(j *mappedCounterJournal, amount int64) {
		<-start
		counter, err := j.Register("user>>>concurrent>>>traffic>>>uplink")
		if err == nil {
			counter.Add(amount)
		}
		errors <- err
	}
	go register(owner, 11)
	go register(joined, 13)
	close(start)
	for range 2 {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}
	ownerCounter, err := owner.Register("user>>>concurrent>>>traffic>>>uplink")
	if err != nil {
		t.Fatal(err)
	}
	if got := ownerCounter.Value(); got != 24 {
		t.Fatalf("cross-generation registration counter = %d, want 24", got)
	}
	if got := int(binary.LittleEndian.Uint32(owner.data[24:28])); got != 1 {
		t.Fatalf("published record count = %d, want 1", got)
	}
}
