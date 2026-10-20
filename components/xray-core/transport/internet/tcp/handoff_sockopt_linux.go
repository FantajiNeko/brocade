//go:build linux

package tcp

import (
	"encoding/binary"
	"fmt"
	"net"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	handoffTCPListen  = 10 // TCP_LISTEN, include/uapi/linux/tcp.h
	handoffDiagV6Only = 11 // INET_DIAG_SKV6ONLY, include/uapi/linux/inet_diag.h
)

// Older MPTCP listeners appear in TCP SOCK_DIAG as their listening subflow.
// The subflow retains the socket inode, though its SO_COOKIE differs from the
// MPTCP meta socket. Only the exact held inode and bind address can supply the
// IPV6_V6ONLY value; the ordinary handoff FD/cookie checks remain unchanged.
func handoffMPTCPV6Only(identity handoffSocketIdentity) (int, error) {
	address, err := net.ResolveTCPAddr("tcp6", identity.Address)
	if err != nil || identity.Protocol != unix.IPPROTO_MPTCP || identity.SocketInode == 0 || address.IP.To4() != nil {
		return 0, fmt.Errorf("invalid MPTCP IPv6 listener identity")
	}
	fd, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, unix.NETLINK_SOCK_DIAG)
	if err != nil {
		return 0, err
	}
	defer unix.Close(fd)
	deadline := time.Now().Add(handoffTimeout)
	timeout := unix.NsecToTimeval(handoffTimeout.Nanoseconds())
	if err := unix.SetsockoptTimeval(fd, unix.SOL_SOCKET, unix.SO_RCVTIMEO, &timeout); err != nil {
		return 0, err
	}
	if err := unix.SetsockoptTimeval(fd, unix.SOL_SOCKET, unix.SO_SNDTIMEO, &timeout); err != nil {
		return 0, err
	}
	// nlmsghdr followed by inet_diag_req_v2. Request only TCP listeners on
	// this port, including MPTCP's first subflow on kernels without MPTCP dumps.
	request := make([]byte, 16+56)
	binary.NativeEndian.PutUint32(request[0:4], uint32(len(request)))
	binary.NativeEndian.PutUint16(request[4:6], unix.SOCK_DIAG_BY_FAMILY)
	binary.NativeEndian.PutUint16(request[6:8], unix.NLM_F_REQUEST|unix.NLM_F_DUMP)
	binary.NativeEndian.PutUint32(request[8:12], 1)
	request[16], request[17] = unix.AF_INET6, unix.IPPROTO_TCP
	binary.NativeEndian.PutUint32(request[20:24], 1<<handoffTCPListen)
	binary.BigEndian.PutUint16(request[24:26], uint16(address.Port))
	copy(request[28:44], address.IP.To16())
	for index := 64; index < 72; index++ {
		request[index] = 0xff // INET_DIAG_NOCOOKIE; match the held inode below.
	}
	if err := unix.Sendto(fd, request, 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return 0, err
	}
	buffer := make([]byte, 64*1024)
	for received := 0; received < 512 && time.Now().Before(deadline); received++ {
		n, _, flags, from, err := unix.Recvmsg(fd, buffer, nil, 0)
		if err != nil {
			return 0, err
		}
		peer, ok := from.(*unix.SockaddrNetlink)
		if !ok || peer.Pid != 0 || flags&unix.MSG_TRUNC != 0 {
			return 0, fmt.Errorf("invalid MPTCP listener diagnostic response")
		}
		messages, err := syscall.ParseNetlinkMessage(buffer[:n])
		if err != nil {
			return 0, err
		}
		for _, message := range messages {
			if message.Header.Seq != 1 {
				return 0, fmt.Errorf("unexpected MPTCP listener diagnostic sequence")
			}
			switch message.Header.Type {
			case unix.NLMSG_DONE, unix.NLMSG_ERROR:
				return 0, fmt.Errorf("MPTCP listener diagnostic did not identify the held socket")
			case unix.SOCK_DIAG_BY_FAMILY:
				value, found, err := handoffMPTCPDiagV6Only(message.Data, identity)
				if err != nil || found {
					return value, err
				}
			default:
				return 0, fmt.Errorf("unexpected MPTCP listener diagnostic message")
			}
		}
	}
	return 0, fmt.Errorf("MPTCP listener diagnostic exceeded its response limit")
}

func handoffMPTCPDiagV6Only(data []byte, identity handoffSocketIdentity) (int, bool, error) {
	const diagnosticSize = 72
	if len(data) < diagnosticSize {
		return 0, false, fmt.Errorf("truncated MPTCP listener diagnostic")
	}
	address := (&net.TCPAddr{IP: net.IP(data[8:24]), Port: int(binary.BigEndian.Uint16(data[4:6]))}).String()
	if data[0] != unix.AF_INET6 || data[1] != handoffTCPListen || uint64(binary.NativeEndian.Uint32(data[68:72])) != identity.SocketInode || address != identity.Address {
		return 0, false, nil
	}
	for attributes := data[diagnosticSize:]; len(attributes) > 0; {
		if len(attributes) < 4 {
			return 0, false, fmt.Errorf("truncated MPTCP listener diagnostic attribute")
		}
		length := int(binary.NativeEndian.Uint16(attributes[:2]))
		if length < 4 || length > len(attributes) || (length+3)&^3 > len(attributes) {
			return 0, false, fmt.Errorf("invalid MPTCP listener diagnostic attribute length")
		}
		if binary.NativeEndian.Uint16(attributes[2:4]) == handoffDiagV6Only {
			if length != 5 || attributes[4] > 1 {
				return 0, false, fmt.Errorf("invalid MPTCP listener v6only value")
			}
			return int(attributes[4]), true, nil
		}
		attributes = attributes[(length+3)&^3:]
	}
	return 0, false, fmt.Errorf("MPTCP listener diagnostic is missing v6only")
}
