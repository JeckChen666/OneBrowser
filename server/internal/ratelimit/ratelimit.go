// Package ratelimit：进程内令牌桶限流（按 key，典型为客户端 IP）。
// 单实例部署足够；多实例时需换集中式后端（Redis）——当前规模不做。
package ratelimit

import (
	"math"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

type bucket struct {
	tokens float64
	last   time.Time
}

type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	rate    float64 // tokens/秒
	burst   float64
	swept   time.Time
}

// New：perMinute 为每分钟补充的令牌数（0 表示禁用限流），burst 为桶容量。
func New(perMinute, burst int) *Limiter {
	if perMinute <= 0 || burst <= 0 {
		return nil // nil Limiter = 全放行（配置关闭）
	}
	return &Limiter{
		buckets: map[string]*bucket{},
		rate:    float64(perMinute) / 60.0,
		burst:   float64(burst),
		swept:   time.Now(),
	}
}

// Allow：取一枚令牌；不足则 false。
func (l *Limiter) Allow(key string) bool {
	if l == nil {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens = math.Min(l.burst, b.tokens+now.Sub(b.last).Seconds()*l.rate)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	// 顺手清扫 stale 桶（避免 key 无限增长）
	if now.Sub(l.swept) > 10*time.Minute {
		for k, bb := range l.buckets {
			if now.Sub(bb.last) > time.Hour {
				delete(l.buckets, k)
			}
		}
		l.swept = now
	}
	return true
}

// Middleware：按 RealIP 限流，超限 429 + Retry-After。
func (l *Limiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !l.Allow(ClientIP(r)) {
			w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(60/l.rate))))
			http.Error(w, `{"error":{"code":"rate_limited","message":"请求过于频繁，请稍后再试"}}`, http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ClientIP：优先 X-Forwarded-For 首项（反代场景），否则 RemoteAddr。
func ClientIP(r *http.Request) string {
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		for i := 0; i < len(fwd); i++ {
			if fwd[i] == ',' {
				return fwd[:i]
			}
		}
		return fwd
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
