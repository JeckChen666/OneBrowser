package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

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

func TestRegisterLoginLogoutFlow(t *testing.T) {
	db := testDB(t)
	svc := NewService(db, time.Hour)

	email := store.NewUUID() + "@t.local"
	kdf := KdfParams{Alg: "argon2id", M: 64, T: 1, P: 1, Salt: "c2FsdA"}

	// 注册
	reg := registerReq{Email: email, AuthKey: "the-auth-key", AuthKdf: kdf, WrappedDek: "enc-envelope", KekKdf: kdf}
	body, _ := json.Marshal(reg)
	w := httptest.NewRecorder()
	svc.HandleRegister(w, httptest.NewRequest("POST", "/v1/auth/register", bytes.NewReader(body)))
	if w.Code != http.StatusCreated {
		t.Fatalf("register = %d %s", w.Code, w.Body.String())
	}

	// kdf-info 返回派生参数
	w = httptest.NewRecorder()
	svc.HandleKdfInfo(w, httptest.NewRequest("GET", "/v1/auth/kdf-info?email="+email, nil))
	if w.Code != http.StatusOK || !bytes.Contains(w.Body.Bytes(), []byte("c2FsdA")) {
		t.Fatalf("kdf-info = %d %s", w.Code, w.Body.String())
	}
	// 未知邮箱不暴露
	w = httptest.NewRecorder()
	svc.HandleKdfInfo(w, httptest.NewRequest("GET", "/v1/auth/kdf-info?email=nobody@x.local", nil))
	if w.Code != http.StatusOK || bytes.Contains(w.Body.Bytes(), []byte("c2FsdA")) {
		t.Fatalf("kdf-info unknown = %d %s", w.Code, w.Body.String())
	}

	// 登录（错误凭据 → 401；正确 → 返回信封）
	login := loginReq{Email: email, AuthKey: "wrong", DeviceID: "dev1", DeviceName: "mac", Platform: "darwin"}
	body, _ = json.Marshal(login)
	w = httptest.NewRecorder()
	svc.HandleLogin(w, httptest.NewRequest("POST", "/v1/auth/login", bytes.NewReader(body)))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("bad login = %d", w.Code)
	}

	login.AuthKey = "the-auth-key"
	body, _ = json.Marshal(login)
	w = httptest.NewRecorder()
	svc.HandleLogin(w, httptest.NewRequest("POST", "/v1/auth/login", bytes.NewReader(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("login = %d %s", w.Code, w.Body.String())
	}
	var resp loginResp
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.WrappedDek != "enc-envelope" || resp.Token == "" || resp.DeviceID != "dev1" {
		t.Fatalf("login resp = %+v", resp)
	}

	// 中间件：有效 token 注入身份
	req := httptest.NewRequest("GET", "/v1/auth/me", nil)
	req.Header.Set("Authorization", "Bearer "+resp.Token)
	w = httptest.NewRecorder()
	svc.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, err := FromContext(r.Context())
		if err != nil || id.Email != email {
			t.Fatalf("identity = %+v, %v", id, err)
		}
		w.WriteHeader(200)
	})).ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("middleware = %d", w.Code)
	}

	// 登出后 token 失效（经中间件注入身份后调用 logout）
	req = httptest.NewRequest("POST", "/v1/auth/logout", nil)
	req.Header.Set("Authorization", "Bearer "+resp.Token)
	w = httptest.NewRecorder()
	svc.Middleware(http.HandlerFunc(svc.HandleLogout)).ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("logout = %d", w.Code)
	}
	req2 := httptest.NewRequest("GET", "/v1/auth/me", nil)
	req2.Header.Set("Authorization", "Bearer "+resp.Token)
	w = httptest.NewRecorder()
	svc.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
	})).ServeHTTP(w, req2)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("token should be invalid after logout, got %d", w.Code)
	}
}
