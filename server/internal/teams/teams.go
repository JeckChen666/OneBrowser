// Package teams：团队协作（V0.6，设计定稿 docs/v0.5.0-plan.md 附录 A）。
//
// 服务端全程只见公钥与密文：team DEK 由客户端生成，用每个成员的 identity_pub
// （X25519）包裹后存 membership 行；本包不理解也无法解密其中内容。
package teams

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"onebrowser/server/internal/auth"
	"onebrowser/server/internal/store"
)

type Service struct {
	DB *store.Store
	// Notify 团队变更广播回调（main 注入 ws hub：对全体 active 成员发 team.updated）
	Notify func(teamID string)
}

type teamItem struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	OwnerEmail    string    `json:"ownerEmail"`
	Role          string    `json:"role"`
	State         string    `json:"state"`
	WrappedTeamDek string   `json:"wrappedTeamDek"`
	MemberCount   int       `json:"memberCount"`
	CreatedAt     time.Time `json:"createdAt"`
}

type memberItem struct {
	UserID       string    `json:"userId"`
	Email        string    `json:"email"`
	Role         string    `json:"role"`
	State        string    `json:"state"`
	IdentityPub  string    `json:"identityPub"` // owner 轮换 DEK 时需为每个成员重新包裹
	JoinedAt     time.Time `json:"joinedAt"`
}

// BroadcastAll Notify 便捷封装：对该团队全部 active 成员广播（幂等，供 router 复用）。
func (s *Service) BroadcastAll(teamID string) {
	if s.Notify != nil {
		s.Notify(teamID)
	}
}

// MemberUserIDs 团队全部 active 成员的用户 ID（router 的 env.updated 团队扇出用）。
func (s *Service) MemberUserIDs(r *http.Request, teamID string) []string {
	rows, err := s.DB.Pool.Query(r.Context(),
		`SELECT user_id FROM team_members WHERE team_id=$1 AND state='active'`, teamID)
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

// --- 处理器 ---

// Create 建团：客户端本地生成 team DEK 并用本人公钥包裹；服务端只落元数据+自包裹副本。
func (s *Service) Create(w http.ResponseWriter, r *http.Request) {
	id, err := auth.FromContext(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthenticated", "未登录")
		return
	}
	var req struct {
		Name           string `json:"name"`
		WrappedSelfDek string `json:"wrappedSelfDek"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 64 {
		writeErr(w, http.StatusBadRequest, "invalid_name", "团队名必填（≤64 字符）")
		return
	}
	if req.WrappedSelfDek == "" {
		writeErr(w, http.StatusBadRequest, "invalid_envelope", "wrappedSelfDek 缺失")
		return
	}
	teamID := store.NewUUID()
	tx, err := s.DB.Pool.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db", "服务端错误")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck
	if _, err := tx.Exec(r.Context(),
		`INSERT INTO teams (id, name, owner_id) VALUES ($1,$2,$3)`, teamID, req.Name, id.UserID); err != nil {
		writeErr(w, http.StatusInternalServerError, "db", "建团失败")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`INSERT INTO team_members (team_id, user_id, role, state, wrapped_team_dek)
		 VALUES ($1,$2,'owner','active',$3)`, teamID, id.UserID, req.WrappedSelfDek); err != nil {
		writeErr(w, http.StatusInternalServerError, "db", "建团失败")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, "db", "建团失败")
		return
	}
	s.audit(r, id.UserID, "team.create", teamID+"/"+req.Name)
	writeJSON(w, http.StatusCreated, map[string]any{"teamId": teamID})
}

// List 我的团队（含我的信封副本与角色；pending=待接受邀请）。
func (s *Service) List(w http.ResponseWriter, r *http.Request) {
	id, err := auth.FromContext(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthenticated", "未登录")
		return
	}
	rows, err := s.DB.Pool.Query(r.Context(), `
		SELECT t.id, t.name, ou.email, m.role, m.state, m.wrapped_team_dek, t.created_at,
		       (SELECT COUNT(*) FROM team_members x WHERE x.team_id = t.id AND x.state='active')
		FROM team_members m
		JOIN teams t ON t.id = m.team_id
		JOIN users ou ON ou.id = t.owner_id
		WHERE m.user_id = $1
		ORDER BY t.created_at DESC`, id.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db", "服务端错误")
		return
	}
	defer rows.Close()
	items := []teamItem{}
	for rows.Next() {
		var it teamItem
		if err := rows.Scan(&it.ID, &it.Name, &it.OwnerEmail, &it.Role, &it.State, &it.WrappedTeamDek, &it.CreatedAt, &it.MemberCount); err != nil {
			writeErr(w, http.StatusInternalServerError, "scan", "服务端错误")
			return
		}
		items = append(items, it)
	}
	writeJSON(w, http.StatusOK, map[string]any{"teams": items})
}

// LookupUser 按邮箱查公钥（邀请前置；仅登录用户，返回 id+公钥，不泄露其他信息）。
func (s *Service) LookupUser(w http.ResponseWriter, r *http.Request) {
	if _, err := auth.FromContext(r.Context()); err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthenticated", "未登录")
		return
	}
	email := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("email")))
	var userID, pub string
	err := s.DB.Pool.QueryRow(r.Context(),
		`SELECT id, identity_pub FROM users WHERE email=$1`, email).Scan(&userID, &pub)
	if err != nil || pub == "" {
		writeErr(w, http.StatusNotFound, "user_not_found", "用户不存在或尚未生成身份密钥")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"userId": userID, "identityPub": pub})
}

// AddMember 邀请（push 模型）：邀请人（owner/admin）用被邀人公钥包裹 team DEK 后写入
// pending 成员行；被邀人接受（accept）才激活。重复邀请覆盖旧行（吊销后重邀场景）。
func (s *Service) AddMember(w http.ResponseWriter, r *http.Request) {
	id, err := auth.FromContext(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthenticated", "未登录")
		return
	}
	teamID := chi.URLParam(r, "teamID")
	var req struct {
		UserID         string `json:"userId"`
		WrappedTeamDek string `json:"wrappedTeamDek"`
		Role           string `json:"role"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	if req.Role != "admin" && req.Role != "member" {
		req.Role = "member"
	}
	if req.UserID == "" || req.WrappedTeamDek == "" {
		writeErr(w, http.StatusBadRequest, "invalid_args", "userId 与 wrappedTeamDek 必填")
		return
	}
	// 邀请权限：owner/admin；目标必须有身份公钥（包裹前提）
	var targetPub string
	err = s.DB.Pool.QueryRow(r.Context(), `
		SELECT u.identity_pub FROM users u WHERE u.id=$1`, req.UserID).Scan(&targetPub)
	if err != nil || targetPub == "" {
		writeErr(w, http.StatusNotFound, "user_not_found", "目标用户不存在或无身份密钥")
		return
	}
	if err := s.requireRole(r, teamID, id.UserID, "owner", "admin"); err != nil {
		writeErr(w, http.StatusForbidden, "forbidden", "仅 owner/admin 可邀请")
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(), `
		INSERT INTO team_members (team_id, user_id, role, state, wrapped_team_dek)
		VALUES ($1,$2,$3,'pending',$4)
		ON CONFLICT (team_id, user_id) DO UPDATE
		  SET role=$3, state='pending', wrapped_team_dek=$4, joined_at=now()`,
		teamID, req.UserID, req.Role, req.WrappedTeamDek); err != nil {
		writeErr(w, http.StatusInternalServerError, "db", "邀请失败")
		return
	}
	s.audit(r, id.UserID, "team.invite", teamID+"/"+req.UserID)
	s.BroadcastAll(teamID)
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "state": "pending"})
}

// ListMembers 成员列表（明文元数据：邮箱/角色/状态）。
func (s *Service) ListMembers(w http.ResponseWriter, r *http.Request) {
	id, err := auth.FromContext(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthenticated", "未登录")
		return
	}
	teamID := chi.URLParam(r, "teamID")
	if err := s.requireRole(r, teamID, id.UserID, "owner", "admin", "member"); err != nil {
		writeErr(w, http.StatusForbidden, "forbidden", "不是该团队成员")
		return
	}
	rows, err := s.DB.Pool.Query(r.Context(), `
		SELECT m.user_id, u.email, m.role, m.state, u.identity_pub, m.joined_at
		FROM team_members m JOIN users u ON u.id = m.user_id
		WHERE m.team_id = $1
		ORDER BY m.joined_at`, teamID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db", "服务端错误")
		return
	}
	defer rows.Close()
	items := []memberItem{}
	for rows.Next() {
		var it memberItem
		if err := rows.Scan(&it.UserID, &it.Email, &it.Role, &it.State, &it.IdentityPub, &it.JoinedAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "scan", "服务端错误")
			return
		}
		items = append(items, it)
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": items})
}

// Revoke 吊销：删成员行即断其服务端访问（软吊销；DEK 轮换为可选加固 RotateDek）。
func (s *Service) Revoke(w http.ResponseWriter, r *http.Request) {
	id, err := auth.FromContext(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthenticated", "未登录")
		return
	}
	teamID := chi.URLParam(r, "teamID")
	target := chi.URLParam(r, "userID")
	if err := s.requireRole(r, teamID, id.UserID, "owner", "admin"); err != nil {
		writeErr(w, http.StatusForbidden, "forbidden", "仅 owner/admin 可吊销")
		return
	}
	// owner 不可被吊销（转让属后续能力）
	var isOwner bool
	_ = s.DB.Pool.QueryRow(r.Context(),
		`SELECT owner_id=$2 FROM teams WHERE id=$1`, teamID, target).Scan(&isOwner)
	if isOwner {
		writeErr(w, http.StatusBadRequest, "owner_immutable", "团队 owner 不可被吊销")
		return
	}
	tag, err := s.DB.Pool.Exec(r.Context(),
		`DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, teamID, target)
	if err != nil || tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_member", "该用户不是团队成员")
		return
	}
	s.audit(r, id.UserID, "team.revoke", teamID+"/"+target)
	s.BroadcastAll(teamID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// RotateDek DEK 轮换（owner）：必须一次性覆盖全部 active 成员，避免有人持旧 DEK 掉队。
func (s *Service) RotateDek(w http.ResponseWriter, r *http.Request) {
	id, err := auth.FromContext(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthenticated", "未登录")
		return
	}
	teamID := chi.URLParam(r, "teamID")
	if err := s.requireRole(r, teamID, id.UserID, "owner"); err != nil {
		writeErr(w, http.StatusForbidden, "forbidden", "仅 owner 可轮换密钥")
		return
	}
	var req struct {
		Items []struct {
			UserID         string `json:"userId"`
			WrappedTeamDek string `json:"wrappedTeamDek"`
		} `json:"items"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	tx, err := s.DB.Pool.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db", "服务端错误")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck
	for _, it := range req.Items {
		tag, err := tx.Exec(r.Context(),
			`UPDATE team_members SET wrapped_team_dek=$3 WHERE team_id=$1 AND user_id=$2 AND state='active'`,
			teamID, it.UserID, it.WrappedTeamDek)
		if err != nil || tag.RowsAffected() == 0 {
			writeErr(w, http.StatusBadRequest, "member_mismatch", "轮换清单与 active 成员不一致（"+it.UserID+"）")
			return
		}
	}
	// 覆盖完整性校验：轮换条数 = active 成员数
	var active int
	if err := tx.QueryRow(r.Context(),
		`SELECT COUNT(*) FROM team_members WHERE team_id=$1 AND state='active'`, teamID).Scan(&active); err != nil {
		writeErr(w, http.StatusInternalServerError, "db", "服务端错误")
		return
	}
	if active != len(req.Items) {
		writeErr(w, http.StatusBadRequest, "member_mismatch", "轮换清单必须覆盖全部 active 成员")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, "db", "轮换失败")
		return
	}
	s.audit(r, id.UserID, "team.rotate_dek", teamID)
	s.BroadcastAll(teamID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// AcceptInvite 接受邀请：pending → active（此后团队环境对其可见、信封可解封）。
func (s *Service) AcceptInvite(w http.ResponseWriter, r *http.Request) {
	id, err := auth.FromContext(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthenticated", "未登录")
		return
	}
	teamID := chi.URLParam(r, "teamID")
	tag, err := s.DB.Pool.Exec(r.Context(),
		`UPDATE team_members SET state='active' WHERE team_id=$1 AND user_id=$2 AND state='pending'`,
		teamID, id.UserID)
	if err != nil || tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "invite_not_found", "没有待接受的邀请")
		return
	}
	s.audit(r, id.UserID, "team.accept", teamID)
	s.BroadcastAll(teamID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// DeclineInvite 拒绝邀请：删 pending 行（信封从未被解封，随行删除无害）。
func (s *Service) DeclineInvite(w http.ResponseWriter, r *http.Request) {
	id, err := auth.FromContext(r.Context())
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "unauthenticated", "未登录")
		return
	}
	teamID := chi.URLParam(r, "teamID")
	tag, err := s.DB.Pool.Exec(r.Context(),
		`DELETE FROM team_members WHERE team_id=$1 AND user_id=$2 AND state='pending'`, teamID, id.UserID)
	if err != nil || tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "invite_not_found", "没有待处理的邀请")
		return
	}
	s.audit(r, id.UserID, "team.decline", teamID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- 工具 ---

// requireRole 校验调用者是团队 active 成员且角色在 allowed 内。
func (s *Service) requireRole(r *http.Request, teamID, userID string, allowed ...string) error {
	var role string
	err := s.DB.Pool.QueryRow(r.Context(),
		`SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2 AND state='active'`,
		teamID, userID).Scan(&role)
	if err != nil {
		return err
	}
	for _, a := range allowed {
		if role == a {
			return nil
		}
	}
	return errForbidden
}

var errForbidden = &forbiddenError{}

type forbiddenError struct{}

func (*forbiddenError) Error() string { return "forbidden" }

func (s *Service) audit(r *http.Request, userID, event, detail string) {
	_, _ = s.DB.Pool.Exec(r.Context(),
		`INSERT INTO audit_log (user_id, device_id, event, detail) VALUES ($1,'',$2,$3)`,
		userID, event, detail)
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json", "请求体不是合法 JSON")
		return false
	}
	return true
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
