// onesrv：OneBrowser 服务端（V0.1.0）。
//
// 开发栈（deploy/docker-compose.yml）：
//
//	make infra   # Postgres + MinIO
//	make server
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"onebrowser/server/internal/api"
	"onebrowser/server/internal/auth"
	"onebrowser/server/internal/config"
	"onebrowser/server/internal/envs"
	"onebrowser/server/internal/leases"
	"onebrowser/server/internal/s3s3"
	"onebrowser/server/internal/snapshots"
	"onebrowser/server/internal/store"
	"onebrowser/server/internal/ws"
)

func main() {
	cfg := config.Load()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	db, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer db.Close()
	if err := db.Migrate(ctx); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	log.Printf("db ready (migrations applied)")

	s3c := s3s3.New(cfg.S3Endpoint, cfg.S3Region, cfg.S3AccessKey, cfg.S3SecretKey, cfg.S3Bucket, cfg.S3UsePathStyle)
	if err := s3c.EnsureBucket(ctx); err != nil {
		log.Fatalf("s3 ensure bucket: %v", err)
	}
	log.Printf("s3 ready (bucket=%s endpoint=%s)", cfg.S3Bucket, cfg.S3Endpoint)

	authSvc := auth.NewService(db, cfg.AuthSessionTTL)
	envSvc := &envs.Service{DB: db}
	snapSvc := &snapshots.Service{DB: db, S3: s3c, Cfg: cfg}
	leaseSvc := leases.New(db, cfg)
	hub := ws.NewHub(authSvc)
	leaseSvc.SetNotifier(hub)

	router := api.NewRouter(api.Deps{
		DB: db, S3: s3c, Auth: authSvc, Envs: envSvc, Snaps: snapSvc, Leases: leaseSvc, Hub: hub,
	})

	go leaseSvc.RunSweeper(ctx)

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Printf("onesrv listening on http://127.0.0.%s", cfg.ListenAddr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	<-ctx.Done()
	log.Println("shutting down...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}
