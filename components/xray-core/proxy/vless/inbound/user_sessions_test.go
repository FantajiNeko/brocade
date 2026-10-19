package inbound

import (
	"bytes"
	"context"
	"net"
	"testing"
	"time"

	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/protocol"
	"github.com/xtls/xray-core/common/session"
	"github.com/xtls/xray-core/common/uuid"
	"github.com/xtls/xray-core/features/policy"
	"github.com/xtls/xray-core/features/routing"
	"github.com/xtls/xray-core/proxy/vless"
	"github.com/xtls/xray-core/proxy/vless/encoding"
	"github.com/xtls/xray-core/transport"
)

type quotaSessionDispatcher struct{ started chan context.Context }

func (*quotaSessionDispatcher) Type() interface{} { return routing.DispatcherType() }
func (*quotaSessionDispatcher) Start() error      { return nil }
func (*quotaSessionDispatcher) Close() error      { return nil }
func (*quotaSessionDispatcher) Dispatch(context.Context, xnet.Destination) (*transport.Link, error) {
	panic("unexpected Dispatch")
}
func (d *quotaSessionDispatcher) DispatchLink(ctx context.Context, _ xnet.Destination, _ *transport.Link) error {
	d.started <- ctx
	<-ctx.Done()
	return ctx.Err()
}

func TestRemoveUserCancelsAuthenticatedTCPAndMuxWithoutClosingOtherUsers(t *testing.T) {
	validator := new(vless.MemoryValidator)
	alice := &protocol.MemoryUser{Email: "alice", Account: &vless.MemoryAccount{ID: protocol.NewID(uuid.New())}}
	bob := &protocol.MemoryUser{Email: "bob", Account: &vless.MemoryAccount{ID: protocol.NewID(uuid.New())}}
	for _, u := range []*protocol.MemoryUser{alice, bob} {
		if err := validator.Add(u); err != nil {
			t.Fatal(err)
		}
	}
	h := &Handler{validator: validator, policyManager: policy.DefaultManager{}}
	dispatch := &quotaSessionDispatcher{started: make(chan context.Context, 3)}
	type live struct {
		ctx  context.Context
		done chan error
		conn net.Conn
	}
	open := func(user *protocol.MemoryUser, cmd protocol.RequestCommand) live {
		t.Helper()
		client, server := net.Pipe()
		t.Cleanup(func() { _ = client.Close(); _ = server.Close() })
		done := make(chan error, 1)
		ctx := session.ContextWithInbound(context.Background(), &session.Inbound{})
		go func() { done <- h.Process(ctx, xnet.Network_TCP, server, dispatch) }()
		var header bytes.Buffer
		if err := encoding.EncodeRequestHeader(&header, &protocol.RequestHeader{Version: encoding.Version, User: user, Command: cmd, Address: xnet.DomainAddress("example.test"), Port: 443}, &encoding.Addons{}); err != nil {
			t.Fatal(err)
		}
		_ = client.SetWriteDeadline(time.Now().Add(time.Second))
		if _, err := client.Write(header.Bytes()); err != nil {
			t.Fatal(err)
		}
		select {
		case ctx := <-dispatch.started:
			return live{ctx, done, client}
		case <-time.After(time.Second):
			t.Fatal("authentication did not finish")
			return live{}
		}
	}
	tcp := open(alice, protocol.RequestCommandTCP)
	mux := open(alice, protocol.RequestCommandMux)
	other := open(bob, protocol.RequestCommandTCP)
	defer func() { _ = h.RemoveUser(context.Background(), "bob") }()
	if err := h.RemoveUser(context.Background(), "alice"); err != nil {
		t.Fatal(err)
	}
	for _, flow := range []live{tcp, mux} {
		select {
		case <-flow.done:
		case <-time.After(time.Second):
			t.Fatal("revoked carrier still serving")
		}
		if flow.ctx.Err() == nil {
			t.Fatal("outbound context was not canceled")
		}
		_ = flow.conn.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := flow.conn.Read(make([]byte, 1)); err == nil {
			t.Fatal("revoked stream remained open")
		}
	}
	if other.ctx.Err() != nil {
		t.Fatal("another user's context was canceled")
	}
	if err := h.AddUser(context.Background(), alice); err != nil {
		t.Fatal(err)
	}
	restored := open(alice, protocol.RequestCommandTCP)
	if restored.ctx.Err() != nil {
		t.Fatal("restored authorization cannot establish a new stream")
	}
	if err := h.RemoveUser(context.Background(), "alice"); err != nil {
		t.Fatal(err)
	}
}
