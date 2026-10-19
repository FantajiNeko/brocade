package siteusage

import (
	"net/netip"
	"strings"
)

// NormalizeFailedTarget accepts IP endpoints only and canonicalizes mapped IPv4.
func NormalizeFailedTarget(value string) string {
	network, endpoint, ok := strings.Cut(value, "://")
	if !ok || (network != "tcp" && network != "udp") || len(value) > 80 {
		return ""
	}
	address, err := netip.ParseAddrPort(endpoint)
	if err != nil || address.Port() == 0 || address.Addr().Zone() != "" {
		return ""
	}
	return network + "://" + netip.AddrPortFrom(address.Addr().Unmap(), address.Port()).String()
}
