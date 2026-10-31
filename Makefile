.PHONY: infra infra-down infra-logs server site desktop test test-db e2e e2e-teams desktop-build clean

# 一键开发栈：Postgres（docker）+ MinIO（本地二进制 :9000）
infra:
	bash scripts/dev-infra.sh

infra-down:
	docker compose -f deploy/docker-compose.yml down

infra-down-v:
	docker compose -f deploy/docker-compose.yml down -v

infra-logs:
	docker compose -f deploy/docker-compose.yml logs -f

# 一次性测试库（依赖 infra 的 Postgres；服务端集成测试经 TEST_DATABASE_URL 使用）
test-db:
	@docker exec onebrowser-postgres psql -U onebrowser -d postgres \
		-c "DROP DATABASE IF EXISTS onebrowser_test;" \
		-c "CREATE DATABASE onebrowser_test;"
	@echo "测试库就绪: postgres://onebrowser:onebrowser@127.0.0.1:5432/onebrowser_test"

# Go 服务端（默认连 localhost 的 compose 栈）
server:
	cd server && go run ./cmd/onesrv

# Go 测试站（:8080）
site:
	cd test-site && go run .

# Electron 桌面端（开发模式）
desktop:
	cd apps/desktop && pnpm dev

test: test-db
	cd server && TEST_DATABASE_URL="postgres://onebrowser:onebrowser@127.0.0.1:5432/onebrowser_test?sslmode=disable" go test ./...
	cd test-site && go test ./...

desktop-build:
	cd apps/desktop && pnpm install --silent && pnpm build

# 安装包（mac dmg x64+arm64；产物在 apps/desktop/release/，未签名=ad-hoc）
dist-mac:
	cd apps/desktop && pnpm dist:mac

# 端到端验证：需要先 make infra && make server && make site（各自后台运行）
e2e: desktop-build
	cd apps/desktop && pnpm e2e

# 团队协作端到端（V0.6：A邀B共享 / 吊C断访 / S3密文 / 轮换语义）
e2e-teams: desktop-build
	cd apps/desktop && pnpm e2e:teams

clean: infra-down-v
