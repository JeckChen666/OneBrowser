// Package api：路由装配。
package api

import (
	"encoding/json"
	"net"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"onebrowser/server/internal/auth"
	"onebrowser/server/internal/envs"
	"onebrowser/server/internal/geo"
	"onebrowser/server/internal/leases"
	"onebrowser/server/internal/s3s3"
	"onebrowser/server/internal/snapshots"
	"onebrowser/server/internal/store"
	"onebrowser/server/internal/ws"
)

type Deps struct {
	DB     *store.Store
	S3     *s3s3.Client
	Auth   *auth.Service
	Envs   *envs.Service
	Snaps  *snapshots.Service
	Leases *leases.Service
	Hub    *ws.Hub
}

func NewRouter(d Deps) http.Handler {
	// 模式二信令处理与 env.updated 广播回调
	d.Hub.SetLeaseHandler(d.Leases.HandleClientMsg)
	d.Envs.Notify = func(userID, envID string) {
		d.Hub.BroadcastUser(userID, ws.OutMsg{Type: ws.TypeEnvUpdate, EnvID: envID})
	}
	d.Snaps.Notify = d.Envs.Notify

	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.RealIP, middleware.Recoverer)
	r.Use(middleware.Logger)

	// 公开
	r.Get("/v1/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "onebrowser-server"})
	})
	r.Get("/v1/geo", func(w http.ResponseWriter, r *http.Request) {
		ip := r.URL.Query().Get("ip")
		if ip == "" {
			ip = clientIPFromRequest(r)
		}
		writeJSON(w, http.StatusOK, geo.Lookup(r.Context(), ip))
	})
	r.Get("/v1/auth/kdf-info", d.Auth.HandleKdfInfo)
	r.Post("/v1/auth/register", d.Auth.HandleRegister)
	r.Post("/v1/auth/login", d.Auth.HandleLogin)
	r.Get("/v1/ws", d.Hub.HandleWS)

	// 需登录
	r.Group(func(r chi.Router) {
		r.Use(d.Auth.Middleware)
		r.Post("/v1/auth/logout", d.Auth.HandleLogout)
		r.Get("/v1/auth/me", d.Auth.HandleMe)

		r.Get("/v1/envs", d.Envs.List)
		r.Post("/v1/envs", d.Envs.Create)
		r.Patch("/v1/envs/{envID}", d.Envs.Update)
		r.Delete("/v1/envs/{envID}", d.Envs.Delete)

		r.Post("/v1/envs/{envID}/snapshots", d.Snaps.Create)
		r.Post("/v1/envs/{envID}/snapshots/{snapID}/commit", d.Snaps.Commit)
		r.Get("/v1/envs/{envID}/snapshots/{snapID}/download", d.Snaps.GetDownload)
		r.Get("/v1/envs/{envID}/base", d.Snaps.GetBase)
	})
	return r
}

func clientIPFromRequest(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		parts := splitTrim(fwd)
		if len(parts) > 0 {
			return parts[0]
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func splitTrim(s string) []string {
	var out []string
	cur := ""
	for _, c := range s {
		if c == ',' {
			out = append(out, trimSpace(cur))
			cur = ""
		} else {
			cur += string(c)
		}
	}
	out = append(out, trimSpace(cur))
	return out
}

func trimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
