#!/usr/bin/env bash
# 本地开发栈：Postgres（docker compose）+ MinIO（原生二进制，:9000）
# 服务端与桶初始化由 onesrv 启动时自动完成（s3s3.EnsureBucket）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Postgres (docker compose)"
docker compose -f "$ROOT/deploy/docker-compose.yml" up -d

echo "==> MinIO (:9000, console :9001)"
MINIO_DIR="$ROOT/.minio-data"
mkdir -p "$MINIO_DIR"
if curl -fsS -o /dev/null http://127.0.0.1:9000/minio/health/live 2>/dev/null; then
  echo "    已在运行"
else
  MINIO_ROOT_USER=onebrowser MINIO_ROOT_PASSWORD=onebrowser123 \
    nohup minio server "$MINIO_DIR" --address :9000 --console-address :9001 \
    > "$MINIO_DIR/minio.log" 2>&1 &
  echo $! > "$MINIO_DIR/minio.pid"
  for i in $(seq 1 20); do
    curl -fsS -o /dev/null http://127.0.0.1:9000/minio/health/live 2>/dev/null && break
    sleep 1
  done
fi
curl -fsS -o /dev/null http://127.0.0.1:9000/minio/health/live && echo "    就绪"

echo "==> 完成。启动服务端: make server"
