package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/xtls/xray-core/common/geodata"
	"github.com/xtls/xray-core/common/siteusage"
	"google.golang.org/protobuf/proto"
)

func TestImportIsPinnedDeterministicAndPreservesRuleTypes(t *testing.T) {
	asset, err := proto.Marshal(&geodata.GeoSiteList{Entry: []*geodata.GeoSite{{Code: "EXAMPLE", Domain: []*geodata.Domain{
		{Type: geodata.Domain_Domain, Value: "example.com"}, {Type: geodata.Domain_Domain, Value: "example.com"},
		{Type: geodata.Domain_Full, Value: "one.cdn.test"}, {Type: geodata.Domain_Substr, Value: "keyword"}, {Type: geodata.Domain_Regex, Value: `^re[0-9]\.test$`},
	}}}})
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(asset)
	input := config{Version: 1, Sites: []selection{{Definition: siteusage.Definition{ID: "example", Name: "Example", Domains: []string{"supplement.test"}}, Geosite: []string{"example"}}}}
	input.Source.SHA256 = hex.EncodeToString(sum[:])
	a, err := generate(input, asset)
	if err != nil {
		t.Fatal(err)
	}
	b, err := generate(input, asset)
	if err != nil || !bytes.Equal(a, b) {
		t.Fatal("nondeterministic import")
	}
	var output siteusage.Catalog
	if err := json.Unmarshal(a, &output); err != nil {
		t.Fatal(err)
	}
	site := output.Sites[0]
	if len(site.Domains) != 2 || len(site.Full) != 1 || len(site.Keywords) != 1 || len(site.Regexps) != 1 {
		t.Fatalf("rule semantic lost: %+v", site)
	}
	input.Source.SHA256 = "bad"
	if _, err := generate(input, asset); err == nil {
		t.Fatal("unpinned asset accepted")
	}
	input.Source.SHA256 = hex.EncodeToString(sum[:])
	input.Sites[0].Geosite = []string{"missing"}
	if _, err := generate(input, asset); err == nil {
		t.Fatal("missing set silently ignored")
	}
}
