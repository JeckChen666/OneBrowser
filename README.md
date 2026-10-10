# OneBrowser

> 指纹环境 + 登录态云端共享的浏览器（V0.1.0，MVP = 规划中的 M0–M4）
>
> 调研报告：[docs/research-report.md](docs/research-report.md) · 总体规划：[docs/project-plan.md](docs/project-plan.md) · 版本范围：[docs/v0.1.0-scope.md](docs/v0.1.0-scope.md)

## ⚠️ 工作流约定（必读）

**[NextStep.md](NextStep.md) 是本项目的唯一「工作指针」，必须持续维护。**

- **开始任何开发工作前**：先读 `NextStep.md`，从「下一步」列表第一项开始，不要凭记忆或猜测决定做什么；
- **完成一项工作后**：立即更新 `NextStep.md`（移入归档、刷新状态快照），再提交代码；
- **它必须始终反映真实的下一步**——发现内容与实际不符时，先修正它再动手。

## 这是什么

一个「环境隔离浏览器 + 登录态云端存储」系统：

- **模式一（快照分支）**：在某台电脑的环境里完成登录后，把登录态（cookie + localStorage）作为**基线快照**加密上云；之后在任何设备打开该环境，都从基线**克隆分支**，关闭即弃——基线永不被本地改动污染（更新基线是显式操作）。
- **模式二（互斥接管）**：同一环境同一时刻只允许一台设备使用。设备 B 请求打开时，持有者 A 会被**强制下线**——下线前自动抓取最新登录态上传云端，再下发给 B 无缝接管。

桌面端 Electron（Vue3 + Element Plus），服务端 Go（chi + pgx + aws-sdk-go-v2），存储 S3 兼容（本地用 MinIO），元数据 Postgres。测试不依赖任何真实网站：内置 Go 编写的带登录态测试站。

## 架构（V0.1.0 数据面为 L1 结构化）

```
Electron 主进程
 ├─ EnvManager / BrowserHost   每环境 = 独立内存 partition + 独立窗口（分支语义）
 ├─ DataPlane L1               session.cookies（含 HttpOnly）+ executeJavaScript(localStorage)
 ├─ SnapshotEngine            manifest + AES-256-GCM 信封（Argon2id→KEK→DEK→HKDF 每快照子密钥）
 ├─ CloudClient               REST（fetch）+ WS 信令
 └─ LeaseAgent                模式二客户端状态机（acquire/evict/heartbeat/release）
Go 服务端（无状态薄层）
 ├─ auth       注册/登录（E2E 密钥信封托管，服务端只见密文与 authKey 校验值）
 ├─ envs       环境 CRUD（name/mode 明文列 + config E2E 密文）
 ├─ snapshots  快照元数据 + S3 presigned PUT/GET 直传直下（流量不过服务端）
 └─ leases     租约状态机 + WS hub（驱逐 deadline 15s / 心跳 30s / 失联兜底 stale 授予）
S3：u/<uid>/envs/<envId>/snapshots/<snapId>/{manifest.json, blob.enc}   ← 全密文
```

**E2E 安全模型**：主密码 → Argon2id 派生 KEK（仅客户端内存）→ 解包 DEK → HKDF 派生每快照子密钥 → AES-256-GCM。服务端与 S3 任何时刻都拿不到明文登录态（`pnpm e2e` 中的 T5.1 会验证）。

## 快速开始

前置：Go ≥1.26、Node ≥22 / pnpm ≥11、Docker（跑 Postgres）、MinIO（`brew install minio` 或任意 S3 兼容服务）。

```bash
make infra        # Postgres（docker）+ MinIO（:9000，console :9001）
make server       # 服务端 :8787（自动迁移 + 自动建桶）
make site         # 测试站 :18080（登录任意用户名即可）
make desktop      # 桌面端（electron-vite dev）

# 或一键端到端验收（T1/T2/T3/T5，17 项断言）
make e2e
```

桌面端使用流程：注册（邮箱 + 主密码）→ 新建环境（选模式、填主页 `http://127.0.0.1:18080`）→ 打开环境 → 在环境窗口里登录测试站 → 「保存为基线」→ 关闭。换一台设备（或删掉本地数据重登）打开同一环境即免登录。模式二环境直接点「打开 / 接管」即可体验互斥。

环境变量（均可省略）：`ONEBROWSER_SERVER`（默认 `http://127.0.0.1:8787`）、`ONEBROWSER_SITE`（e2e 用，默认 `http://127.0.0.1:18080`）、服务端的 `DATABASE_URL` / `S3_*`（见 `server/internal/config/config.go`）。

## 测试

```bash
make test         # Go 单测（带 TEST_DATABASE_URL 时含 DB 集成测试）
make e2e          # 全链路：模式一克隆 / 分支语义 / 模式二互斥接管 / E2E 密文抽查
```

测试站工具页（人工验收）：`/sessions`（会话管理台，直观查看接管过程）、`POST /api/expire`（模拟会话过期）、`POST /api/bind-ip?on=1`（模拟换 IP 风控）、`/fp`（指纹回显，M5 用）。

## V0.1.0 已知限制（按规划，后续版本解决）

- **数据面 L1**：只迁移 cookie + localStorage；IndexedDB / Service Worker / 密码库不在内（M6 文件级快照解决）。
- **指纹**：V0.1.0 未做指纹伪装（M5 引入 fingerprint-chromium 外挂内核）；环境间仅存储隔离。
- **Google 站点**：受 DBSC（设备绑定会话）限制，Google 登录态无法跨设备共享——这是行业级硬限制，详见调研报告 §4.3。
- 快照保留策略、审计界面、团队协作、安装包分发未实现。

## 目录

```
apps/desktop   Electron 桌面端（src/main/core 为核心模块）
server         Go 服务端
test-site      Go 登录态测试站
deploy         docker-compose（Postgres；MinIO 本地二进制运行）
docs           调研报告 / 总体规划 / 版本范围
scripts        dev-infra.sh
```
