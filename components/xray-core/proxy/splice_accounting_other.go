//go:build !linux

package proxy

import "net"

func copyAccountedSplice(net.Conn, *net.TCPConn, func(int64)) (bool, error) { return false, nil }
