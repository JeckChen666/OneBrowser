.PHONY: infra infra-down infra-logs server site desktop test e2e desktop-build clean

# 一键开发栈：Postgres（docker）+ MinIO（本地二进制 :9000）
infra:
	bash scripts/dev-infra.sh

infra-down:
	docker compose -f deploy/docker-compose.yml down

infra-down-v:
	docker compose -f deploy/docker-compose.yml down -v

infra-logs:
	docker compose -f deploy/docker-compose.yml logs -f

# Go 服务端（默认连 localhost 的 compose 栈）
server:
	cd server && go run ./cmd/onesrv

# Go 测试站（:8080）
site:
	cd test-site && go run .

# Electron 桌面端（开发模式）
desktop:
	cd apps/desktop && pnpm dev

test:
	cd server && go test ./...
	cd test-site && go test ./...

desktop-build:
	cd apps/desktop && pnpm install --silent && pnpm build

# 端到端验证：需要先 make infra && make server && make site（各自后台运行）
e2e: desktop-build
	cd apps/desktop && pnpm e2e

clean: infra-down-v
