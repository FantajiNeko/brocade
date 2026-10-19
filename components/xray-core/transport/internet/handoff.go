package internet

import (
	"context"
	"fmt"
	"net"
	"sync"
)

// PacketHandoffGate is the admission and lifetime boundary for connection-oriented and
// session-oriented protocols carried by a UDP socket. Pausing admission never closes the
// PacketConn: the old generation must keep receiving packets for its established flows.
type PacketHandoffGate interface {
	BeforeAccept(context.Context) (context.Context, bool)
	AfterAccept(bool)
	StartConnection() bool
	FinishConnection()
	Close()
}

type packetHandoffController func(string, *SocketConfig, func(string) (net.PacketConn, error)) (net.PacketConn, PacketHandoffGate, error)

var packetHandoffRegistry struct {
	sync.RWMutex
	controller packetHandoffController
}

// RegisterPacketHandoffController installs the process-wide inbound UDP lifecycle controller.
// The returned closure removes only this registration and is safe to call more than once.
func RegisterPacketHandoffController(controller packetHandoffController) (func(), error) {
	if controller == nil {
		return nil, fmt.Errorf("packet handoff controller is nil")
	}
	packetHandoffRegistry.Lock()
	defer packetHandoffRegistry.Unlock()
	if packetHandoffRegistry.controller != nil {
		return nil, fmt.Errorf("packet handoff controller is already registered")
	}
	packetHandoffRegistry.controller = controller
	var once sync.Once
	return func() {
		once.Do(func() {
			packetHandoffRegistry.Lock()
			packetHandoffRegistry.controller = nil
			packetHandoffRegistry.Unlock()
		})
	}, nil
}

// OpenPacketHandoffListener delegates an inbound UDP bind when a generation manifest is active,
// and otherwise preserves the ordinary direct bind behavior.
func OpenPacketHandoffListener(logicalAddress string, config *SocketConfig, bind func(string) (net.PacketConn, error)) (net.PacketConn, PacketHandoffGate, error) {
	packetHandoffRegistry.RLock()
	controller := packetHandoffRegistry.controller
	packetHandoffRegistry.RUnlock()
	if controller == nil {
		conn, err := bind(logicalAddress)
		return conn, nil, err
	}
	return controller(logicalAddress, config, bind)
}
