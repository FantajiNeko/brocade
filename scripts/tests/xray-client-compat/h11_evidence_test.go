package handofflab

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"hash"
	"io"
	"net"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type h11Counter struct {
	Count              uint64 `json:"count"`
	Bytes              uint64 `json:"bytes"`
	FirstUS            int64  `json:"first_us"`
	LastUS             int64  `json:"last_us"`
	MaxGapUS           int64  `json:"max_gap_us"`
	SHA256             string `json:"sha256"`
	ExpectedSHA256     string `json:"expected_sha256"`
	MaxWriteUS         int64  `json:"max_write_us"`
	TotalWriteUS       int64  `json:"total_write_us"`
	MaxWriteStartedUS  int64  `json:"max_write_started_us"`
	MaxWriteFinishedUS int64  `json:"max_write_finished_us"`
	actual, expected   hash.Hash
}
type h11Evidence struct {
	Up       h11Counter `json:"up"`
	Down     h11Counter `json:"down"`
	SentUp   h11Counter `json:"sent_up"`
	SentDown h11Counter `json:"sent_down"`
}
type h11WorkerEvidence struct {
	Name   string `json:"name"`
	Joined bool   `json:"joined"`
	AtUS   int64  `json:"at_us"`
	Error  string `json:"error"`
}

func h11NewCounter() h11Counter {
	a, e := sha256.New(), sha256.New()
	return h11Counter{actual: a, expected: e, SHA256: hex.EncodeToString(a.Sum(nil)), ExpectedSHA256: hex.EncodeToString(e.Sum(nil))}
}
func h11NewEvidence() *h11Evidence {
	return &h11Evidence{Up: h11NewCounter(), Down: h11NewCounter(), SentUp: h11NewCounter(), SentDown: h11NewCounter()}
}
func h11Record(h *h9Run, f *h9Flow, up, sent bool, seq uint64, body []byte) {
	actual, expected := sha256.Sum256(body), sha256.Sum256(framePayload(seq))
	at := time.Since(h.base.start).Microseconds()
	f.mu.Lock()
	defer f.mu.Unlock()
	c := &f.Evidence.Down
	if up {
		c = &f.Evidence.Up
	}
	if sent {
		if up {
			c = &f.Evidence.SentUp
		} else {
			c = &f.Evidence.SentDown
		}
	}
	if c.Count != seq {
		panic("H11 non-contiguous frame recorder")
	}
	if c.Count == 0 {
		c.FirstUS = at
	} else if at-c.LastUS > c.MaxGapUS {
		c.MaxGapUS = at - c.LastUS
	}
	c.Count++
	c.Bytes += uint64(len(body))
	c.LastUS = at
	fmt.Fprintf(c.actual, "%d:%d:%x\n", seq, len(body), actual)
	fmt.Fprintf(c.expected, "%d:%d:%x\n", seq, len(body), expected)
	c.SHA256 = hex.EncodeToString(c.actual.Sum(nil))
	c.ExpectedSHA256 = hex.EncodeToString(c.expected.Sum(nil))
	if !sent && seq < 3 {
		sample := h9Frame{AtUS: at, Seq: seq, Bytes: len(body), SHA256: hex.EncodeToString(actual[:]), ExpectedSHA256: hex.EncodeToString(expected[:])}
		if up {
			f.UpFrames = append(f.UpFrames, sample)
		} else {
			f.DownFrames = append(f.DownFrames, sample)
		}
	}
}
func h11Worker(f *h9Flow, name string, fn func() error) error {
	e := fn()
	message := ""
	if e != nil {
		message = e.Error()
	}
	f.mu.Lock()
	f.Workers = append(f.Workers, h11WorkerEvidence{Name: name, Joined: true, AtUS: time.Since(h9Current.base.start).Microseconds(), Error: message})
	f.mu.Unlock()
	return e
}
func h11EnvInt(name string, fallback int) int {
	if s := os.Getenv(name); s != "" {
		v, e := strconv.Atoi(s)
		if e != nil {
			panic("invalid integer " + name)
		}
		return v
	}
	return fallback
}
func h11Deadline() time.Time {
	return time.Now().Add(time.Duration(h11EnvInt("H11_DURATION_MS", 3000)+h11EnvInt("H11_IDLE_MS", 3000)+120000) * time.Millisecond)
}
func h11FrameBudget() uint64 {
	return uint64((h11EnvInt("H11_DURATION_MS", 3000)+120000)/h11EnvInt("H11_FRAME_INTERVAL_MS", 30) + 1000)
}
func h11EarlyUpload() bool {
	return os.Getenv("H9_BOUNDARY") != "" && os.Getenv("H11_DIRECTION") == "upload"
}

var h11IdleGate chan struct{}
var h11GateMu sync.Mutex
var h11GateBlocked map[string]bool
var h11InitialClose chan struct{}
var h11SlowReleased atomic.Bool

func h11AwaitInitialClose(f *h9Flow) error {
	if h11InitialClose == nil {
		return nil
	}
	select {
	case <-h11InitialClose:
		return nil
	case <-f.abort:
		return fmt.Errorf("initial half-close cancelled")
	}
}

func h11TuneSocket(f *h9Flow, conn *tls.Conn, role string) error {
	if os.Getenv("H11_SCENE") != "slow" {
		return nil
	}
	tcp, ok := conn.NetConn().(*net.TCPConn)
	if !ok {
		return fmt.Errorf("slow-reader requires a real TCP endpoint")
	}
	if err := tcp.SetReadBuffer(4096); err != nil {
		return err
	}
	if err := tcp.SetWriteBuffer(4096); err != nil {
		return err
	}
	raw, err := tcp.SyscallConn()
	if err != nil {
		return err
	}
	read, write := 0, 0
	var socketErr error
	err = raw.Control(func(fd uintptr) {
		read, socketErr = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF)
		if socketErr == nil {
			write, socketErr = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_SNDBUF)
		}
	})
	if err != nil {
		return err
	}
	if socketErr != nil {
		return socketErr
	}
	f.mu.Lock()
	f.SocketBuffers[role] = object{"read_bytes": read, "write_bytes": write}
	f.mu.Unlock()
	return nil
}

func h11WriteFrame(f *h9Flow, writer io.Writer, up bool, seq uint64, body []byte) error {
	begin := time.Now()
	err := writeFrame(writer, seq, body)
	duration := time.Since(begin).Microseconds()
	f.mu.Lock()
	c := &f.Evidence.SentDown
	if up {
		c = &f.Evidence.SentUp
	}
	if duration > c.MaxWriteUS {
		c.MaxWriteUS = duration
		c.MaxWriteStartedUS = begin.Sub(h9Current.base.start).Microseconds()
		c.MaxWriteFinishedUS = time.Since(h9Current.base.start).Microseconds()
	}
	c.TotalWriteUS += duration
	f.mu.Unlock()
	return err
}

func h11BeforeFrame(f *h9Flow, up bool) error {
	h11GateMu.Lock()
	gate := h11IdleGate
	if gate != nil {
		h11GateBlocked[fmt.Sprintf("%s/%t", f.ID, up)] = true
	}
	h11GateMu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-f.abort:
			return fmt.Errorf("idle writer cancelled")
		}
	}
	return nil
}

func h11PauseWriters(h *h9Run) {
	h11GateMu.Lock()
	h11IdleGate, h11GateBlocked = make(chan struct{}), map[string]bool{}
	h11GateMu.Unlock()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		ready := true
		for _, f := range h.flows {
			h11GateMu.Lock()
			blocked := h11GateBlocked[fmt.Sprintf("%s/%t", f.ID, f.Mode == "upload")]
			h11GateMu.Unlock()
			f.mu.Lock()
			ready = ready && blocked && f.Evidence.Up.Count == f.Evidence.SentUp.Count && f.Evidence.Down.Count == f.Evidence.SentDown.Count
			f.mu.Unlock()
		}
		if ready {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.base.t.Fatal("idle writers failed to reach drained pause")
}

func h11ResumeWriters() {
	h11GateMu.Lock()
	gate := h11IdleGate
	h11IdleGate = nil
	h11GateMu.Unlock()
	if gate != nil {
		close(gate)
	}
}
func h11BeforeRead(f *h9Flow, up bool) {
	if os.Getenv("H11_SCENE") == "slow" && !h11SlowReleased.Load() {
		d := h11EnvInt("H11_READ_DELAY_MS", 100)
		if d > 0 {
			time.Sleep(time.Duration(d) * time.Millisecond)
		}
	}
}

func h11ReleaseSlow(h *h9Run) {
	if os.Getenv("H11_SCENE") != "slow" {
		return
	}
	h.base.event("slow-pressure-released", nil)
	h11SlowReleased.Store(true)
	for _, f := range h.flows {
		for _, c := range []*tls.Conn{f.conn, f.originConn} {
			tcp, ok := c.NetConn().(*net.TCPConn)
			if !ok {
				h.base.t.Fatal("slow release lost TCP endpoint")
			}
			if err := tcp.SetReadBuffer(1048576); err != nil {
				h.base.t.Fatal(err)
			}
			if err := tcp.SetWriteBuffer(1048576); err != nil {
				h.base.t.Fatal(err)
			}
		}
	}
	h.base.event("slow-buffers-restored", nil)
}

func h11Progress(h *h9Run, flows []*h9Flow, partial bool) {
	counts := make([][2]uint64, len(flows))
	for i, f := range flows {
		f.mu.Lock()
		counts[i] = [2]uint64{f.Evidence.Up.Count, f.Evidence.Down.Count}
		f.mu.Unlock()
	}
	buckets := h.base.result["progress_buckets"].([]object)
	if len(buckets) > 1900 {
		h.base.t.Fatal("bounded progress bucket budget exceeded")
	}
	h.base.result["progress_buckets"] = append(buckets, object{"at_us": time.Since(h.base.start).Microseconds(), "partial": partial, "counts": counts})
}
