// Package snapshots：快照元数据与 S3 预签名（快照内容为 E2E 密文，服务端不可读）。
package snapshots

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"onebrowser/server/internal/auth"
	"onebrowser/server/internal/config"
	"onebrowser/server/internal/s3s3"
	"onebrowser/server/internal/store"
)

type Service struct {
	DB     *store.Store
	S3     *s3s3.Client
	Cfg    config.Config
	Notify func(userID, envID string)
}

type uploadResp struct {
	SnapshotID string            `json:"snapshotId"`
	Upload     map[string]string `json:"upload"` // manifestUrl / blobUrl（presigned PUT）
}

// 申请上传：创建 uploading 快照并返回预签名 PUT。
func (s *Service) Create(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	envID := chi.URLParam(r, "envID")
	var req struct {
		DeviceID string `json:"deviceId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	var envMode string
	var baseID *string
	err := s.DB.Pool.QueryRow(r.Context(),
		`SELECT mode, latest_base_id FROM environments WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
		envID, id.UserID).Scan(&envMode, &baseID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "env_not_found", "环境不存在")
		return
	}

	snapID := store.NewUUID()
	if _, err := s.DB.Pool.Exec(r.Context(),
		`INSERT INTO snapshots (id, env_id, user_id, device_id, based_on, state)
		 VALUES ($1,$2,$3,$4,$5,'uploading')`,
		snapID, envID, id.UserID, req.DeviceID, derefStr(baseID)); err != nil {
		writeErr(w, http.StatusInternalServerError, "db", "快照创建失败")
		return
	}

	mk, bk := s3s3.Keys(id.UserID, envID, snapID)
	manifestURL, err1 := s.S3.PresignPut(r.Context(), mk, s.Cfg.PresignPutTTL)
	blobURL, err2 := s.S3.PresignPut(r.Context(), bk, s.Cfg.PresignPutTTL)
	if err1 != nil || err2 != nil {
		writeErr(w, http.StatusInternalServerError, "presign", "预签名失败")
		return
	}
	writeJSON(w, http.StatusCreated, uploadResp{SnapshotID: snapID, Upload: map[string]string{
		"manifestUrl": manifestURL, "blobUrl": blobURL,
	}})
}

// 确认上传：校验对象存在（可选）→ ready → 提升为环境基线（last-write-wins）。
func (s *Service) Commit(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	envID := chi.URLParam(r, "envID")
	snapID := chi.URLParam(r, "snapID")
	var req struct {
		SHA256    string `json:"sha256"`
		SizeBytes int64  `json:"sizeBytes"`
	}
	if !decodeBody(w, r, &req) {
		return
	}

	var owner string
	err := s.DB.Pool.QueryRow(r.Context(),
		`SELECT user_id FROM snapshots WHERE id=$1 AND env_id=$2`, snapID, envID).Scan(&owner)
	if err != nil || owner != id.UserID {
		writeErr(w, http.StatusNotFound, "snap_not_found", "快照不存在")
		return
	}

	if s.Cfg.S3StrictHead {
		mk, bk := s3s3.Keys(id.UserID, envID, snapID)
		if _, ok := s.S3.Head(r.Context(), mk); !ok {
			writeErr(w, http.StatusBadRequest, "manifest_missing", "manifest.json 未上传")
			return
		}
		if size, ok := s.S3.Head(r.Context(), bk); !ok || size == 0 {
			writeErr(w, http.StatusBadRequest, "blob_missing", "blob.enc 未上传")
			return
		}
	}

	tag, err := s.DB.Pool.Exec(r.Context(),
		`UPDATE snapshots SET state='ready', sha256=$3, size_bytes=$4 WHERE id=$1 AND env_id=$2 AND state='uploading'`,
		snapID, envID, req.SHA256, req.SizeBytes)
	if err != nil || tag.RowsAffected() == 0 {
		writeErr(w, http.StatusConflict, "bad_state", "快照状态不允许 commit")
		return
	}
	if _, err := s.DB.Pool.Exec(r.Context(),
		`UPDATE environments SET latest_base_id=$2, updated_at=now() WHERE id=$1`, envID, snapID); err != nil {
		writeErr(w, http.StatusInternalServerError, "db", "基线更新失败")
		return
	}
	_, _ = s.DB.Pool.Exec(r.Context(),
		`INSERT INTO audit_log (user_id, device_id, event, detail) VALUES ($1,$2,'snapshot.commit',$3)`,
		id.UserID, id.DeviceID, envID+"/"+snapID)
	if s.Notify != nil {
		s.Notify(id.UserID, envID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "promotedToBase": true})
}

type baseResp struct {
	HasBase  bool              `json:"hasBase"`
	Snapshot *baseMeta         `json:"snapshot"`
	Download map[string]string `json:"download,omitempty"` // manifestUrl / blobUrl（presigned GET）
}

type baseMeta struct {
	SnapshotID string    `json:"snapshotId"`
	CreatedAt  time.Time `json:"createdAt"`
	SizeBytes  int64     `json:"sizeBytes"`
	SHA256     string    `json:"sha256"`
	DeviceID   string    `json:"deviceId"`
}

// 获取当前基线（模式一克隆 / 模式二冷启动均使用）。
func (s *Service) GetBase(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	envID := chi.URLParam(r, "envID")

	var latest *string
	err := s.DB.Pool.QueryRow(r.Context(),
		`SELECT latest_base_id FROM environments WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
		envID, id.UserID).Scan(&latest)
	if err != nil {
		writeErr(w, http.StatusNotFound, "env_not_found", "环境不存在")
		return
	}
	if latest == nil || *latest == "" {
		writeJSON(w, http.StatusOK, baseResp{HasBase: false})
		return
	}

	var meta baseMeta
	err = s.DB.Pool.QueryRow(r.Context(), `
		SELECT id, created_at, size_bytes, sha256, device_id FROM snapshots
		WHERE id=$1 AND env_id=$2 AND state='ready'`, *latest, envID).
		Scan(&meta.SnapshotID, &meta.CreatedAt, &meta.SizeBytes, &meta.SHA256, &meta.DeviceID)
	if err != nil {
		writeJSON(w, http.StatusOK, baseResp{HasBase: false})
		return
	}
	mk, bk := s3s3.Keys(id.UserID, envID, meta.SnapshotID)
	manifestURL, err1 := s.S3.PresignGet(r.Context(), mk, s.Cfg.PresignGetTTL)
	blobURL, err2 := s.S3.PresignGet(r.Context(), bk, s.Cfg.PresignGetTTL)
	if err1 != nil || err2 != nil {
		writeErr(w, http.StatusInternalServerError, "presign", "预签名失败")
		return
	}
	writeJSON(w, http.StatusOK, baseResp{
		HasBase: true, Snapshot: &meta,
		Download: map[string]string{"manifestUrl": manifestURL, "blobUrl": blobURL},
	})
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

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// GetDownload：按快照 ID 返回预签名下载（模式二接管时下载指定快照）。
func (s *Service) GetDownload(w http.ResponseWriter, r *http.Request) {
	id, _ := auth.FromContext(r.Context())
	envID := chi.URLParam(r, "envID")
	snapID := chi.URLParam(r, "snapID")

	var meta baseMeta
	err := s.DB.Pool.QueryRow(r.Context(), `
		SELECT id, created_at, size_bytes, sha256, device_id FROM snapshots
		WHERE id=$1 AND env_id=$2 AND user_id=$3 AND state='ready'`, snapID, envID, id.UserID).
		Scan(&meta.SnapshotID, &meta.CreatedAt, &meta.SizeBytes, &meta.SHA256, &meta.DeviceID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "snap_not_found", "快照不存在")
		return
	}
	mk, bk := s3s3.Keys(id.UserID, envID, snapID)
	manifestURL, err1 := s.S3.PresignGet(r.Context(), mk, s.Cfg.PresignGetTTL)
	blobURL, err2 := s.S3.PresignGet(r.Context(), bk, s.Cfg.PresignGetTTL)
	if err1 != nil || err2 != nil {
		writeErr(w, http.StatusInternalServerError, "presign", "预签名失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"snapshot": meta,
		"download": map[string]string{"manifestUrl": manifestURL, "blobUrl": blobURL},
	})
}
