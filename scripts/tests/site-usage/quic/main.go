// A correctness test, not a throughput benchmark. All QUIC and proxy traffic
// stays on loopback. The SNI is synthetic; no request is sent to YouTube.
package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	quic "github.com/apernet/quic-go"
	quicsniff "github.com/xtls/xray-core/common/protocol/quic"
)

const identity = "11111111-1111-4111-8111-111111111111"
const label = "quic-test@root#entry"
const serverName = "www.youtube.com"
const applicationProtocol = "brocade-quic-attribution-test"

type scenario struct {
	Name        string
	Transport   string
	Version     quic.Version
	Hybrid      bool
	DelaySecond time.Duration
	Rebind      bool
}

type result struct {
	Scenario                     string                      `json:"scenario"`
	Artifacts                    string                      `json:"artifacts"`
	ApplicationBytesPerDirection int                         `json:"application_bytes_per_direction"`
	Stages                       map[string]map[string]int64 `json:"stages"`
	SentPackets                  int64                       `json:"sent_packets"`
	SentBytes                    int64                       `json:"sent_bytes"`
	ReceivedBytes                int64                       `json:"received_bytes"`
	InitialSniff                 []string                    `json:"initial_sniff"`
	TargetPackets                []string                    `json:"target_packets"`
	Error                        string                      `json:"error,omitempty"`
}

func main() {
	xray := flag.String("xray", "", "exact Xray binary to test")
	out := flag.String("out", "", "artifact directory (created if omitted)")
	filter := flag.String("cases", "", "comma-separated scenario names; all if empty")
	size := flag.Int("bytes", 4<<20, "application bytes per direction")
	flag.Parse()
	if *xray == "" || *size < 1 || *size > 64<<20 {
		panic("provide -xray and a bounded byte count")
	}
	if *out == "" {
		var err error
		*out, err = os.MkdirTemp("", "brocade-quic-attribution-")
		must(err)
	}
	must(os.MkdirAll(*out, 0700))
	var cases []scenario
	for _, transport := range []string{"vless", "xudp", "hysteria2"} {
		for _, v := range []quic.Version{quic.Version1, quic.Version2} {
			versionNumber := 1
			if v == quic.Version2 {
				versionNumber = 2
			}
			for _, hybrid := range []bool{false, true} {
				name := fmt.Sprintf("%s-v%d-x25519", transport, versionNumber)
				if hybrid {
					name = fmt.Sprintf("%s-v%d-default-tls", transport, versionNumber)
				}
				cases = append(cases, scenario{Name: name, Transport: transport, Version: v, Hybrid: hybrid})
			}
		}
		cases = append(cases, scenario{Name: transport + "-delayed-initial", Transport: transport, Version: quic.Version1, Hybrid: true, DelaySecond: 350 * time.Millisecond})
		cases = append(cases, scenario{Name: transport + "-rebind", Transport: transport, Version: quic.Version1, Rebind: true})
	}
	var results []result
	failed := false
	for _, c := range cases {
		if *filter != "" && !strings.Contains(","+*filter+",", ","+c.Name+",") {
			continue
		}
		r := run(*xray, filepath.Join(*out, c.Name), c, *size)
		results = append(results, r)
		failed = failed || r.Error != ""
		must(json.NewEncoder(os.Stdout).Encode(r))
		must(writeJSON(filepath.Join(*out, "results.json"), results))
	}
	if failed {
		os.Exit(1)
	}
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
func writeJSON(path string, value any) error {
	b, e := json.MarshalIndent(value, "", "  ")
	if e != nil {
		return e
	}
	return os.WriteFile(path, append(b, '\n'), 0600)
}
func freePort() int {
	l, e := net.Listen("tcp", "127.0.0.1:0")
	must(e)
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}
func endpoint(p int) string { return fmt.Sprintf("127.0.0.1:%d", p) }

func start(xray, dir, name string, config any, env []string) (func(), error) {
	path := filepath.Join(dir, name+".json")
	if e := writeJSON(path, config); e != nil {
		return nil, e
	}
	log, e := os.OpenFile(filepath.Join(dir, name+".log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if e != nil {
		return nil, e
	}
	c := exec.Command(xray, "run", "-config", path)
	// Do not inherit production accounting paths from the caller's environment.
	for _, v := range os.Environ() {
		if !strings.HasPrefix(v, "XRAY_BROCADE_") {
			c.Env = append(c.Env, v)
		}
	}
	c.Env = append(c.Env, env...)
	c.Stdout = log
	c.Stderr = log
	if e = c.Start(); e != nil {
		log.Close()
		return nil, e
	}
	return func() { _ = c.Process.Kill(); _ = c.Wait(); _ = log.Close() }, nil
}
func waitPort(port int) error {
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) {
		c, e := net.DialTimeout("tcp", endpoint(port), 100*time.Millisecond)
		if e == nil {
			c.Close()
			return nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	return fmt.Errorf("startup timeout on port %d", port)
}

func certs() (tls.Certificate, *x509.CertPool, error) {
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		return tls.Certificate{}, nil, e
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: serverName}, DNSNames: []string{serverName}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, e := x509.CreateCertificate(rand.Reader, template, template, pub, key)
	if e != nil {
		return tls.Certificate{}, nil, e
	}
	keyDER, e := x509.MarshalPKCS8PrivateKey(key)
	if e != nil {
		return tls.Certificate{}, nil, e
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	pair, e := tls.X509KeyPair(certPEM, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}))
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(certPEM)
	return pair, pool, e
}

func run(xray, dir string, c scenario, size int) (r result) {
	r = result{Scenario: c.Name, Artifacts: dir, ApplicationBytesPerDirection: size, Stages: map[string]map[string]int64{}}
	defer func() {
		if p := recover(); p != nil {
			r.Error = fmt.Sprint(p)
		}
	}()
	// Never reuse an accounting journal from an earlier run.
	must(os.Mkdir(dir, 0700))
	cert, pool, e := certs()
	must(e)
	targetUDP, e := net.ListenPacket("udp", "127.0.0.1:0")
	must(e)
	targetTrace := &receivedTrace{PacketConn: targetUDP}
	defer targetTrace.Close()
	defer func() {
		targetTrace.mu.Lock()
		r.TargetPackets = append([]string{}, targetTrace.packets...)
		targetTrace.mu.Unlock()
	}()
	listener, e := quic.Listen(targetTrace, &tls.Config{Certificates: []tls.Certificate{cert}, NextProtos: []string{applicationProtocol}}, &quic.Config{Versions: []quic.Version{c.Version}, MaxIdleTimeout: 15 * time.Second})
	must(e)
	defer listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	serverErrors := make(chan error, 1)
	go func() {
		conn, e := listener.Accept(ctx)
		if e != nil {
			serverErrors <- e
			return
		}
		for {
			stream, e := conn.AcceptStream(ctx)
			if e != nil {
				return
			}
			go func() {
				if e := serveStream(stream); e != nil {
					select {
					case serverErrors <- e:
					default:
					}
				}
			}()
		}
	}()
	entry, api := freePort(), freePort()
	config := map[string]any{
		"log": map[string]any{"loglevel": "info"}, "stats": map[string]any{},
		"api":    map[string]any{"tag": "api", "services": []string{"StatsService"}},
		"policy": map[string]any{"levels": map[string]any{"0": map[string]any{"statsUserUplink": true, "statsUserDownlink": true}}},
		"inbounds": []any{
			map[string]any{"tag": "entry", "listen": "127.0.0.1", "port": entry, "protocol": "vless", "settings": map[string]any{"decryption": "none", "clients": []any{map[string]any{"id": identity, "email": label}}}, "sniffing": map[string]any{"enabled": true, "destOverride": []string{"http", "tls", "quic"}, "routeOnly": true}},
			map[string]any{"tag": "api", "listen": "127.0.0.1", "port": api, "protocol": "dokodemo-door", "settings": map[string]any{"address": "127.0.0.1"}},
		},
		"outbounds": []any{map[string]any{"protocol": "freedom", "tag": "direct", "settings": map[string]any{"ipsBlocked": []any{}}}},
		"routing":   map[string]any{"rules": []any{map[string]any{"type": "field", "inboundTag": []string{"api"}, "outboundTag": "api"}}},
	}
	if c.Transport == "hysteria2" {
		keyDER, err := x509.MarshalPKCS8PrivateKey(cert.PrivateKey)
		must(err)
		entryConfig := config["inbounds"].([]any)[0].(map[string]any)
		entryConfig["protocol"] = "hysteria"
		entryConfig["settings"] = map[string]any{"version": 2, "clients": []any{map[string]any{"auth": "loopback-only-test-password", "email": label}}}
		entryConfig["streamSettings"] = map[string]any{
			"network": "hysteria", "security": "tls", "hysteriaSettings": map[string]any{"version": 2},
			"tlsSettings": map[string]any{"alpn": []string{"h3"}, "certificates": []any{map[string]any{
				"certificate": []string{string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]}))},
				"key":         []string{string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}))},
			}}},
		}
	}
	must(os.WriteFile(filepath.Join(dir, "enabled"), []byte("1\n"), 0600))
	must(writeJSON(filepath.Join(dir, "failed-policy.json"), map[string]any{"enabled": true, "top_n": 128, "max_targets_per_user": 1024, "node_capacity": 4096, "report_interval_secs": 30}))
	env := []string{"XRAY_BROCADE_ACCOUNTING_FILE=" + filepath.Join(dir, "billing.bin"), "XRAY_BROCADE_SITE_ACCOUNTING_FILE=" + filepath.Join(dir, "sites.bin"), "XRAY_BROCADE_SITE_USAGE_CONTROL_FILE=" + filepath.Join(dir, "enabled"), "XRAY_BROCADE_ACCOUNTING_SHARED=owner", "XRAY_BROCADE_SNIFFING_FAILED_CONTROL_FILE=" + filepath.Join(dir, "failed-policy.json")}
	stop, e := start(xray, dir, "server", config, env)
	must(e)
	defer stop()
	must(waitPort(api))
	if c.Transport != "hysteria2" {
		must(waitPort(entry))
	}
	target := listener.Addr().(*net.UDPAddr)
	var dial func() (net.PacketConn, error)
	if c.Transport == "vless" {
		dial = func() (net.PacketConn, error) { return dialVLESS(entry, target) }
	} else {
		socks := freePort()
		client := map[string]any{"log": map[string]any{"loglevel": "info"}, "inbounds": []any{map[string]any{"listen": "127.0.0.1", "port": socks, "protocol": "socks", "settings": map[string]any{"auth": "noauth", "udp": true, "ip": "127.0.0.1"}}}, "outbounds": []any{map[string]any{"protocol": "vless", "settings": map[string]any{"vnext": []any{map[string]any{"address": "127.0.0.1", "port": entry, "users": []any{map[string]any{"id": identity, "encryption": "none"}}}}}, "mux": map[string]any{"enabled": true, "concurrency": 8, "xudpConcurrency": 8, "xudpProxyUDP443": "allow"}}}}
		if c.Transport == "hysteria2" {
			client["outbounds"] = []any{map[string]any{
				"protocol": "hysteria", "settings": map[string]any{"version": 2, "address": "127.0.0.1", "port": entry},
				"streamSettings": map[string]any{
					"network": "hysteria", "security": "tls", "hysteriaSettings": map[string]any{"version": 2, "auth": "loopback-only-test-password"},
					"tlsSettings": map[string]any{"serverName": serverName, "alpn": []string{"h3"}, "certificates": []any{map[string]any{"usage": "verify", "certificate": []string{string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]}))}}}},
				},
			}}
		}
		stopClient, e := start(xray, dir, "client", client, nil)
		must(e)
		defer stopClient()
		must(waitPort(socks))
		dial = func() (net.PacketConn, error) { return dialSOCKS(socks, target) }
	}
	base, e := dial()
	must(e)
	pc := &observedConn{PacketConn: base, dial: dial, target: target, delay: c.DelaySecond}
	defer pc.Close()
	defer func() {
		r.SentPackets = pc.sent.Load()
		r.SentBytes = pc.up.Load()
		r.ReceivedBytes = pc.down.Load()
		pc.mu.Lock()
		r.InitialSniff = append([]string{}, pc.sniff...)
		pc.mu.Unlock()
	}()
	clientTLS := &tls.Config{RootCAs: pool, ServerName: serverName, NextProtos: []string{applicationProtocol}}
	if !c.Hybrid {
		clientTLS.CurvePreferences = []tls.CurveID{tls.X25519}
	}
	conn, e := quic.Dial(ctx, pc, target, clientTLS, &quic.Config{Versions: []quic.Version{c.Version}, InitialPacketSize: 1200, HandshakeIdleTimeout: 5 * time.Second, MaxIdleTimeout: 15 * time.Second})
	if e != nil {
		if s, err := query(xray, api); err == nil {
			r.Stages["handshake_error"] = s
		}
	}
	must(e)
	defer conn.CloseWithError(0, "")
	snapshot := func(stage string) {
		time.Sleep(350 * time.Millisecond)
		s, e := query(xray, api)
		must(e)
		r.Stages[stage] = s
	}
	snapshot("handshake")
	var observed int64
	for name, n := range r.Stages["handshake"] {
		if strings.HasPrefix(name, "site>>>") {
			observed += n
		}
	}
	if observed == 0 {
		panic("site counters unavailable; inspect server.log before interpreting this test")
	}
	must(transfer(ctx, conn, 'U', size))
	snapshot("upload")
	must(transfer(ctx, conn, 'D', size))
	snapshot("download")
	if c.Rebind {
		must(pc.rebind())
		must(transfer(ctx, conn, 'U', size))
		must(transfer(ctx, conn, 'D', size))
		snapshot("rebound")
	}
	// Fixed-site categories partition mandatory billing within every snapshot.
	// Detail target counters are a second view, not additional billed traffic.
	for stage, counters := range r.Stages {
		for _, direction := range []string{"uplink", "downlink"} {
			var total int64
			for name, n := range counters {
				if strings.HasPrefix(name, "site>>>") && strings.HasSuffix(name, ">>>traffic>>>"+direction) {
					total += n
				}
			}
			billed := counters["user>>>"+label+">>>traffic>>>"+direction]
			if total != billed {
				panic(fmt.Sprintf("%s %s: categories=%d billing=%d", stage, direction, total, billed))
			}
		}
	}
	last := r.Stages["download"]
	if c.Rebind {
		last = r.Stages["rebound"]
	}
	failedBytes := last["site>>>"+label+">>>sniffing-failed>>>traffic>>>uplink"] + last["site>>>"+label+">>>sniffing-failed>>>traffic>>>downlink"]
	if (c.Rebind || c.DelaySecond > 0) != (failedBytes > 0) {
		panic("unexpected failed-sniff classification; inspect snapshots")
	}
	select {
	case e := <-serverErrors:
		must(e)
	default:
	}
	return r
}

func serveStream(s *quic.Stream) error {
	defer s.Close()
	var header [5]byte
	if _, e := io.ReadFull(s, header[:]); e != nil {
		return e
	}
	n := int64(binary.BigEndian.Uint32(header[1:]))
	if n > 64<<20 {
		return fmt.Errorf("unbounded request")
	}
	if header[0] == 'U' {
		h := sha256.New()
		if _, e := io.CopyN(h, s, n); e != nil {
			return e
		}
		_, e := s.Write(h.Sum(nil))
		return e
	}
	if header[0] != 'D' {
		return fmt.Errorf("bad mode")
	}
	_, e := io.CopyN(s, patternReader{}, n)
	return e
}

type patternReader struct{}

func (patternReader) Read(b []byte) (int, error) {
	for i := range b {
		b[i] = 0x5a
	}
	return len(b), nil
}
func transfer(ctx context.Context, c *quic.Conn, mode byte, n int) error {
	s, e := c.OpenStreamSync(ctx)
	if e != nil {
		return e
	}
	defer s.CancelRead(0)
	defer s.CancelWrite(0)
	must(s.SetDeadline(time.Now().Add(10 * time.Second)))
	header := []byte{mode, 0, 0, 0, 0}
	binary.BigEndian.PutUint32(header[1:], uint32(n))
	if _, e = s.Write(header); e != nil {
		return e
	}
	h := sha256.New()
	_, _ = io.CopyN(h, patternReader{}, int64(n))
	expected := h.Sum(nil)
	if mode == 'U' {
		if _, e = io.CopyN(s, patternReader{}, int64(n)); e != nil {
			return e
		}
		if e = s.Close(); e != nil {
			return e
		}
		got := make([]byte, sha256.Size)
		if _, e = io.ReadFull(s, got); e != nil {
			return e
		}
		if !bytes.Equal(got, expected) {
			return fmt.Errorf("upload hash mismatch")
		}
		return nil
	}
	if e = s.Close(); e != nil {
		return e
	}
	h.Reset()
	if _, e = io.CopyN(h, s, int64(n)); e != nil {
		return e
	}
	if !bytes.Equal(h.Sum(nil), expected) {
		return fmt.Errorf("download hash mismatch")
	}
	return nil
}

func query(xray string, port int) (map[string]int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out := map[string]int64{}
	for _, pattern := range []string{label, "sniffingfailed>>>"} {
		b, e := exec.CommandContext(ctx, xray, "api", "statsquery", "--server="+endpoint(port), "-pattern", pattern).Output()
		if e != nil {
			return nil, e
		}
		var s struct {
			Stat []struct {
				Name  string      `json:"name"`
				Value json.Number `json:"value"`
			} `json:"stat"`
		}
		if e = json.Unmarshal(b, &s); e != nil {
			return nil, e
		}
		for _, v := range s.Stat {
			// Protobuf JSON omits the default zero value on detail metadata.
			var n int64
			var e error
			if v.Value != "" {
				n, e = v.Value.Int64()
			}
			if e != nil {
				return nil, e
			}
			out[v.Name] = n
		}
	}
	return out, nil
}

// PacketConn wrapper records encrypted application QUIC packets, never carrier
// packets. Rebinding replaces only the authenticated proxy UDP association.
type observedConn struct {
	net.PacketConn
	mu             sync.Mutex
	dial           func() (net.PacketConn, error)
	target         net.Addr
	delay          time.Duration
	closed         bool
	sent, up, down atomic.Int64
	sniff          []string
	initial        []byte
}

func (p *observedConn) current() net.PacketConn {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.PacketConn
}
func (p *observedConn) WriteTo(b []byte, a net.Addr) (int, error) {
	i := p.sent.Add(1)
	if i == 2 && p.delay > 0 {
		time.Sleep(p.delay)
	}
	if i <= 6 {
		p.mu.Lock()
		one, e := quicsniff.SniffQUIC(bytes.Clone(b))
		text := fmt.Sprintf("packet=%d bytes=%d sha256=%x result=%v", i, len(b), sha256.Sum256(b), e)
		if e == nil {
			text += " domain=" + one.Domain()
		}
		p.initial = append(p.initial, b...)
		joined, e := quicsniff.SniffQUIC(bytes.Clone(p.initial))
		text += fmt.Sprintf(" cumulative=%v", e)
		if e == nil {
			text += " domain=" + joined.Domain()
		}
		p.sniff = append(p.sniff, text)
		p.mu.Unlock()
	}
	n, e := p.current().WriteTo(b, a)
	p.up.Add(int64(n))
	return n, e
}

// Capture at most six datagrams before handing them to the real QUIC server.
// Hashes distinguish attribution limitations from actual payload corruption.
type receivedTrace struct {
	net.PacketConn
	mu      sync.Mutex
	packets []string
}

func (p *receivedTrace) ReadFrom(b []byte) (int, net.Addr, error) {
	n, a, e := p.PacketConn.ReadFrom(b)
	if e == nil {
		p.mu.Lock()
		if len(p.packets) < 6 {
			h, err := quicsniff.SniffQUIC(bytes.Clone(b[:n]))
			entry := fmt.Sprintf("bytes=%d sha256=%x prefix=%x result=%v", n, sha256.Sum256(b[:n]), b[:min(n, 16)], err)
			if err == nil {
				entry += " domain=" + h.Domain()
			}
			p.packets = append(p.packets, entry)
		}
		p.mu.Unlock()
	}
	return n, a, e
}
func (p *observedConn) ReadFrom(b []byte) (int, net.Addr, error) {
	for {
		c := p.current()
		n, a, e := c.ReadFrom(b)
		if e != nil {
			p.mu.Lock()
			changed := c != p.PacketConn && !p.closed
			p.mu.Unlock()
			if changed {
				continue
			}
		}
		p.down.Add(int64(n))
		return n, a, e
	}
}
func (p *observedConn) rebind() error {
	c, e := p.dial()
	if e != nil {
		return e
	}
	p.mu.Lock()
	old := p.PacketConn
	p.PacketConn = c
	p.mu.Unlock()
	return old.Close()
}
func (p *observedConn) Close() error {
	p.mu.Lock()
	p.closed = true
	c := p.PacketConn
	p.mu.Unlock()
	return c.Close()
}

type vlessConn struct {
	net.Conn
	target     *net.UDPAddr
	readHeader bool
	writeMu    sync.Mutex
}

func dialVLESS(port int, target *net.UDPAddr) (net.PacketConn, error) {
	c, e := net.DialTimeout("tcp", endpoint(port), time.Second)
	if e != nil {
		return nil, e
	}
	// VLESS v0, fixed test identity, no addons, UDP command, IP target.
	header := []byte{0, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x41, 0x11, 0x81, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0, 2, byte(target.Port >> 8), byte(target.Port), 1, 127, 0, 0, 1}
	if _, e = c.Write(header); e != nil {
		c.Close()
		return nil, e
	}
	return &vlessConn{Conn: c, target: target}, nil
}
func (c *vlessConn) ReadFrom(b []byte) (int, net.Addr, error) {
	if !c.readHeader {
		var h [2]byte
		if _, e := io.ReadFull(c.Conn, h[:]); e != nil {
			return 0, nil, e
		}
		if h[0] != 0 {
			return 0, nil, fmt.Errorf("VLESS version")
		}
		if _, e := io.CopyN(io.Discard, c.Conn, int64(h[1])); e != nil {
			return 0, nil, e
		}
		c.readHeader = true
	}
	var h [2]byte
	if _, e := io.ReadFull(c.Conn, h[:]); e != nil {
		return 0, nil, e
	}
	n := int(binary.BigEndian.Uint16(h[:]))
	if n > len(b) {
		return 0, nil, io.ErrShortBuffer
	}
	n, e := io.ReadFull(c.Conn, b[:n])
	return n, c.target, e
}
func (c *vlessConn) WriteTo(b []byte, _ net.Addr) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if len(b) > 65535 {
		return 0, io.ErrShortBuffer
	}
	packet := make([]byte, len(b)+2)
	binary.BigEndian.PutUint16(packet, uint16(len(b)))
	copy(packet[2:], b)
	_, e := io.Copy(c.Conn, bytes.NewReader(packet))
	if e != nil {
		return 0, e
	}
	return len(b), nil
}
func (c *vlessConn) LocalAddr() net.Addr {
	return &net.UDPAddr{IP: net.ParseIP("127.0.0.1"), Port: c.Conn.LocalAddr().(*net.TCPAddr).Port}
}

type socksConn struct {
	*net.UDPConn
	control net.Conn
	relay   *net.UDPAddr
	target  *net.UDPAddr
}

func dialSOCKS(port int, target *net.UDPAddr) (net.PacketConn, error) {
	c, e := net.DialTimeout("tcp", endpoint(port), time.Second)
	if e != nil {
		return nil, e
	}
	ok := false
	defer func() {
		if !ok {
			c.Close()
		}
	}()
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	if _, e = c.Write([]byte{5, 1, 0}); e != nil {
		return nil, e
	}
	var greeting [2]byte
	if _, e = io.ReadFull(c, greeting[:]); e != nil {
		return nil, e
	}
	if greeting != [2]byte{5, 0} {
		return nil, fmt.Errorf("SOCKS authentication")
	}
	if _, e = c.Write([]byte{5, 3, 0, 1, 0, 0, 0, 0, 0, 0}); e != nil {
		return nil, e
	}
	var reply [10]byte
	if _, e = io.ReadFull(c, reply[:]); e != nil {
		return nil, e
	}
	if reply[1] != 0 || reply[3] != 1 {
		return nil, fmt.Errorf("SOCKS associate: %x", reply)
	}
	u, e := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if e != nil {
		return nil, e
	}
	_ = c.SetDeadline(time.Time{})
	ok = true
	return &socksConn{UDPConn: u, control: c, relay: &net.UDPAddr{IP: net.IPv4(reply[4], reply[5], reply[6], reply[7]), Port: int(binary.BigEndian.Uint16(reply[8:]))}, target: target}, nil
}
func (c *socksConn) WriteTo(b []byte, _ net.Addr) (int, error) {
	packet := make([]byte, len(b)+10)
	copy(packet, []byte{0, 0, 0, 1, 127, 0, 0, 1, byte(c.target.Port >> 8), byte(c.target.Port)})
	copy(packet[10:], b)
	_, e := c.UDPConn.WriteToUDP(packet, c.relay)
	if e != nil {
		return 0, e
	}
	return len(b), nil
}
func (c *socksConn) ReadFrom(b []byte) (int, net.Addr, error) {
	packet := make([]byte, 65535)
	n, _, e := c.UDPConn.ReadFromUDP(packet)
	if e != nil {
		return 0, nil, e
	}
	if n < 10 || packet[3] != 1 {
		return 0, nil, fmt.Errorf("SOCKS UDP header")
	}
	if n-10 > len(b) {
		return 0, nil, io.ErrShortBuffer
	}
	return copy(b, packet[10:n]), c.target, nil
}
func (c *socksConn) Close() error { _ = c.control.Close(); return c.UDPConn.Close() }
