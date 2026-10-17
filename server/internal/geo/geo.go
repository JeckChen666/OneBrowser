// Package geo：出口 IP 的地理推导（时区/语言），供指纹 auto 模式使用。
package geo

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"strings"
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

// localTimezone：解析服务器本地 IANA 时区名。
// time.Local.String() 在 macOS/Linux 上常返回 "Local"（Go 无法从 /etc/localtime
// 文件内容反推名字），直接用会把本地分支错报成 UTC——按 TZ 环境变量、
// /etc/localtime 符号链接（…/zoneinfo/<名字>）的顺序解析，兜底 UTC。
func localTimezone() string {
	if tz := os.Getenv("TZ"); tz != "" && tz != "Local" {
		if _, err := time.LoadLocation(tz); err == nil {
			return tz
		}
	}
	if p, err := os.Readlink("/etc/localtime"); err == nil {
		if i := strings.LastIndex(p, "zoneinfo/"); i >= 0 {
			name := strings.TrimPrefix(p[i+len("zoneinfo/"):], "/")
			if _, err := time.LoadLocation(name); err == nil {
				return name
			}
		}
	}
	if s := time.Local.String(); s != "" && s != "Local" {
		return s
	}
	return "UTC"
}

// Lookup：私网 → 服务器本地时区；公网 → 外部 geo 服务（GEO_API 可换源），失败回退 UTC。
func Lookup(ctx context.Context, ip string) Info {
	if isPrivate(ip) {
		return Info{IP: ip, Source: "local", Timezone: localTimezone(), Lang: "en-US"}
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
