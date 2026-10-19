// Linux loopback benchmark. Driver, target and client are separate processes on
// disjoint CPUs. Only the fixed-category policy differs between paired runs.
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type sample struct {
	Profile          string             `json:"profile"`
	Direction        string             `json:"direction"`
	Enabled          bool               `json:"enabled"`
	Repeat           int                `json:"repeat"`
	Bytes            int64              `json:"delivered_bytes"`
	Seconds          float64            `json:"seconds"`
	Gbps             float64            `json:"gbps"`
	CPUPercent       float64            `json:"xray_cpu_percent"`
	CPUMsPerGiB      float64            `json:"xray_cpu_ms_per_gib"`
	RSSKiB           int64              `json:"xray_rss_peak_kib"`
	ClientCPUPercent float64            `json:"client_cpu_percent"`
	TargetCPUPercent float64            `json:"target_cpu_percent"`
	CoreBusy         map[string]float64 `json:"core_busy_percent"`
	SiteBytes        int64              `json:"site_bytes"`
	Dimension        string             `json:"dimension"`
	Errors           []string           `json:"errors,omitempty"`
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "_target" {
		target()
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "_client" {
		client()
		return
	}
	xray := flag.String("xray", "/tmp/brocade-site-usage-xray", "newly built Xray")
	seconds := flag.Int("seconds", 8, "steady-state seconds after two-second warmup")
	conns := flag.Int("connections", 32, "parallel connections using one authenticated user")
	repeats := flag.Int("repeats", 3, "paired repetitions; alternating off/on order")
	filter := flag.String("profiles", "p1,e1,p4,e4", "comma-separated CPU profiles")
	otherDomains := flag.Bool("other-domains", false, "measure other domains with fixed categories disabled")
	failedTargets := flag.Bool("failed-targets", false, "measure failed-sniff IP targets with other dimensions disabled")
	flag.Parse()
	if *seconds < 1 || *conns < 1 || *repeats < 1 || (*otherDomains && *failedTargets) {
		panic("positive parameters required")
	}
	profiles := []struct {
		name, server, client, target string
		procs                        int
	}{
		{"p1", "4", "8,10", "12,14", 1}, {"e1", "16", "8,10", "12,14", 1},
		{"p4", "0,2,4,6", "8,10", "12,14", 4}, {"e4", "16,17,18,19", "0,2,4,6", "8,10,12,14", 4},
	}
	for _, p := range profiles {
		if !strings.Contains(","+*filter+",", ","+p.name+",") {
			continue
		}
		for _, direction := range []string{"download", "upload"} {
			for repeat := 0; repeat < *repeats; repeat++ {
				order := []bool{false, true}
				if repeat%2 == 1 {
					order = []bool{true, false}
				}
				for _, enabled := range order {
					result, err := run(*xray, p.name, p.server, p.client, p.target, p.procs, direction, enabled, repeat, *seconds, *conns, *otherDomains, *failedTargets)
					if err != nil {
						fmt.Fprintln(os.Stderr, err)
						os.Exit(1)
					}
					if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
						panic(err)
					}
				}
			}
		}
	}
}

func command(cpus string, procs int, binary string, args ...string) *exec.Cmd {
	c := exec.Command("taskset", append([]string{"-c", cpus, binary}, args...)...)
	c.Env = append(os.Environ(), fmt.Sprintf("GOMAXPROCS=%d", procs))
	return c
}
func stop(c *exec.Cmd) {
	if c != nil && c.Process != nil {
		_ = c.Process.Kill()
		_ = c.Wait()
	}
}
func freePort() int {
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		panic(e)
	}
	p := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	return p
}

func run(xray, profile, serverCPUs, clientCPUs, targetCPUs string, procs int, direction string, enabled bool, repeat, seconds, conns int, otherDomains, failedTargets bool) (sample, error) {
	dir, err := os.MkdirTemp("", "brocade-site-bench-")
	if err != nil {
		return sample{}, err
	}
	// Keep config, process log and journals as local reproducibility artifacts.
	exe, err := os.Executable()
	if err != nil {
		return sample{}, err
	}
	t := command(targetCPUs, 4, exe, "_target")
	t.Stderr = os.Stderr
	out, err := t.StdoutPipe()
	if err != nil {
		return sample{}, err
	}
	if err = t.Start(); err != nil {
		return sample{}, err
	}
	defer stop(t)
	addr, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		return sample{}, err
	}
	_, portString, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		return sample{}, err
	}
	port, err := strconv.Atoi(portString)
	if err != nil {
		return sample{}, err
	}
	entry, api := freePort(), freePort()
	config := map[string]any{
		"log": map[string]any{"loglevel": "warning"}, "stats": map[string]any{},
		"api":    map[string]any{"tag": "api", "services": []string{"StatsService"}},
		"policy": map[string]any{"levels": map[string]any{"0": map[string]any{"statsUserUplink": true, "statsUserDownlink": true}}},
		"inbounds": []any{
			map[string]any{"tag": "entry", "listen": "127.0.0.1", "port": entry, "protocol": "vless", "settings": map[string]any{"decryption": "none", "clients": []any{map[string]any{"id": "11111111-1111-4111-8111-111111111111", "email": "bench@root#entry"}}}, "sniffing": map[string]any{"enabled": true, "destOverride": []string{"http", "tls"}, "routeOnly": true}},
			map[string]any{"tag": "api", "listen": "127.0.0.1", "port": api, "protocol": "dokodemo-door", "settings": map[string]any{"address": "127.0.0.1"}},
		},
		"outbounds": []any{map[string]any{"protocol": "freedom", "tag": "direct", "settings": map[string]any{"ipsBlocked": []any{}}}},
		"routing":   map[string]any{"rules": []any{map[string]any{"type": "field", "inboundTag": []string{"api"}, "outboundTag": "api"}}},
	}
	data, _ := json.Marshal(config)
	if err = os.WriteFile(filepath.Join(dir, "xray.json"), data, 0600); err != nil {
		return sample{}, err
	}
	control := []byte("0\n")
	if enabled && !otherDomains && !failedTargets {
		control = []byte("1\n")
	}
	if err = os.WriteFile(filepath.Join(dir, "enabled"), control, 0600); err != nil {
		return sample{}, err
	}
	x := command(serverCPUs, procs, xray, "run", "-config", filepath.Join(dir, "xray.json"))
	x.Env = append(x.Env, "XRAY_BROCADE_ACCOUNTING_FILE="+filepath.Join(dir, "billing.bin"), "XRAY_BROCADE_SITE_ACCOUNTING_FILE="+filepath.Join(dir, "sites.bin"), "XRAY_BROCADE_SITE_USAGE_CONTROL_FILE="+filepath.Join(dir, "enabled"), "XRAY_BROCADE_ACCOUNTING_SHARED=owner")
	if otherDomains {
		policy, e := json.Marshal(map[string]any{"enabled": enabled, "top_n": 128, "max_domains_per_user": 1024, "node_capacity": 4096, "report_interval_secs": 30})
		if e != nil {
			return sample{}, e
		}
		path := filepath.Join(dir, "domain-policy.json")
		if e := os.WriteFile(path, policy, 0600); e != nil {
			return sample{}, e
		}
		x.Env = append(x.Env, "XRAY_BROCADE_OTHER_DOMAIN_CONTROL_FILE="+path)
	}
	if failedTargets {
		path := filepath.Join(dir, "failed-policy.json")
		policy, _ := json.Marshal(map[string]any{"enabled": enabled, "top_n": 128, "max_targets_per_user": 1024, "node_capacity": 4096, "report_interval_secs": 30})
		if err := os.WriteFile(path, policy, 0600); err != nil {
			return sample{}, err
		}
		x.Env = append(x.Env, "XRAY_BROCADE_SNIFFING_FAILED_CONTROL_FILE="+path)
	}
	log, err := os.Create(filepath.Join(dir, "xray.log"))
	if err != nil {
		return sample{}, err
	}
	defer log.Close()
	x.Stdout = log
	x.Stderr = log
	if err = x.Start(); err != nil {
		return sample{}, err
	}
	defer stop(x)
	deadline := time.Now().Add(5 * time.Second)
	for {
		conn, e := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", entry), 100*time.Millisecond)
		if e == nil {
			_ = conn.Close()
			break
		}
		if time.Now().After(deadline) {
			return sample{}, fmt.Errorf("Xray startup timeout; see %s", dir)
		}
		time.Sleep(20 * time.Millisecond)
	}
	c := command(clientCPUs, 4, exe, "_client", strconv.Itoa(entry), strconv.Itoa(port), direction, strconv.Itoa(seconds), strconv.Itoa(conns), strconv.Itoa(x.Process.Pid), strconv.Itoa(t.Process.Pid))
	if otherDomains {
		c.Env = append(c.Env, "BROCADE_BENCH_DOMAIN=video.benchmark.example")
	}
	if failedTargets {
		c.Env = append(c.Env, "BROCADE_BENCH_DOMAIN=127.0.0.1")
	}
	c.Stderr = os.Stderr
	result, err := c.Output()
	if err != nil {
		return sample{}, fmt.Errorf("client: %w (artifacts %s)", err, dir)
	}
	var s sample
	if err = json.Unmarshal(result, &s); err != nil {
		return sample{}, err
	}
	s.Profile = profile
	s.Direction = direction
	s.Enabled = enabled
	s.Repeat = repeat + 1
	s.Dimension = "fixed-site"
	pattern := "site>>>"
	if otherDomains {
		pattern = "otherdomain>>>"
		s.Dimension = "other-domain"
	}
	if failedTargets {
		pattern = "sniffingfailed>>>"
		s.Dimension = "sniffing-failed-target"
	}
	stats := command(clientCPUs, 1, xray, "api", "statsquery", fmt.Sprintf("--server=127.0.0.1:%d", api), "-pattern", pattern)
	response, err := stats.Output()
	if err != nil {
		return sample{}, fmt.Errorf("stats validation: %w", err)
	}
	var snapshot struct {
		Stat []struct {
			Name  string      `json:"name"`
			Value json.Number `json:"value"`
		} `json:"stat"`
	}
	if err = json.Unmarshal(response, &snapshot); err != nil {
		return sample{}, err
	}
	for _, v := range snapshot.Stat {
		if strings.Contains(v.Name, ">>>traffic>>>") || ((otherDomains || failedTargets) && strings.Contains(v.Name, ">>>bench@root#entry>>>")) {
			n, _ := v.Value.Int64()
			s.SiteBytes += n
		}
	}
	if (enabled && s.SiteBytes == 0) || (!enabled && s.SiteBytes != 0) {
		return sample{}, fmt.Errorf("policy validation failed: enabled=%v site_bytes=%d", enabled, s.SiteBytes)
	}
	fmt.Fprintf(os.Stderr, "%s %s on=%v repeat=%d: %.2f Gbps CPU %.1f%% %.1f ms/GiB; %s\n", profile, direction, enabled, repeat+1, s.Gbps, s.CPUPercent, s.CPUMsPerGiB, dir)
	return s, nil
}

func target() {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	fmt.Println(l.Addr())
	for {
		c, err := l.Accept()
		if err != nil {
			panic(err)
		}
		go serve(c)
	}
}
func serve(c net.Conn) {
	defer c.Close()
	r := bufio.NewReader(c)
	var direction string
	var start, end int64
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		if line == "\r\n" {
			break
		}
		if strings.HasPrefix(line, "X-Bench:") {
			_, _ = fmt.Sscanf(line, "X-Bench: %s %d %d", &direction, &start, &end)
		}
	}
	if start == 0 || end <= start {
		return
	}
	_ = c.SetDeadline(time.Unix(0, end).Add(5 * time.Second))
	buf := make([]byte, 64*1024)
	if direction == "download" {
		for {
			if _, err := c.Write(buf); err != nil {
				return
			}
		}
	}
	_ = c.SetReadDeadline(time.Unix(0, end))
	var count int64
	for {
		n, err := r.Read(buf)
		now := time.Now().UnixNano()
		if now >= start && now < end {
			count += int64(n)
		}
		if err != nil {
			break
		}
	}
	var ack [8]byte
	binary.BigEndian.PutUint64(ack[:], uint64(count))
	_, _ = c.Write(ack[:])
	// Do not depend on proxy half-close semantics or count sender-queued data.
	// A bounded post-window drain lets the delivered-byte acknowledgement arrive
	// before closing a TCP socket which may still have unread upload bytes.
	_ = c.SetReadDeadline(time.Unix(0, end).Add(2 * time.Second))
	_, _ = io.Copy(io.Discard, r)
}

func proc(pid int) (ticks, rss int64) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return
	}
	fields := strings.Fields(string(data)[strings.LastIndex(string(data), ")")+2:])
	u, _ := strconv.ParseInt(fields[11], 10, 64)
	s, _ := strconv.ParseInt(fields[12], 10, 64)
	pages, _ := strconv.ParseInt(fields[21], 10, 64)
	return u + s, pages * int64(os.Getpagesize()) / 1024
}
func cores() map[string][2]int64 {
	data, _ := os.ReadFile("/proc/stat")
	out := map[string][2]int64{}
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 9 || !strings.HasPrefix(f[0], "cpu") || f[0] == "cpu" {
			continue
		}
		var total, idle int64
		for i := 1; i <= 8; i++ {
			n, _ := strconv.ParseInt(f[i], 10, 64)
			total += n
			if i == 4 || i == 5 {
				idle += n
			}
		}
		out[f[0]] = [2]int64{total, idle}
	}
	return out
}
func client() {
	arg := os.Args[2:]
	entry, _ := strconv.Atoi(arg[0])
	port, _ := strconv.Atoi(arg[1])
	direction := arg[2]
	seconds, _ := strconv.Atoi(arg[3])
	conns, _ := strconv.Atoi(arg[4])
	xpid, _ := strconv.Atoi(arg[5])
	tpid, _ := strconv.Atoi(arg[6])
	start := time.Now().Add(2 * time.Second)
	end := start.Add(time.Duration(seconds) * time.Second)
	var bytes atomic.Int64
	var wg sync.WaitGroup
	var lock sync.Mutex
	var failures []string
	fail := func(err error) { lock.Lock(); failures = append(failures, err.Error()); lock.Unlock() }
	for i := 0; i < conns; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", entry), time.Second)
			if err != nil {
				fail(err)
				return
			}
			defer c.Close()
			_ = c.SetDeadline(end.Add(5 * time.Second))
			header := []byte{0, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x41, 0x11, 0x81, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0, 1, byte(port >> 8), byte(port), 1, 127, 0, 0, 1}
			host := os.Getenv("BROCADE_BENCH_DOMAIN")
			if host == "" {
				host = "www.youtube.com"
			}
			header = append(header, []byte(fmt.Sprintf("GET / HTTP/1.1\r\nHost: %s\r\nX-Bench: %s %d %d\r\n\r\n", host, direction, start.UnixNano(), end.UnixNano()))...)
			if _, err = c.Write(header); err != nil {
				fail(err)
				return
			}
			buf := make([]byte, 64*1024)
			if direction == "download" {
				if _, err = io.ReadFull(c, buf[:2]); err != nil {
					fail(err)
					return
				}
				_ = c.SetReadDeadline(end)
				for {
					n, e := c.Read(buf)
					now := time.Now()
					if !now.Before(start) && now.Before(end) {
						bytes.Add(int64(n))
					}
					if e != nil {
						if now.Before(end.Add(-time.Millisecond)) {
							fail(e)
						}
						return
					}
				}
			}
			_ = c.SetWriteDeadline(end)
			for {
				if _, err = c.Write(buf); err != nil {
					break
				}
			}
			if time.Now().Before(end.Add(-time.Millisecond)) {
				fail(fmt.Errorf("early upload termination: %w", err))
				return
			}
			var ack [10]byte
			if _, err = io.ReadFull(c, ack[:]); err != nil {
				fail(err)
				return
			}
			bytes.Add(int64(binary.BigEndian.Uint64(ack[2:])))
		}()
	}
	time.Sleep(time.Until(start))
	x0, _ := proc(xpid)
	c0, _ := proc(os.Getpid())
	t0, _ := proc(tpid)
	busy0 := cores()
	var peak int64
	for time.Now().Before(end) {
		_, rss := proc(xpid)
		if rss > peak {
			peak = rss
		}
		delay := min(100*time.Millisecond, time.Until(end))
		if delay > 0 {
			time.Sleep(delay)
		}
	}
	x1, _ := proc(xpid)
	c1, _ := proc(os.Getpid())
	t1, _ := proc(tpid)
	busy1 := cores()
	wg.Wait()
	// Linux USER_HZ is 100 on the measured x86_64 host (recorded by getconf).
	s := sample{Bytes: bytes.Load(), Seconds: float64(seconds), RSSKiB: peak, Errors: failures, CoreBusy: map[string]float64{}}
	s.Gbps = float64(s.Bytes) * 8 / s.Seconds / 1e9
	s.CPUPercent = float64(x1-x0) / s.Seconds
	s.ClientCPUPercent = float64(c1-c0) / s.Seconds
	s.TargetCPUPercent = float64(t1-t0) / s.Seconds
	if s.Bytes > 0 {
		s.CPUMsPerGiB = float64(x1-x0) * 10 / (float64(s.Bytes) / (1 << 30))
	}
	for cpu, a := range busy0 {
		b := busy1[cpu]
		if b[0] > a[0] {
			s.CoreBusy[cpu] = float64((b[0]-a[0])-(b[1]-a[1])) / float64(b[0]-a[0]) * 100
		}
	}
	if len(failures) > 0 {
		fmt.Fprintln(os.Stderr, failures)
		os.Exit(1)
	}
	_ = json.NewEncoder(os.Stdout).Encode(s)
}
