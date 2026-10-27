// Package config 加载服务端环境变量配置。
package config

import (
	"os"
	"strconv"
	"time"
)

type Config struct {
	ListenAddr  string
	DatabaseURL string

	S3Endpoint     string
	S3Region       string
	S3AccessKey    string
	S3SecretKey    string
	S3Bucket       string
	S3UsePathStyle bool
	S3StrictHead   bool // commit 时是否强校验对象已存在（测试可关）

	AuthSessionTTL time.Duration

	EvictDeadline time.Duration // 驱逐宽限
	HeartbeatTTL  time.Duration // 心跳失联判定
	SweepInterval time.Duration

	SnapshotRetention int           // 每环境保留的 ready 快照数（最新 N 个；0=不清理）
	StaleUploadingTTL time.Duration // uploading 未 commit 的过期时长（残骸清扫）

	AuthRatePerMin int   // 认证接口每 IP 每分钟令牌数（0=不限流）
	AuthRateBurst int    // 令牌桶容量
	UserQuotaBytes int64 // 每用户快照存储配额（0=不限）

	AdminToken string // 运维工作台口令（空=不挂载 /admin）

	PresignPutTTL time.Duration
	PresignGetTTL time.Duration
}

func Load() Config {
	return Config{
		ListenAddr:  getenv("LISTEN_ADDR", ":8787"),
		DatabaseURL: getenv("DATABASE_URL", "postgres://onebrowser:onebrowser@127.0.0.1:5432/onebrowser?sslmode=disable"),

		S3Endpoint:     getenv("S3_ENDPOINT", "http://127.0.0.1:9000"),
		S3Region:       getenv("S3_REGION", "us-east-1"),
		S3AccessKey:    getenv("S3_ACCESS_KEY", "onebrowser"),
		S3SecretKey:    getenv("S3_SECRET_KEY", "onebrowser123"),
		S3Bucket:       getenv("S3_BUCKET", "onebrowser-snapshots"),
		S3UsePathStyle: getenv("S3_USE_PATH_STYLE", "true") == "true",
		S3StrictHead:   getenv("S3_STRICT_HEAD", "true") == "true",

		AuthSessionTTL: 30 * 24 * time.Hour,

		EvictDeadline: 15 * time.Second,
		HeartbeatTTL:  30 * time.Second,
		SweepInterval: 5 * time.Second,

		SnapshotRetention: getenvInt("SNAPSHOT_RETENTION", 5),
		StaleUploadingTTL: time.Duration(getenvInt("STALE_UPLOADING_HOURS", 24)) * time.Hour,

		AuthRatePerMin: getenvInt("AUTH_RATE_PER_MIN", 20),
		AuthRateBurst:  getenvInt("AUTH_RATE_BURST", 10),
		UserQuotaBytes: int64(getenvInt("USER_QUOTA_GB", 2)) << 30,

		AdminToken: getenv("ADMIN_TOKEN", ""),

		PresignPutTTL: 15 * time.Minute,
		PresignGetTTL: 60 * time.Minute,
	}
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func getenvInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
	}
	return def
}
