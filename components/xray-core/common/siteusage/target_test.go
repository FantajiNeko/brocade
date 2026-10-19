package siteusage

import "testing"

func TestFailedTargetNormalization(t *testing.T) {
	for input, want := range map[string]string{
		"tcp://192.0.2.1:443":          "tcp://192.0.2.1:443",
		"udp://[2001:0db8::1]:53":      "udp://[2001:db8::1]:53",
		"tcp://[::ffff:192.0.2.1]:443": "tcp://192.0.2.1:443",
		"tcp://example.com:443":        "", "https://192.0.2.1:443": "", "tcp://192.0.2.1:0": "",
		"tcp://192.0.2.1:65536": "", "udp://[fe80::1%eth0]:53": "", "tcp://192.0.2.1:443/path": "", "tcp://192.0.2.1:443>>>x": "",
	} {
		if got := NormalizeFailedTarget(input); got != want {
			t.Fatalf("%q: %q != %q", input, got, want)
		}
	}
}
