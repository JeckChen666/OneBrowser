// Package admin：运维工作台（只读）。
//
// 设计约束：环境配置（config_enc）与快照载荷均为 E2E 密文，本工作台只展示服务端
// 天然可见的元数据（账号/环境名与模式/基线大小/租约/存储水位），绝不接触密文内容。
//
// 鉴权：ADMIN_TOKEN 口令 → 登录后下发 HttpOnly cookie（值为口令 sha256，恒时比较；
// 也接受 Authorization: Bearer <口令> 便于 curl）。未设口令时整组路由不挂载。
package admin

import (
	"crypto/subtle"
	"embed"
	"encoding/json"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"onebrowser/server/internal/config"
	"onebrowser/server/internal/s3s3"
	"onebrowser/server/internal/store"
)

//go:embed index.html
var indexFS embed.FS

const cookieName = "ob_admin"
const cookieTTL = 12 * time.Hour

type Service struct {
	DB    *store.Store
	S3    *s3s3.Client
	Cfg   config.Config // 只读展示治理参数（口令取 Cfg.AdminToken）
	hash  string        // sha256(token) hex，cookie 值比对用
	start time.Time
}

func New(db *store.Store, s3c *s3s3.Client, cfg config.Config) *Service {
	return &Service{DB: db, S3: s3c, Cfg: cfg, hash: store.HashToken(cfg.AdminToken), start: time.Now()}
}

func (s *Service) token() string { return s.Cfg.AdminToken }

// Handler 装配 /admin 子路由。authLimit 由调用方注入（复用认证限流器防爆破）。
func (s *Service) Handler(authLimit func(http.HandlerFunc) http.HandlerFunc) http.Handler {
	r := chi.NewRouter()
	r.Get("/", s.HandleIndex)
	r.Post("/api/login", authLimit(s.HandleLogin))
	r.Post("/api/logout", s.HandleLogout)
	r.Get("/api/session", s.HandleSession)

	r.Group(func(r chi.Router) {
		r.Use(s.requireAdmin)
		r.Get("/api/overview", s.HandleOverview)
		r.Get("/api/users", s.HandleUsers)
		r.Get("/api/envs", s.HandleEnvs)
		r.Get("/api/snapshots", s.HandleSnapshots)
	})
	return r
}

// --- 鉴权 ---

func (s *Service) authorized(r *http.Request) bool {
	if c, err := r.Cookie(cookieName); err == nil {
		if subtle.ConstantTimeCompare([]byte(c.Value), []byte(s.hash)) == 1 {
			return true
		}
	}
	authz := r.Header.Get("Authorization")
	if strings.HasPrefix(authz, "Bearer ") {
		if subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(authz, "Bearer ")), []byte(s.token())) == 1 {
			return true
		}
	}
	return false
}

func (s *Service) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": map[string]string{"code": "unauthorized", "message": "请先登录"}})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func adminCookie(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: value, Path: "/", MaxAge: maxAge,
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: secure,
	})
}

func (s *Service) HandleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]string{"code": "bad_request", "message": "请求体不是 JSON"}})
		return
	}
	// 恒时比较防时序侧信道；失败不区分「口令空/错」
	if subtle.ConstantTimeCompare([]byte(body.Token), []byte(s.token())) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": map[string]string{"code": "bad_token", "message": "口令错误"}})
		return
	}
	adminCookie(w, r, s.hash, int(cookieTTL.Seconds()))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Service) HandleLogout(w http.ResponseWriter, r *http.Request) {
	adminCookie(w, r, "", -1)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Service) HandleSession(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": map[string]string{"code": "unauthorized", "message": "未登录"}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- 页面 ---

func (s *Service) HandleIndex(w http.ResponseWriter, _ *http.Request) {
	html, err := indexFS.ReadFile("index.html")
	if err != nil {
		http.Error(w, "admin page missing", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(html)
}

// --- 数据端点（只读） ---

func (s *Service) HandleOverview(w http.ResponseWriter, r *http.Request) {
	var o struct {
		Users       int64   `json:"users"`
		Envs        int64   `json:"envs"`
		Snapshots   int64   `json:"snapshots"`
		SnapBytes   int64   `json:"snapBytes"`
		Leases      int64   `json:"activeLeases"`
		Sessions    int64   `json:"activeSessions"`
		Uploadings  int64   `json:"uploadingSnapshots"`
		DB          string  `json:"db"`
		S3          string  `json:"s3"`
		UptimeSec   float64 `json:"uptimeSec"`
		GoVersion   string  `json:"goVersion"`
		QuotaBytes  int64   `json:"quotaBytes"`
		Retention   int     `json:"snapshotRetention"`
		AuthRateMin int     `json:"authRatePerMin"`
	}
	o.GoVersion = runtime.Version()
	o.UptimeSec = time.Since(s.start).Seconds()
	o.QuotaBytes = s.Cfg.UserQuotaBytes
	o.Retention = s.Cfg.SnapshotRetention
	o.AuthRateMin = s.Cfg.AuthRatePerMin
	if err := s.DB.Pool.QueryRow(r.Context(), `
		SELECT (SELECT COUNT(*) FROM users),
		       (SELECT COUNT(*) FROM environments WHERE deleted_at IS NULL),
		       (SELECT COUNT(*) FROM snapshots WHERE state='ready'),
		       (SELECT COALESCE(SUM(size_bytes),0) FROM snapshots WHERE state='ready'),
		       (SELECT COUNT(*) FROM snapshots WHERE state='uploading'),
		       (SELECT COUNT(*) FROM leases WHERE state IN ('active','evicting')),
		       (SELECT COUNT(*) FROM auth_sessions WHERE expires_at > now())
	`).Scan(&o.Users, &o.Envs, &o.Snapshots, &o.SnapBytes, &o.Uploadings, &o.Leases, &o.Sessions); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": "db_error", "message": err.Error()}})
		return
	}
	if err := s.DB.Pool.Ping(r.Context()); err != nil {
		o.DB = "down: " + err.Error()
	} else {
		o.DB = "ok"
	}
	if err := s.S3.Probe(r.Context()); err != nil {
		o.S3 = "down: " + err.Error()
	} else {
		o.S3 = "ok"
	}
	writeJSON(w, http.StatusOK, o)
}

func (s *Service) HandleUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := s.DB.Pool.Query(r.Context(), `
		SELECT u.email, u.created_at,
		       (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id),
		       (SELECT COUNT(*) FROM environments e WHERE e.user_id = u.id AND e.deleted_at IS NULL),
		       (SELECT COALESCE(SUM(s.size_bytes),0) FROM snapshots s WHERE s.user_id = u.id AND s.state='ready')
		FROM users u
		ORDER BY u.created_at DESC
		LIMIT 500`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": "db_error", "message": err.Error()}})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var email string
		var createdAt time.Time
		var devices, envs int64
		var bytes int64
		if err := rows.Scan(&email, &createdAt, &devices, &envs, &bytes); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": "scan_error", "message": err.Error()}})
			return
		}
		out = append(out, map[string]any{
			"email": email, "createdAt": createdAt, "devices": devices, "envs": envs, "snapBytes": bytes,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Service) HandleEnvs(w http.ResponseWriter, r *http.Request) {
	rows, err := s.DB.Pool.Query(r.Context(), `
		SELECT e.name, e.mode, u.email, e.created_at, e.updated_at,
		       s.size_bytes, s.created_at,
		       l.holder_device_id, l.state, l.heartbeat_at
		FROM environments e
		JOIN users u ON u.id = e.user_id
		LEFT JOIN snapshots s ON s.id = e.latest_base_id AND s.state = 'ready'
		LEFT JOIN leases l ON l.env_id = e.id
		WHERE e.deleted_at IS NULL
		ORDER BY e.updated_at DESC
		LIMIT 500`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": "db_error", "message": err.Error()}})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var name, mode, email string
		var createdAt, updatedAt time.Time
		var baseSize *int64
		var baseAt *time.Time
		var holder, leaseState *string
		var heartbeat *time.Time
		if err := rows.Scan(&name, &mode, &email, &createdAt, &updatedAt, &baseSize, &baseAt, &holder, &leaseState, &heartbeat); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": "scan_error", "message": err.Error()}})
			return
		}
		item := map[string]any{"name": name, "mode": mode, "email": email, "createdAt": createdAt, "updatedAt": updatedAt}
		if baseAt != nil {
			item["baseSize"] = *baseSize
			item["baseAt"] = *baseAt
		}
		if holder != nil && *holder != "" {
			item["lease"] = map[string]any{"holder": shortID(*holder), "state": *leaseState, "heartbeatAt": heartbeat}
		}
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Service) HandleSnapshots(w http.ResponseWriter, r *http.Request) {
	rows, err := s.DB.Pool.Query(r.Context(), `
		SELECT s.state, s.size_bytes, s.created_at, s.device_id, e.name, u.email
		FROM snapshots s
		JOIN environments e ON e.id = s.env_id
		JOIN users u ON u.id = s.user_id
		ORDER BY s.created_at DESC
		LIMIT 200`)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": "db_error", "message": err.Error()}})
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var state, deviceID, envName, email string
		var size int64
		var createdAt time.Time
		if err := rows.Scan(&state, &size, &createdAt, &deviceID, &envName, &email); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": "scan_error", "message": err.Error()}})
			return
		}
		out = append(out, map[string]any{
			"state": state, "sizeBytes": size, "createdAt": createdAt,
			"device": shortID(deviceID), "env": envName, "email": email,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
