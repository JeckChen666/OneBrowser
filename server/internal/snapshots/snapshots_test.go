package snapshots

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"onebrowser/server/internal/auth"
	"onebrowser/server/internal/config"
	"onebrowser/server/internal/s3s3"
	"onebrowser/server/internal/store"
)

// 需要 TEST_DATABASE_URL（指向可丢弃的测试库），否则跳过；make test-db 提供一次性 postgres。
func testDB(t *testing.T) *store.Store {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	s, err := store.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = s.Pool.Exec(context.Background(),
			`TRUNCATE leases, snapshots, environments, auth_sessions, devices, users CASCADE`)
		s.Close()
	})
	return s
}

// 造用户 + snapshot 模式环境；retention=3。S3 接本地 MinIO（开发栈默认配置），
// 使 Create/Commit 的预签名与保留清理的对象删除都走真实链路；连不上则跳过。
func newTestService(t *testing.T) (*Service, string, string) {
	t.Helper()
	db := testDB(t)
	ctx := context.Background()

	cfg := config.Load()
	cfg.SnapshotRetention = 3
	cfg.StaleUploadingTTL = 1 * time.Hour
	cfg.S3StrictHead = false
	s3c := s3s3.New(cfg.S3Endpoint, cfg.S3Region, cfg.S3AccessKey, cfg.S3SecretKey, cfg.S3Bucket, cfg.S3UsePathStyle)
	if err := s3c.EnsureBucket(ctx); err != nil {
		t.Skipf("S3 不可达（跳过）: %v", err)
	}

	userID := store.NewUUID()
	envID := store.NewUUID()
	if _, err := db.Pool.Exec(ctx,
		`INSERT INTO users (id, email, verifier, auth_kdf, wrapped_dek, kek_kdf)
		 VALUES ($1,$2,'x','{}','{}','{}')`, userID, "retention-"+userID[:8]+"@t.local"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx,
		`INSERT INTO environments (id, user_id, name, mode) VALUES ($1,$2,'retention-env','snapshot')`,
		envID, userID); err != nil {
		t.Fatal(err)
	}
	return &Service{DB: db, S3: s3c, Cfg: cfg}, userID, envID
}

func insertSnap(t *testing.T, db *store.Store, userID, envID string, state string, age time.Duration) string {
	t.Helper()
	id := store.NewUUID()
	_, err := db.Pool.Exec(context.Background(),
		`INSERT INTO snapshots (id, env_id, user_id, device_id, state, created_at)
		 VALUES ($1,$2,$3,'dev',$4, now() - make_interval(secs => $5))`,
		id, envID, userID, state, age.Seconds())
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func readyIDs(t *testing.T, db *store.Store, envID string) map[string]bool {
	t.Helper()
	rows, err := db.Pool.Query(context.Background(),
		`SELECT id FROM snapshots WHERE env_id=$1 AND state='ready'`, envID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		out[id] = true
	}
	return out
}

// 经预签名 URL 直传对象（模拟客户端上传）。
func putObject(t *testing.T, url, body string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT 预签名对象失败: %s", resp.Status)
	}
}

func TestPruneEnvKeepsNewestNAndProtectsBase(t *testing.T) {
	svc, userID, envID := newTestService(t)
	ctx := context.Background()

	// 7 个 ready（snap0 最老 … snap6 最新），base 指向 snap2（故意不在最新 3 个内）
	ids := make([]string, 7)
	for i := 0; i < 7; i++ {
		ids[i] = insertSnap(t, svc.DB, userID, envID, "ready", time.Duration(7-i)*time.Minute)
	}
	base := ids[2]
	if _, err := svc.DB.Pool.Exec(ctx,
		`UPDATE environments SET latest_base_id=$2 WHERE id=$1`, envID, base); err != nil {
		t.Fatal(err)
	}
	// 新鲜 uploading（未超时，不应清理）与超时 uploading 残骸（应清理）
	fresh := insertSnap(t, svc.DB, userID, envID, "uploading", 2*time.Minute)
	stale := insertSnap(t, svc.DB, userID, envID, "uploading", 3*time.Hour)

	// 给将被清理的快照放真实 S3 对象（两条旧 ready + 一条残骸），清理后应消失
	for _, sn := range []string{ids[0], ids[1], stale} {
		mk, bk := s3s3.Keys(userID, envID, sn)
		for _, k := range []string{mk, bk} {
			url, err := svc.S3.PresignPut(ctx, k, time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			putObject(t, url, "x")
		}
	}

	svc.pruneEnv(ctx, userID, envID, base)

	got := readyIDs(t, svc.DB, envID)
	if len(got) != 4 { // 最新 3 个 + 受保护的 base
		t.Fatalf("ready 快照数 = %d（want 4）：%v", len(got), got)
	}
	for _, keep := range append(ids[4:], base) {
		if !got[keep] {
			t.Fatalf("应保留的快照 %s 不在了", keep)
		}
	}
	for _, gone := range ids[:2] {
		if got[gone] {
			t.Fatalf("超出保留数的旧快照 %s 未被清理", gone)
		}
	}
	var freshAlive, staleAlive bool
	_ = svc.DB.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM snapshots WHERE id=$1)`, fresh).Scan(&freshAlive)
	_ = svc.DB.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM snapshots WHERE id=$1)`, stale).Scan(&staleAlive)
	if !freshAlive {
		t.Fatal("未超时的 uploading 被误删")
	}
	if staleAlive {
		t.Fatal("超时的 uploading 残骸未被清理")
	}

	// S3 对象也应被删除；保留快照的对象即使不存在也不影响（读不到即视为通过）
	for _, sn := range []string{ids[0], ids[1], stale} {
		mk, bk := s3s3.Keys(userID, envID, sn)
		for _, k := range []string{mk, bk} {
			if _, ok := svc.S3.Head(ctx, k); ok {
				t.Fatalf("被清理快照 %s 的 S3 对象仍存在: %s", sn, k)
			}
		}
	}
}

func TestPruneEnvDisabledWhenRetentionZero(t *testing.T) {
	svc, userID, envID := newTestService(t)
	ctx := context.Background()
	svc.Cfg.SnapshotRetention = 0

	for i := 0; i < 8; i++ {
		insertSnap(t, svc.DB, userID, envID, "ready", time.Duration(8-i)*time.Minute)
	}
	svc.pruneEnv(ctx, userID, envID, "")
	if got := readyIDs(t, svc.DB, envID); len(got) != 8 {
		t.Fatalf("retention=0 应不清理，实剩 %d", len(got))
	}
}

// 配额：USER_QUOTA_GB 语义——已 ready 快照累计超配额后 Create 返回 413。
func TestCreateRejectsWhenQuotaExceeded(t *testing.T) {
	svc, userID, envID := newTestService(t)
	ctx := context.Background()
	svc.Cfg.UserQuotaBytes = 100 // 极小配额

	// 预置一份 150 字节的 ready 快照（直接写库模拟历史用量）
	q := insertSnap(t, svc.DB, userID, envID, "ready", time.Minute)
	if _, err := svc.DB.Pool.Exec(ctx,
		`UPDATE snapshots SET size_bytes=150 WHERE id=$1`, q); err != nil {
		t.Fatal(err)
	}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(auth.WithIdentity(req.Context(),
				auth.Identity{UserID: userID, DeviceID: "dev-1"})))
		})
	})
	r.Post("/envs/{envID}/snapshots/", svc.Create)
	srv := httptest.NewServer(r)
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/envs/"+envID+"/snapshots/", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusInsufficientStorage {
		t.Fatalf("超配额应 413，得到 %d", resp.StatusCode)
	}
	var body struct {
		Error struct{ Code string } `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if body.Error.Code != "quota_exceeded" {
		t.Fatalf("错误码应为 quota_exceeded，得到 %s", body.Error.Code)
	}

	// 配额放开（0=不限）后恢复
	svc.Cfg.UserQuotaBytes = 0
	resp2, err := http.Post(srv.URL+"/envs/"+envID+"/snapshots/", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusCreated {
		t.Fatalf("不限配额应 201，得到 %d", resp2.StatusCode)
	}
}

// 集成：Commit 触发异步保留清理（完整 HTTP 路径）。
func TestCommitTriggersPrune(t *testing.T) {
	svc, userID, envID := newTestService(t)

	for i := 0; i < 3; i++ {
		insertSnap(t, svc.DB, userID, envID, "ready", time.Duration(10-i)*time.Minute)
	}

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			next.ServeHTTP(w, req.WithContext(auth.WithIdentity(req.Context(),
				auth.Identity{UserID: userID, DeviceID: "dev-1"})))
		})
	})
	r.Route("/envs/{envID}/snapshots", func(r2 chi.Router) {
		r2.Post("/", svc.Create)
		r2.Post("/{snapID}/commit", svc.Commit)
	})
	srv := httptest.NewServer(r)
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/envs/"+envID+"/snapshots/", "application/json", nil)
	if err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: %v status=%v", err, resp)
	}
	var created struct {
		SnapshotID string            `json:"snapshotId"`
		Upload     map[string]string `json:"upload"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.SnapshotID == "" {
		t.Fatal("create 未返回 snapshotId")
	}

	// 客户端实际上传（manifest + blob），供清理路径删除
	for _, u := range created.Upload {
		putObject(t, u, "x")
	}
	mk, bk := s3s3.Keys(userID, envID, created.SnapshotID)
	// 该上传对应的旧 ready（insertSnap 的第 1 条，最老）的对象预置后应被清理
	oldMk, oldBk := s3s3.Keys(userID, envID, oldestReady(t, svc, envID))
	for _, k := range []string{oldMk, oldBk} {
		url, err := svc.S3.PresignPut(context.Background(), k, time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		putObject(t, url, "x")
	}

	cResp, err := http.Post(srv.URL+"/envs/"+envID+"/snapshots/"+created.SnapshotID+"/commit",
		"application/json", strings.NewReader(`{"sha256":"x","sizeBytes":1}`))
	if err != nil || cResp.StatusCode != http.StatusOK {
		t.Fatalf("commit: %v status=%v", err, cResp)
	}

	// prune 在 commit 后异步执行
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if got := readyIDs(t, svc.DB, envID); len(got) == 3 {
			// 被清理的旧快照对象应消失；新基线的对象仍在
			if _, ok := svc.S3.Head(context.Background(), oldMk); ok {
				t.Fatal("被清理快照的 S3 对象仍存在")
			}
			if _, ok := svc.S3.Head(context.Background(), mk); !ok {
				t.Fatal("新基线的 S3 对象被误删")
			}
			if _, ok := svc.S3.Head(context.Background(), bk); !ok {
				t.Fatal("新基线的 blob 被误删")
			}
			return // 通过：4 个 ready 收敛到最新 3 个
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("commit 后未收敛到 3 个 ready：%v", readyIDs(t, svc.DB, envID))
}

// oldestReady：当前最老的 ready 快照 ID（commit 清理后应消失的那个）。
func oldestReady(t *testing.T, svc *Service, envID string) string {
	t.Helper()
	var id string
	err := svc.DB.Pool.QueryRow(context.Background(),
		`SELECT id FROM snapshots WHERE env_id=$1 AND state='ready' ORDER BY created_at ASC LIMIT 1`,
		envID).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
