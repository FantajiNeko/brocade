package dns

import (
	"context"
	"testing"
	"time"

	mdns "github.com/miekg/dns"
	"github.com/xtls/xray-core/common/buf"
	"github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/core"
	dnsfeature "github.com/xtls/xray-core/features/dns"
	"github.com/xtls/xray-core/features/routing"
	"github.com/xtls/xray-core/transport"
	"github.com/xtls/xray-core/transport/pipe"
)

func TestResponseTTLUsesAnswerMinimum(t *testing.T) {
	for _, test := range []struct {
		name    string
		records []string
		ttl     time.Duration
	}{
		{"long", []string{"example.com. 3600 IN A 192.0.2.1"}, 3600 * time.Second},
		{"minimum", []string{"example.com. 3600 IN A 192.0.2.1", "example.com. 120 IN A 192.0.2.2"}, 120 * time.Second},
		{"zero", []string{"example.com. 0 IN A 192.0.2.1"}, time.Second},
		{"empty", nil, dnsfeature.DefaultTTL * time.Second},
	} {
		t.Run(test.name, func(t *testing.T) {
			msg := new(mdns.Msg)
			for _, record := range test.records {
				rr, err := mdns.NewRR(record)
				if err != nil {
					t.Fatal(err)
				}
				msg.Answer = append(msg.Answer, rr)
			}
			payload, err := msg.Pack()
			if err != nil {
				t.Fatal(err)
			}
			before := time.Now()
			answer, err := parseResponse(payload)
			after := time.Now()
			if err != nil {
				t.Fatal(err)
			}
			if answer.Expire.Before(before.Add(test.ttl)) || answer.Expire.After(after.Add(test.ttl)) {
				t.Fatalf("expiration %s does not preserve TTL %s", answer.Expire, test.ttl)
			}
		})
	}
}

type dnsMetadataDispatcher struct {
	routing.Dispatcher
	link   *transport.Link
	target net.Destination
}

func (d *dnsMetadataDispatcher) Dispatch(_ context.Context, target net.Destination) (*transport.Link, error) {
	d.target = target
	return d.link, nil
}

func TestUDPDomainResolverLeavesPacketDestinationUnset(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	ctx = context.WithValue(ctx, core.XrayKey(1), &core.Instance{})
	up, writer := pipe.New(pipe.WithSizeLimit(1024))
	defer up.Interrupt()
	defer writer.Close()
	reader, down := pipe.New(pipe.WithSizeLimit(1024))
	defer reader.Interrupt()
	defer down.Close()
	dispatcher := &dnsMetadataDispatcher{link: &transport.Link{Reader: reader, Writer: writer}}
	target := net.UDPDestination(net.DomainAddress("resolver.example"), 53)
	server := NewClassicNameServer(target, dispatcher, true, false, 0, nil)
	defer server.requestsCleanup.Close()
	server.sendQuery(ctx, nil, "example.com.", dnsfeature.IPOption{IPv4Enable: true})
	packets, err := up.ReadMultiBuffer()
	if err != nil {
		t.Fatal(err)
	}
	defer buf.ReleaseMulti(packets)
	if dispatcher.target != target {
		t.Fatal("resolver dispatch lost its domain target")
	}
	if len(packets) != 1 || packets[0].UDP != nil {
		t.Fatal("domain destination leaked into UDP packet metadata")
	}
}
