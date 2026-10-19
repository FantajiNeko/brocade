package siteusage

import (
	"regexp"
	"strings"
	"testing"
)

func TestClassify(t *testing.T) {
	for _, tc := range []struct {
		domain string
		sniff  bool
		want   string
	}{
		{"WWW.YouTube.COM.", true, "youtube"}, {"i.ytimg.com", false, "youtube"},
		{"youtube.com.attacker.test", true, "other"}, {"notyoutube.com", true, "other"},
		{"youtubei.googleapis.com", true, "youtube"}, {"maps.googleapis.com", true, "google"},
		{"video-s.twimg.com", true, "twitter"}, {"api.twitter.com", true, "twitter"},
		{"pbs.twimg.com", true, "twitter"}, {"abs.twimg.com", false, "twitter"},
		{"API.X.COM.", true, "twitter"}, {"t.co", true, "twitter"},
		{"notwitter.com", true, "other"}, {"twitter.com.evil.example", true, "other"},
		{"twimg.com.evil.example", true, "other"}, {"notx.com", true, "other"},
		{"graph.facebook.com", true, "facebook"}, {"www.instagram.com", true, "instagram"},
		{"scontent.cdninstagram.com", true, "instagram"}, {"scontent.example.fbcdn.net", true, "meta-shared"},
		{"facebook.com.evil.example", true, "other"}, {"notinstagram.com", true, "other"},
		{"www.douyin.com", true, "douyin"}, {"lf.bytetos.com", true, "bytedance"},
		{"pan.baidu.com", true, "baidu"}, {"img.bdstatic.com", true, "baidu"},
		{"mp.weixin.qq.com", true, "tencent"}, {"p.qpic.cn", true, "tencent"},
		{"www.taobao.com", true, "alibaba"}, {"cdn.bilivideo.com", true, "bilibili"},
		{"grok.x.com", true, "xai"}, {"wide-youtube.l.google.com", true, "youtube"},
		{"unrelated.cloudfront.net", true, "other"}, {"unrelated.amazonaws.com", true, "other"},
		{"unrelated.akamaized.net", true, "other"},
		{"", true, "sniffing-failed"}, {"", false, "unidentified"}, {"example.com", true, "other"},
	} {
		if got := Classify(tc.domain, tc.sniff); got != tc.want {
			t.Errorf("%q: got %s, want %s", tc.domain, got, tc.want)
		}
	}
}

func TestTriePreservesCatalogPriorityAndEverySuffix(t *testing.T) {
	for _, definitions := range [][]Definition{
		{{ID: "generic", Domains: []string{"example.com"}}, {ID: "specific", Domains: []string{"sub.example.com"}}},
		{{ID: "specific", Domains: []string{"sub.example.com"}}, {ID: "generic", Domains: []string{"example.com"}}},
	} {
		if got := compileSuffixes(definitions).match("cdn.sub.example.com"); got != definitions[0].ID {
			t.Fatalf("priority changed: %s", got)
		}
	}
	linear := func(domain string) string {
		for _, site := range catalog.Sites {
			for _, suffix := range site.Domains {
				if domain == suffix || strings.HasSuffix(domain, "."+suffix) {
					return site.ID
				}
			}
			for _, exact := range site.Full {
				if exact == domain {
					return site.ID
				}
			}
			for _, keyword := range site.Keywords {
				if strings.Contains(domain, keyword) {
					return site.ID
				}
			}
			for _, pattern := range site.Regexps {
				if regexp.MustCompile(pattern).MatchString(domain) {
					return site.ID
				}
			}
		}
		return "other"
	}
	for _, site := range catalog.Sites {
		for _, suffix := range site.Domains {
			for _, domain := range []string{suffix, "cdn." + suffix, "bad" + suffix, suffix + ".invalid", "a.." + suffix} {
				if got, want := classifier.match(domain), linear(domain); got != want {
					t.Fatalf("%s: got %s want %s", domain, got, want)
				}
			}
		}
	}
}

func TestExactKeywordRegexAndManualLayers(t *testing.T) {
	c := compileDefinitions([]Definition{
		{ID: "specific", Full: []string{"only.shared.test"}, Keywords: []string{"needle"}, Regexps: []string{`^api[0-9]+\.shared\.test$`}},
		{ID: "broad", Domains: []string{"shared.test"}},
	})
	for domain, want := range map[string]string{"only.shared.test": "specific", "sub.only.shared.test": "broad", "hayneedle.test": "specific", "api123.shared.test": "specific", "apiX.shared.test": "broad", "other.test": "other"} {
		if got := c.match(domain); got != want {
			t.Fatalf("%s: got %s want %s", domain, got, want)
		}
	}
	// Shared Meta CDN is deliberately separated from Facebook's upstream set.
	if classifier.match("scontent.fbcdn.net") != "facebook" || Classify("scontent.fbcdn.net", true) != "meta-shared" {
		t.Fatal("explicit manual override lost")
	}
}

func BenchmarkCatalogClassify(b *testing.B) {
	for _, domain := range []string{"video-s.twimg.com", "wide-youtube.l.google.com", "cdn.apple.com", "unknown.example", "hses1.akamaized.net"} {
		b.Run(domain, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				Classify(domain, true)
			}
		})
	}
}

func BenchmarkCatalogCompile(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		_ = compileDefinitions(catalog.Sites)
	}
}
