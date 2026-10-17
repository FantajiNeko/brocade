package conf_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/xtls/xray-core/infra/conf"
)

func TestMasqueOutboundValidation(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	private, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	public, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, network, security, protocol, dns string
		mux, valid                             bool
	}{
		{"warp", "masque", "tls", "masque", "1.1.1.1", false, true},
		{"no-tls", "masque", "none", "masque", "1.1.1.1", false, false},
		{"wrong-transport", "tcp", "tls", "masque", "1.1.1.1", false, false},
		{"wrong-proxy", "masque", "tls", "freedom", "1.1.1.1", false, false},
		{"mux", "masque", "tls", "masque", "1.1.1.1", true, false},
		{"invalid-dns", "masque", "tls", "masque", "resolver.invalid", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			value := map[string]any{"protocol": tc.protocol, "settings": map[string]any{"address": "162.159.198.2", "port": 443, "remoteDNS": []string{tc.dns}}, "mux": map[string]any{"enabled": tc.mux}, "streamSettings": map[string]any{
				"network": tc.network, "security": tc.security, "tlsSettings": map[string]any{"serverName": "consumer-masque.cloudflareclient.com", "alpn": []string{"h2"}}, "masqueSettings": map[string]any{"warp": map[string]any{
					"privateKey": base64.StdEncoding.EncodeToString(private), "publicKey": base64.StdEncoding.EncodeToString(public), "address": []string{"172.16.0.2/32"},
				}},
			}}
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			var config conf.OutboundDetourConfig
			if err = json.Unmarshal(raw, &config); err != nil {
				t.Fatal(err)
			}
			_, err = config.Build()
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v error=%v", tc.valid, err)
			}
		})
	}
}
