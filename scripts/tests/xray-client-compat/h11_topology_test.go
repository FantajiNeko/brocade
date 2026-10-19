package handofflab

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"time"
)

func h11Config(h *h7Run, role, file string) {
	h.result["configs"] = append(h.result["configs"].([]object), object{"role": role, "path": file, "sha256": fileDigest(h.t, file)})
}
func h11TLS(h *h7Run, server bool) object {
	if server {
		return object{"alpn": []string{"http/1.1"}, "minVersion": "1.3", "maxVersion": "1.3", "certificates": []any{object{"certificateFile": h.f.certPath, "keyFile": h.f.keyPath}}}
	}
	return object{"serverName": "local-cover.test", "alpn": []string{"http/1.1"}, "minVersion": "1.3", "maxVersion": "1.3", "allowInsecure": false, "certificates": []any{object{"certificateFile": h.f.certPath, "usage": "verify"}}}
}
func h11Stream(h *h7Run, server bool, cover int) object {
	if os.Getenv("H11_TRANSPORT") == "tls-vision" {
		return object{"network": "tcp", "security": "tls", "tlsSettings": h11TLS(h, server)}
	}
	settings := object{"serverName": "local-cover.test", "fingerprint": "chrome", "publicKey": h.f.publicKey, "shortId": "0123456789abcdef"}
	if server {
		settings = object{"dest": fmt.Sprintf("127.0.0.1:%d", cover), "serverNames": []string{"local-cover.test"}, "privateKey": h.f.privateKey, "shortIds": []string{"0123456789abcdef"}}
	}
	return object{"network": "tcp", "security": "reality", "realitySettings": settings}
}
func h11VLESSOut(h *h7Run, tag, address string, port int) object {
	return object{"tag": tag, "protocol": "vless", "settings": object{"vnext": []any{object{"address": address, "port": port, "users": []any{object{"id": h.f.uuid, "encryption": "none", "flow": "xtls-rprx-vision"}}}}}, "streamSettings": h11Stream(h, false, 0)}
}
func (h *h7Run) bConfig(g *generation, cover, route int) object {
	c := h.h11LegacyBConfig(g, cover, route)
	ins := []any{}
	for _, raw := range c["inbounds"].([]any) {
		in := raw.(object)
		if in["tag"] == "cover" && os.Getenv("H11_TRANSPORT") == "tls-vision" {
			continue
		}
		if in["tag"] == "vision" {
			in["streamSettings"] = h11Stream(h, true, cover)
		}
		ins = append(ins, in)
	}
	c["inbounds"] = ins
	return c
}
func (h *h7Run) h11Launch(name, binary, kind, role string, config object, readyPorts []int) {
	h.t.Helper()
	file := filepath.Join(h.f.dir, name+".json")
	writeJSON(h.t, file, config)
	h11Config(h, name, file)
	args := []string{"run", "-config", file}
	switch kind {
	case "sing-box":
		args = []string{"run", "-c", file}
	case "mihomo":
		state := filepath.Join(h.f.dir, "mihomo-state")
		if e := os.Mkdir(state, 0700); e != nil {
			h.t.Fatal(e)
		}
		args = []string{"-d", state, "-f", file}
	}
	cmd := h9Command(role, binary, args...)
	cmd.Env = append(labCleanEnv(), "xray.buf.splice=auto", "SSL_CERT_FILE="+h.f.certPath)
	h.f.startProcess(cmd, filepath.Join(h.f.dir, name+".log"))
	until := time.Now().Add(15 * time.Second)
	for time.Now().Before(until) {
		all := true
		for _, p := range readyPorts {
			address := "127.0.0.1"
			if role == "forward" {
				address = h9ForwardAddress()
			}
			c, e := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", address, p), 100*time.Millisecond)
			if e != nil {
				all = false
				break
			}
			c.Close()
		}
		if all {
			h.verifyNode(cmd, binary, role)
			h.event(name+"-ready", object{"pid": cmd.Process.Pid, "binary_sha256": fileDigest(h.t, binary), "config_path": file, "config_sha256": fileDigest(h.t, file), "netns_role": role, "kind": kind})
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	h.t.Fatalf("%s %s startup failed; see %s.log", name, kind, filepath.Join(h.f.dir, name))
}
func (h *h7Run) startChain() {
	cover := h.port()
	relay := object{"tag": "from-client", "listen": h9ForwardAddress(), "port": h.relay, "protocol": "vless", "settings": object{"decryption": "none", "clients": []any{object{"id": h.f.uuid, "email": userEmail, "flow": "xtls-rprx-vision", "level": 0}}}, "streamSettings": h11Stream(h, true, cover)}
	coverIn := object{"tag": "cover", "listen": "127.0.0.1", "port": cover, "protocol": "dokodemo-door", "settings": object{"address": "127.0.0.1", "port": 1, "network": "tcp"}, "streamSettings": object{"network": "tcp", "security": "tls", "tlsSettings": h11TLS(h, true)}}
	configA := object{"log": object{"loglevel": "warning"}, "stats": object{}, "policy": object{"levels": object{"0": object{"statsUserUplink": true, "statsUserDownlink": true, "connIdle": 300}}}, "inbounds": []any{relay, coverIn}, "outbounds": []any{h11VLESSOut(h, "to-B", h7AccessAddress, h.reality), object{"tag": "cover-response", "protocol": "blackhole", "settings": object{"response": object{"type": "http"}}}}, "routing": object{"rules": []any{object{"type": "field", "inboundTag": []string{"cover"}, "outboundTag": "cover-response"}, object{"type": "field", "inboundTag": []string{"from-client"}, "outboundTag": "to-B"}}}}
	h.h11Launch("fixed-A", os.Getenv("H11_A_BIN"), "xray", "forward", configA, []int{h.relay})
	kind := os.Getenv("H11_CLIENT_KIND")
	entries := []struct {
		tag, address  string
		remote, local int
	}{{"direct", h7AccessAddress, h.reality, h.direct}, {"via-A", h9ForwardAddress(), h.relay, h.viaA}}
	ins, outs, rules := []any{}, []any{}, []any{}
	var config object
	for _, entry := range entries {
		switch kind {
		case "xray":
			ins = append(ins, object{"tag": entry.tag, "listen": "127.0.0.1", "port": entry.local, "protocol": "socks", "settings": object{"auth": "noauth", "udp": false}})
			outs = append(outs, h11VLESSOut(h, entry.tag, entry.address, entry.remote))
			rules = append(rules, object{"type": "field", "inboundTag": []string{entry.tag}, "outboundTag": entry.tag})
		case "sing-box":
			ins = append(ins, object{"type": "socks", "tag": entry.tag, "listen": "127.0.0.1", "listen_port": entry.local})
			tls := object{"enabled": true, "server_name": "local-cover.test", "insecure": false, "alpn": []string{"http/1.1"}, "min_version": "1.3", "max_version": "1.3"}
			if os.Getenv("H11_TRANSPORT") == "reality-vision" {
				tls["utls"] = object{"enabled": true, "fingerprint": "chrome"}
				tls["reality"] = object{"enabled": true, "public_key": h.f.publicKey, "short_id": "0123456789abcdef"}
			} else {
				tls["certificate_path"] = h.f.certPath
			}
			outs = append(outs, object{"type": "vless", "tag": entry.tag, "server": entry.address, "server_port": entry.remote, "uuid": h.f.uuid, "flow": "xtls-rprx-vision", "network": "tcp", "tls": tls})
			rules = append(rules, object{"inbound": []string{entry.tag}, "outbound": entry.tag})
		case "mihomo":
			ins = append(ins, object{"name": entry.tag, "type": "socks", "listen": "127.0.0.1", "port": entry.local, "udp": false, "proxy": entry.tag})
			out := object{"name": entry.tag, "type": "vless", "server": entry.address, "port": entry.remote, "uuid": h.f.uuid, "flow": "xtls-rprx-vision", "network": "tcp", "tls": true, "servername": "local-cover.test", "alpn": []string{"http/1.1"}, "client-fingerprint": "chrome", "skip-cert-verify": false, "udp": false}
			if os.Getenv("H11_TRANSPORT") == "reality-vision" {
				out["reality-opts"] = object{"public-key": h.f.publicKey, "short-id": "0123456789abcdef"}
			} else {
				data, e := os.ReadFile(h.f.certPath)
				if e != nil {
					h.t.Fatal(e)
				}
				block, _ := pem.Decode(data)
				if block == nil {
					h.t.Fatal("certificate PEM")
				}
				sum := sha256.Sum256(block.Bytes)
				out["fingerprint"] = hex.EncodeToString(sum[:])
			}
			outs = append(outs, out)
		default:
			h.t.Fatal("unsupported third-party client kind")
		}
	}
	switch kind {
	case "xray":
		config = object{"log": object{"loglevel": "warning"}, "inbounds": ins, "outbounds": outs, "routing": object{"rules": rules}}
	case "sing-box":
		config = object{"log": object{"level": "warn"}, "inbounds": ins, "outbounds": outs, "route": object{"rules": rules}}
	case "mihomo":
		config = object{"log-level": "warning", "mode": "rule", "ipv6": false, "allow-lan": false, "listeners": ins, "proxies": outs, "rules": []string{"MATCH,direct"}, "dns": object{"enable": false}, "profile": object{"store-selected": false, "store-fake-ip": false}}
	}
	h.h11Launch("fixed-client", os.Getenv("H11_CLIENT_BIN"), kind, "client", config, []int{h.direct, h.viaA})
}

// SOCKS negotiation occurs on the original TCP object: TLS.NetConn stays a
// *net.TCPConn, so a later CloseWrite really sends TCP FIN to the unmodified client.
func h11DialSOCKS(port int) (net.Conn, error) {
	c, e := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 3*time.Second)
	if e != nil {
		return nil, e
	}
	fail := func(err error) (net.Conn, error) { c.Close(); return nil, err }
	c.SetDeadline(time.Now().Add(10 * time.Second))
	if _, e = c.Write([]byte{5, 1, 0}); e != nil {
		return fail(e)
	}
	answer := make([]byte, 2)
	if _, e = io.ReadFull(c, answer); e != nil {
		return fail(e)
	}
	if answer[0] != 5 || answer[1] != 0 {
		return fail(fmt.Errorf("SOCKS authentication rejected %v", answer))
	}
	if _, e = c.Write([]byte{5, 1, 0, 1, 127, 0, 0, 1, 1, 187}); e != nil {
		return fail(e)
	}
	header := make([]byte, 4)
	if _, e = io.ReadFull(c, header); e != nil {
		return fail(e)
	}
	if header[0] != 5 || header[1] != 0 {
		return fail(fmt.Errorf("SOCKS connect rejected %v", header))
	}
	size := 0
	switch header[3] {
	case 1:
		size = 4
	case 4:
		size = 16
	case 3:
		b := []byte{0}
		if _, e = io.ReadFull(c, b); e != nil {
			return fail(e)
		}
		size = int(b[0])
	default:
		return fail(fmt.Errorf("invalid SOCKS address type"))
	}
	if _, e = io.CopyN(io.Discard, c, int64(size+2)); e != nil {
		return fail(e)
	}
	c.SetDeadline(time.Time{})
	return c, nil
}
