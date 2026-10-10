// Package api：路由装配。
package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"onebrowser/server/internal/auth"
	"onebrowser/server/internal/envs"
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

	r.Get("/v1/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "service": "onebrowser-server"})
	})

	// 公开
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

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
