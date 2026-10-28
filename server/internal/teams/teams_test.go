package teams

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/go-chi/chi/v5"

	"onebrowser/server/internal/auth"
	"onebrowser/server/internal/config"
	"onebrowser/server/internal/envs"
	"onebrowser/server/internal/s3s3"
	"onebrowser/server/internal/snapshots"
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
			`TRUNCATE leases, snapshots, environments, team_members, teams, auth_sessions, devices, users CASCADE`)
		s.Close()
	})
	return s
}

// seedUser 插入用户（identityPub 可为空=旧账号）返回 userID
func seedUser(t *testing.T, db *store.Store, email, identityPub string) string {
	t.Helper()
	id := store.NewUUID()
	_, err := db.Pool.Exec(context.Background(),
		`INSERT INTO users (id, email, verifier, auth_kdf, wrapped_dek, kek_kdf, identity_pub)
		 VALUES ($1,$2,'v','{}','w','{}',$3)`, id, email, identityPub)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// newRouter 装配 teams + envs + snapshots 路由；X-Test-User 头注入身份（仅测试）
func newRouter(t *testing.T) (*store.Store, http.Handler, *auth.Service) {
	t.Helper()
	db := testDB(t)
	ts := &Service{DB: db}
	es := &envs.Service{DB: db}
	// S3 接本地 localstack（开发栈）；不可达则快照断言降级跳过
	cfg := config.Load()
	cfg.UserQuotaBytes = 1 << 30
	cfg.S3Endpoint = getenvDefault("S3_ENDPOINT_TEST", "http://127.0.0.1:4566")
	s3c := s3s3.New(cfg.S3Endpoint, cfg.S3Region, cfg.S3AccessKey, cfg.S3SecretKey, cfg.S3Bucket, true)
	if err := s3c.EnsureBucket(context.Background()); err != nil {
		t.Skipf("S3 不可达（跳过）: %v", err)
	}
	ss := &snapshots.Service{DB: db, S3: s3c, Cfg: cfg}
	authSvc := auth.NewService(db, 0)

	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			uid := req.Header.Get("X-Test-User")
			next.ServeHTTP(w, req.WithContext(auth.WithIdentity(req.Context(),
				auth.Identity{UserID: uid, DeviceID: "dev-test", Email: uid + "@t.local"})))
		})
	})
	r.Post("/v1/teams", ts.Create)
	r.Get("/v1/teams", ts.List)
	r.Get("/v1/users", ts.LookupUser)
	r.Post("/v1/teams/{teamID}/members", ts.AddMember)
	r.Get("/v1/teams/{teamID}/members", ts.ListMembers)
	r.Post("/v1/teams/{teamID}/members/{userID}/revoke", ts.Revoke)
	r.Put("/v1/teams/{teamID}/dek", ts.RotateDek)
	r.Post("/v1/invites/{teamID}/accept", ts.AcceptInvite)
	r.Post("/v1/invites/{teamID}/decline", ts.DeclineInvite)
	r.Get("/v1/envs", es.List)
	r.Post("/v1/envs", es.Create)
	r.Post("/v1/envs/{envID}/snapshots", ss.Create)
	return db, r, authSvc
}

func call(t *testing.T, h http.Handler, method, path, asUser string, body any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rdr)
	req.Header.Set("X-Test-User", asUser)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if out == nil {
		out = map[string]any{}
	}
	return w, out
}

func getenvDefault(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func TestTeamsFullFlow(t *testing.T) {
	db, h, _ := newRouter(t)
	ctx := context.Background()

	a := seedUser(t, db, "a@t.local", "pub-A")
	b := seedUser(t, db, "b@t.local", "pub-B")
	c := seedUser(t, db, "c@t.local", "pub-C")

	// 建团
	w, out := call(t, h, "POST", "/v1/teams", a, map[string]string{"name": "测试团", "wrappedSelfDek": "envA"})
	if w.Code != http.StatusCreated {
		t.Fatalf("建团应 201: %d %v", w.Code, out)
	}
	teamID, _ := out["teamId"].(string)

	// 公钥查询：命中/未知
	w, out = call(t, h, "GET", "/v1/users?email=b@t.local", a, nil)
	if w.Code != http.StatusOK || out["identityPub"] != "pub-B" {
		t.Fatalf("公钥查询不符: %d %v", w.Code, out)
	}
	w, _ = call(t, h, "GET", "/v1/users?email=ghost@t.local", a, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("未知邮箱应 404: %d", w.Code)
	}

	// 邀请 B → pending → B 接受 → active
	w, _ = call(t, h, "POST", "/v1/teams/"+teamID+"/members", a,
		map[string]string{"userId": b, "wrappedTeamDek": "envB", "role": "member"})
	if w.Code != http.StatusCreated {
		t.Fatalf("邀请应 201: %d", w.Code)
	}
	w, out = call(t, h, "GET", "/v1/teams", b, nil)
	teamsB, _ := out["teams"].([]any)
	if len(teamsB) != 1 || teamsB[0].(map[string]any)["state"] != "pending" {
		t.Fatalf("B 应看到 pending 邀请: %v", out)
	}
	w, _ = call(t, h, "POST", "/v1/invites/"+teamID+"/accept", b, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("接受邀请应 200: %d", w.Code)
	}

	// member B 不可邀请（角色闸）
	w, _ = call(t, h, "POST", "/v1/teams/"+teamID+"/members", b,
		map[string]string{"userId": c, "wrappedTeamDek": "envC"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("member 邀请应 403: %d", w.Code)
	}

	// B（member）创建团队环境 → user_id 归因 owner（A）
	w, out = call(t, h, "POST", "/v1/envs", b, map[string]any{
		"id": "env-team-1", "name": "团队环境", "mode": "snapshot", "configEnc": "enc", "teamId": teamID,
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("团队环境创建应 201: %d %v", w.Code, out)
	}
	var envOwner, envTeam string
	if err := db.Pool.QueryRow(ctx,
		`SELECT user_id, COALESCE(team_id,'') FROM environments WHERE id='env-team-1'`).Scan(&envOwner, &envTeam); err != nil {
		t.Fatal(err)
	}
	if envOwner != a || envTeam != teamID {
		t.Fatalf("归因不符：owner=%s(应 %s) team=%s", envOwner, a, envTeam)
	}

	// 可见性：A/B 可见；无关用户 C 不可见
	for _, uid := range []string{a, b} {
		_, out = call(t, h, "GET", "/v1/envs", uid, nil)
		envsList, _ := out["envs"].([]any)
		if len(envsList) != 1 {
			t.Fatalf("用户 %s 应看到 1 个团队环境: %v", uid, out)
		}
	}
	_, out = call(t, h, "GET", "/v1/envs", c, nil)
	if envsList, _ := out["envs"].([]any); len(envsList) != 0 {
		t.Fatalf("无关用户不应看到团队环境: %v", out)
	}

	// B（成员）上传快照 → snapshots.user_id 归因 owner（A），配额计入 A
	w, out = call(t, h, "POST", "/v1/envs/env-team-1/snapshots", b, map[string]string{"deviceId": "dev-B"})
	if w.Code != http.StatusCreated {
		t.Fatalf("成员上传应 201: %d %v", w.Code, out)
	}
	snapID, _ := out["snapshotId"].(string)
	var snapOwner string
	if err := db.Pool.QueryRow(ctx,
		`SELECT user_id FROM snapshots WHERE id=$1`, snapID).Scan(&snapOwner); err != nil {
		t.Fatal(err)
	}
	if snapOwner != a {
		t.Fatalf("快照归因应 owner: %s", snapOwner)
	}

	// 轮换：覆盖不全 → 400；正确覆盖 [A,B] → 200
	w, _ = call(t, h, "PUT", "/v1/teams/"+teamID+"/dek", a, map[string]any{"items": []map[string]string{
		{"userId": a, "wrappedTeamDek": "envA2"},
	}})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("覆盖不全应 400: %d", w.Code)
	}
	w, _ = call(t, h, "PUT", "/v1/teams/"+teamID+"/dek", a, map[string]any{"items": []map[string]string{
		{"userId": a, "wrappedTeamDek": "envA2"},
		{"userId": b, "wrappedTeamDek": "envB2"},
	}})
	if w.Code != http.StatusOK {
		t.Fatalf("正确轮换应 200: %d", w.Code)
	}

	// owner 不可被吊销
	w, _ = call(t, h, "POST", "/v1/teams/"+teamID+"/members/"+a+"/revoke", a, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("吊销 owner 应 400: %d", w.Code)
	}

	// 吊销 B → 环境不可见 + 上传断 + 成员列表断
	w, _ = call(t, h, "POST", "/v1/teams/"+teamID+"/members/"+b+"/revoke", a, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("吊销应 200: %d", w.Code)
	}
	_, out = call(t, h, "GET", "/v1/envs", b, nil)
	if envsList, _ := out["envs"].([]any); len(envsList) != 0 {
		t.Fatalf("吊销后 B 不应再看到团队环境: %v", out)
	}
	w, _ = call(t, h, "POST", "/v1/envs/env-team-1/snapshots", b, map[string]string{"deviceId": "dev-B"})
	if w.Code != http.StatusNotFound {
		t.Fatalf("吊销后上传应 404: %d", w.Code)
	}
	w, _ = call(t, h, "GET", "/v1/teams/"+teamID+"/members", b, nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("吊销后成员列表应 403: %d", w.Code)
	}

	// 吊销后重邀（push 覆盖）→ 再接受
	w, _ = call(t, h, "POST", "/v1/teams/"+teamID+"/members", a,
		map[string]string{"userId": b, "wrappedTeamDek": "envB3"})
	if w.Code != http.StatusCreated {
		t.Fatalf("重邀应 201: %d", w.Code)
	}
	w, _ = call(t, h, "POST", "/v1/invites/"+teamID+"/decline", b, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("拒绝应 200: %d", w.Code)
	}
}

func TestSetIdentityBackfill(t *testing.T) {
	db, _, authSvc := newRouter(t)

	// 注册（不带身份密钥对，模拟旧客户端路径）
	reg := map[string]any{
		"email": "old@t.local", "authKey": "k", "wrappedDek": "d",
		"authKdf": map[string]any{"alg": "argon2id", "m": 64, "t": 1, "p": 1, "salt": "c2FsdA=="},
		"kekKdf":  map[string]any{"alg": "argon2id", "m": 64, "t": 1, "p": 1, "salt": "c2FsdA=="},
	}
	body, _ := json.Marshal(reg)
	w := httptest.NewRecorder()
	authSvc.HandleRegister(w, httptest.NewRequest("POST", "/v1/auth/register", bytes.NewReader(body)))
	if w.Code != http.StatusCreated {
		t.Fatalf("注册应 201: %d %s", w.Code, w.Body.String())
	}

	setID := func(pub, priv string) int {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/v1/auth/identity",
			bytes.NewReader([]byte(`{"identityPub":"`+pub+`","wrappedIdentityPriv":"`+priv+`"}`)))
		req = req.WithContext(auth.WithIdentity(req.Context(),
			auth.Identity{UserID: userIDByEmail(t, db, "old@t.local"), DeviceID: "d"}))
		authSvc.HandleSetIdentity(w, req)
		return w.Code
	}
	if code := setID("pub-1", "priv-1"); code != http.StatusOK {
		t.Fatalf("回填应 200: %d", code)
	}
	if code := setID("pub-2", "priv-2"); code != http.StatusConflict {
		t.Fatalf("二次回填应 409（不可覆盖）: %d", code)
	}
}

func userIDByEmail(t *testing.T, db *store.Store, email string) string {
	t.Helper()
	var id string
	if err := db.Pool.QueryRow(context.Background(),
		`SELECT id FROM users WHERE email=$1`, email).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
