package siteusage

import "testing"

func TestNormalizeOtherDomain(t *testing.T) {
	if got := NormalizeOtherDomain("Video.Example."); got != "video.example" {
		t.Fatal(got)
	}
	for _, value := range []string{"", "1.2.3.4", "::1", "https://secret.example/path", "a.example:443", "a..example", "-a.example", "例子.example", "a.example.."} {
		if NormalizeOtherDomain(value) != "" {
			t.Errorf("accepted non DNS metadata")
		}
	}
}
