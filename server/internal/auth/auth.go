// Package auth：注册/登录/登出与会话中间件。
//
// 密钥体系（与桌面端 src/main/core/e2e.ts 对应）：
//
//	authKey = Argon2id(masterPassword, saltAuth)        —— 仅用于登录，发往服务端
//	KEK     = Argon2id(masterPassword, saltKek)         —— 仅存在于客户端内存
//	DEK     —— 随机数据密钥，以 wrappedDek(KEK 加密) 形式托管服务端
//
// 服务端任何时刻都无法得到 masterPassword 或 KEK，因此无法解密快照（E2E）。
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"onebrowser/server/internal/store"
)

type ctxKey int

const ctxIdentity ctxKey = iota

type Identity struct {
	UserID   string
	DeviceID string
	Email    string
}

func WithIdentity(ctx context.Context, id Identity) context.Context {
	return context.WithValue(ctx, ctxIdentity, id)
}

func FromContext(ctx context.Context) (Identity, error) {
	id, ok := ctx.Value(ctxIdentity).(Identity)
	if !ok || id.UserID == "" {
		return Identity{}, errors.New("unauthenticated")
	}
	return id, nil
}

type KdfParams struct {
	Alg  string `json:"alg"`
	M    int    `json:"m"`
	T    int    `json:"t"`
	P    int    `json:"p"`
	Salt string `json:"salt"`
}

type Service struct {
	DB         *store.Store
	SessionTTL time.Duration
}

func NewService(db *store.Store, ttl time.Duration) *Service {
	return &Service{DB: db, SessionTTL: ttl}
}

// --- 请求/响应结构 ---

type registerReq struct {
	Email      string    `json:"email"`
	AuthKey    string    `json:"authKey"`
	AuthKdf    KdfParams `json:"authKdf"`
	WrappedDek string    `json:"wrappedDek"`
	KekKdf     KdfParams `json:"kekKdf"`
	// 身份密钥对（V0.6 团队协作）：可选（旧客户端兼容）；新客户端注册时生成
	IdentityPub         string `json:"identityPub"`
	WrappedIdentityPriv string `json:"wrappedIdentityPriv"`
}

type loginReq struct {
	Email      string `json:"email"`
	AuthKey    string `json:"authKey"`
	DeviceID   string `json:"deviceId"`
	DeviceName string `json:"deviceName"`
	Platform   string `json:"platform"`
}

type loginResp struct {
	Token      string    `json:"token"`
	ExpiresAt  time.Time `json:"expiresAt"`
	DeviceID   string    `json:"deviceId"`
	UserID     string    `json:"userId"`
	Email      string    `json:"email"`
	WrappedDek string    `json:"wrappedDek"`
	KekKdf     KdfParams `json:"kekKdf"`
	// 身份密钥对（V0.6 团队协作）：旧账号未生成时为空串，客户端登录后走 /v1/auth/identity 回填
	IdentityPub         string `json:"identityPub"`
	WrappedIdentityPriv string `json:"wrappedIdentityPriv"`
}

// --- 处理器 ---

func (s *Service) HandleKdfInfo(w http.ResponseWriter, r *http.Request) {
	email := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("email")))
	var authKdf, wrapped, kek string
	err := s.DB.Pool.QueryRow(r.Context(),
		`SELECT auth_kdf, wrapped_dek, kek_kdf FROM users WHERE email=$1`, email).
		Scan(&authKdf, &wrapped, &kek)
	if err != nil {
		// 未知邮箱：返回通用参数，避免账号枚举（salt 为占位值）
		writeJSON(w, http.StatusOK, map[string]any{
			"authKdf": KdfParams{Alg: "argon2id", M: 19456, T: 2, P: 1, Salt: "unknown-account"},
		})
		return
	}
	var k KdfParams
	_ = json.Unmarshal([]byte(authKdf), &k)
	writeJSON(w, http.StatusOK, map[string]any{"authKdf": k})
}

func (s *Service) HandleRegister(w http.ResponseWriter, r *http.Request) {
	var req registerReq
	if !decodeBody(w, r, &req) {
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	if _, err := mail.ParseAddress(req.Email); err != nil || req.Email == "" {
		writeErr(w, http.StatusBadRequest, "invalid_email", "邮箱格式不正确")
		return
	}
	if req.AuthKey == "" || len(req.AuthKey) > 256 {
		writeErr(w, http.StatusBadRequest, "invalid_auth_key", "authKey 缺失或超长")
		return
	}
	if req.WrappedDek == "" {
		writeErr(w, http.StatusBadRequest, "invalid_envelope", "wrappedDek 缺失")
		return
	}
	verifier, err := HashAuthKey(req.AuthKey)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "hash", "服务端错误")
		return
	}
	authKdf, _ := json.Marshal(req.AuthKdf)
	kekKdf, _ := json.Marshal(req.KekKdf)
	userID := store.NewUUID()
	_, err = s.DB.Pool.Exec(r.Context(),
		`INSERT INTO users (id, email, verifier, auth_kdf, wrapped_dek, kek_kdf, identity_pub, wrapped_identity_priv)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		userID, req.Email, verifier, string(authKdf), req.WrappedDek, string(kekKdf),
		req.IdentityPub, req.WrappedIdentityPriv)
	if err != nil {
		if strings.Contains(err.Error(), "duplicate key") {
			writeErr(w, http.StatusConflict, "email_taken", "该邮箱已注册")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db", "服务端错误")
		return
	}
	s.audit(r.Context(), userID, "", "user.register", req.Email)
	writeJSON(w, http.StatusCreated, map[string]any{"userId": userID})
}

func (s *Service) HandleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if !decodeBody(w, r, &req) {
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))

	var userID, verifier, wrapped, kek string
	var identityPub, wrappedIdentityPriv string
	err := s.DB.Pool.QueryRow(r.Context(),
		`SELECT id, verifier, wrapped_dek, kek_kdf, identity_pub, wrapped_identity_priv FROM users WHERE email=$1`, req.Email).
		Scan(&userID, &verifier, &wrapped, &kek, &identityPub, &wrappedIdentityPriv)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "bad_credentials", "邮箱或密码错误")
		return
	}
	ok, err := VerifyAuthKey(verifier, req.AuthKey)
	if err != nil || !ok {
		writeErr(w, http.StatusUnauthorized, "bad_credentials", "邮箱或密码错误")
		return
	}

	if req.DeviceID == "" {
		req.DeviceID = store.NewUUID()
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `
		INSERT INTO devices (id, user_id, name, platform, last_seen_at) VALUES ($1,$2,$3,$4,now())
		ON CONFLICT (id) DO UPDATE SET name=$3, platform=$4, last_seen_at=now()`,
		req.DeviceID, userID, req.DeviceName, req.Platform); err != nil {
		writeErr(w, http.StatusInternalServerError, "db", "设备登记失败")
		return
	}

	token := store.RandomToken()
	expires := time.Now().Add(s.SessionTTL)
	if _, err := s.DB.Pool.Exec(r.Context(),
		`INSERT INTO auth_sessions (token_hash, user_id, device_id, expires_at) VALUES ($1,$2,$3,$4)`,
		store.HashToken(token), userID, req.DeviceID, expires); err != nil {
		writeErr(w, http.StatusInternalServerError, "db", "会话创建失败")
		return
	}
	s.audit(r.Context(), userID, req.DeviceID, "user.login", req.Email)

	var kekKdf KdfParams
	_ = json.Unmarshal([]byte(kek), &kekKdf)
	writeJSON(w, http.StatusOK, loginResp{
		Token: token, ExpiresAt: expires, DeviceID: req.DeviceID,
		UserID: userID, Email: req.Email, WrappedDek: wrapped, KekKdf: kekKdf,
		IdentityPub: identityPub, WrappedIdentityPriv: wrappedIdentityPriv,
	})
}

// HandleSetIdentity 身份密钥对回填（V0.6）：旧账号首次用新客户端登录时补生成。
// 仅允许从空态一次性写入——已有关钥不可覆盖（防劫持他人包裹语义）。
func (s *Service) HandleSetIdentity(w http.ResponseWriter, r *http.Request) {
	id, err := FromContext(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthenticated", "未登录")
		return
	}
	var req struct {
		IdentityPub         string `json:"identityPub"`
		WrappedIdentityPriv string `json:"wrappedIdentityPriv"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.IdentityPub == "" || req.WrappedIdentityPriv == "" {
		writeErr(w, http.StatusBadRequest, "invalid_args", "identityPub/wrappedIdentityPriv 必填")
		return
	}
	tag, err := s.DB.Pool.Exec(r.Context(),
		`UPDATE users SET identity_pub=$3, wrapped_identity_priv=$4
		 WHERE id=$1 AND identity_pub='' AND wrapped_identity_priv=''`,
		id.UserID, "", req.IdentityPub, req.WrappedIdentityPriv)
	if err != nil || tag.RowsAffected() == 0 {
		writeErr(w, http.StatusConflict, "already_set", "身份密钥已存在，不可覆盖")
		return
	}
	s.audit(r.Context(), id.UserID, id.DeviceID, "user.set_identity", "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Service) HandleLogout(w http.ResponseWriter, r *http.Request) {
	id, err := FromContext(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthenticated", "未登录")
		return
	}
	h := r.Header.Get("Authorization")
	token := strings.TrimPrefix(h, "Bearer ")
	_, _ = s.DB.Pool.Exec(r.Context(), `DELETE FROM auth_sessions WHERE token_hash=$1`, store.HashToken(token))
	s.audit(r.Context(), id.UserID, id.DeviceID, "user.logout", "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Service) HandleMe(w http.ResponseWriter, r *http.Request) {
	id, err := FromContext(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthenticated", "未登录")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"userId": id.UserID, "deviceId": id.DeviceID, "email": id.Email})
}

// Middleware 从 Bearer token 解析会话并注入身份。
func (s *Service) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" {
			writeErr(w, http.StatusUnauthorized, "no_token", "缺少令牌")
			return
		}
		var id Identity
		err := s.DB.Pool.QueryRow(r.Context(), `
			SELECT s.user_id, s.device_id, u.email
			FROM auth_sessions s JOIN users u ON u.id = s.user_id
			WHERE s.token_hash=$1 AND s.expires_at > now()`, store.HashToken(token)).
			Scan(&id.UserID, &id.DeviceID, &id.Email)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "bad_token", "令牌无效或已过期")
			return
		}
		next.ServeHTTP(w, r.WithContext(WithIdentity(r.Context(), id)))
	})
}

// AuthenticateWS 供 WebSocket 升级前校验（token 走查询参数）。
func (s *Service) AuthenticateWS(ctx context.Context, token string) (Identity, error) {
	if token == "" {
		return Identity{}, errors.New("no token")
	}
	var id Identity
	err := s.DB.Pool.QueryRow(ctx, `
		SELECT s.user_id, s.device_id, u.email
		FROM auth_sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash=$1 AND s.expires_at > now()`, store.HashToken(token)).
		Scan(&id.UserID, &id.DeviceID, &id.Email)
	return id, err
}

func (s *Service) audit(ctx context.Context, userID, deviceID, event, detail string) {
	_, _ = s.DB.Pool.Exec(ctx,
		`INSERT INTO audit_log (user_id, device_id, event, detail) VALUES ($1,$2,$3,$4)`,
		userID, deviceID, event, detail)
}

// --- 小工具（本包内 handlers 共用） ---

func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json", "请求体不是合法 JSON")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}
