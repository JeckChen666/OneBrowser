// Package snapshots：快照元数据与 S3 预签名（快照内容为 E2E 密文，服务端不可读）。
package snapshots

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
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

// envAccess 解析调用者对环境的访问权与归因 owner（V0.6 团队化）：
// 个人环境=本人；团队环境=active 成员。owner 是快照 user_id/S3 key/配额的归因主体
// （团队环境=团队 owner，附录 A.8 决议）。
func (s *Service) envAccess(r *http.Request, envID, callerID string) (ownerID string, ok bool) {
	err := s.DB.Pool.QueryRow(r.Context(), `
		SELECT user_id FROM environments
		WHERE id=$1 AND deleted_at IS NULL AND
		  ((user_id=$2 AND team_id IS NULL) OR
		   (team_id IS NOT NULL AND EXISTS(SELECT 1 FROM team_members m
		     WHERE m.team_id = environments.team_id AND m.user_id=$2 AND m.state='active')))`,
		envID, callerID).Scan(&ownerID)
	return ownerID, err == nil
}

// snapAccess 快照级访问权（commit/download）：经环境谓词校验，返回快照归因 owner。
func (s *Service) snapAccess(r *http.Request, envID, snapID, callerID string) (ownerID string, ok bool) {
	err := s.DB.Pool.QueryRow(r.Context(), `
		SELECT sn.user_id FROM snapshots sn
		JOIN environments e ON e.id = sn.env_id
		WHERE sn.id=$1 AND sn.env_id=$2 AND e.deleted_at IS NULL AND
		  ((e.user_id=$3 AND e.team_id IS NULL) OR
		   (e.team_id IS NOT NULL AND EXISTS(SELECT 1 FROM team_members m
		     WHERE m.team_id = e.team_id AND m.user_id=$3 AND m.state='active')))`,
		snapID, envID, callerID).Scan(&ownerID)
	return ownerID, err == nil
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
	ownerID, ok := s.envAccess(r, envID, id.UserID)
	if ok {
		err := s.DB.Pool.QueryRow(r.Context(),
			`SELECT mode, latest_base_id FROM environments WHERE id=$1`, envID).Scan(&envMode, &baseID)
		ok = err == nil
	}
	if !ok {
		writeErr(w, http.StatusNotFound, "env_not_found", "环境不存在")
		return
	}

	// 用户存储配额（USER_QUOTA_GB，0=不限）：按归因 owner 的已 ready 快照累计
	if s.Cfg.UserQuotaBytes > 0 {
		var used int64
		if err := s.DB.Pool.QueryRow(r.Context(),
			`SELECT COALESCE(SUM(size_bytes),0) FROM snapshots WHERE user_id=$1 AND state='ready'`,
			ownerID).Scan(&used); err == nil && used >= s.Cfg.UserQuotaBytes {
			writeErr(w, http.StatusInsufficientStorage, "quota_exceeded",
				"存储配额已用尽：请删除不再使用的环境，或联系管理员扩容")
			return
		}
	}

	snapID := store.NewUUID()
	if _, err := s.DB.Pool.Exec(r.Context(),
		`INSERT INTO snapshots (id, env_id, user_id, device_id, based_on, state)
		 VALUES ($1,$2,$3,$4,$5,'uploading')`,
		snapID, envID, ownerID, req.DeviceID, derefStr(baseID)); err != nil {
		writeErr(w, http.StatusInternalServerError, "db", "快照创建失败")
		return
	}

	mk, bk := s3s3.Keys(ownerID, envID, snapID)
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

	owner, ok := s.snapAccess(r, envID, snapID, id.UserID)
	if !ok {
		writeErr(w, http.StatusNotFound, "snap_not_found", "快照不存在")
		return
	}

	if s.Cfg.S3StrictHead {
		mk, bk := s3s3.Keys(owner, envID, snapID)
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
	// 保留策略（best-effort，不阻塞 commit 响应）：清掉超出配额的旧 ready
	// 与超时未 commit 的 uploading 残骸。刚晋升的基线始终受保护。
	go func() {
		pctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		s.pruneEnv(pctx, owner, envID, snapID)
	}()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "promotedToBase": true})
}

// pruneEnv：快照保留策略。
//  1. ready 只留最近 SnapshotRetention 个（0=不清理），protectID（当前基线）即使
//     排在窗口外也不删；
//  2. uploading 超过 StaleUploadingTTL 未 commit 的视为残骸（上传中断）。
//
// 被清理的快照连同 S3 对象（manifest + blob）一起删除；S3 失败仅记日志（DB 已删，
// 孤儿对象由存储生命周期策略兜底）。失败不返回错误——调用方均为 best-effort。
func (s *Service) pruneEnv(ctx context.Context, userID, envID, protectID string) {
	removed := s.deleteStaleUploading(ctx, userID, envID)
	if s.Cfg.SnapshotRetention > 0 {
		rows, err := s.DB.Pool.Query(ctx, `
			WITH ranked AS (
				SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS rn
				FROM snapshots
				WHERE env_id=$1 AND user_id=$2 AND state='ready'
			)
			SELECT id FROM ranked WHERE rn > $3 AND id <> $4`,
			envID, userID, s.Cfg.SnapshotRetention, protectID)
		if err != nil {
			log.Printf("snapshot prune query: %v", err)
			return
		}
		var ids []string
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				ids = append(ids, id)
			}
		}
		rows.Close()
		removed += s.deleteSnaps(ctx, userID, envID, ids)
	}
	if removed > 0 {
		_, _ = s.DB.Pool.Exec(ctx,
			`INSERT INTO audit_log (user_id, device_id, event, detail) VALUES ($1,'','snapshot.prune',$2)`,
			userID, envID+"/"+strconv.Itoa(removed))
		log.Printf("snapshot prune: env=%s removed=%d", envID, removed)
	}
}

// deleteStaleUploading：清掉超时未 commit 的 uploading 残骸，返回删除数。
func (s *Service) deleteStaleUploading(ctx context.Context, userID, envID string) int {
	rows, err := s.DB.Pool.Query(ctx,
		`DELETE FROM snapshots
		 WHERE env_id=$1 AND user_id=$2 AND state='uploading'
		   AND created_at < now() - make_interval(secs => $3)
		 RETURNING id`,
		envID, userID, s.Cfg.StaleUploadingTTL.Seconds())
	if err != nil {
		log.Printf("snapshot stale-upload delete: %v", err)
		return 0
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	return s.deleteSnaps(ctx, userID, envID, ids)
}

// deleteSnaps：删 DB 行 + S3 对象（manifest/blob 可能从未上传，删除幂等）。
func (s *Service) deleteSnaps(ctx context.Context, userID, envID string, ids []string) int {
	if len(ids) == 0 {
		return 0
	}
	var keys []string
	for _, snapID := range ids {
		mk, bk := s3s3.Keys(userID, envID, snapID)
		keys = append(keys, mk, bk)
	}
	if s.S3 != nil {
		if err := s.S3.Delete(ctx, keys...); err != nil {
			log.Printf("snapshot prune s3 delete: %v", err)
		}
	}
	del, err := s.DB.Pool.Exec(ctx,
		`DELETE FROM snapshots WHERE env_id=$1 AND user_id=$2 AND id = ANY($3)`,
		envID, userID, ids)
	if err != nil {
		log.Printf("snapshot prune delete: %v", err)
		return 0
	}
	return int(del.RowsAffected())
}

// RunStaleSweeper：周期清扫全库 uploading 残骸（commit 路径只清当前环境，
// 被放弃的环境靠这里兜底）。SweepInterval 与租约清扫共用配置。
func (s *Service) RunStaleSweeper(ctx context.Context) {
	if s.Cfg.StaleUploadingTTL <= 0 {
		return
	}
	t := time.NewTicker(s.Cfg.SweepInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			rows, err := s.DB.Pool.Query(ctx,
				`DELETE FROM snapshots WHERE state='uploading'
				   AND created_at < now() - make_interval(secs => $1)
				 RETURNING id, env_id, user_id`,
				s.Cfg.StaleUploadingTTL.Seconds())
			if err != nil {
				log.Printf("stale snapshot sweep: %v", err)
				continue
			}
			type staleSnap struct{ id, env, user string }
			var batch []staleSnap
			for rows.Next() {
				var sn staleSnap
				if rows.Scan(&sn.id, &sn.env, &sn.user) == nil {
					batch = append(batch, sn)
				}
			}
			rows.Close()
			for _, sn := range batch {
				mk, bk := s3s3.Keys(sn.user, sn.env, sn.id)
				if s.S3 != nil {
					if err := s.S3.Delete(ctx, mk, bk); err != nil {
						log.Printf("stale snapshot sweep s3: %v", err)
					}
				}
			}
			if len(batch) > 0 {
				log.Printf("stale snapshot sweep: removed %d uploading rows", len(batch))
			}
		}
	}
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
	ownerID, ok := s.envAccess(r, envID, id.UserID)
	if ok {
		var err error
		err = s.DB.Pool.QueryRow(r.Context(),
			`SELECT latest_base_id FROM environments WHERE id=$1`, envID).Scan(&latest)
		ok = err == nil
	}
	if !ok {
		writeErr(w, http.StatusNotFound, "env_not_found", "环境不存在")
		return
	}
	if latest == nil || *latest == "" {
		writeJSON(w, http.StatusOK, baseResp{HasBase: false})
		return
	}

	var meta baseMeta
	err := s.DB.Pool.QueryRow(r.Context(), `
		SELECT id, created_at, size_bytes, sha256, device_id FROM snapshots
		WHERE id=$1 AND env_id=$2 AND state='ready'`, *latest, envID).
		Scan(&meta.SnapshotID, &meta.CreatedAt, &meta.SizeBytes, &meta.SHA256, &meta.DeviceID)
	if err != nil {
		writeJSON(w, http.StatusOK, baseResp{HasBase: false})
		return
	}
	mk, bk := s3s3.Keys(ownerID, envID, meta.SnapshotID)
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
	ownerID, ok := s.snapAccess(r, envID, snapID, id.UserID)
	if !ok {
		writeErr(w, http.StatusNotFound, "snap_not_found", "快照不存在")
		return
	}
	err := s.DB.Pool.QueryRow(r.Context(), `
		SELECT id, created_at, size_bytes, sha256, device_id FROM snapshots
		WHERE id=$1 AND env_id=$2 AND state='ready'`, snapID, envID).
		Scan(&meta.SnapshotID, &meta.CreatedAt, &meta.SizeBytes, &meta.SHA256, &meta.DeviceID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "snap_not_found", "快照不存在")
		return
	}
	mk, bk := s3s3.Keys(ownerID, envID, snapID)
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
