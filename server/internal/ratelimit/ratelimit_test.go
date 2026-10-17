package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLimiterAllowsBurstThenRejects(t *testing.T) {
	l := New(600, 3) // 每分钟 600（每秒 10）——补充极快，主要看桶容量
	for i := 0; i < 3; i++ {
		if !l.Allow("ip-a") {
			t.Fatalf("桶内第 %d 次应放行", i+1)
		}
	}
	if l.Allow("ip-a") {
		t.Fatal("超出桶容量应拒绝")
	}
	// 其他 key 不受影响
	if !l.Allow("ip-b") {
		t.Fatal("不同 key 应独立计桶")
	}
}

func TestLimiterRefillsOverTime(t *testing.T) {
	l := New(6000, 1) // 每秒 100，补充立等可取
	if !l.Allow("k") {
		t.Fatal("首次应放行")
	}
	if l.Allow("k") {
		t.Fatal("桶空应拒绝")
	}
	time.Sleep(30 * time.Millisecond)
	if !l.Allow("k") {
		t.Fatal("补充后应恢复放行")
	}
}

func TestNilLimiterAllowsAll(t *testing.T) {
	var l *Limiter // 配置关闭（AUTH_RATE_PER_MIN=0）
	for i := 0; i < 100; i++ {
		if !l.Allow("any") {
			t.Fatal("nil Limiter 应全放行")
		}
	}
}

func TestMiddlewareReturns429(t *testing.T) {
	l := New(1, 2) // 几乎不补充
	h := l.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodPost, "/v1/auth/login", nil)
	req.RemoteAddr = "1.2.3.4:5678"
	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("第 %d 次应 200，得到 %d", i+1, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("超限应 429，得到 %d", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("应带 Retry-After")
	}
}

func TestClientIPXForwardedFor(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.1:1234"
	req.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.2")
	if got := ClientIP(req); got != "203.0.113.9" {
		t.Fatalf("XFF 首项优先：got %s", got)
	}
	req2 := httptest.NewRequest(http.MethodGet, "/", nil)
	req2.RemoteAddr = "10.0.0.1:1234"
	if got := ClientIP(req2); got != "10.0.0.1" {
		t.Fatalf("无 XFF 用 RemoteAddr host：got %s", got)
	}
}
