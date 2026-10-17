package conf

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"github.com/xtls/xray-core/common/errors"
	"github.com/xtls/xray-core/transport/internet/masque"
	"golang.org/x/net/http/httpguts"
	"google.golang.org/protobuf/proto"
	"maps"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

type MasqueWarpConfig struct {
	PrivateKey string   `json:"privateKey"`
	PublicKey  string   `json:"publicKey"`
	Address    []string `json:"address"`
}

type MasqueConfig struct {
	Host    string            `json:"host"`
	Path    string            `json:"path"`
	User    string            `json:"user"`
	Pass    string            `json:"pass"`
	Headers map[string]string `json:"headers"`
	Warp    *MasqueWarpConfig `json:"warp"`
}

func (c *MasqueConfig) Build() (proto.Message, error) {
	var warp *masque.Warp
	host := c.Host
	path := c.Path
	if c.Warp != nil {
		if c.User != "" || c.Pass != "" {
			return nil, errors.New(`"user" and "pass" can't be used with "warp"`)
		}
		key, err := parseWarpPrivateKey(c.Warp.PrivateKey)
		if err != nil {
			return nil, errors.New(`invalid "privateKey" in "warp"`).Base(err)
		}
		publicKey, err := parseWarpPublicKey(c.Warp.PublicKey)
		if err != nil {
			return nil, errors.New(`invalid "publicKey" in "warp"`).Base(err)
		}
		address, err := parseWarpAddress(c.Warp.Address)
		if err != nil {
			return nil, err
		}
		warp = &masque.Warp{PrivateKey: key, PublicKey: publicKey, Address: address}
		if host == "" {
			host = masque.WarpHost
		}
		if path == "" {
			path = masque.WarpPath
		}
	}
	if path == "" {
		path = masque.DefaultPath
	}
	path = strings.NewReplacer(
		"{target}", "*", "{ipproto}", "*",
		"{?target,ipproto}", "?target=*&ipproto=*", "{?ipproto,target}", "?ipproto=*&target=*",
		"{&target,ipproto}", "&target=*&ipproto=*", "{&ipproto,target}", "&ipproto=*&target=*",
	).Replace(path)
	if !strings.HasPrefix(path, "/") || strings.ContainsAny(path, "{}") {
		return nil, errors.New(`invalid "path": `, path, `, only the variables {target} and {ipproto} are supported`)
	}
	if host != "" {
		if u, err := url.Parse("https://" + host); err != nil || u.Host != host {
			return nil, errors.New(`invalid "host": `, host)
		}
	}
	for k, v := range c.Headers {
		if !httpguts.ValidHeaderFieldName(k) || !httpguts.ValidHeaderFieldValue(v) {
			return nil, errors.New(`invalid header in "headers": `, strconv.Quote(k))
		}
		switch strings.ToLower(k) {
		case "host", "capsule-protocol":
			return nil, errors.New(`"headers" can't contain "`, k, `"`)
		case "authorization":
			if c.User != "" || c.Pass != "" {
				return nil, errors.New(`"headers" can't contain "`, k, `" when "user" or "pass" is set`)
			}
		}
	}
	headers := c.Headers
	if c.User != "" || c.Pass != "" {
		if strings.Contains(c.User, ":") {
			return nil, errors.New(`invalid "user": `, c.User)
		}
		headers = maps.Clone(c.Headers)
		if headers == nil {
			headers = make(map[string]string)
		}
		headers["Authorization"] = "Basic " + base64.StdEncoding.EncodeToString([]byte(c.User+":"+c.Pass))
	}
	return &masque.Config{
		Host:    host,
		Path:    path,
		Headers: headers,
		Warp:    warp,
	}, nil
}

func parseWarpAddress(list []string) ([]string, error) {
	if len(list) == 0 {
		return nil, errors.New(`"address" in "warp" is not set`)
	}
	var v4, v6 bool
	address := make([]string, 0, len(list))
	for _, s := range list {
		prefix, err := netip.ParsePrefix(s)
		if err != nil {
			addr, err := netip.ParseAddr(s)
			if err != nil {
				return nil, errors.New(`invalid "address" in "warp": `, s)
			}
			prefix = netip.PrefixFrom(addr, addr.BitLen())
		}
		if prefix.Addr().Is4() && v4 || prefix.Addr().Is6() && v6 {
			return nil, errors.New(`"address" in "warp" takes at most one IPv4 and one IPv6 address`)
		}
		v4 = v4 || prefix.Addr().Is4()
		v6 = v6 || prefix.Addr().Is6()
		address = append(address, prefix.String())
	}
	return address, nil
}

func decodeWarpKey(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, errors.New("empty key")
	}
	if block, _ := pem.Decode([]byte(s)); block != nil {
		return block.Bytes, nil
	}
	der, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, errors.New("neither PEM nor base64").Base(err)
	}
	return der, nil
}

func parseWarpPublicKey(s string) ([]byte, error) {
	der, err := decodeWarpKey(s)
	if err != nil {
		return nil, err
	}
	if _, err := x509.ParsePKIXPublicKey(der); err != nil {
		return nil, errors.New("not a PKIX public key").Base(err)
	}
	return der, nil
}

func parseWarpPrivateKey(s string) ([]byte, error) {
	der, err := decodeWarpKey(s)
	if err != nil {
		return nil, err
	}
	var key any
	key, err = x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		if key, err = x509.ParseECPrivateKey(der); err != nil {
			return nil, errors.New("neither a PKCS #8 nor a SEC 1 private key")
		}
	}
	ecKey, ok := key.(*ecdsa.PrivateKey)
	if !ok || ecKey.Curve != elliptic.P256() {
		return nil, errors.New("not an ECDSA P-256 key")
	}
	return x509.MarshalPKCS8PrivateKey(ecKey)
}
