//go:build linux

package stats

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	journalMagic      = "BRACCT02"
	journalHeaderSize = 64
	journalRecordSize = 512
	journalCapacity   = 16384
	journalSize       = journalHeaderSize + journalCapacity*journalRecordSize
)

type mappedCounterJournal struct {
	file     *os.File
	data     []byte
	count    int
	counters map[string]*Counter
}

func openCounterJournal() (counterJournal, error) {
	path := os.Getenv(accountingJournalEnv)
	if path == "" {
		return nil, nil
	}
	return openMappedCounterJournal(path)
}

func openMappedCounterJournal(path string) (*mappedCounterJournal, error) {
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		return nil, fmt.Errorf("managed accounting journal requires a 64-bit little-endian target")
	}
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("accounting journal path must be absolute")
	}
	fd, err := unix.Open(path, unix.O_RDWR|unix.O_CREAT|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, fmt.Errorf("open accounting journal: %w", err)
	}
	f := os.NewFile(uintptr(fd), path)
	lockDeadline := time.Now().Add(time.Second)
	lockErr := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
	for lockErr == unix.EWOULDBLOCK && time.Now().Before(lockDeadline) {
		time.Sleep(10 * time.Millisecond)
		lockErr = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
	}
	if lockErr != nil {
		f.Close()
		return nil, fmt.Errorf("accounting journal already has a writer: %w", lockErr)
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		f.Close()
		return nil, fmt.Errorf("accounting journal must be a private regular file")
	}
	if info.Size() == 0 {
		// Reserve space before mapping: ENOSPC must fail startup, not SIGBUS on a traffic Add.
		if err := unix.Fallocate(fd, 0, 0, journalSize); err != nil {
			f.Close()
			return nil, fmt.Errorf("reserve accounting journal: %w", err)
		}
		header := make([]byte, journalHeaderSize)
		copy(header, journalMagic)
		if _, err := rand.Read(header[8:24]); err != nil {
			f.Close()
			return nil, err
		}
		if _, err := f.WriteAt(header, 0); err != nil {
			f.Close()
			return nil, err
		}
		if err := f.Sync(); err != nil {
			f.Close()
			return nil, err
		}
	} else if info.Size() != journalSize {
		f.Close()
		return nil, fmt.Errorf("invalid accounting journal size")
	}
	data, err := unix.Mmap(fd, 0, journalSize, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_SHARED)
	if err != nil {
		f.Close()
		return nil, err
	}
	fail := func(err error) (*mappedCounterJournal, error) {
		unix.Munmap(data)
		f.Close()
		return nil, err
	}
	if string(data[:8]) != journalMagic {
		return fail(fmt.Errorf("invalid accounting journal format"))
	}
	count := int(binary.LittleEndian.Uint32(data[24:28]))
	if count > journalCapacity {
		return fail(fmt.Errorf("invalid accounting journal count"))
	}
	j := &mappedCounterJournal{file: f, data: data, count: count, counters: make(map[string]*Counter, count)}
	for i := 0; i < count; i++ {
		offset := journalHeaderSize + i*journalRecordSize
		length := int(binary.LittleEndian.Uint32(data[offset+8 : offset+12]))
		if length == 0 || length > journalRecordSize-16 {
			return fail(fmt.Errorf("invalid accounting journal label"))
		}
		name := string(data[offset+16 : offset+16+length])
		if _, exists := j.counters[name]; exists {
			return fail(fmt.Errorf("duplicate accounting journal label"))
		}
		j.counters[name] = &Counter{mapped: (*int64)(unsafe.Pointer(&data[offset]))}
	}
	// Agent only trusts the journal epoch when this header identifies the serving process.
	proc, err := os.ReadFile("/proc/self/stat")
	if err != nil {
		return fail(err)
	}
	separator := strings.LastIndex(string(proc), ") ")
	if separator < 0 {
		return fail(fmt.Errorf("invalid process identity"))
	}
	fields := string(proc)[separator+2:]
	if len(strings.Fields(fields)) < 20 {
		return fail(fmt.Errorf("invalid process identity"))
	}
	ticks, err := strconv.ParseUint(strings.Fields(fields)[19], 10, 64)
	if err != nil {
		return fail(err)
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return fail(err)
	}
	bootID, err := hex.DecodeString(strings.ReplaceAll(strings.TrimSpace(string(boot)), "-", ""))
	if err != nil || len(bootID) != 16 {
		return fail(fmt.Errorf("invalid process boot identity"))
	}
	binary.LittleEndian.PutUint64(data[32:40], ticks)
	copy(data[40:56], bootID)
	// Core.Start has not opened business listeners yet. This is a conservative end of
	// certified downtime even when staging/fsync before exec took substantially longer.
	binary.LittleEndian.PutUint64(data[56:64], uint64(time.Now().UnixMilli()))
	atomic.StoreUint32((*uint32)(unsafe.Pointer(&data[28])), uint32(os.Getpid()))
	if err := f.Sync(); err != nil {
		return fail(err)
	}
	return j, nil
}

func (j *mappedCounterJournal) Counters() map[string]*Counter { return j.counters }

// Register is called under Manager.access; existing records are never reused or reset.
func (j *mappedCounterJournal) Register(name string) (*Counter, error) {
	if c := j.counters[name]; c != nil {
		// A previous register can have published the record but failed its durability gate.
		// Keep its identity and retry that gate instead of creating a duplicate label.
		if err := j.file.Sync(); err != nil {
			return nil, err
		}
		return c, nil
	}
	if len(name) == 0 || len(name) > journalRecordSize-16 || j.count == journalCapacity {
		return nil, fmt.Errorf("accounting journal label invalid or capacity exhausted")
	}
	offset := journalHeaderSize + j.count*journalRecordSize
	copy(j.data[offset+16:offset+journalRecordSize], name)
	binary.LittleEndian.PutUint32(j.data[offset+8:offset+12], uint32(len(name)))
	// Publish a durable label before allowing any traffic to use its mapped value.
	if err := j.file.Sync(); err != nil {
		return nil, err
	}
	j.count++
	atomic.StoreUint32((*uint32)(unsafe.Pointer(&j.data[24])), uint32(j.count))
	c := &Counter{mapped: (*int64)(unsafe.Pointer(&j.data[offset]))}
	j.counters[name] = c
	if err := j.file.Sync(); err != nil {
		return nil, err
	}
	return c, nil
}
