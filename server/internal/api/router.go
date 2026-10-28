// Package api：路由装配。
package api

import (
	"context"
	"encoding/json"
	"net"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"onebrowser/server/internal/admin"
	"onebrowser/server/internal/auth"
	"onebrowser/server/internal/config"
	"onebrowser/server/internal/envs"
	"onebrowser/server/internal/geo"
	"onebrowser/server/internal/leases"
	"onebrowser/server/internal/ratelimit"
	"onebrowser/server/internal/s3s3"
	"onebrowser/server/internal/snapshots"
	"onebrowser/server/internal/store"
	"onebrowser/server/internal/teams"
	"onebrowser/server/internal/ws"
)

type Deps struct {
	DB     *store.Store
	S3     *s3s3.Client
	Auth   *auth.Service
	Envs   *envs.Service
	Snaps  *snapshots.Service
	Leases *leases.Service
	Teams  *teams.Service
	Hub    *ws.Hub
	Cfg    config.Config
}

func NewRouter(d Deps) http.Handler {
	// 模式二信令处理与 env.updated 广播回调
	d.Hub.SetLeaseHandler(d.Leases.HandleClientMsg)

	// env.updated 团队扇出：团队环境变更广播给全部 active 成员（个人环境只通知本人）
	envTeamMembers := func(envID string) []string {
		var teamID *string
		if err := d.DB.Pool.QueryRow(context.Background(),
			`SELECT team_id FROM environments WHERE id=$1`, envID).Scan(&teamID); err != nil || teamID == nil {
			return nil
		}
		rows, err := d.DB.Pool.Query(context.Background(),
			`SELECT user_id FROM team_members WHERE team_id=$1 AND state='active'`, *teamID)
		if err != nil {
			return nil
		}
		defer rows.Close()
		var ids []string
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				ids = append(ids, id)
			}
		}
		return ids
	}
	d.Envs.Notify = func(userID, envID string) {
		msg := ws.OutMsg{Type: ws.TypeEnvUpdate, EnvID: envID}
		if members := envTeamMembers(envID); members != nil {
			for _, uid := range members {
				d.Hub.BroadcastUser(uid, msg)
			}
		} else {
			d.Hub.BroadcastUser(userID, msg)
		}
	}
	d.Snaps.Notify = d.Envs.Notify

	// team.updated：成员/DEK 变更 → 团队全体 active 成员刷新
	d.Teams.Notify = func(teamID string) {
		rows, err := d.DB.Pool.Query(context.Background(),
			`SELECT user_id FROM team_members WHERE team_id=$1 AND state='active'`, teamID)
		if err != nil {
			return
		}
		defer rows.Close()
		var ids []string
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				ids = append(ids, id)
			}
		}
		msg := ws.OutMsg{Type: ws.TypeTeamUpdate, TeamID: teamID}
		for _, uid := range ids {
			d.Hub.BroadcastUser(uid, msg)
		}
	}

	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.RealIP, middleware.Recoverer)
	r.Use(middleware.Logger)

	// 认证接口限流（防撞库/爆破）：每 IP 令牌桶，AUTH_RATE_PER_MIN=0 关闭
	authLimiter := ratelimit.New(d.Cfg.AuthRatePerMin, d.Cfg.AuthRateBurst)
	authLimited := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			authLimiter.Middleware(h).ServeHTTP(w, r)
		}
	}

	// 公开。浅探针给 LB；?deep=1 附带依赖状态（db ping + s3 bucket 探测）
	r.Get("/v1/health", func(w http.ResponseWriter, req *http.Request) {
		resp := map[string]any{"ok": true, "service": "onebrowser-server"}
		if req.URL.Query().Get("deep") == "1" {
			deps := map[string]string{}
			if err := d.DB.Pool.Ping(req.Context()); err != nil {
				deps["db"] = "down: " + err.Error()
			} else {
				deps["db"] = "ok"
			}
			if err := d.S3.Probe(req.Context()); err != nil {
				deps["s3"] = "down: " + err.Error()
			} else {
				deps["s3"] = "ok"
			}
			resp["deps"] = deps
			resp["bucket"] = d.Cfg.S3Bucket
		}
		writeJSON(w, http.StatusOK, resp)
	})
	r.Get("/v1/geo", func(w http.ResponseWriter, r *http.Request) {
		ip := r.URL.Query().Get("ip")
		if ip == "" {
			ip = clientIPFromRequest(r)
		}
		writeJSON(w, http.StatusOK, geo.Lookup(r.Context(), ip))
	})
	r.Get("/v1/auth/kdf-info", authLimited(d.Auth.HandleKdfInfo))
	r.Post("/v1/auth/register", authLimited(d.Auth.HandleRegister))
	r.Post("/v1/auth/login", authLimited(d.Auth.HandleLogin))
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

		// 身份密钥对回填（V0.6，旧账号一次性写入）
		r.Post("/v1/auth/identity", d.Auth.HandleSetIdentity)

		// 团队协作（V0.6，附录 A；服务端全程只见公钥与密文）
		r.Post("/v1/teams", d.Teams.Create)
		r.Get("/v1/teams", d.Teams.List)
		r.Get("/v1/users", d.Teams.LookupUser)
		r.Post("/v1/teams/{teamID}/members", d.Teams.AddMember)
		r.Get("/v1/teams/{teamID}/members", d.Teams.ListMembers)
		r.Post("/v1/teams/{teamID}/members/{userID}/revoke", d.Teams.Revoke)
		r.Put("/v1/teams/{teamID}/dek", d.Teams.RotateDek)
		r.Post("/v1/invites/{teamID}/accept", d.Teams.AcceptInvite)
		r.Post("/v1/invites/{teamID}/decline", d.Teams.DeclineInvite)
	})

	// 运维工作台（只读）：设了 ADMIN_TOKEN 才挂载；登录端点复用认证限流防爆破
	if d.Cfg.AdminToken != "" {
		r.Mount("/admin", admin.New(d.DB, d.S3, d.Cfg).Handler(authLimited))
	}
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
