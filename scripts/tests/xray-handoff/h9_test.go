package handofflab

import (
	"bufio"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type h9Frame struct {
	AtUS           int64  `json:"at_us"`
	Seq            uint64 `json:"seq"`
	Bytes          int    `json:"bytes"`
	SHA256         string `json:"sha256"`
	ExpectedSHA256 string `json:"expected_sha256"`
}

type h9Flow struct {
	ID                string    `json:"id"`
	Path              string    `json:"path"`
	Generation        string    `json:"generation"`
	Mode              string    `json:"mode"`
	Marker            string    `json:"marker"`
	Local             string    `json:"local"`
	Remote            string    `json:"remote"`
	StartedUS         int64     `json:"started_us"`
	StopRequestedUS   int64     `json:"stop_requested_us"`
	FinishedUS        int64     `json:"finished_us"`
	Completion        string    `json:"completion"`
	UpFrames          []h9Frame `json:"up_frames"`
	DownFrames        []h9Frame `json:"down_frames"`
	SentUpFrames      uint64    `json:"sent_up_frames"`
	VerifiedUpBytes   uint64    `json:"verified_up_bytes"`
	VerifiedDownBytes uint64    `json:"verified_down_bytes"`
	Error             string    `json:"error"`
	HalfClose         object    `json:"half_close"`
	mu                sync.Mutex
	stop              chan struct{}
	serverEnded       chan struct{}
	clientEnded       chan struct{}
	originDone        chan error
	done              chan error
	clientFinished    chan struct{}
	originFinished    chan struct{}
	abort             chan struct{}
	abortOnce         sync.Once
	sent              atomic.Uint64
	conn              *tls.Conn
}

func (f *h9Flow) MarshalJSON() ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	type value h9Flow
	return json.Marshal((*value)(f))
}

func h9FlowError(f *h9Flow, err error) {
	if err == nil {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.Error == "" {
		f.Error = err.Error()
	}
}

type h9Run struct {
	base          *h7Run
	mu            sync.Mutex
	flows         []*h9Flow
	processes     []*h9Process
	checkpoints   []object
	pauseRequests []object
	requests      []h7Request
	requestMu     sync.Mutex
}

func h9HalfClose(conn *tls.Conn) error {
	if err := conn.CloseWrite(); err != nil {
		return err
	}
	if os.Getenv("H9_HALF_CLOSE") == "tls-only" {
		return nil
	}
	tcp, ok := conn.NetConn().(*net.TCPConn)
	if !ok {
		return fmt.Errorf("expected underlying TCP connection")
	}
	return tcp.CloseWrite()
}

func (h *h9Run) record(flow *h9Flow, up bool, seq uint64, body []byte) {
	sum, expected := sha256.Sum256(body), sha256.Sum256(framePayload(seq))
	x := h9Frame{AtUS: time.Since(h.base.start).Microseconds(), Seq: seq, Bytes: len(body), SHA256: hex.EncodeToString(sum[:]), ExpectedSHA256: hex.EncodeToString(expected[:])}
	flow.mu.Lock()
	defer flow.mu.Unlock()
	if up {
		flow.UpFrames = append(flow.UpFrames, x)
	} else {
		flow.DownFrames = append(flow.DownFrames, x)
	}
}

func h9StartOrigin(base *h7Run, marker string) *h7Origin {
	h := base.h9
	pair, err := tls.LoadX509KeyPair(base.f.certPath, base.f.keyPath)
	if err != nil {
		base.t.Fatal(err)
	}
	address := "127.0.0.1:0"
	if os.Getenv("H7_NETNS") == "1" {
		address = "10.77.3.2:0"
	}
	var listener net.Listener
	err = h7InNamespace("origin", func() error { var e error; listener, e = net.Listen("tcp4", address); return e })
	if err != nil {
		base.t.Fatal(err)
	}
	l := tls.NewListener(listener, &tls.Config{Certificates: []tls.Certificate{pair}, MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13, NextProtos: []string{"http/1.1"}})
	o := &h7Origin{marker: marker, addr: l.Addr().String(), stops: map[string]<-chan struct{}{}}
	base.event(marker+"-bound", object{"marker": marker, "address": o.addr})
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		o.requests.Add(1)
		if r.URL.Path == "/one" {
			w.Header().Set("X-H7-Origin", marker)
			body := append([]byte(marker+"\n"), framePayload(0)...)
			w.Header().Set("Content-Length", strconv.Itoa(len(body)))
			_, _ = w.Write(body)
			return
		}
		h.mu.Lock()
		var flow *h9Flow
		for _, f := range h.flows {
			if f.ID == r.URL.Query().Get("id") {
				flow = f
				break
			}
		}
		h.mu.Unlock()
		if flow == nil {
			http.Error(w, "unknown H9 flow", 400)
			return
		}
		raw, rw, e := w.(http.Hijacker).Hijack()
		if e != nil {
			flow.originDone <- e
			return
		}
		conn, ok := raw.(*tls.Conn)
		if !ok {
			raw.Close()
			flow.originDone <- fmt.Errorf("origin hijack is not TLS")
			return
		}
		_ = conn.SetDeadline(time.Now().Add(240 * time.Second))
		_, e = fmt.Fprintf(rw, "HTTP/1.1 200 OK\r\nX-H7-Origin: %s\r\nConnection: close\r\n\r\n", marker)
		if e == nil {
			e = rw.Flush()
		}
		if e != nil {
			conn.Close()
			flow.originDone <- e
			return
		}
		go func() {
			defer conn.Close()
			defer close(flow.originFinished)
			ends := make(chan error, 2)
			go func() { ends <- h.originRead(flow, rw.Reader) }()
			go func() { ends <- h.originWrite(flow, conn) }()
			var result error
			for i := 0; i < 2; i++ {
				if e := <-ends; e != nil && result == nil {
					result = e
					conn.Close()
				}
			}
			h9FlowError(flow, result)
			flow.originDone <- result
		}()
	})}
	go func() { _ = server.Serve(l) }()
	base.t.Cleanup(func() { _ = server.Close() })
	return o
}

func (h *h9Run) originRead(f *h9Flow, reader io.Reader) error {
	defer close(f.clientEnded)
	for seq := uint64(0); ; seq++ {
		if seq >= 20000 {
			return fmt.Errorf("bounded upload frame budget exceeded")
		}
		body, err := readDuplexFrame(reader, seq)
		if err != nil {
			return err
		}
		if len(body) == 0 {
			tail, e := io.ReadAll(reader)
			if e != nil {
				return e
			}
			if len(tail) != 0 {
				return fmt.Errorf("upload bytes after terminal")
			}
			f.mu.Lock()
			f.HalfClose["origin_read_eof"] = true
			f.HalfClose["origin_read_eof_us"] = time.Since(h.base.start).Microseconds()
			f.HalfClose["down_frames_at_origin_eof"] = len(f.DownFrames)
			f.mu.Unlock()
			return nil
		}
		if f.Mode == "download" {
			return fmt.Errorf("download sent unexpected upload payload")
		}
		h.record(f, true, seq, body)
	}
}

func (h *h9Run) originWrite(f *h9Flow, conn *tls.Conn) error {
	seq := uint64(0)
	tail := 0
	for {
		stop := false
		if f.Mode == "upload" {
			<-f.clientEnded
			stop = true
		} else if f.Mode == "duplex" && f.Completion == "client-half-close" {
			select {
			case <-f.clientEnded:
				tail++
				stop = tail > 3
			default:
			}
		} else {
			select {
			case <-f.stop:
				stop = true
			default:
			}
		}
		if stop {
			if err := writeFrame(conn, seq, nil); err != nil {
				return err
			}
			return h9HalfClose(conn)
		}
		body := framePayload(seq)
		if os.Getenv("H9_NEGATIVE") == "corrupt-payload" && f.ID == "b0-via-A-0" && seq == 4 {
			body[0] ^= 1
		}
		if err := writeFrame(conn, seq, body); err != nil {
			return err
		}
		seq++
		time.Sleep(h.base.frameInterval)
	}
}

func (h *h9Run) startFlow(id, path, generation, mode, completion, marker string) *h9Flow {
	t := h.base.t
	f := &h9Flow{ID: id, Path: path, Generation: generation, Mode: mode, Completion: completion, StartedUS: time.Since(h.base.start).Microseconds(), UpFrames: []h9Frame{}, DownFrames: []h9Frame{}, stop: make(chan struct{}), serverEnded: make(chan struct{}), clientEnded: make(chan struct{}), originDone: make(chan error, 1), done: make(chan error, 1), HalfClose: object{}}
	f.clientFinished, f.originFinished = make(chan struct{}), make(chan struct{})
	f.abort = make(chan struct{})
	h.mu.Lock()
	h.flows = append(h.flows, f)
	h.mu.Unlock()
	p := h.base.viaA
	if path == "direct-REALITY" {
		p = h.base.direct
	}
	raw, e := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", p), 3*time.Second)
	if e != nil {
		t.Fatal(e)
	}
	pem, e := os.ReadFile(h.base.f.certPath)
	if e != nil {
		raw.Close()
		t.Fatal(e)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(pem) {
		t.Fatal("invalid fixture certificate")
	}
	c := tls.Client(raw, &tls.Config{ServerName: "origin.test", RootCAs: roots, MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13, NextProtos: []string{"http/1.1"}})
	f.conn = c
	t.Cleanup(func() { f.abortOnce.Do(func() { close(f.abort) }); c.Close() })
	_ = c.SetDeadline(time.Now().Add(240 * time.Second))
	if e = c.Handshake(); e != nil {
		t.Fatal(e)
	}
	req, _ := http.NewRequest(http.MethodGet, "https://origin.test/h9/stream?id="+id, nil)
	req.Close = true
	if e = req.Write(c); e != nil {
		t.Fatal(e)
	}
	resp, e := http.ReadResponse(bufio.NewReader(c), req)
	if e != nil {
		t.Fatal(e)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("stream status %d", resp.StatusCode)
	}
	f.Marker = resp.Header.Get("X-H7-Origin")
	if f.Marker != marker {
		t.Fatalf("%s marker %s want %s", id, f.Marker, marker)
	}
	f.Local, f.Remote = c.LocalAddr().String(), c.RemoteAddr().String()
	go func() {
		defer c.Close()
		defer close(f.clientFinished)
		ends := make(chan error, 2)
		go func() { ends <- h.clientWrite(f, c) }()
		go func() { ends <- h.clientRead(f, resp.Body) }()
		var result error
		for i := 0; i < 2; i++ {
			if e := <-ends; e != nil && result == nil {
				result = e
				f.abortOnce.Do(func() { close(f.abort) })
				c.Close()
			}
		}
		h9FlowError(f, result)
		f.done <- result
	}()
	return f
}

func (h *h9Run) clientWrite(f *h9Flow, c *tls.Conn) error {
	seq := uint64(0)
	tail := 0
	if f.Mode == "download" && os.Getenv("H9_BOUNDARY") == "" {
		select {
		case <-f.stop:
		case <-f.abort:
			return fmt.Errorf("upload writer cancelled after peer failure")
		}
	}
	for {
		stop := f.Mode == "download" && os.Getenv("H9_BOUNDARY") != ""
		if f.Completion == "server-ended" && f.Mode == "duplex" {
			select {
			case <-f.serverEnded:
				tail++
				stop = tail > 3
			default:
			}
		} else {
			select {
			case <-f.stop:
				stop = true
			default:
			}
		}
		if stop {
			if e := writeFrame(c, seq, nil); e != nil {
				return e
			}
			if e := h9HalfClose(c); e != nil {
				return e
			}
			f.mu.Lock()
			f.HalfClose["client_write_closed_us"] = time.Since(h.base.start).Microseconds()
			f.HalfClose["down_frames_at_client_close"] = len(f.DownFrames)
			f.mu.Unlock()
			return nil
		}
		if e := writeFrame(c, seq, framePayload(seq)); e != nil {
			return e
		}
		seq++
		f.sent.Store(seq)
		time.Sleep(h.base.frameInterval)
	}
}

func (h *h9Run) clientRead(f *h9Flow, reader io.Reader) error {
	for seq := uint64(0); ; seq++ {
		if seq >= 20000 {
			return fmt.Errorf("bounded download frame budget exceeded")
		}
		body, e := readDuplexFrame(reader, seq)
		if e != nil {
			return e
		}
		if len(body) == 0 {
			f.mu.Lock()
			f.HalfClose["server_terminal_us"] = time.Since(h.base.start).Microseconds()
			f.HalfClose["up_frames_at_server_terminal"] = len(f.UpFrames)
			f.mu.Unlock()
			tail, e := io.ReadAll(reader)
			if e != nil {
				return e
			}
			if len(tail) != 0 {
				return fmt.Errorf("download bytes after terminal")
			}
			f.mu.Lock()
			f.HalfClose["server_read_eof"] = true
			f.HalfClose["server_read_eof_us"] = time.Since(h.base.start).Microseconds()
			f.HalfClose["up_frames_at_server_eof"] = len(f.UpFrames)
			f.mu.Unlock()
			close(f.serverEnded)
			return nil
		}
		if f.Mode == "upload" {
			return fmt.Errorf("upload received unexpected download payload")
		}
		h.record(f, false, seq, body)
	}
}

func (h *h9Run) selectFlows(generation string) []*h9Flow {
	result := []*h9Flow{}
	for _, f := range h.flows {
		if generation == "" || f.Generation == generation {
			result = append(result, f)
		}
	}
	return result
}

func h9Counts(f *h9Flow) (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.UpFrames), len(f.DownFrames)
}

func (h *h9Run) advance(flows []*h9Flow, delta int) {
	before := make([][2]int, len(flows))
	for i, f := range flows {
		u, d := h9Counts(f)
		before[i] = [2]int{u, d}
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		all := true
		for i, f := range flows {
			select {
			case <-f.clientFinished:
				f.mu.Lock()
				message := f.Error
				f.mu.Unlock()
				h.base.t.Fatalf("flow ended before stop: %s: %s", f.ID, message)
			default:
			}
			u, d := h9Counts(f)
			if (f.Mode != "download" && u < before[i][0]+delta) || (f.Mode != "upload" && d < before[i][1]+delta) {
				all = false
			}
		}
		if all {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.base.t.Fatal("existing streams did not advance in every required direction")
}

func (h *h9Run) checkpoint(name string, flows []*h9Flow) {
	x := []object{}
	for _, f := range flows {
		u, d := h9Counts(f)
		x = append(x, object{"id": f.ID, "up_frames": u, "down_frames": d})
	}
	h.base.event(name, nil)
	events := h.base.result["events"].([]object)
	h.checkpoints = append(h.checkpoints, object{"name": name, "at_us": events[len(events)-1]["at_us"], "flows": x})
}

func (h *h9Run) finish(flows []*h9Flow) {
	for _, f := range flows {
		f.StopRequestedUS = time.Since(h.base.start).Microseconds()
		close(f.stop)
	}
	for _, f := range flows {
		for _, done := range []chan error{f.done, f.originDone} {
			select {
			case e := <-done:
				if e != nil {
					f.Error = e.Error()
					h.base.t.Fatalf("flow %s: %v", f.ID, e)
				}
			case <-time.After(10 * time.Second):
				h.base.t.Fatalf("flow %s completion timeout", f.ID)
			}
		}
		f.FinishedUS = time.Since(h.base.start).Microseconds()
		f.SentUpFrames = f.sent.Load()
		u, d := h9Counts(f)
		f.VerifiedUpBytes = uint64(u * frameSize)
		f.VerifiedDownBytes = uint64(d * frameSize)
		if uint64(u) != f.SentUpFrames {
			h.base.t.Fatalf("upload conservation %s sent=%d verified=%d", f.ID, f.SentUpFrames, u)
		}
		if f.Mode == "duplex" {
			if f.Completion == "client-half-close" && d < f.HalfClose["down_frames_at_origin_eof"].(int)+3 {
				h.base.t.Fatal("download did not continue after client half close")
			}
			if f.Completion == "server-ended" && u < f.HalfClose["up_frames_at_server_eof"].(int)+3 {
				h.base.t.Fatal("upload did not continue after server ended")
			}
		}
	}
}

func (h *h9Run) startRequests() func() {
	stop, done := make(chan struct{}), make(chan struct{})
	var once sync.Once
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		defer wg.Wait()
		sem := make(chan struct{}, 32)
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		i := 0
		for {
			select {
			case <-stop:
				return
			case at := <-ticker.C:
				path := []string{"via-A", "direct-REALITY"}[i%2]
				i++
				select {
				case sem <- struct{}{}:
					wg.Add(1)
					go func() {
						defer wg.Done()
						defer func() { <-sem }()
						r := h.base.request(path, "", at)
						h.requestMu.Lock()
						h.requests = append(h.requests, r)
						h.requestMu.Unlock()
					}()
				default:
					h.base.t.Errorf("request concurrency budget exceeded")
				}
			}
		}
	}()
	return func() {
		once.Do(func() {
			close(stop)
			select {
			case <-done:
			case <-time.After(12 * time.Second):
				h.base.t.Error("request generator stop timeout")
			}
		})
	}
}

func (h *h9Run) switchGeneration(old, next *generation, epoch int, operation, want string) {
	b := h.base
	t := b.t
	b.phase.Store(operation)
	begin := time.Now()
	b.event(operation+"-begin", nil)
	fencedConfig(t, old, epoch, "pause", "fence")
	fencedConfig(t, next, 1, "resume", "fence")
	s := fencedConfig(t, old, epoch, "pause", "pause")
	if !s.Paused {
		t.Fatal("old not paused")
	}
	for _, l := range s.Listeners {
		if l.Role == "public" && l.InAccept {
			t.Fatal("old still in accept")
		}
	}
	pause := time.Since(b.start).Microseconds()
	b.event(operation+"-paused", object{"certificate": s})
	done := make(chan h7Request, 2)
	for _, p := range []string{"via-A", "direct-REALITY"} {
		go func(path string) { done <- b.request(path, want, time.Now()) }(p)
	}
	// The deliberate barrier is a correctness case, not a latency measurement.
	time.Sleep(100 * time.Millisecond)
	fencedConfig(t, next, 1, "resume", "resume")
	resume := time.Since(b.start).Microseconds()
	b.event(operation+"-committed", object{"pause_to_resume_us": resume - pause, "total_us": time.Since(begin).Microseconds()})
	b.phase.Store(operation + "-post")
	for i := 0; i < 2; i++ {
		select {
		case r := <-done:
			if r.Error != "" {
				t.Fatal(r.Error)
			}
			if r.DispatchUS <= pause || r.DispatchUS >= resume {
				t.Fatal("pause probe did not dispatch within barrier")
			}
			h.pauseRequests = append(h.pauseRequests, object{"operation": operation, "path": r.Path, "dispatch_us": r.DispatchUS, "pause_us": pause, "resume_us": resume, "marker": r.Marker, "error": r.Error, "total_us": r.TotalUS, "scheduled_us": r.ScheduledUS, "local_adapter_connect_us": r.ConnectUS, "end_to_end_inner_tls_us": r.HandshakeUS, "http_headers_us": r.FirstByteUS})
		case <-time.After(10 * time.Second):
			t.Fatal("pause request did not finish")
		}
	}
}

func (h *h9Run) retire(g *generation, epoch int) {
	b := h.base
	t := b.t
	fencedConfig(t, g, epoch, "retire", "fence")
	deadline := time.Now().Add(150 * time.Second)
	var certificate configStatus
	for time.Now().Before(deadline) {
		certificate = fencedConfig(t, g, epoch, "retire", "drain")
		if certificate.RetireReady {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !certificate.RetireReady {
		t.Fatalf("%s strict drain deadline exceeded: %+v", g.name, certificate)
	}
	if certificate.Unsupported || certificate.PublicActive != 0 || certificate.CoverActive != 0 || certificate.BackgroundActive != 0 || !certificate.PublicQuiescent || !certificate.CoverPaused {
		t.Fatalf("invalid strict certificate: %+v", certificate)
	}
	b.event(g.name+"-drain-certified", object{"pid": g.cmd.Process.Pid, "certificate": certificate})
	h.terminate(g.name)
}

func TestH9MixedLifecycle(t *testing.T) {
	if os.Getenv("XRAY_H9_RUN") != "1" {
		t.Skip("explicit isolated H9 integration")
	}
	negative := os.Getenv("H9_NEGATIVE")
	if negative != "" && negative != "corrupt-payload" && negative != "unexpected-exit" {
		t.Fatal("unknown negative control")
	}
	oldBin, newBin, client := os.Getenv("H9_OLD_BIN"), os.Getenv("H9_NEW_BIN"), os.Getenv("H9_CLIENT_BIN")
	if oldBin == "" || newBin == "" || client == "" {
		t.Fatal("explicit immutable binary paths required")
	}
	t.Setenv("XRAY_LAB_CLIENT_BIN", client)
	root := os.Getenv("H9_RESULT_DIR")
	if root == "" {
		t.Fatal("explicit fresh result directory required")
	}
	if e := os.MkdirAll(root, 0700); e != nil {
		t.Fatal(e)
	}
	dir, e := os.MkdirTemp(root, "r-")
	if e != nil {
		t.Fatal(e)
	}
	if os.Getenv("H7_NETNS") != "1" {
		h7AccessAddress = "127.0.0.1"
	}
	cert, key := makeCertificate(t, dir)
	priv, e := ecdh.X25519().GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	f := &fixture{t: t, dir: dir, certPath: cert, keyPath: key, uuid: "0f9a8125-6854-4c3d-a375-3bcedc058213", privateKey: base64.RawURLEncoding.EncodeToString(priv.Bytes()), publicKey: base64.RawURLEncoding.EncodeToString(priv.PublicKey().Bytes())}
	pace := 30
	if v := os.Getenv("H9_FRAME_INTERVAL_MS"); v != "" {
		pace, e = strconv.Atoi(v)
		if e != nil || pace < 2 || pace > 1000 {
			t.Fatal("invalid pacing")
		}
	}
	h := &h9Run{requests: []h7Request{}, flows: []*h9Flow{}, pauseRequests: []object{}, checkpoints: []object{}}
	b := &h7Run{t: t, f: f, start: time.Now(), ports: map[int]bool{}, frameInterval: time.Duration(pace) * time.Millisecond, binaries: map[string]string{}, h9: h, result: object{"schema_version": 9, "run_id": filepath.Base(dir), "events": []object{}, "errors": []string{}, "scope": "isolated strict runtime lifecycle; no Rust/PG claim", "initial_persistent_flows": 32, "frame_interval_ms": pace}}
	h.base = b
	h9Current = h
	hashes := object{"b0": fileDigest(t, oldBin), "b1": fileDigest(t, newBin), "b2": fileDigest(t, newBin), "client": fileDigest(t, client)}
	b.result["binary_sha256"], b.result["expected_binary_sha256"] = hashes, hashes
	operation := "same-binary-control"
	mode := "fixed-to-fixed"
	if oldBin != newBin && hashes["b0"] != hashes["b1"] {
		operation = "binary-upgrade"
		mode = "old-to-fixed"
	}
	b.result["mode"] = mode
	b.result["negative_control"] = os.Getenv("H9_NEGATIVE")
	b.result["boundary"] = os.Getenv("H9_BOUNDARY")
	b.result["half_close_transport"] = os.Getenv("H9_HALF_CLOSE")
	b.result["timeout_policy_seconds"] = object{"conn_idle": 300, "uplink_only": 1, "downlink_only": 1}
	t.Cleanup(func() {
		deadline := time.After(2 * time.Second)
		for _, flow := range h.flows {
			for _, done := range []chan struct{}{flow.clientFinished, flow.originFinished} {
				select {
				case <-done:
				case <-deadline:
					t.Errorf("flow cleanup did not complete: %s", flow.ID)
					deadline = time.After(time.Millisecond)
				}
			}
		}
		failures := 0
		phaseByEvent := map[string]string{"baseline-begin": "baseline", operation + "-begin": operation, operation + "-committed": operation + "-post", "routing-update-begin": "routing-update", "routing-update-committed": "routing-update-post", "retirement-begin": "retirement"}
		for i := range h.requests {
			r := &h.requests[i]
			for _, event := range b.result["events"].([]object) {
				if event["at_us"].(int64) > r.DispatchUS {
					break
				}
				if phase, ok := phaseByEvent[event["name"].(string)]; ok {
					r.Phase = phase
				}
			}
			if r.Error != "" {
				failures++
			}
		}
		streamErrors := []string{}
		for _, f := range h.flows {
			if f.Error != "" {
				streamErrors = append(streamErrors, f.ID+": "+f.Error)
			}
		}
		b.result["new_request_failures"], b.result["application_reconnects"], b.result["stream_errors"] = failures, 0, streamErrors
		b.result["test_failed"] = t.Failed()
		b.result["flows"] = h.flows
		b.result["requests"] = h.requests
		b.result["pause_requests"] = h.pauseRequests
		b.result["checkpoints"] = h.checkpoints
		b.result["processes"] = h.processes
		writeJSON(t, filepath.Join(dir, "result.json"), b.result)
		t.Logf("H9_RESULT %s", filepath.Join(dir, "result.json"))
		h9Current = nil
	})
	b.phase.Store("setup")
	b.origins = []*h7Origin{b.startOrigin("origin-1"), b.startOrigin("origin-2")}
	b.plain, b.reality, b.relay, b.viaA, b.direct = b.port(), b.port(), b.port(), b.port(), b.port()
	b0 := b.startB("b0", oldBin, 1, nil)
	b.startChain()
	if os.Getenv("H9_BOUNDARY") != "" {
		for _, path := range []string{"via-A", "direct-REALITY"} {
			h.startFlow("boundary-"+path, path, "b0", "download", "server-ended", "origin-1")
		}
		h.advance(h.flows, 3)
		until := time.Now().Add(2500 * time.Millisecond)
		for time.Now().Before(until) {
			h.advance(h.flows, 3)
		}
		h.finish(h.flows)
		b.result["b0_stats"] = b.queryStats(b0)
		b.event("boundary-complete", nil)
		for _, name := range []string{"b0", "fixed-A", "fixed-client"} {
			h.terminate(name)
		}
		return
	}
	add := func(generation string, count int, marker string) {
		for _, path := range []string{"via-A", "direct-REALITY"} {
			for i := 0; i < count; i++ {
				m := []string{"download", "upload", "duplex"}[i%3]
				completion := "client-half-close"
				if m == "download" || (m == "duplex" && i%2 == 0) {
					completion = "server-ended"
				}
				h.startFlow(fmt.Sprintf("%s-%s-%d", generation, path, i), path, generation, m, completion, marker)
			}
		}
	}
	add("b0", 16, "origin-1")
	h.advance(h.flows, 3)
	b.phase.Store("baseline")
	b.event("baseline-begin", nil)
	h.checkpoint("baseline", h.flows)
	if os.Getenv("H9_NEGATIVE") == "unexpected-exit" {
		if err := b0.cmd.Process.Kill(); err != nil {
			t.Fatal(err)
		}
		h.advance(h.flows, 3)
	}
	stopRequests := h.startRequests()
	defer stopRequests()
	time.Sleep(time.Second)
	b1 := b.startB("b1", newBin, 1, b0)
	h.switchGeneration(b0, b1, 1, operation, "origin-1")
	add("b1", 3, "origin-1")
	h.advance(h.flows, 3)
	h.checkpoint("after-handoff", h.flows)
	time.Sleep(time.Second)
	b2 := b.startB("b2", newBin, 2, b1)
	h.switchGeneration(b1, b2, 2, "routing-update", "origin-2")
	add("b2", 3, "origin-2")
	h.advance(h.flows, 3)
	h.checkpoint("after-route", h.flows)
	time.Sleep(time.Second)
	b.phase.Store("retirement")
	b.event("retirement-begin", nil)
	h.finish(h.selectFlows("b0"))
	b.result["b0_stats"] = b.queryStats(b0)
	h.checkpoint("before-b0-retire", h.selectFlows("b2"))
	h.retire(b0, 3)
	h.advance(h.selectFlows("b2"), 3)
	h.checkpoint("after-b0-retire", h.selectFlows("b2"))
	h.finish(h.selectFlows("b1"))
	b.result["b1_stats"] = b.queryStats(b1)
	h.checkpoint("before-b1-retire", h.selectFlows("b2"))
	h.retire(b1, 4)
	h.advance(h.selectFlows("b2"), 3)
	h.checkpoint("after-b1-retire", h.selectFlows("b2"))
	time.Sleep(time.Second)
	stopRequests()
	h.finish(h.selectFlows("b2"))
	b.result["b2_stats"] = b.queryStats(b2)
	b.event("measurement-end", nil)
	for _, r := range h.requests {
		if r.Error != "" {
			t.Errorf("request %s: %s", r.Path, r.Error)
		}
	}
	for _, name := range []string{"b2", "fixed-A", "fixed-client"} {
		h.terminate(name)
	}
	for role, bin := range map[string]string{"b0": oldBin, "b1": newBin, "client": client} {
		if fileDigest(t, bin) != hashes[role] {
			t.Fatalf("binary changed during run: %s", role)
		}
	}
}

func TestH9EarlyHalfCloseBoundary(t *testing.T) {
	t.Setenv("H9_BOUNDARY", "early-download")
	TestH9MixedLifecycle(t)
}
