package core

import (
	"slices"
	"testing"
)

func TestVersionStatementAdvertisesBrocadeCapabilities(t *testing.T) {
	want := "Brocade-Capabilities: anytls-ktls-splice anytls-ktls-writev config-listener-handoff-v1 control-listener-handoff-v1 detail-checkpoints-v2 forwarding-close-connections-v1 generation-retirement-v2 listener-handoff-v1 other-domain-usage-v1 secure-dokodemo-splice sniffing-failed-targets-v1 tcp-handoff-udp-reset-v1 user-session-revocation-v1 user-site-usage-v1"
	if !slices.Contains(VersionStatement(), want) {
		t.Fatal("version statement does not advertise Brocade splice capabilities")
	}
}
