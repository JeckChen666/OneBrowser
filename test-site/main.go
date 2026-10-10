// OneBrowser 测试站：一个带登录态的 Web 服务，用于开发与验收测试。
// 详见 docs/project-plan.md §7.1。
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Session struct {
	SID      string
	User     string
	IP       string
	UA       string
	LoginAt  time.Time
	LastSeen time.Time
	Expired  bool
}

type site struct {
	mu       sync.Mutex
	sessions map[string]*Session
	bindIP   bool // IP 绑定校验开关（模拟站点风控）
}

func newSite() *site {
	s := &site{sessions: make(map[string]*Session)}
	go func() { // 会话回收（仅测试站，防内存无限增长）
		for range time.Tick(10 * time.Minute) {
			s.mu.Lock()
			for sid, sess := range s.sessions {
				if time.Since(sess.LastSeen) > 2*time.Hour {
					delete(s.sessions, sid)
				}
			}
			s.mu.Unlock()
		}
	}()
	return s
}

// current 解析请求中的会话。reason 说明未登录原因（自动化断言用）。
func (s *site) current(r *http.Request) (sess *Session, reason string) {
	c, err := r.Cookie("sid")
	if err != nil || c.Value == "" {
		return nil, "no-sid"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sess = s.sessions[c.Value]
	if sess == nil || sess.Expired {
		return nil, "sid-invalid"
	}
	if s.bindIP && sess.IP != clientIP(r) {
		return nil, "ip-mismatch" // 模拟：换 IP 使用同一会话被要求重新验证
	}
	sess.LastSeen = time.Now()
	sess.UA = r.UserAgent()
	return sess, ""
}

func (s *site) handleHome(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if sess, _ := s.current(r); sess != nil {
		http.Redirect(w, r, "/app", http.StatusSeeOther)
		return
	}
	render(w, tplLogin, nil)
}

func (s *site) handleLogin(w http.ResponseWriter, r *http.Request) {
	var user string
	asJSON := strings.Contains(r.Header.Get("Content-Type"), "application/json")
	if asJSON {
		var body struct{ User, Pass string }
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		user = body.User
	} else {
		user = r.FormValue("user")
	}
	if strings.TrimSpace(user) == "" {
		http.Error(w, "user required", http.StatusBadRequest)
		return
	}
	sid := randHex(16)
	now := time.Now()
	s.mu.Lock()
	s.sessions[sid] = &Session{SID: sid, User: user, IP: clientIP(r), UA: r.UserAgent(), LoginAt: now, LastSeen: now}
	s.mu.Unlock()

	// 三种 cookie 变体：HttpOnly 持久会话 / JS 可读持久 / 会话级
	http.SetCookie(w, &http.Cookie{Name: "sid", Value: sid, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: 30 * 86400})
	http.SetCookie(w, &http.Cookie{Name: "token", Value: randHex(16), Path: "/", MaxAge: 30 * 86400})
	http.SetCookie(w, &http.Cookie{Name: "short", Value: "1", Path: "/"})

	if asJSON {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sid": sid})
		return
	}
	http.Redirect(w, r, "/app", http.StatusSeeOther)
}

func (s *site) handleApp(w http.ResponseWriter, r *http.Request) {
	sess, reason := s.current(r)
	if sess == nil {
		render(w, tplLogin, map[string]any{"Error": "会话无效（" + reason + "），请重新登录"})
		return
	}
	render(w, tplApp, sess)
}

func (s *site) handleWhoami(w http.ResponseWriter, r *http.Request) {
	sess, reason := s.current(r)
	if sess == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"loggedIn": false, "reason": reason})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"loggedIn": true,
		"user":     sess.User,
		"sid":      sess.SID,
		"loginAt":  sess.LoginAt.Format(time.RFC3339),
		"ip":       clientIP(r),
		"ua":       r.UserAgent(),
	})
}

func (s *site) handleSessions(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	list := make([]*Session, 0, len(s.sessions))
	for _, sess := range s.sessions {
		list = append(list, sess)
	}
	s.mu.Unlock()
	sortSessions(list)
	render(w, tplSessions, map[string]any{"Sessions": list, "BindIP": s.bindIP})
}

func (s *site) handleExpire(w http.ResponseWriter, r *http.Request) {
	sid := r.FormValue("sid")
	s.mu.Lock()
	defer s.mu.Unlock()
	if sid == "" || sid == "all" {
		for _, sess := range s.sessions {
			sess.Expired = true
		}
	} else if sess := s.sessions[sid]; sess != nil {
		sess.Expired = true
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *site) handleBindIP(w http.ResponseWriter, r *http.Request) {
	on, err := strconv.ParseBool(r.FormValue("on"))
	if err != nil {
		on = !s.bindIP // 无参数时取反
	}
	s.mu.Lock()
	s.bindIP = on
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "bindIP": on})
}

func (s *site) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("sid"); err == nil {
		s.mu.Lock()
		delete(s.sessions, c.Value)
		s.mu.Unlock()
	}
	for _, name := range []string{"sid", "token", "short"} {
		http.SetCookie(w, &http.Cookie{Name: name, Value: "", Path: "/", MaxAge: -1})
	}
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (s *site) handleFP(w http.ResponseWriter, r *http.Request) {
	render(w, tplFP, map[string]any{"UA": r.UserAgent(), "RemoteAddr": r.RemoteAddr})
}

func (s *site) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", s.handleHome)
	mux.HandleFunc("POST /login", s.handleLogin)
	mux.HandleFunc("GET /app", s.handleApp)
	mux.HandleFunc("GET /api/whoami", s.handleWhoami)
	mux.HandleFunc("GET /sessions", s.handleSessions)
	mux.HandleFunc("POST /api/expire", s.handleExpire)
	mux.HandleFunc("POST /api/bind-ip", s.handleBindIP)
	mux.HandleFunc("GET /logout", s.handleLogout)
	mux.HandleFunc("GET /fp", s.handleFP)
	return mux
}

func main() {
	// 代理模式：PROXY_LISTEN=addr 时作为 HTTP 正向代理运行（测试用，与站点模式互斥）
	if os.Getenv("PROXY_LISTEN") != "" {
		proxyMain()
		return
	}
	addr := os.Getenv("LISTEN_ADDR")
	if addr == "" {
		addr = ":18080"
	}
	log.Printf("test-site listening on http://127.0.0.1%s (登录任意用户名即可)", addr)
	log.Fatal(http.ListenAndServe(addr, newSite().routes()))
}

// --- 工具函数 ---

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		log.Fatal(err)
	}
	return hex.EncodeToString(b)
}

func clientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		return strings.TrimSpace(strings.Split(fwd, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func sortSessions(list []*Session) {
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && list[j].LoginAt.After(list[j-1].LoginAt); j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
}
