//go:build linux

package stats

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/unix"
)

// This intentionally narrow manifest describes one already-populated forwarding
// namespace. It is not an ownership transfer and must never rewrite BRACCT02.
type delegatedJournalManifest struct {
	SchemaVersion         int    `json:"schema_version"`
	JournalFD             int    `json:"journal_fd"`
	OwnerPIDFD            int    `json:"owner_pidfd"`
	OwnerPID              int    `json:"owner_pid"`
	OwnerStartTicks       uint64 `json:"owner_start_ticks"`
	OwnerBootID           string `json:"owner_boot_id"`
	OwnerExecutableSHA256 string `json:"owner_executable_sha256"`
	Device                uint64 `json:"device"`
	Inode                 uint64 `json:"inode"`
	Epoch                 string `json:"epoch"`
	RecordCount           uint32 `json:"record_count"`
	Tag                   string `json:"tag"`
}

type delegatedMappedJournal struct {
	file     *os.File
	owner    *os.File
	data     []byte
	manifest delegatedJournalManifest
	header   [journalHeaderSize]byte
	labels   map[int]string
	counters map[string]*Counter
	access   sync.Mutex
	blocked  string
}

func openDelegatedCounterJournal(path string) (*delegatedMappedJournal, error) {
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("delegated accounting manifest must be absolute")
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("open delegated accounting manifest: %w", err)
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 4096 {
		return nil, fmt.Errorf("delegated accounting manifest must be a bounded private regular file")
	}
	decoder := json.NewDecoder(io.LimitReader(file, 4097))
	var manifest delegatedJournalManifest
	if err := decoder.Decode(&manifest); err != nil {
		return nil, fmt.Errorf("decode delegated accounting manifest: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, fmt.Errorf("unexpected data after delegated accounting manifest")
	}
	return mapDelegatedJournal(manifest)
}

func mapDelegatedJournal(manifest delegatedJournalManifest) (*delegatedMappedJournal, error) {
	if runtime.GOARCH != "amd64" && runtime.GOARCH != "arm64" {
		return nil, fmt.Errorf("delegated accounting requires a 64-bit little-endian target")
	}
	ruleID, ruleErr := strconv.ParseUint(strings.TrimPrefix(manifest.Tag, "fwd:"), 10, 63)
	if manifest.SchemaVersion != 1 || manifest.JournalFD < 3 || manifest.OwnerPIDFD < 3 || manifest.JournalFD == manifest.OwnerPIDFD || manifest.OwnerPID <= 0 || manifest.OwnerStartTicks == 0 || manifest.Inode == 0 || manifest.RecordCount < 2 || manifest.RecordCount > journalCapacity || ruleErr != nil || ruleID == 0 || manifest.Tag != "fwd:"+strconv.FormatUint(ruleID, 10) {
		return nil, fmt.Errorf("invalid delegated accounting manifest identity")
	}
	if _, err := decodeHexIdentity(manifest.Epoch, 16); err != nil {
		return nil, fmt.Errorf("invalid delegated accounting epoch")
	}
	if _, err := decodeHexIdentity(manifest.OwnerExecutableSHA256, 32); err != nil {
		return nil, fmt.Errorf("invalid delegated accounting executable hash")
	}
	if _, err := decodeHexIdentity(manifest.OwnerBootID, 16); err != nil {
		return nil, fmt.Errorf("invalid delegated accounting boot identity")
	}
	fd, err := unix.FcntlInt(uintptr(manifest.JournalFD), unix.F_DUPFD_CLOEXEC, 3)
	if err != nil {
		return nil, fmt.Errorf("duplicate delegated journal descriptor: %w", err)
	}
	j := &delegatedMappedJournal{file: os.NewFile(uintptr(fd), "delegated-accounting"), manifest: manifest, labels: make(map[int]string), counters: make(map[string]*Counter)}
	fail := func(err error) (*delegatedMappedJournal, error) {
		if j.data != nil {
			_ = unix.Munmap(j.data)
		}
		if j.owner != nil {
			_ = j.owner.Close()
		}
		_ = j.file.Close()
		return nil, err
	}
	ownerFD, err := unix.FcntlInt(uintptr(manifest.OwnerPIDFD), unix.F_DUPFD_CLOEXEC, 3)
	if err != nil {
		return fail(fmt.Errorf("duplicate delegated owner pidfd: %w", err))
	}
	j.owner = os.NewFile(uintptr(ownerFD), "delegated-accounting-owner")
	if err := j.checkDescriptors(); err != nil {
		return fail(err)
	}
	if err := verifyOwnerExecutable(manifest); err != nil {
		return fail(err)
	}
	data, err := unix.Mmap(fd, 0, journalSize, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_SHARED)
	if err != nil {
		return fail(fmt.Errorf("map delegated accounting: %w", err))
	}
	j.data = data
	copy(j.header[:], data[:journalHeaderSize])
	if string(j.header[:8]) != journalMagic || hex.EncodeToString(j.header[8:24]) != manifest.Epoch || binary.LittleEndian.Uint32(j.header[24:28]) != manifest.RecordCount || binary.LittleEndian.Uint32(j.header[28:32]) != uint32(manifest.OwnerPID) || binary.LittleEndian.Uint64(j.header[32:40]) != manifest.OwnerStartTicks || hex.EncodeToString(j.header[40:56]) != manifest.OwnerBootID {
		return fail(fmt.Errorf("delegated accounting header does not identify the pinned owner"))
	}
	wanted := map[string]bool{"inbound>>>" + manifest.Tag + ">>>traffic>>>uplink": true, "inbound>>>" + manifest.Tag + ">>>traffic>>>downlink": true}
	seen := make(map[string]bool)
	for index := 0; index < int(manifest.RecordCount); index++ {
		offset := journalHeaderSize + index*journalRecordSize
		length := int(binary.LittleEndian.Uint32(data[offset+8 : offset+12]))
		if length == 0 || length > journalRecordSize-16 {
			return fail(fmt.Errorf("invalid delegated accounting label length"))
		}
		name := string(data[offset+16 : offset+16+length])
		if seen[name] {
			return fail(fmt.Errorf("duplicate delegated accounting label"))
		}
		seen[name] = true
		if wanted[name] {
			counter := &Counter{mapped: (*int64)(unsafe.Pointer(&data[offset])), addOnly: true}
			if counter.Value() < 0 {
				return fail(fmt.Errorf("negative delegated accounting baseline"))
			}
			j.counters[name] = counter
			j.labels[offset] = name
		}
	}
	if len(j.counters) != 2 {
		return fail(fmt.Errorf("delegated forwarding requires both existing direction counters"))
	}
	if err := j.checkIdentity(); err != nil {
		return fail(err)
	}
	// Keep both the descriptors and mapping alive through process exit. Existing
	// stream counters outlive Manager.Close. Never unlock the inherited OFD.
	unix.CloseOnExec(manifest.JournalFD)
	unix.CloseOnExec(manifest.OwnerPIDFD)
	return j, nil
}

func decodeHexIdentity(value string, size int) ([]byte, error) {
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != size || hex.EncodeToString(decoded) != value {
		return nil, fmt.Errorf("invalid hex identity")
	}
	return decoded, nil
}

func (j *delegatedMappedJournal) checkDescriptors() error {
	var st unix.Stat_t
	if err := unix.Fstat(int(j.file.Fd()), &st); err != nil {
		return fmt.Errorf("stat delegated journal: %w", err)
	}
	if st.Mode&unix.S_IFMT != unix.S_IFREG || st.Mode&0077 != 0 || st.Nlink == 0 || uint64(st.Dev) != j.manifest.Device || st.Ino != j.manifest.Inode || st.Size != journalSize {
		return fmt.Errorf("delegated journal file identity or permissions changed")
	}
	flags, err := unix.FcntlInt(j.file.Fd(), unix.F_GETFL, 0)
	if err != nil || flags&unix.O_ACCMODE != unix.O_RDWR {
		return fmt.Errorf("delegated journal descriptor must be read/write")
	}
	info, err := os.ReadFile(fmt.Sprintf("/proc/self/fdinfo/%d", j.file.Fd()))
	if err != nil || !hasOwnerFlock(string(info), j.manifest) {
		return fmt.Errorf("delegated journal must inherit the owner's exclusive flock OFD")
	}
	pidInfo, err := os.ReadFile(fmt.Sprintf("/proc/self/fdinfo/%d", j.owner.Fd()))
	if err != nil {
		return fmt.Errorf("read delegated owner pidfd: %w", err)
	}
	matched := false
	for _, line := range strings.Split(string(pidInfo), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "Pid:" && fields[1] == strconv.Itoa(j.manifest.OwnerPID) {
			matched = true
		}
	}
	if !matched {
		return fmt.Errorf("delegated owner pidfd identity changed or owner exited")
	}
	poll := []unix.PollFd{{Fd: int32(j.owner.Fd()), Events: unix.POLLIN}}
	if _, err := unix.Poll(poll, 0); err != nil || poll[0].Revents != 0 {
		return fmt.Errorf("delegated accounting owner is no longer live")
	}
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", j.manifest.OwnerPID))
	if err != nil {
		return fmt.Errorf("read delegated owner identity: %w", err)
	}
	separator := strings.LastIndex(string(stat), ") ")
	if separator < 0 {
		return fmt.Errorf("invalid delegated owner process identity")
	}
	fields := strings.Fields(string(stat)[separator+2:])
	if len(fields) < 20 || fields[0] == "Z" || fields[19] != strconv.FormatUint(j.manifest.OwnerStartTicks, 10) {
		return fmt.Errorf("delegated owner process identity changed")
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil || strings.ReplaceAll(strings.TrimSpace(string(boot)), "-", "") != j.manifest.OwnerBootID {
		return fmt.Errorf("delegated owner boot identity changed")
	}
	return nil
}

func hasOwnerFlock(info string, manifest delegatedJournalManifest) bool {
	for _, line := range strings.Split(info, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 9 || fields[0] != "lock:" || fields[2] != "FLOCK" || fields[3] != "ADVISORY" || fields[4] != "WRITE" || fields[5] != strconv.Itoa(manifest.OwnerPID) || fields[7] != "0" || fields[8] != "EOF" {
			continue
		}
		identity := strings.Split(fields[6], ":")
		if len(identity) != 3 {
			continue
		}
		major, a := strconv.ParseUint(identity[0], 16, 32)
		minor, b := strconv.ParseUint(identity[1], 16, 32)
		inode, c := strconv.ParseUint(identity[2], 10, 64)
		if a == nil && b == nil && c == nil && uint32(major) == unix.Major(manifest.Device) && uint32(minor) == unix.Minor(manifest.Device) && inode == manifest.Inode {
			return true
		}
	}
	return false
}

func verifyOwnerExecutable(manifest delegatedJournalManifest) error {
	file, err := os.Open(fmt.Sprintf("/proc/%d/exe", manifest.OwnerPID))
	if err != nil {
		return fmt.Errorf("open delegated owner executable: %w", err)
	}
	defer file.Close()
	hash := sha256.New()
	const maxSize = 256 << 20
	n, err := io.Copy(hash, io.LimitReader(file, maxSize+1))
	if err != nil || n > maxSize || hex.EncodeToString(hash.Sum(nil)) != manifest.OwnerExecutableSHA256 {
		return fmt.Errorf("delegated owner executable digest differs")
	}
	return nil
}

func (j *delegatedMappedJournal) checkIdentity() error {
	if err := j.checkDescriptors(); err != nil {
		return err
	}
	if !bytes.Equal(j.data[:journalHeaderSize], j.header[:]) {
		return fmt.Errorf("delegated accounting owner header changed")
	}
	for offset, name := range j.labels {
		length := int(binary.LittleEndian.Uint32(j.data[offset+8 : offset+12]))
		if length != len(name) || string(j.data[offset+16:offset+16+len(name)]) != name {
			return fmt.Errorf("delegated accounting label changed")
		}
		if atomic.LoadInt64((*int64)(unsafe.Pointer(&j.data[offset]))) < 0 {
			return fmt.Errorf("delegated accounting counter became negative")
		}
	}
	return nil
}

func (j *delegatedMappedJournal) Status() DelegatedAccountingStatus {
	j.access.Lock()
	defer j.access.Unlock()
	if j.blocked == "" {
		if err := j.checkIdentity(); err != nil {
			j.blocked = err.Error()
		}
	}
	return DelegatedAccountingStatus{Enabled: true, Blocked: j.blocked != "", Reason: j.blocked, OwnerPID: j.manifest.OwnerPID, Tag: j.manifest.Tag}
}

func (j *delegatedMappedJournal) Counters() map[string]*Counter { return j.counters }

func (j *delegatedMappedJournal) Register(name string) (*Counter, error) {
	if counter := j.counters[name]; counter != nil {
		return counter, nil
	}
	return nil, fmt.Errorf("delegated accounting cannot create counter %q", name)
}
