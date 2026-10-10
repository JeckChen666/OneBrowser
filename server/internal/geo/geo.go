// Package geo：出口 IP 的地理推导（时区/语言），供指纹 auto 模式使用。
package geo

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"time"
)

type Info struct {
	IP       string `json:"ip"`
	Source   string `json:"source"` // local / external / fallback
	Timezone string `json:"timezone"`
	Lang     string `json:"lang"`
}

var httpGeo = &http.Client{Timeout: 3 * time.Second}

// country → 首选语言（覆盖主要市场；缺省 en-US）
var langByCountry = map[string]string{
	"CN": "zh-CN", "TW": "zh-TW", "HK": "zh-HK", "MO": "zh-HK",
	"US": "en-US", "GB": "en-GB", "AU": "en-AU", "CA": "en-CA", "SG": "en-SG", "NZ": "en-NZ",
	"JP": "ja", "KR": "ko", "DE": "de", "AT": "de", "CH": "de",
	"FR": "fr", "BE": "fr", "ES": "es", "MX": "es", "IT": "it",
	"RU": "ru", "BY": "ru", "NL": "nl", "PL": "pl", "PT": "pt", "BR": "pt-BR",
	"SE": "sv", "NO": "no", "DK": "da", "FI": "fi", "TR": "tr",
	"TH": "th", "VN": "vi", "ID": "id", "IN": "hi-IN", "MY": "ms", "PH": "fil-PH",
}

func isPrivate(ip string) bool {
	p := net.ParseIP(ip)
	if p == nil {
		return true
	}
	return p.IsLoopback() || p.IsPrivate() || p.IsLinkLocalUnicast() || p.IsUnspecified()
}

// Lookup：私网 → 服务器本地时区；公网 → 外部 geo 服务（GEO_API 可换源），失败回退 UTC。
func Lookup(ctx context.Context, ip string) Info {
	if isPrivate(ip) {
		tz := time.Local.String()
		if tz == "" || tz == "Local" {
			tz = "UTC"
		}
		return Info{IP: ip, Source: "local", Timezone: tz, Lang: "en-US"}
	}

	api := os.Getenv("GEO_API")
	if api == "" {
		api = "http://ip-api.com/json/{ip}?fields=status,countryCode,timezone"
	}
	api = replaceIP(api, ip)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, api, nil)
	if err == nil {
		if resp, err := httpGeo.Do(req); err == nil {
			defer resp.Body.Close()
			var out struct {
				Status      string `json:"status"`
				CountryCode string `json:"countryCode"`
				Timezone    string `json:"timezone"`
			}
			if json.NewDecoder(resp.Body).Decode(&out) == nil && out.Status == "success" && out.Timezone != "" {
				lang := langByCountry[out.CountryCode]
				if lang == "" {
					lang = "en-US"
				}
				return Info{IP: ip, Source: "external", Timezone: out.Timezone, Lang: lang}
			}
		}
	}
	return Info{IP: ip, Source: "fallback", Timezone: "UTC", Lang: "en-US"}
}

func replaceIP(tpl, ip string) string {
	out := ""
	for i := 0; i < len(tpl); i++ {
		if tpl[i] == '{' && i+4 <= len(tpl) && tpl[i:i+4] == "{ip}" {
			out += ip
			i += 3
			continue
		}
		out += string(tpl[i])
	}
	return out
}
