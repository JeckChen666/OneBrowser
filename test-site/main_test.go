package main

import (
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"testing"
)

func newClients(t *testing.T, srv *httptest.Server) (follow, noFollow *http.Client) {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	tr := srv.Client().Transport
	follow = &http.Client{Transport: tr, Jar: jar}
	noFollow = &http.Client{Transport: tr, Jar: jar, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	return follow, noFollow
}

// 登录 → whoami 已登录 → expire → whoami 未登录
func TestLoginExpireFlow(t *testing.T) {
	srv := httptest.NewServer(newSite().routes())
	defer srv.Close()
	follow, noFollow := newClients(t, srv)

	resp, err := noFollow.PostForm(srv.URL+"/login", url.Values{"user": {"alice"}})
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusSeeOther {
		t.Fatalf("login status = %d, want 303", resp.StatusCode)
	}

	resp, err = follow.Get(srv.URL + "/api/whoami")
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["loggedIn"] != true || body["user"] != "alice" {
		t.Fatalf("whoami = %v, want loggedIn=true user=alice", body)
	}
	sid, _ := body["sid"].(string)

	if _, err := follow.PostForm(srv.URL+"/api/expire", url.Values{"sid": {sid}}); err != nil {
		t.Fatal(err)
	}
	resp, _ = follow.Get(srv.URL + "/api/whoami")
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["loggedIn"] != false || body["reason"] != "sid-invalid" {
		t.Fatalf("whoami after expire = %v, want loggedIn=false sid-invalid", body)
	}
}

// bind-ip 开启后：换 IP 使用同一 sid → 401 ip-mismatch（模拟换 IP 风控）
func TestBindIPRisk(t *testing.T) {
	s := newSite()
	srv := httptest.NewServer(s.routes())
	defer srv.Close()
	follow, _ := newClients(t, srv)

	if _, err := follow.PostForm(srv.URL+"/api/bind-ip", url.Values{"on": {"true"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := follow.PostForm(srv.URL+"/login", url.Values{"user": {"bob"}}); err != nil {
		t.Fatal(err)
	}

	u, _ := url.Parse(srv.URL)
	req, _ := http.NewRequest("GET", "/api/whoami", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.9") // 与登录 IP 不同
	for _, c := range follow.Jar.Cookies(u) {
		req.AddCookie(c)
	}
	w := httptest.NewRecorder()
	s.routes().ServeHTTP(w, req)
	var body map[string]any
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusUnauthorized || body["reason"] != "ip-mismatch" {
		t.Fatalf("whoami = %d %v, want 401 ip-mismatch", w.Code, body)
	}
}
