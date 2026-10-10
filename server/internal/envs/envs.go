// Package envs：环境 CRUD（config_enc 为 E2E 密文，服务端原样存取）。
package envs

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
	DB     *store.Store
	Notify func(userID, envID string) // env.updated 广播回调（main 注入 ws hub）
}

type baseMeta struct {
	SnapshotID string    `json:"snapshotId"`
	CreatedAt  time.Time `json:"createdAt"`
	SizeBytes  int64     `json:"sizeBytes"`
	SHA256     string    `json:"sha256"`
	DeviceID   string    `json:"deviceId"`
}

type leaseMeta struct {
	HolderDeviceID string `json:"holderDeviceId"`
	State          string `json:"state"`
}

type envItem struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Mode      string     `json:"mode"`
	ConfigEnc string     `json:"configEnc"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	Base      *baseMeta  `json:"base"`
	Lease     *leaseMeta `json:"lease"`
}

func (s *Service) List(w http.ResponseWriter, r *http.Request) {
	id, err := auth.FromContext(r.Context())
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	rows, err := s.DB.Pool.Query(r.Context(), `
		SELECT e.id, e.name, e.mode, e.config_enc, e.created_at, e.updated_at,
		       s.id, s.created_at, s.size_bytes, s.sha256, s.device_id,
		       l.holder_device_id, l.state
		FROM environments e
		LEFT JOIN snapshots s ON s.id = e.latest_base_id AND s.state = 'ready'
		LEFT JOIN leases l ON l.env_id = e.id
		WHERE e.user_id = $1 AND e.deleted_at IS NULL
		ORDER BY e.updated_at DESC`, id.UserID)
	if err != nil {
		http.Error(w, "db error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	items := []envItem{}
	for rows.Next() {
		var it envItem
		var baseID, baseDev *string
		var baseAt *time.Time
		var baseSize *int64
		var baseSha *string
		var holder *string
		var leaseState *string
		if err := rows.Scan(&it.ID, &it.Name, &it.Mode, &it.ConfigEnc, &it.CreatedAt, &it.UpdatedAt,
			&baseID, &baseAt, &baseSize, &baseSha, &baseDev, &holder, &leaseState); err != nil {
			http.Error(w, "scan error", http.StatusInternalServerError)
			return
		}
		if baseID != nil && *baseID != "" {
			it.Base = &baseMeta{SnapshotID: *baseID, CreatedAt: *baseAt, SizeBytes: *baseSize, SHA256: *baseSha, DeviceID: deref(baseDev)}
		}
		if holder != nil {
			it.Lease = &leaseMeta{HolderDeviceID: *holder, State: deref(leaseState)}
		}
		items = append(items, it)
	}
	writeJSON(w, http.StatusOK, map[string]any{"envs": items})
}

func (s *Service) Create(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	var req struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Mode      string `json:"mode"`
		ConfigEnc string `json:"configEnc"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	req.ID = strings.TrimSpace(req.ID)
	if req.ID == "" {
		req.ID = store.NewUUID()
	}
	if req.Name == "" || (req.Mode != "snapshot" && req.Mode != "exclusive") {
		writeErr(w, http.StatusBadRequest, "invalid_env", "name 必填，mode 必须为 snapshot/exclusive")
		return
	}
	var out envItem
	err := s.DB.Pool.QueryRow(r.Context(), `
		INSERT INTO environments (id, user_id, name, mode, config_enc)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (id) DO UPDATE SET name=$3, mode=$4, config_enc=$5, updated_at=now()
		WHERE environments.user_id = $2
		RETURNING id, name, mode, config_enc, created_at, updated_at`,
		req.ID, id.UserID, req.Name, req.Mode, req.ConfigEnc).
		Scan(&out.ID, &out.Name, &out.Mode, &out.ConfigEnc, &out.CreatedAt, &out.UpdatedAt)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db", "环境创建失败")
		return
	}
	writeJSON(w, http.StatusCreated, out)
}

func (s *Service) Update(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	envID := chi.URLParam(r, "envID")
	var req struct {
		Name      *string `json:"name"`
		ConfigEnc *string `json:"configEnc"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	tag, err := s.DB.Pool.Exec(r.Context(), `
		UPDATE environments SET
		  name = COALESCE($3, name),
		  config_enc = COALESCE($4, config_enc),
		  updated_at = now()
		WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
		envID, id.UserID, req.Name, req.ConfigEnc)
	if err != nil || tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "环境不存在")
		return
	}
	s.notifyUpdated(id.UserID, envID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Service) Delete(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	envID := chi.URLParam(r, "envID")
	tag, err := s.DB.Pool.Exec(r.Context(),
		`UPDATE environments SET deleted_at=now(), updated_at=now() WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
		envID, id.UserID)
	if err != nil || tag.RowsAffected() == 0 {
		writeErr(w, http.StatusNotFound, "not_found", "环境不存在")
		return
	}
	_, _ = s.DB.Pool.Exec(r.Context(), `DELETE FROM leases WHERE env_id=$1`, envID)
	s.notifyUpdated(id.UserID, envID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// notifyUpdated 广播 env.updated（多设备列表刷新）。
func (s *Service) notifyUpdated(userID, envID string) {
	if s.Notify != nil {
		s.Notify(userID, envID)
	}
}

func decodeBody(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_json", "请求体不是合法 JSON")
		return false
	}
	return true
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func deref[T any](p *T) T {
	if p == nil {
		var zero T
		return zero
	}
	return *p
}
