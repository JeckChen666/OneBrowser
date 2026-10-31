package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"onebrowser/server/internal/config"
	"onebrowser/server/internal/s3s3"
	"onebrowser/server/internal/store"
)

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

// passthroughLimiter：测试中不用真实令牌桶
func passthroughLimiter(h http.HandlerFunc) http.HandlerFunc { return h }

const testToken = "unit-admin-token-42"

func newSvc(t *testing.T) (*store.Store, *Service, http.Handler) {
	t.Helper()
	// S3 指向必然不可达的端点：Probe 返回 error（overview 显示 down），验证不 panic
	db := testDB(t)
	s3c := s3s3.New("http://127.0.0.1:1", "us-east-1", "x", "x", "bucket-x", true)
	cfg := config.Config{
		AdminToken:        testToken,
		UserQuotaBytes:    2 << 30,
		SnapshotRetention: 5,
		AuthRatePerMin:    20,
	}
	svc := New(db, s3c, cfg)
	return db, svc, svc.Handler(passthroughLimiter)
}

func login(t *testing.T, h http.Handler, token string) *http.Cookie {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"token": token})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/api/login", bytes.NewReader(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("login code=%d body=%s", w.Code, w.Body.String())
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == cookieName {
			return c
		}
	}
	t.Fatal("login 未下发 cookie")
	return nil
}

func TestAdminAuthFlow(t *testing.T) {
	_, _, h := newSvc(t)

	// 错口令 → 401 且无 cookie
	body, _ := json.Marshal(map[string]string{"token": "wrong"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/api/login", bytes.NewReader(body)))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("错口令应 401，得到 %d", w.Code)
	}

	// 未登录访问受保护端点 → 401
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/overview", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("未登录 overview 应 401，得到 %d", w.Code)
	}

	// 正确口令 → 200 + HttpOnly cookie
	ck := login(t, h, testToken)
	if !ck.HttpOnly {
		t.Fatal("cookie 必须 HttpOnly")
	}

	// cookie 会话可用
	w = httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/session", nil)
	r.AddCookie(ck)
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("session 应 200，得到 %d", w.Code)
	}

	// Bearer 也可用（curl 场景）
	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/api/overview", nil)
	r.Header.Set("Authorization", "Bearer "+testToken)
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("bearer overview 应 200，得到 %d", w.Code)
	}

	// 错误 Bearer → 401
	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/api/overview", nil)
	r.Header.Set("Authorization", "Bearer wrong")
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("错误 bearer 应 401，得到 %d", w.Code)
	}

	// 登出：浏览器会用响应的 Set-Cookie（MaxAge=-1 删除指令，值为空）替换旧 cookie
	w = httptest.NewRecorder()
	r = httptest.NewRequest("POST", "/api/logout", nil)
	r.AddCookie(ck)
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("logout 应 200，得到 %d", w.Code)
	}
	var cleared *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == cookieName {
			cleared = c
		}
	}
	if cleared == nil || cleared.MaxAge >= 0 || cleared.Value != "" {
		t.Fatalf("logout 未下发删除 cookie: %v", cleared)
	}
	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/api/session", nil)
	r.AddCookie(cleared)
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("登出后 session 应 401，得到 %d", w.Code)
	}
}

func TestAdminDataShape(t *testing.T) {
	db, _, h := newSvc(t)
	ctx := context.Background()

	// 造数：1 用户 + 1 环境 + 1 ready 快照 + 1 活跃租约
	_, err := db.Pool.Exec(ctx, `
		INSERT INTO users (id, email, verifier, auth_kdf, wrapped_dek, kek_kdf)
		VALUES ('u-1', 'shape@t.local', 'v', '{}', 'w', '{}')`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `
		INSERT INTO environments (id, user_id, name, mode)
		VALUES ('e-1', 'u-1', '形状环境', 'snapshot')`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `
		INSERT INTO snapshots (id, env_id, user_id, device_id, state, size_bytes, created_at)
		VALUES ('s-1', 'e-1', 'u-1', 'dev-123456789', 'ready', 4096, now())`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `
		INSERT INTO environments (id, user_id, name, mode, latest_base_id)
		VALUES ('e-2', 'u-1', '带基线环境', 'exclusive', 's-1')`)
	if err != nil {
		t.Fatal(err)
	}

	ck := login(t, h, testToken)
	get := func(path string) []map[string]any {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", path, nil)
		r.AddCookie(ck)
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("%s 应 200，得到 %d: %s", path, w.Code, w.Body.String())
		}
		var arr []map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &arr)
		return arr
	}

	// users
	users := get("/api/users")
	if len(users) != 1 || users[0]["email"] != "shape@t.local" {
		t.Fatalf("users 形状不符: %v", users)
	}
	if users[0]["envs"].(float64) != 2 {
		t.Fatalf("users.envs 应为 2: %v", users[0])
	}

	// envs：e-2 带 base 元数据；e-1 无基线且无租约
	envs := get("/api/envs")
	if len(envs) != 2 {
		t.Fatalf("envs 应 2 条: %v", envs)
	}
	var withBase, noBase map[string]any
	for _, e := range envs {
		if e["name"] == "带基线环境" {
			withBase = e
		} else {
			noBase = e
		}
	}
	if withBase["baseSize"].(float64) != 4096 {
		t.Fatalf("baseSize 应 4096: %v", withBase)
	}
	if _, has := noBase["baseSize"]; has {
		t.Fatalf("无基线环境不应有 baseSize: %v", noBase)
	}
	if _, has := noBase["lease"]; has {
		t.Fatalf("空闲环境不应有 lease: %v", noBase)
	}

	// snapshots：设备号截断为 8 位
	snaps := get("/api/snapshots")
	if len(snaps) != 1 || snaps[0]["device"] != "dev-1234" {
		t.Fatalf("snapshots 形状不符: %v", snaps)
	}

	// overview 总数
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/overview", nil)
	r.AddCookie(ck)
	h.ServeHTTP(w, r)
	var ov map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &ov); err != nil {
		t.Fatal(err)
	}
	if ov["users"].(float64) != 1 || ov["envs"].(float64) != 2 || ov["snapshots"].(float64) != 1 {
		t.Fatalf("overview 计数不符: %v", ov)
	}
	if ov["db"] != "ok" {
		t.Fatalf("overview db 应 ok: %v", ov["db"])
	}
	// 治理参数应从 config 接入（曾出现「字段声明但从未赋值」回归）
	if ov["quotaBytes"].(float64) != float64(2<<30) || ov["snapshotRetention"].(float64) != 5 || ov["authRatePerMin"].(float64) != 20 {
		t.Fatalf("overview 治理参数未接入: %v", ov)
	}
	// S3 指向不可达端点：应给出 down 且不带 panic
	if ov["s3"] == "ok" {
		t.Fatalf("不可达 S3 不应显示 ok: %v", ov["s3"])
	}
}

// TestAdminTeamsView 团队只读视图（V0.6）：归因计数与团队环境标注。
func TestAdminTeamsView(t *testing.T) {
	db, _, h := newSvc(t)
	ctx := context.Background()

	seed := func(id, email, pub string) {
		_, err := db.Pool.Exec(ctx,
			`INSERT INTO users (id, email, verifier, auth_kdf, wrapped_dek, kek_kdf, identity_pub)
			 VALUES ($1,$2,'v','{}','w','{}',$3)`, id, email, pub)
		if err != nil {
			t.Fatal(err)
		}
	}
	seed("u-own", "owner@t.local", "pub-own")
	seed("u-mem", "member@t.local", "pub-mem")
	seed("u-out", "outsider@t.local", "")

	if _, err := db.Pool.Exec(ctx, `
		INSERT INTO teams (id, name, owner_id) VALUES ('t-1', '形状团队', 'u-own')`); err != nil {
		t.Fatal(err)
	}
	members := []struct{ uid, role, state string }{
		{"u-own", "owner", "active"},
		{"u-mem", "member", "active"},
		{"u-out", "member", "pending"},
	}
	for _, m := range members {
		if _, err := db.Pool.Exec(ctx, `
			INSERT INTO team_members (team_id, user_id, role, state, wrapped_team_dek)
			VALUES ('t-1',$1,$2,$3,'env')`, m.uid, m.role, m.state); err != nil {
			t.Fatal(err)
		}
	}
	// 团队环境（归因 owner）+ 其基线快照；另有 outsider 的个人环境
	if _, err := db.Pool.Exec(ctx, `
		INSERT INTO environments (id, user_id, name, mode, team_id)
		VALUES ('te-1', 'u-own', '团队环境', 'snapshot', 't-1')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `
		INSERT INTO snapshots (id, env_id, user_id, device_id, state, size_bytes)
		VALUES ('ts-1', 'te-1', 'u-own', 'dev-x', 'ready', 8192)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `
		INSERT INTO environments (id, user_id, name, mode)
		VALUES ('pe-1', 'u-out', '个人环境', 'snapshot')`); err != nil {
		t.Fatal(err)
	}

	ck := login(t, h, testToken)
	get := func(path string) []map[string]any {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("GET", path, nil)
		r.AddCookie(ck)
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("%s 应 200，得到 %d: %s", path, w.Code, w.Body.String())
		}
		var arr []map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &arr)
		return arr
	}

	// teams：active 2 / pending 1 / envs 1 / snapBytes 8192
	teams := get("/api/teams")
	if len(teams) != 1 {
		t.Fatalf("teams 应 1 条: %v", teams)
	}
	tm := teams[0]
	if tm["name"] != "形状团队" || tm["ownerEmail"] != "owner@t.local" {
		t.Fatalf("teams 基本字段不符: %v", tm)
	}
	if tm["members"].(float64) != 2 || tm["pendingInvites"].(float64) != 1 || tm["envs"].(float64) != 1 {
		t.Fatalf("teams 归因计数不符: %v", tm)
	}
	if tm["snapBytes"].(float64) != 8192 {
		t.Fatalf("teams.snapBytes 应 8192: %v", tm)
	}

	// envs：团队环境带 team 标注，个人环境不带
	envs := get("/api/envs")
	var teamEnv, personalEnv map[string]any
	for _, e := range envs {
		if e["name"] == "团队环境" {
			teamEnv = e
		} else {
			personalEnv = e
		}
	}
	if teamEnv == nil || teamEnv["team"] != "形状团队" {
		t.Fatalf("团队环境应带 team 标注: %v", teamEnv)
	}
	if personalEnv == nil {
		t.Fatal("个人环境应存在")
	}
	if _, has := personalEnv["team"]; has {
		t.Fatalf("个人环境不应有 team 标注: %v", personalEnv)
	}

	// overview：teams 计数
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/overview", nil)
	r.AddCookie(ck)
	h.ServeHTTP(w, r)
	var ov map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &ov); err != nil {
		t.Fatal(err)
	}
	if ov["teams"].(float64) != 1 {
		t.Fatalf("overview.teams 应 1: %v", ov)
	}
}

func TestAdminIndexPage(t *testing.T) {
	_, _, h := newSvc(t)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("index 应 200，得到 %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Fatalf("Content-Type 不符: %s", ct)
	}
	if !bytes.Contains(w.Body.Bytes(), []byte("运维工作台")) {
		t.Fatal("index 应包含标题")
	}
}
