// Package siteusage classifies observation traffic without changing routing decisions.
package siteusage

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

//go:embed catalog.json
var catalogJSON []byte

type Definition struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Domains  []string `json:"domains"`
	Full     []string `json:"full,omitempty"`
	Keywords []string `json:"keywords,omitempty"`
	Regexps  []string `json:"regexps,omitempty"`
}

type Catalog struct {
	Version   int          `json:"version"`
	Sites     []Definition `json:"sites"`
	Overrides []Definition `json:"overrides"`
}

var catalog = func() Catalog {
	var value Catalog
	if err := json.Unmarshal(catalogJSON, &value); err != nil {
		panic("invalid embedded site usage catalog: " + err.Error())
	}
	return value
}()

func Version() int { return catalog.Version }

type suffixNode struct {
	children map[string]*suffixNode
	site     string
	priority int
}

// The immutable reverse-label trie is shared by all connections. Lowest catalog
// priority wins, preserving the ordered-list semantics even for overlapping rules.
var classifier = compileDefinitions(catalog.Sites)
var overrides = compileDefinitions(catalog.Overrides)

// ValidateDefinitions bounds startup memory and the slower fallback rules. A
// maintainer refresh must explicitly review any increase rather than silently
// importing the entire geosite database on small nodes.
func ValidateDefinitions(sites []Definition) error {
	total, slow := 0, 0
	if len(sites) > 64 {
		return fmt.Errorf("site catalog exceeds 64 categories")
	}
	seen := make(map[string]bool)
	for _, site := range sites {
		if site.ID == "" || seen[site.ID] {
			return fmt.Errorf("invalid or duplicate site ID")
		}
		seen[site.ID] = true
		total += len(site.Domains) + len(site.Full) + len(site.Keywords) + len(site.Regexps)
		slow += len(site.Keywords) + len(site.Regexps)
		for _, domains := range [][]string{site.Domains, site.Full} {
			for _, domain := range domains {
				if NormalizeOtherDomain(domain) != domain || domain == "" {
					return fmt.Errorf("invalid DNS rule in %s", site.ID)
				}
			}
		}
		for _, pattern := range site.Regexps {
			if len(pattern) > 2048 {
				return fmt.Errorf("regex too long in %s", site.ID)
			}
			if _, err := regexp.Compile(pattern); err != nil {
				return fmt.Errorf("invalid regex in %s: %w", site.ID, err)
			}
		}
		for _, pattern := range site.Keywords {
			if pattern == "" || len(pattern) > 253 {
				return fmt.Errorf("invalid keyword in %s", site.ID)
			}
		}
	}
	if total > 20000 || slow > 64 {
		return fmt.Errorf("site rule budget exceeded: %d rules, %d slow rules", total, slow)
	}
	return nil
}

type siteMatch struct {
	site     string
	priority int
}
type fallbackRule struct {
	siteMatch
	keyword string
	regex   *regexp.Regexp
}
type compiledCatalog struct {
	suffix   *suffixNode
	full     map[string]siteMatch
	fallback []fallbackRule
}

func compileDefinitions(sites []Definition) *compiledCatalog {
	if err := ValidateDefinitions(sites); err != nil {
		panic("invalid embedded site usage catalog: " + err.Error())
	}
	result := &compiledCatalog{suffix: compileSuffixes(sites), full: make(map[string]siteMatch)}
	for priority, site := range sites {
		match := siteMatch{site.ID, priority}
		for _, domain := range site.Full {
			if _, exists := result.full[domain]; !exists {
				result.full[domain] = match
			}
		}
		for _, keyword := range site.Keywords {
			result.fallback = append(result.fallback, fallbackRule{siteMatch: match, keyword: keyword})
		}
		for _, pattern := range site.Regexps {
			result.fallback = append(result.fallback, fallbackRule{siteMatch: match, regex: regexp.MustCompile(pattern)})
		}
	}
	return result
}

func (c *compiledCatalog) match(domain string) string {
	best := c.suffix.lookup(domain)
	if full, ok := c.full[domain]; ok && (best.site == "" || full.priority < best.priority) {
		best = full
	}
	for _, rule := range c.fallback {
		if best.site != "" && rule.priority >= best.priority {
			break
		}
		if rule.regex != nil && rule.regex.MatchString(domain) || rule.keyword != "" && strings.Contains(domain, rule.keyword) {
			best = rule.siteMatch
			break
		}
	}
	if best.site == "" {
		return "other"
	}
	return best.site
}

func compileSuffixes(sites []Definition) *suffixNode {
	root := &suffixNode{}
	for priority, site := range sites {
		for _, suffix := range site.Domains {
			node := root
			for {
				dot := strings.LastIndexByte(suffix, '.')
				label := suffix[dot+1:]
				if node.children == nil {
					node.children = make(map[string]*suffixNode)
				}
				child := node.children[label]
				if child == nil {
					child = &suffixNode{}
					node.children[label] = child
				}
				node = child
				if dot < 0 {
					break
				}
				suffix = suffix[:dot]
			}
			if node.site == "" {
				node.site, node.priority = site.ID, priority
			}
		}
	}
	return root
}

func (node *suffixNode) match(domain string) string {
	best := node.lookup(domain)
	if best.site == "" {
		return "other"
	}
	return best.site
}

func (node *suffixNode) lookup(domain string) siteMatch {
	best := siteMatch{}
	for {
		dot := strings.LastIndexByte(domain, '.')
		node = node.children[domain[dot+1:]]
		if node == nil {
			return best
		}
		if node.site != "" && (best.site == "" || node.priority < best.priority) {
			best = siteMatch{node.site, node.priority}
			if best.priority == 0 {
				return best
			}
		}
		if dot < 0 {
			return best
		}
		domain = domain[:dot]
	}
}

// Classify matches DNS-label boundaries without scanning every catalog suffix.
// No reverse-DNS, shared-CDN-IP guesses or per-domain cache is involved.
func Classify(domain string, sniffEnabled bool) string {
	domain = strings.ToLower(strings.TrimSuffix(domain, "."))
	if domain == "" {
		if sniffEnabled {
			return "sniffing-failed"
		}
		return "unidentified"
	}
	if site := overrides.match(domain); site != "other" {
		return site
	}
	return classifier.match(domain)
}
