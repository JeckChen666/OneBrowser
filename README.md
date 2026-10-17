# OneBrowser

> 指纹环境 + 登录态云端共享的浏览器（V0.3.0）
>
> 调研报告：[docs/research-report.md](docs/research-report.md) · 总体规划：[docs/project-plan.md](docs/project-plan.md) · 版本范围：[docs/v0.1.0-scope.md](docs/v0.1.0-scope.md) · V0.2.0 计划：[docs/v0.2.0-plan.md](docs/v0.2.0-plan.md) · V0.3.0 计划：[docs/v0.3.0-plan.md](docs/v0.3.0-plan.md)

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

**V0.2.0 新增**：fingerprint-chromium 指纹内核承载（同 seed 跨设备指纹一致）、双承载互迁移（builtin ⇄ kernel 登录态无缝）、每环境代理（含认证）+ auto 时区/语言（按代理出口 geo 推导）、会话健康检查（基线失效提示）、服务端快照保留策略。

**V0.3.0 新增**：**L2 文件级快照**——kernel 环境以整个浏览器 profile 为快照单位（cookie/IndexedDB/Service Worker/密码库等全部站点数据随基线漫游）；容器 profile 宿主直通（-v 挂载）+ 冻结一致性抓取（docker pause）；双写策略（L2 为主 + L1 结构化副本），builtin 设备自动回退 L1，跨承载互迁移不回退。

## 架构（数据面为 L1 结构化）

```
Electron 主进程
 ├─ EnvManager / BrowserHost   每环境 = 独立内存 partition + 独立窗口（分支语义）
 ├─ ExternalKernelHost         fingerprint-chromium 外挂内核承载（spawn + browser-level CDP 数据面）
 ├─ KernelManager              内核下载/sha256 校验/自愈（GitHub Releases 预编译产物）
 ├─ DataPlane L1               cookies（含 HttpOnly）+ localStorage，双承载同一快照格式（互迁移）
 ├─ SnapshotEngine            manifest + AES-256-GCM 信封（Argon2id→KEK→DEK→HKDF 每快照子密钥）
 ├─ CloudClient               REST（fetch，上传指数退避重试）+ WS 信令
 ├─ sessionCheck              会话健康探测（基线失效 → 提示重新登录并更新基线）
 └─ LeaseAgent                模式二客户端状态机（acquire/evict/heartbeat/release）
Go 服务端（无状态薄层）
 ├─ auth       注册/登录（E2E 密钥信封托管，服务端只见密文与 authKey 校验值）
 ├─ envs       环境 CRUD（name/mode 明文列 + config E2E 密文）
 ├─ snapshots  快照元数据 + S3 presigned PUT/GET 直传直下 + 保留策略（SNAPSHOT_RETENTION）
 ├─ geo        /v1/geo 出口地理推导（auto 时区/语言）
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

# 或一键端到端验收（builtin 全链路，17 项断言）
make e2e
```

桌面端使用流程：注册（邮箱 + 主密码）→ 新建环境（选模式、填主页 `http://127.0.0.1:18080`）→ 打开环境 → 在环境窗口里登录测试站 → 「保存为基线」→ 关闭。换一台设备（或删掉本地数据重登）打开同一环境即免登录。模式二环境直接点「打开 / 接管」即可体验互斥。

环境变量（均可省略）：`ONEBROWSER_SERVER`（默认 `http://127.0.0.1:8787`）、`ONEBROWSER_SITE`（e2e 用，默认 `http://127.0.0.1:18080`）、`ONEBROWSER_KERNEL_DOCKER=1`（无原生内核平台用 Docker 内核验证）、服务端的 `DATABASE_URL` / `S3_*` / `SNAPSHOT_RETENTION`（每环境保留快照数，默认 5，0=不清理）/ `STALE_UPLOADING_HOURS`（默认 24，见 `server/internal/config/config.go`）。

## 测试

```bash
make test         # Go 单测 + DB/S3 集成测试（自动建一次性测试库 test-db）
make e2e          # 全链路：模式一克隆 / 分支语义 / 互斥接管 / E2E 密文抽查 / 会话过期提示
pnpm --dir apps/desktop e2e:l2        # L2 文件级快照（kernel 容器，需 Docker）
pnpm --dir apps/desktop e2e:interop   # 双承载互迁移 + 混合接管（kernel 容器，需 Docker）
pnpm --dir apps/desktop e2e:fp        # 指纹三件套 + 代理 + auto 时区（kernel 容器，需 Docker）
pnpm --dir apps/desktop kernel-smoke  # 内核指纹冒烟（Docker）
```

测试站工具页（人工验收）：`/sessions`（会话管理台，直观查看接管过程）、`POST /api/expire`（模拟会话过期）、`POST /api/bind-ip?on=1`（模拟换 IP 风控）、`/fp`（指纹回显，M5 用）。

## 已知限制（按规划，后续版本解决）

- **数据面 L1**：builtin 承载只迁移 cookie + localStorage（kernel 承载已升级 L2 文件级快照，全量站点数据随基线漫游）。
- **内核分发**：fingerprint-chromium 官方预编译产物 mac 为 arm64-only；Intel mac 开发机经 Docker（Linux 内核）验证（`ONEBROWSER_KERNEL_DOCKER=1`）。
- **指纹 seed**：必须为 1~2147483647 的整数（内核要求 32 位整数；非法值会使渲染进程死锁，客户端已强校验）。
- **Google 站点**：受 DBSC（设备绑定会话）限制，Google 登录态无法跨设备共享——这是行业级硬限制，详见调研报告 §4.3。
- 审计界面、团队协作、安装包分发未实现。

## 目录

```
apps/desktop   Electron 桌面端（src/main/core 为核心模块）
server         Go 服务端
test-site      Go 登录态测试站
deploy         docker-compose（Postgres；MinIO 本地二进制运行）
docs           调研报告 / 总体规划 / 版本范围
scripts        dev-infra.sh
```
