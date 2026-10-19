// cataloggen imports selected, already-expanded geosite sets. It is an explicit
// maintainer command, never part of process startup or the packet path.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/xtls/xray-core/common/geodata"
	"github.com/xtls/xray-core/common/siteusage"
	"google.golang.org/protobuf/proto"
)

type selection struct {
	siteusage.Definition
	Geosite []string `json:"geosite,omitempty"`
}

type config struct {
	Version int `json:"version"`
	Source  struct {
		URL    string `json:"url"`
		SHA256 string `json:"sha256"`
	} `json:"source"`
	Sites     []selection            `json:"sites"`
	Overrides []siteusage.Definition `json:"overrides"`
}

func generate(input config, asset []byte) ([]byte, error) {
	sum := sha256.Sum256(asset)
	if hex.EncodeToString(sum[:]) != input.Source.SHA256 {
		return nil, fmt.Errorf("geosite asset checksum mismatch")
	}
	var data geodata.GeoSiteList
	if err := proto.Unmarshal(asset, &data); err != nil {
		return nil, err
	}
	sets := make(map[string]*geodata.GeoSite)
	for _, set := range data.Entry {
		sets[strings.ToLower(set.Code)] = set
	}
	output := struct {
		Version   int                    `json:"version"`
		Source    any                    `json:"source"`
		Overrides []siteusage.Definition `json:"overrides"`
		Sites     []siteusage.Definition `json:"sites"`
	}{Version: input.Version, Source: input.Source, Overrides: input.Overrides}
	seen := make(map[string]bool)
	for _, site := range input.Sites {
		if seen[site.ID] {
			return nil, fmt.Errorf("duplicate category %q", site.ID)
		}
		seen[site.ID] = true
		base := site.Definition
		if base.Domains == nil {
			base.Domains = []string{}
		}
		for _, name := range site.Geosite {
			set, ok := sets[name]
			if !ok {
				return nil, fmt.Errorf("missing geosite set %q", name)
			}
			for _, rule := range set.Domain {
				switch rule.Type {
				case geodata.Domain_Domain:
					base.Domains = append(base.Domains, rule.Value)
				case geodata.Domain_Full:
					base.Full = append(base.Full, rule.Value)
				case geodata.Domain_Substr:
					base.Keywords = append(base.Keywords, rule.Value)
				case geodata.Domain_Regex:
					base.Regexps = append(base.Regexps, rule.Value)
				default:
					return nil, fmt.Errorf("unsupported rule type in %q", name)
				}
			}
		}
		for _, values := range []*[]string{&base.Domains, &base.Full, &base.Keywords, &base.Regexps} {
			sort.Strings(*values)
			*values = compact(*values)
		}
		output.Sites = append(output.Sites, base)
	}
	for _, override := range input.Overrides {
		if !seen[override.ID] {
			return nil, fmt.Errorf("override references unknown category %q", override.ID)
		}
	}
	if err := siteusage.ValidateDefinitions(output.Sites); err != nil {
		return nil, err
	}
	if err := siteusage.ValidateDefinitions(output.Overrides); err != nil {
		return nil, err
	}
	encoded, err := json.MarshalIndent(output, "", "  ")
	return append(encoded, '\n'), err
}

func compact(values []string) []string {
	if len(values) == 0 {
		return values
	}
	n := 1
	for _, value := range values[1:] {
		if value != values[n-1] {
			values[n] = value
			n++
		}
	}
	return values[:n]
}

func run() error {
	assetPath := flag.String("asset", "../../.tools/site-usage-geosite.dat", "pinned community geosite asset (not the routing asset)")
	configPath := flag.String("config", "common/siteusage/catalog.source.json", "maintained categories and overrides")
	outputPath := flag.String("output", "common/siteusage/catalog.json", "generated catalog")
	check := flag.Bool("check", false, "compare without writing")
	list := flag.Bool("list", false, "list available source sets")
	flag.Parse()
	asset, err := os.ReadFile(*assetPath)
	if err != nil {
		return err
	}
	if len(asset) > 32<<20 {
		return fmt.Errorf("geosite exceeds 32 MiB")
	}
	if *list {
		var data geodata.GeoSiteList
		if err := proto.Unmarshal(asset, &data); err != nil {
			return err
		}
		for _, set := range data.Entry {
			fmt.Println(strings.ToLower(set.Code), len(set.Domain))
		}
		return nil
	}
	raw, err := os.ReadFile(*configPath)
	if err != nil {
		return err
	}
	var input config
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return err
	}
	output, err := generate(input, asset)
	if err != nil {
		return err
	}
	if *check {
		current, err := os.ReadFile(*outputPath)
		if err != nil {
			return err
		}
		if !bytes.Equal(current, output) {
			return fmt.Errorf("catalog is stale; run cataloggen")
		}
		return nil
	}
	return os.WriteFile(*outputPath, output, 0644)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
