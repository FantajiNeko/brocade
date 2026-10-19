package anytls

import (
	"bytes"
	"context"
	"fmt"
	"sync"
	"testing"

	M "github.com/sagernet/sing/common/metadata"
	"github.com/sagernet/sing/common/uot"
	"github.com/xtls/xray-core/common/buf"
	xnet "github.com/xtls/xray-core/common/net"
	httpSniffer "github.com/xtls/xray-core/common/protocol/http"
	sessionctx "github.com/xtls/xray-core/common/session"
	"github.com/xtls/xray-core/common/singbridge"
	"github.com/xtls/xray-core/transport"
)

func TestSessionStreamsOwnDispatchMetadata(t *testing.T) {
	parent := &sessionctx.Content{SniffingRequest: sessionctx.SniffingRequest{
		Enabled: true, RouteOnly: true, OverrideDestinationForProtocol: []string{"tls", "http"},
	}}
	parentOutbound := &sessionctx.Outbound{}
	ctx := sessionctx.ContextWithContent(context.Background(), parent)
	ctx = sessionctx.ContextWithOutbounds(ctx, []*sessionctx.Outbound{parentOutbound})
	s, _ := newWireSession(nil, false)
	t.Cleanup(func() { s.close(nil) })
	var dispatched []context.Context
	s.dispatcher = &testDispatcher{dispatch: func(ctx context.Context, _ xnet.Destination) (*transport.Link, error) {
		dispatched = append(dispatched, ctx)
		endpoint := newTestLinkEndpoint()
		t.Cleanup(endpoint.closeInput)
		t.Cleanup(endpoint.closeOutput)
		return endpoint.link, nil
	}}
	for index := 0; index < 8; index++ {
		stream := newStream(uint32(index*2+1), nil)
		s.streamsMu.Lock()
		s.streams[stream.sid] = stream
		s.streamsMu.Unlock()
		var body bytes.Buffer
		destination := xnet.TCPDestination(xnet.DomainAddress("stream.example"), 443)
		if index%2 == 0 {
			if err := M.SocksaddrSerializer.WriteAddrPort(&body, singbridge.ToSocksaddr(destination)); err != nil {
				t.Fatal(err)
			}
		} else {
			stream.isUDP = true
			destination.Network = xnet.Network_UDP
			if err := uot.WriteRequest(&body, uot.Request{Destination: singbridge.ToSocksaddr(destination), IsConnect: true}); err != nil {
				t.Fatal(err)
			}
		}
		reader := &buf.BufferedReader{Reader: buf.NewReader(bytes.NewReader(body.Bytes()))}
		var err error
		if stream.isUDP {
			err = s.handleFirstUDPFrame(ctx, stream, reader, body.Len())
		} else {
			err = s.handleNewStream(ctx, stream, reader, body.Len())
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(dispatched) != 8 {
		t.Fatalf("dispatched %d streams, want 8", len(dispatched))
	}
	contents := make(map[*sessionctx.Content]bool)
	outbounds := make(map[*sessionctx.Outbound]bool)
	for index, ctx := range dispatched {
		content := sessionctx.ContentFromContext(ctx)
		if content == nil || content == parent || contents[content] {
			t.Fatalf("stream %d reuses another stream's Content", index)
		}
		contents[content] = true
		if !content.SniffingRequest.Enabled || !content.SniffingRequest.RouteOnly || len(content.SniffingRequest.OverrideDestinationForProtocol) != 2 {
			t.Fatalf("stream %d lost the inbound sniffing policy", index)
		}
		ob := sessionctx.OutboundsFromContext(ctx)
		if len(ob) != 1 || ob[0] == parentOutbound || outbounds[ob[0]] {
			t.Fatalf("stream %d reuses another stream's Outbound", index)
		}
		outbounds[ob[0]] = true
	}

	// Dispatchers sniff each stream asynchronously. Exercise both HTTP attributes and the
	// failure marker while the same AnyTLS connection carries mixed TCP/UDP streams.
	var writers sync.WaitGroup
	start := make(chan struct{})
	for index, ctx := range dispatched {
		writers.Add(1)
		go func(index int, ctx context.Context) {
			defer writers.Done()
			<-start
			content := sessionctx.ContentFromContext(ctx)
			path := fmt.Sprintf("/stream-%d", index)
			request := []byte("GET " + path + " HTTP/1.1\r\nHost: stream.example\r\n\r\n")
			if _, err := httpSniffer.SniffHTTP(request, ctx); err != nil {
				t.Error(err)
				return
			}
			for iteration := 0; iteration < 100; iteration++ {
				content.SetAttribute("xray.sniffing", "failed")
				content.Protocol = fmt.Sprintf("stream-%d", index)
				sessionctx.OutboundsFromContext(ctx)[0].Tag = content.Protocol
				if content.Attribute(":path") != path {
					t.Errorf("stream %d observed another stream's HTTP attributes", index)
				}
				delete(content.Attributes, "xray.sniffing")
			}
		}(index, ctx)
	}
	close(start)
	writers.Wait()
	if parent.Attributes != nil || parent.Protocol != "" || parentOutbound.Tag != "" {
		t.Fatal("stream dispatch mutated connection-wide metadata")
	}
}
