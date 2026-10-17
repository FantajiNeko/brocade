package splithttp_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/protocol/tls/cert"
	"github.com/xtls/xray-core/testing/servers/udp"
	"github.com/xtls/xray-core/transport/internet"
	. "github.com/xtls/xray-core/transport/internet/splithttp"
	"github.com/xtls/xray-core/transport/internet/stat"
	"github.com/xtls/xray-core/transport/internet/tls"
)

func TestHTTP3PacketUploadSurvivesConnectionRotation(t *testing.T) {
	certificate, hash := cert.MustGenerate(nil, cert.CommonName("localhost"))
	settings := &internet.MemoryStreamConfig{
		ProtocolName: "splithttp",
		ProtocolSettings: &Config{
			Path: "/rotate/", Mode: "packet-up",
			ScMaxEachPostBytes:   &RangeConfig{From: 32768, To: 32768},
			ScMinPostsIntervalMs: &RangeConfig{From: 1, To: 1},
			Xmux: &XmuxConfig{
				MaxConcurrency:   &RangeConfig{From: 1, To: 1},
				CMaxReuseTimes:   &RangeConfig{From: 2, To: 2},
				HMaxRequestTimes: &RangeConfig{From: 4, To: 4},
			},
		},
		SecurityType: "tls",
		SecuritySettings: &tls.Config{
			ServerName: "localhost", NextProtocol: []string{"h3"},
			Certificate:          []*tls.Certificate{tls.ParseCertificate(certificate)},
			PinnedPeerCertSha256: [][]byte{hash[:]},
		},
	}
	port := udp.PickPort()
	listener, err := ListenXH(context.Background(), net.LocalHostIP, port, settings, func(conn stat.Connection) {
		go func() { defer conn.Close(); io.Copy(conn, conn) }()
	})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	payload := bytes.Repeat([]byte("rotation payload"), 32769)
	failures := make(chan error, 3)
	var group sync.WaitGroup
	for range 3 {
		group.Add(1)
		go func() {
			defer group.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			conn, err := Dial(ctx, net.UDPDestination(net.LocalHostIP, port), settings)
			if err != nil {
				failures <- err
				return
			}
			defer conn.Close()
			stop := context.AfterFunc(ctx, func() { conn.Close() })
			defer stop()
			sent := make(chan error, 1)
			go func() { _, err := conn.Write(payload); sent <- err }()
			received := make([]byte, len(payload))
			if _, err := io.ReadFull(conn, received); err != nil {
				failures <- fmt.Errorf("rotated upload: %w", err)
				return
			}
			if err := <-sent; err != nil {
				failures <- err
				return
			}
			if !bytes.Equal(received, payload) {
				failures <- fmt.Errorf("rotated upload changed payload")
			}
		}()
	}
	group.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
}
