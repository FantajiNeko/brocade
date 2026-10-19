package handofflab

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestH11ClientCompatibility(t *testing.T) {
	if os.Getenv("XRAY_H9_RUN") != "1" {
		t.Skip("explicit isolated H11 run required")
	}
	client, relay, oldBin, newBin := os.Getenv("H11_CLIENT_BIN"), os.Getenv("H11_A_BIN"), os.Getenv("H11_OLD_BIN"), os.Getenv("H11_NEW_BIN")
	for _, bin := range []string{client, relay, oldBin, newBin} {
		if bin == "" {
			t.Fatal("four explicit binary roles required")
		}
	}
	kind, transport, path, scene := os.Getenv("H11_CLIENT_KIND"), os.Getenv("H11_TRANSPORT"), os.Getenv("H11_PATH"), os.Getenv("H11_SCENE")
	if kind != "xray" && kind != "sing-box" && kind != "mihomo" {
		t.Fatal("unknown client kind")
	}
	if transport != "tls-vision" && transport != "reality-vision" {
		t.Fatal("unknown outer transport")
	}
	if path != "direct" && path != "via-A" {
		t.Fatal("explicit single path required")
	}
	if scene != "halfclose" && scene != "soak" && scene != "lifecycle" && scene != "idle" && scene != "slow" {
		t.Fatal("unknown scene")
	}
	concurrency, duration, pace := h11EnvInt("H11_CONCURRENCY", 1), h11EnvInt("H11_DURATION_MS", 3000), h11EnvInt("H11_FRAME_INTERVAL_MS", 30)
	if concurrency != 1 && concurrency != 32 && concurrency != 128 {
		t.Fatal("concurrency must be 1,32,128")
	}
	if duration < 1000 || duration > 1800000 || pace < 10 || pace > 500 {
		t.Fatal("duration or pacing outside bounded test range")
	}
	if scene == "slow" && (duration > 10000 || h11EnvInt("H11_READ_DELAY_MS", 100) < 20 || h11EnvInt("H11_READ_DELAY_MS", 100) > 200) {
		t.Fatal("slow-reader requires duration <=10000ms and read delay 20..200ms")
	}
	if scene == "idle" && os.Getenv("H11_IDLE_MODE") != "resume" && os.Getenv("H11_IDLE_MODE") != "halfclosed" {
		t.Fatal("explicit idle-resume or halfclosed required")
	}
	direction, half := os.Getenv("H11_DIRECTION"), os.Getenv("H11_HALF_CLOSE")
	if direction != "download" && direction != "upload" {
		t.Fatal("direction required")
	}
	if half != "tls-only" && half != "tls-and-tcp" {
		t.Fatal("half-close transport required")
	}
	t.Setenv("H9_HALF_CLOSE", half)
	t.Setenv("H9_NEGATIVE", "")
	t.Setenv("XRAY_LAB_CLIENT_BIN", relay)
	early := scene == "halfclose" || (scene == "idle" && os.Getenv("H11_IDLE_MODE") == "halfclosed")
	if early {
		t.Setenv("H9_BOUNDARY", "h11-early")
	} else {
		t.Setenv("H9_BOUNDARY", "")
	}
	root := os.Getenv("H11_RESULT_DIR")
	if root == "" {
		t.Fatal("fresh result root required")
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
	h := &h9Run{requests: []h7Request{}, flows: []*h9Flow{}, pauseRequests: []object{}, checkpoints: []object{}}
	b := &h7Run{t: t, f: f, start: time.Now(), ports: map[int]bool{}, frameInterval: time.Duration(pace) * time.Millisecond, binaries: map[string]string{}, h9: h, result: object{"schema_version": 11, "run_id": filepath.Base(dir), "events": []object{}, "errors": []string{}, "configs": []object{}, "progress_buckets": []object{}, "progress_flow_ids": []string{}, "client_kind": kind, "transport": transport, "path": path, "scene": scene, "concurrency": concurrency, "duration_ms": duration, "frame_interval_ms": pace, "direction": direction, "half_close_transport": half, "timeout_policy_seconds": object{"server_conn_idle": 300, "server_uplink_only": 1, "server_downlink_only": 1, "A_conn_idle": 300, "A_uplink_only": 1, "A_downlink_only": 1}, "client_timeout_policy": "unmodified client defaults", "idle_ms": h11EnvInt("H11_IDLE_MS", 3000), "idle_mode": os.Getenv("H11_IDLE_MODE"), "read_delay_ms": h11EnvInt("H11_READ_DELAY_MS", 100)}}
	h.base = b
	h9Current = h
	h11IdleGate = nil
	h11GateBlocked = map[string]bool{}
	h11InitialClose = nil
	h11SlowReleased.Store(false)
	if scene == "idle" && early {
		h11InitialClose = make(chan struct{})
	}
	if scene == "slow" {
		b.result["slow_reader_only"] = false
		b.result["slow_backpressure_requested"] = true
	}
	hashes := object{"b0": fileDigest(t, oldBin), "b1": fileDigest(t, newBin), "b2": fileDigest(t, newBin), "A": fileDigest(t, relay), "client": fileDigest(t, client)}
	b.result["binary_sha256"] = hashes
	t.Cleanup(func() {
		deadline := time.After(3 * time.Second)
		for _, flow := range h.flows {
			for _, done := range []chan struct{}{flow.clientFinished, flow.originFinished} {
				select {
				case <-done:
				case <-deadline:
					t.Errorf("worker cleanup timeout %s", flow.ID)
					deadline = time.After(time.Millisecond)
				}
			}
		}
		failures := 0
		operation, _ := b.result["first_operation"].(string)
		phaseByEvent := map[string]string{"baseline-begin": "baseline", operation + "-begin": operation, operation + "-committed": operation + "-post", "routing-update-begin": "routing-update", "routing-update-committed": "routing-update-post", "retirement-begin": "retirement"}
		for i := range h.requests {
			q := &h.requests[i]
			for _, event := range b.result["events"].([]object) {
				if event["at_us"].(int64) > q.DispatchUS {
					break
				}
				if phase, ok := phaseByEvent[event["name"].(string)]; ok {
					q.Phase = phase
				}
			}
		}
		streamErrors := []string{}
		for _, q := range h.requests {
			if q.Error != "" {
				failures++
			}
		}
		for _, flow := range h.flows {
			if flow.Error != "" {
				streamErrors = append(streamErrors, flow.ID+": "+flow.Error)
			}
		}
		b.result["test_failed"], b.result["new_request_failures"], b.result["stream_errors"] = t.Failed(), failures, streamErrors
		b.result["application_reconnects"] = 0
		b.result["flows"] = h.flows
		b.result["requests"] = h.requests
		b.result["pause_requests"] = h.pauseRequests
		b.result["checkpoints"] = h.checkpoints
		b.result["processes"] = h.processes
		writeJSON(t, filepath.Join(dir, "result.json"), b.result)
		t.Logf("H11_RESULT %s", filepath.Join(dir, "result.json"))
		h9Current = nil
		h11IdleGate = nil
		h11InitialClose = nil
	})
	b.phase.Store("setup")
	b.origins = []*h7Origin{b.startOrigin("origin-1"), b.startOrigin("origin-2")}
	b.plain, b.reality, b.relay, b.viaA, b.direct = b.port(), b.port(), b.port(), b.port(), b.port()
	b0 := b.startB("b0", oldBin, 1, nil)
	b.startChain()
	add := func(generation string, count int, marker string) {
		for i := 0; i < count; i++ {
			mode, completion := direction, "server-ended"
			if !early && scene != "idle" && scene != "slow" {
				mode = []string{"download", "upload", "duplex"}[i%3]
				if count == 1 {
					mode = "duplex"
				}
				completion = "client-half-close"
				if mode == "download" || (mode == "duplex" && i%2 == 0) {
					completion = "server-ended"
				}
			}
			h.startFlow(fmt.Sprintf("%s-%s-%d", generation, path, i), path, generation, mode, completion, marker)
		}
	}
	if scene != "lifecycle" {
		ids := []string{}
		for i := 0; i < concurrency; i++ {
			ids = append(ids, fmt.Sprintf("b0-%s-%d", path, i))
		}
		b.result["progress_flow_ids"] = ids
		b.result["progress_buckets"] = []object{{"at_us": time.Since(b.start).Microseconds(), "partial": true, "counts": make([][2]uint64, concurrency)}}
	}
	add("b0", concurrency, "origin-1")
	if scene == "idle" {
		h.advance(h.flows, 3)
		h11RunIdle(h, early)
		if early {
			b.result["b0_stats"] = b.queryStats(b0)
			b.event("measurement-end", nil)
			for _, name := range []string{"b0", "fixed-A", "fixed-client"} {
				h.terminate(name)
			}
			return
		}
	}
	h.advance(h.flows, 3)
	b.phase.Store("baseline")
	b.event("baseline-begin", nil)
	h.checkpoint("baseline", h.flows)
	if scene == "lifecycle" {
		h11Lifecycle(h, b0, newBin, add)
	} else {
		b.result["progress_begin_us"] = time.Since(b.start).Microseconds()
		h11Progress(h, h.flows, true)
		until := time.Now().Add(time.Duration(duration+pace) * time.Millisecond)
		next := time.Now().Add(time.Second)
		for time.Now().Before(until) {
			for _, flow := range h.flows {
				flow.mu.Lock()
				err := flow.Error
				flow.mu.Unlock()
				if err != "" {
					t.Fatalf("persistent flow %s: %s", flow.ID, err)
				}
			}
			if !time.Now().Before(next) {
				h11Progress(h, h.flows, false)
				b.phase.Store("active")
				q := b.request(path, "origin-1", time.Now())
				h.requests = append(h.requests, q)
				if q.Error != "" {
					t.Fatal(q.Error)
				}
				next = next.Add(time.Second)
			}
			time.Sleep(10 * time.Millisecond)
		}
		b.result["progress_end_us"] = time.Since(b.start).Microseconds()
		h11Progress(h, h.flows, true)
		h11ReleaseSlow(h)
		h.finish(h.flows)
		h11Progress(h, h.flows, true)
		b.result["b0_stats"] = b.queryStats(b0)
		b.event("measurement-end", nil)
		h.terminate("b0")
	}
	h.terminate("fixed-A")
	h.terminate("fixed-client")
	for role, bin := range map[string]string{"b0": oldBin, "b1": newBin, "A": relay, "client": client} {
		if fileDigest(t, bin) != hashes[role] {
			t.Fatal("binary mutated during run: " + role)
		}
	}
}

func h11RunIdle(h *h9Run, early bool) {
	b := h.base
	idle := h11EnvInt("H11_IDLE_MS", 3000)
	if idle < 1200 || idle > 10000 {
		b.t.Fatal("idle duration must be 1200..10000ms")
	}
	b.event("idle-begin", nil)
	h11PauseWriters(h)
	h.checkpoint("idle-pause", h.flows)
	b.event("idle-window-begin", nil)
	if !early {
		time.Sleep(time.Duration(idle) * time.Millisecond)
		h.checkpoint("idle-before-resume", h.flows)
		b.event("idle-resumed", nil)
		h11ResumeWriters()
		return
	}
	close(h11InitialClose)
	observations := []object{}
	for _, f := range h.flows {
		reader := "client-reader"
		if f.Mode == "upload" {
			reader = "origin-reader"
		}
		deadline := time.Now().Add(time.Duration(idle) * time.Millisecond)
		observed := false
		for time.Now().Before(deadline) {
			f.mu.Lock()
			for _, worker := range f.Workers {
				if worker.Name == reader && worker.Error != "" {
					observations = append(observations, object{"id": f.ID, "at_us": worker.AtUS, "reader": reader, "error": worker.Error})
					observed = true
				}
			}
			f.mu.Unlock()
			if observed {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if !observed {
			b.t.Fatal("halfclosed idle did not expire within observation window")
		}
	}
	h.checkpoint("idle-expired-counts", h.flows)
	for _, f := range h.flows {
		f.abortOnce.Do(func() { close(f.abort) })
	}
	h11ResumeWriters()
	for _, f := range h.flows {
		for _, done := range []chan error{f.done, f.originDone} {
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				b.t.Fatal("idle endpoint did not join")
			}
		}
	}
	b.result["idle_observations"] = observations
	b.event("idle-expired", nil)
	b.result["idle_expiry_observed"] = true
}

func h11Lifecycle(h *h9Run, b0 *generation, newBin string, add func(string, int, string)) {
	b := h.base
	// Persistent requested concurrency is the original generation. Candidates
	// add three explicit canaries each; peak is recorded rather than concealed.
	b.result["lifecycle_peak_persistent_flows"] = h11EnvInt("H11_CONCURRENCY", 1) + 6
	stop := h.startRequests()
	defer stop()
	time.Sleep(time.Second)
	b1 := b.startB("b1", newBin, 1, b0)
	operation := "same-binary-control"
	if b.binaries["b0"] != newBin && fileDigest(b.t, b.binaries["b0"]) != fileDigest(b.t, newBin) {
		operation = "binary-upgrade"
	}
	b.result["first_operation"] = operation
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
	b.event("retirement-begin", nil)
	h.finish(h.selectFlows("b0"))
	b.result["b0_stats"] = b.queryStats(b0)
	h.checkpoint("before-b0-retire", h.selectFlows("b2"))
	h.retire(b0, 3)
	h.checkpoint("after-b0-exit", h.selectFlows("b2"))
	h.advance(h.selectFlows("b2"), 3)
	h.checkpoint("after-b0-retire", h.selectFlows("b2"))
	h.finish(h.selectFlows("b1"))
	b.result["b1_stats"] = b.queryStats(b1)
	h.checkpoint("before-b1-retire", h.selectFlows("b2"))
	h.retire(b1, 4)
	h.checkpoint("after-b1-exit", h.selectFlows("b2"))
	h.advance(h.selectFlows("b2"), 3)
	h.checkpoint("after-b1-retire", h.selectFlows("b2"))
	time.Sleep(time.Second)
	stop()
	h.finish(h.selectFlows("b2"))
	b.result["b2_stats"] = b.queryStats(b2)
	b.event("measurement-end", nil)
	h.terminate("b2")
}
