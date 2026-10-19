//go:build linux

package handofflab

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	statscmd "github.com/xtls/xray-core/app/stats/command"
	"golang.org/x/sys/unix"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// This is a runtime-only pilot, not the Rust coordinator or production release.
// Fixed A really decodes and re-encodes VLESS; it is not a transparent TCP relay.
// Only B is upgraded and covered by the strict whole-config drain contract.
type h7Run struct {
	h9                                  *h9Run
	binaries                            map[string]string
	t                                   *testing.T
	f                                   *fixture
	start                               time.Time
	ports                               map[int]bool
	plain, reality, relay, viaA, direct int
	origins                             []*h7Origin
	flows                               []*h7Flow
	result                              object
	phase                               atomic.Value
	frameInterval                       time.Duration
}

var h7AccessAddress = "10.77.2.2"

// The callback synchronously creates sockets. The origin handler may run on
// other threads afterwards: netns belongs to the socket, not its goroutine.
// Origin and generator share one process; this is not CPU/process isolation.
func h7InNamespace(role string, callback func() error) error {
	if os.Getenv("H7_NETNS") != "1" {
		return callback()
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	prior, err := os.Open("/proc/thread-self/ns/net")
	if err != nil {
		return err
	}
	defer prior.Close()
	target, err := os.Open("/run/netns/h7-" + role)
	if err != nil {
		return err
	}
	defer target.Close()
	if err := unix.Setns(int(target.Fd()), unix.CLONE_NEWNET); err != nil {
		return err
	}
	defer func() {
		if err := unix.Setns(int(prior.Fd()), unix.CLONE_NEWNET); err != nil {
			fmt.Fprintln(os.Stderr, "FATAL: restore test network namespace:", err)
			os.Exit(2)
		}
	}()
	return callback()
}

func h7NamespaceCookie() (uint64, error) {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return 0, err
	}
	defer unix.Close(fd)
	return unix.GetsockoptUint64(fd, unix.SOL_SOCKET, unix.SO_NETNS_COOKIE)
}

func h7SocketCookie(conn syscall.Conn) (uint64, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, err
	}
	var cookie uint64
	var socketErr error
	err = raw.Control(func(fd uintptr) {
		cookie, socketErr = unix.GetsockoptUint64(int(fd), unix.SOL_SOCKET, unix.SO_NETNS_COOKIE)
	})
	if err != nil {
		return 0, err
	}
	return cookie, socketErr
}

func h7DialNamespace(ctx context.Context, role, address string) (net.Conn, error) {
	var conn net.Conn
	err := h7InNamespace(role, func() error {
		want, err := h7NamespaceCookie()
		if err != nil {
			return err
		}
		conn, err = (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp4", address)
		if err != nil {
			return err
		}
		got, err := h7SocketCookie(conn.(syscall.Conn))
		if err != nil || got != want {
			conn.Close()
			return fmt.Errorf("dial namespace cookie got=%d want=%d: %v", got, want, err)
		}
		return nil
	})
	return conn, err
}

func (h *h7Run) verifyNode(cmd *exec.Cmd, binary, role string) {
	h.t.Helper()
	pid := cmd.Process.Pid
	actual, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil || actual != binary || fileDigest(h.t, actual) != fileDigest(h.t, binary) {
		h.t.Fatalf("node executable mismatch PID %d got=%s want=%s err=%v", pid, actual, binary, err)
	}
	if os.Getenv("H7_NETNS") != "1" {
		return
	}
	got, err := os.Stat(fmt.Sprintf("/proc/%d/ns/net", pid))
	want, wantErr := os.Stat("/run/netns/h7-" + role)
	if err != nil || wantErr != nil || !os.SameFile(got, want) {
		h.t.Fatalf("node namespace mismatch pid=%d role=%s err=%v/%v", pid, role, err, wantErr)
	}
}

func (h *h7Run) queryStats(g *generation) map[string]int64 {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := grpc.NewClient(fmt.Sprintf("127.0.0.1:%d", g.api), grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithContextDialer(func(ctx context.Context, address string) (net.Conn, error) {
		return h7DialNamespace(ctx, "access", address)
	}))
	if err != nil {
		h.t.Fatal(err)
	}
	defer c.Close()
	r, err := statscmd.NewStatsServiceClient(c).QueryStats(ctx, &statscmd.QueryStatsRequest{}) // reset defaults false
	if err != nil {
		h.t.Fatal(err)
	}
	result := map[string]int64{}
	for _, stat := range r.Stat {
		result[stat.Name] = stat.Value
	}
	return result
}

type h7Origin struct {
	marker, addr string
	mu           sync.Mutex
	stops        map[string]<-chan struct{}
	requests     atomic.Uint64
}

type h7Frame struct {
	AtUS  int64  `json:"at_us"`
	GapUS int64  `json:"gap_us"`
	Seq   uint64 `json:"seq"`
	Bytes int    `json:"bytes"`
}

type h7Flow struct {
	ID            string    `json:"id"`
	Path          string    `json:"path"`
	Marker        string    `json:"marker"`
	Local         string    `json:"local"`
	Remote        string    `json:"remote"`
	Error         string    `json:"error"`
	VerifiedBytes uint64    `json:"verified_bytes"`
	Frames        []h7Frame `json:"frames"`
	stop          chan struct{}
	done          chan error
}

type h7Request struct {
	Path        string `json:"path"`
	Phase       string `json:"phase"`
	ScheduledUS int64  `json:"scheduled_us"`
	DispatchUS  int64  `json:"dispatch_us"`
	ConnectUS   int64  `json:"local_adapter_connect_us"`
	HandshakeUS int64  `json:"end_to_end_inner_tls_us"`
	FirstByteUS int64  `json:"http_headers_us"`
	TotalUS     int64  `json:"total_us"`
	Marker      string `json:"marker"`
	Error       string `json:"error"`
}

func (h *h7Run) port() int {
	h.t.Helper()
	for i := 0; i < 100; i++ {
		p := pickPort(h.t)
		if !h.ports[p] {
			h.ports[p] = true
			return p
		}
	}
	h.t.Fatal("could not choose a unique fixture port")
	return 0
}

func (h *h7Run) event(name string, extra object) {
	e := object{"name": name, "at_us": time.Since(h.start).Microseconds()}
	for k, v := range extra {
		e[k] = v
	}
	h.result["events"] = append(h.result["events"].([]object), e)
}

func (h *h7Run) startOrigin(marker string) *h7Origin { return h9StartOrigin(h, marker) }

func (h *h7Run) bConfig(g *generation, cover, route int) object {
	client := func(vision bool) object {
		u := object{"id": h.f.uuid, "email": userEmail, "level": 0}
		if vision {
			u["flow"] = "xtls-rprx-vision"
		}
		return u
	}
	plain := object{"tag": "hop", "listen": "127.0.0.1", "port": h.plain, "protocol": "vless", "settings": object{"decryption": "none", "clients": []any{client(false)}}, "streamSettings": object{"network": "tcp", "security": "none"}}
	reality := object{"tag": "vision", "listen": "127.0.0.1", "port": h.reality, "protocol": "vless", "settings": object{"decryption": "none", "clients": []any{client(true)}}, "streamSettings": object{"network": "tcp", "security": "reality", "realitySettings": object{"dest": fmt.Sprintf("127.0.0.1:%d", cover), "serverNames": []string{"local-cover.test"}, "privateKey": h.f.privateKey, "shortIds": []string{"0123456789abcdef"}}}}
	coverIn := object{"tag": "cover", "listen": "127.0.0.1", "port": cover, "protocol": "dokodemo-door", "settings": object{"address": "127.0.0.1", "port": 1, "network": "tcp"}, "streamSettings": object{"network": "tcp", "security": "tls", "tlsSettings": object{"alpn": []string{"http/1.1"}, "rejectUnknownSni": true, "certificates": []any{object{"certificateFile": h.f.certPath, "keyFile": h.f.keyPath, "reloadInterval": 5}}}}}
	plain["listen"] = h7AccessAddress
	reality["listen"] = h7AccessAddress
	return object{"log": object{"loglevel": "warning"}, "stats": object{}, "api": object{"tag": "api", "listen": fmt.Sprintf("127.0.0.1:%d", g.api), "services": []string{"StatsService"}}, "policy": object{"levels": object{"0": object{"statsUserUplink": true, "statsUserDownlink": true, "connIdle": 300}}}, "inbounds": []any{plain, reality, coverIn}, "outbounds": []any{
		object{"tag": "origin-1", "protocol": "freedom", "settings": object{"redirect": h.origins[0].addr, "ipsBlocked": []string{}}},
		object{"tag": "origin-2", "protocol": "freedom", "settings": object{"redirect": h.origins[1].addr, "ipsBlocked": []string{}}},
		object{"tag": "cover-response", "protocol": "blackhole", "settings": object{"response": object{"type": "http"}}},
	}, "routing": object{"rules": []any{object{"type": "field", "inboundTag": []string{"cover"}, "outboundTag": "cover-response"}, object{"type": "field", "inboundTag": []string{"hop", "vision"}, "outboundTag": fmt.Sprintf("origin-%d", route)}}}}
}

func (h *h7Run) startB(name, bin string, route int, from *generation) *generation {
	h.t.Helper()
	begin := time.Now()
	dir := filepath.Join(h.f.dir, name)
	if e := os.Mkdir(dir, 0700); e != nil {
		h.t.Fatal(e)
	}
	g := &generation{name: name, control: filepath.Join(dir, "ctl.sock"), api: h.port()}
	g.client = liveClient(g.control)
	cover := h.port()
	config := h.bConfig(g, cover, route)
	path := filepath.Join(dir, "xray.json")
	writeJSON(h.t, path, config)
	manifest := []object{}
	var files []*os.File
	if from != nil {
		s, e := readLiveStatus(from.control)
		if e != nil {
			h.t.Fatal(e)
		}
		if e = verifyLiveProcess(s, h.binaries[from.name]); e != nil {
			h.t.Fatal(e)
		}
		h.verifyNode(from.cmd, h.binaries[from.name], "access")
		var sockets []liveSocket
		files, sockets, e = receiveLiveGroup(s, "")
		if e != nil {
			h.t.Fatal(e)
		}
		defer func() {
			for _, f := range files {
				_ = f.Close()
			}
		}()
		for i, l := range sockets {
			manifest = append(manifest, object{"address": l.Address, "role": "public", "fd": 3 + i, "socket_inode": l.SocketInode, "socket_cookie": l.SocketCookie})
		}
	} else {
		for _, p := range []int{h.plain, h.reality} {
			manifest = append(manifest, object{"address": fmt.Sprintf("%s:%d", h7AccessAddress, p), "role": "public"})
		}
	}
	for _, m := range manifest {
		if m["address"] == fmt.Sprintf("%s:%d", h7AccessAddress, h.reality) {
			m["depends_on"] = fmt.Sprintf("127.0.0.1:%d", cover)
		}
	}
	manifest = append(manifest, object{"address": fmt.Sprintf("127.0.0.1:%d", cover), "role": "cover"})
	encoded, _ := json.Marshal(manifest)
	cmd := h9Command("access", bin, "run", "-config", path)
	cmd.ExtraFiles = files
	cmd.Env = append(labCleanEnv(), "XRAY_LAB_HANDOFF_MANIFEST="+string(encoded), "XRAY_LAB_CONTROL="+g.control, "XRAY_LAB_GENERATION="+name, "XRAY_LAB_CONFIG_DRAIN=1", "XRAY_LAB_REQUIRE_FENCING=1", "XRAY_BROCADE_ACCOUNTING_FILE="+filepath.Join(dir, "accounting.bin"), "xray.buf.splice=auto")
	if from != nil {
		cmd.Env = append(cmd.Env, "XRAY_LAB_PAUSED=1")
	}
	h.f.startProcess(cmd, filepath.Join(dir, "xray.log"))
	g.cmd = cmd
	h.binaries[name] = bin
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		s, e := readLiveStatus(g.control)
		if e == nil && s.Ready {
			if e = verifyLiveProcess(s, bin); e != nil {
				h.t.Fatal(e)
			}
			if s.PID != cmd.Process.Pid {
				h.t.Fatalf("ip exec PID differs from Xray PID %d/%d", cmd.Process.Pid, s.PID)
			}
			h.verifyNode(cmd, bin, "access")
			cs := readConfigStatus(h.t, g)
			if cs.ConfigVersion != 1 || len(cs.ConfigDigest) != 64 || cs.Unsupported {
				h.t.Fatalf("B lacks complete certificate: %+v", cs)
			}
			if from != nil {
				if !s.Paused {
					h.t.Fatal("candidate not paused")
				}
				for _, l := range s.Listeners {
					if l.Role == "public" && l.Accepted != 0 {
						h.t.Fatal("candidate accepted before commit")
					}
				}
			}
			h.event(name+"-ready", object{"prepare_us": time.Since(begin).Microseconds(), "pid": s.PID, "binary": bin, "binary_sha256": fileDigest(h.t, bin), "config_sha256": fileDigest(h.t, path), "config_digest": cs.ConfigDigest, "selected_origin": route, "listeners": s.Listeners})
			return g
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.t.Fatalf("B %s startup failed; see %s", name, dir)
	return nil
}

func (h *h7Run) startStatic(name string, config object, api int) {
	role := "client"
	if name == "fixed-A" {
		role = "forward"
		for _, item := range config["inbounds"].([]any) {
			item.(object)["listen"] = h9ForwardAddress()
		}
	}
	config["api"].(object)["tag"] = "api"
	path := filepath.Join(h.f.dir, name+".json")
	writeJSON(h.t, path, config)
	cmd := h9Command(role, clientBinary(), "run", "-config", path)
	cmd.Env = append(labCleanEnv(), "xray.buf.splice=auto")
	h.f.startProcess(cmd, filepath.Join(h.f.dir, name+".log"))
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		c, e := h7DialNamespace(context.Background(), role, fmt.Sprintf("127.0.0.1:%d", api))
		if e == nil {
			c.Close()
			h.verifyNode(cmd, clientBinary(), role)
			h.event(name+"-ready", object{"pid": cmd.Process.Pid, "netns_role": role, "binary_sha256": fileDigest(h.t, clientBinary())})
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.t.Fatalf("static %s did not start", name)
}

func (h *h7Run) startChain() {
	vlessOut := func(tag string, port int, reality bool) object {
		address := h7AccessAddress
		if tag == "via-A" {
			address = h9ForwardAddress()
		}
		u := object{"id": h.f.uuid, "encryption": "none"}
		s := object{"network": "tcp", "security": "none"}
		if reality {
			u["flow"] = "xtls-rprx-vision"
			s["security"] = "reality"
			s["realitySettings"] = object{"serverName": "local-cover.test", "fingerprint": "chrome", "publicKey": h.f.publicKey, "shortId": "0123456789abcdef"}
		}
		return object{"tag": tag, "protocol": "vless", "settings": object{"vnext": []any{object{"address": address, "port": port, "users": []any{u}}}}, "streamSettings": s}
	}
	api := h.port()
	h.startStatic("fixed-A", object{"log": object{"loglevel": "warning"}, "api": object{"listen": fmt.Sprintf("127.0.0.1:%d", api), "services": []string{"StatsService"}}, "stats": object{}, "inbounds": []any{object{"listen": "127.0.0.1", "port": h.relay, "protocol": "vless", "settings": object{"decryption": "none", "clients": []any{object{"id": h.f.uuid}}}, "streamSettings": object{"network": "tcp", "security": "none"}}}, "outbounds": []any{vlessOut("to-B-hop", h.plain, false)}}, api)
	api = h.port()
	ins := []any{}
	for _, item := range []struct {
		tag  string
		port int
	}{{"via-A", h.viaA}, {"direct-REALITY", h.direct}} {
		ins = append(ins, object{"tag": item.tag, "listen": "127.0.0.1", "port": item.port, "protocol": "dokodemo-door", "settings": object{"address": "127.0.0.1", "port": 443, "network": "tcp"}})
	}
	h.startStatic("fixed-client", object{"log": object{"loglevel": "warning"}, "api": object{"listen": fmt.Sprintf("127.0.0.1:%d", api), "services": []string{"StatsService"}}, "stats": object{}, "inbounds": ins, "outbounds": []any{vlessOut("via-A", h.relay, false), vlessOut("direct-REALITY", h.reality, true)}, "routing": object{"rules": []any{object{"type": "field", "inboundTag": []string{"via-A"}, "outboundTag": "via-A"}, object{"type": "field", "inboundTag": []string{"direct-REALITY"}, "outboundTag": "direct-REALITY"}}}}, api)
}

func (h *h7Run) open(path, url string, r *h7Request) (*tls.Conn, *http.Response, error) {
	p := h.viaA
	if path == "direct-REALITY" {
		p = h.direct
	}
	begin := time.Now()
	r.DispatchUS = time.Since(h.start).Microseconds()
	raw, e := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", p), 3*time.Second)
	if e != nil {
		return nil, nil, e
	}
	r.ConnectUS = time.Since(begin).Microseconds()
	pem, e := os.ReadFile(h.f.certPath)
	if e != nil {
		raw.Close()
		return nil, nil, e
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(pem) {
		raw.Close()
		return nil, nil, fmt.Errorf("bad synthetic certificate")
	}
	c := tls.Client(raw, &tls.Config{ServerName: "origin.test", RootCAs: roots, MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13, NextProtos: []string{"http/1.1"}})
	_ = c.SetDeadline(time.Now().Add(8 * time.Second))
	if e = c.Handshake(); e != nil {
		c.Close()
		return nil, nil, e
	}
	r.HandshakeUS = time.Since(begin).Microseconds()
	req, _ := http.NewRequest(http.MethodGet, "https://origin.test"+url, nil)
	req.Close = true
	if e = req.Write(c); e != nil {
		c.Close()
		return nil, nil, e
	}
	resp, e := http.ReadResponse(bufio.NewReader(c), req)
	r.FirstByteUS = time.Since(begin).Microseconds()
	if e != nil {
		c.Close()
		return nil, nil, e
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		c.Close()
		return nil, nil, fmt.Errorf("origin status %d", resp.StatusCode)
	}
	r.Marker = resp.Header.Get("X-H7-Origin")
	return c, resp, nil
}

func (h *h7Run) request(path, want string, scheduled time.Time) h7Request {
	r := h7Request{Path: path, Phase: h.phase.Load().(string), ScheduledUS: scheduled.Sub(h.start).Microseconds()}
	c, resp, e := h.open(path, "/one", &r)
	if e == nil {
		b, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		c.Close()
		e = readErr
		if e == nil && (r.Marker != "origin-1" && r.Marker != "origin-2") {
			e = fmt.Errorf("unknown origin %q", r.Marker)
		}
		if e == nil && !bytes.Equal(b, append([]byte(r.Marker+"\n"), framePayload(0)...)) {
			e = fmt.Errorf("response body/hash mismatch")
		}
		if e == nil && want != "" && r.Marker != want {
			e = fmt.Errorf("route marker %s want %s", r.Marker, want)
		}
	}
	r.TotalUS = time.Since(scheduled).Microseconds()
	if e != nil {
		r.Error = e.Error()
	}
	return r
}

func (h *h7Run) startFlow(id, path, want string) *h7Flow {
	f := &h7Flow{ID: id, Path: path, stop: make(chan struct{}), done: make(chan error, 1)}
	for _, o := range h.origins {
		o.mu.Lock()
		o.stops[id] = f.stop
		o.mu.Unlock()
	}
	r := h7Request{}
	c, resp, e := h.open(path, "/stream?id="+id, &r)
	if e != nil {
		h.t.Fatal(e)
	}
	f.Marker = r.Marker
	f.Local = c.LocalAddr().String()
	f.Remote = c.RemoteAddr().String()
	if f.Marker != want {
		h.t.Fatalf("stream %s marker %s want %s", id, f.Marker, want)
	}
	_ = c.SetDeadline(time.Now().Add(90 * time.Second))
	h.t.Cleanup(func() { c.Close() })
	go func() {
		defer c.Close()
		defer resp.Body.Close()
		last := time.Now()
		finish := func(e error) {
			if e != nil {
				f.Error = e.Error()
			}
			f.done <- e
		}
		for seq := uint64(0); ; seq++ {
			var head [44]byte
			if _, e := io.ReadFull(resp.Body, head[:]); e != nil {
				finish(fmt.Errorf("unexpected EOF/reset frame %d: %w", seq, e))
				return
			}
			if binary.BigEndian.Uint64(head[:8]) != seq {
				finish(fmt.Errorf("sequence mismatch %d", seq))
				return
			}
			n := binary.BigEndian.Uint32(head[8:12])
			if n != 0 && n != frameSize {
				finish(fmt.Errorf("invalid frame size %d", n))
				return
			}
			body := make([]byte, n)
			if _, e := io.ReadFull(resp.Body, body); e != nil {
				finish(e)
				return
			}
			sum := sha256.Sum256(body)
			if !bytes.Equal(sum[:], head[12:]) {
				finish(fmt.Errorf("hash mismatch frame %d", seq))
				return
			}
			if n == 0 {
				tail, e := io.ReadAll(resp.Body)
				if e == nil && len(tail) != 0 {
					e = fmt.Errorf("data after terminal frame")
				}
				finish(e)
				return
			}
			if !bytes.Equal(body, framePayload(seq)) {
				finish(fmt.Errorf("payload mismatch frame %d", seq))
				return
			}
			now := time.Now()
			f.Frames = append(f.Frames, h7Frame{AtUS: now.Sub(h.start).Microseconds(), GapUS: now.Sub(last).Microseconds(), Seq: seq, Bytes: int(n)})
			f.VerifiedBytes += uint64(n)
			last = now
			if len(f.Frames) > 100000 {
				finish(fmt.Errorf("bounded fixture frame budget exceeded"))
				return
			}
		}
	}()
	h.flows = append(h.flows, f)
	return f
}

func (h *h7Run) switchB(old, next *generation, oldEpoch int, kind string) {
	h.phase.Store(kind)
	begin := time.Now()
	h.event(kind+"-begin", nil)
	fencedConfig(h.t, old, oldEpoch, "pause", "fence")
	fencedConfig(h.t, next, 1, "resume", "fence")
	pauseBegin := time.Now()
	s := fencedConfig(h.t, old, oldEpoch, "pause", "pause")
	if !s.Paused {
		h.t.Fatal("old not paused")
	}
	for _, l := range s.Listeners {
		if l.Role == "public" && l.InAccept {
			h.t.Fatal("old still accepting")
		}
	}
	fencedConfig(h.t, next, 1, "resume", "resume")
	h.event(kind+"-committed", object{"total_us": time.Since(begin).Microseconds(), "pause_to_resume_us": time.Since(pauseBegin).Microseconds()})
	h.phase.Store(kind + "-post")
}

func h7Distribution(values []int64) object {
	if len(values) == 0 {
		return object{"n": 0}
	}
	sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
	q := func(p int) int64 {
		index := (p*len(values)+99)/100 - 1
		if index < 0 {
			index = 0
		}
		return values[index]
	}
	return object{"n": len(values), "p50_us": q(50), "p95_us": q(95), "p99_us": q(99), "max_us": values[len(values)-1]}
}

func h7Environment(primary, legacy, fallback string) string {
	if value := os.Getenv(primary); value != "" {
		return value
	}
	if value := os.Getenv(legacy); value != "" {
		return value
	}
	return fallback
}
