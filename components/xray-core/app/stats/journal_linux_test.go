//go:build linux

package stats

import (
	"bufio"
	"context"
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
