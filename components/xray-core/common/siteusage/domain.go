package siteusage

import (
	"net"
	"strings"
)

// NormalizeOtherDomain accepts DNS metadata only, never URLs, addresses or paths.
// ASCII/punycode is shared with the Agent/Console validator; no DNS lookup is made.
func NormalizeOtherDomain(domain string) string {
	domain = strings.ToLower(strings.TrimSuffix(domain, "."))
	if len(domain) == 0 || len(domain) > 253 || net.ParseIP(domain) != nil {
		return ""
	}
	for _, label := range strings.Split(domain, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return ""
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return ""
			}
		}
	}
	return domain
}
