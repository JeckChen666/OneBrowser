# OneBrowser 项目总体规划 v1

> 日期：2026-10-10。前置文档：[research-report.md](./research-report.md)（技术调研，本规划的决策依据来源）。
> 技术栈（已定）：桌面端 **Electron** · 服务端 **Go** · 对象存储 **S3 兼容** · 测试站点 **Go 自建**（不依赖真实网站）。

---

## 0. 产品定义

**OneBrowser = 指纹浏览器（多环境隔离） + 登录态云端存储/跨设备共享。**

核心概念（术语表，全项目统一用词）：

| 术语 | 含义 |
|---|---|
| **环境 Environment** | 一个独立的浏览器身份单元：独立存储 + 指纹种子 + 代理 + 名称。用户视角≈指纹浏览器的「一个环境/浏览器实例」 |
| **基线快照 Base Snapshot** | 模式一中「登录时刻」抓取的那份登录态，云端只读基准 |
| **分支 Branch** | 每次打开环境 = 从基线快照克隆出本地工作副本；关闭时**默认丢弃**（严格符合「每次都从登录状态分支出去」） |
| **租约 Lease** | 模式二中环境在同一时刻只允许一台设备使用，云端发放的独占凭证 |
| **接管 Takeover** | 模式二流程：B 请求 → A 被驱逐（先上传最新数据）→ 云端下发 → B 打开 |
| **数据面 Data Plane** | 登录态的抽取/注入管道。分两级：L1 结构化（cookie+localStorage）；L2 全保真（整目录） |

两种模式是**环境级属性**（互斥二选一，创建时选择）：

- **模式一 snapshot（快照分支）**：抓取登录态作为基线快照上云；之后任何设备打开都从基线克隆，本地变更不回写。用户可主动「更新基线」。
- **模式二 exclusive（互斥接管）**：打开即持有租约；他设备请求时，当前持有者被强制下线——下线前自动抓取最新快照上云，再下发给请求方。

---

## 1. 总体架构

```
┌─────────────────────────── 桌面端 Electron（apps/desktop）───────────────────────────┐
│  Renderer（Vue3）：环境列表 / 登录 / 设置 / 环境窗口 UI                                  │
│  Main（TS）：                                                                        │
│   ├─ EnvManager     环境生命周期、partition/user-data-dir 管理、per-env 代理           │
│   ├─ BrowserHost    M1-M4: Electron WebContentsView + session partition               │
│   │                 M5+: 外挂指纹内核（fingerprint-chromium 构建 + CDP 接管）           │
│   ├─ DataPlane      L1: session.cookies / executeJavaScript（localStorage）            │
│   │                 L2: 文件级快照（M6，依赖内核补丁）                                   │
│   ├─ SnapshotEngine manifest 组包、AES-GCM 加密信封、增量哈希、原子写入                  │
│   └─ CloudClient    REST（登录/环境/快照元数据）+ WebSocket（租约/驱逐信令）            │
└──────────────────────────────────────────────────────────────────────────────────┘
            │ HTTPS（REST）+ WSS（信令）                    │ presigned PUT/GET（密文）
┌───────────▼───────────── Go 服务端（server/，无状态可水平扩展）──────────┐   ┌───▼────┐
│  auth（注册/登录/密码轮换/设备）  environments  snapshots(元数据+presign)  │   │  S3 兼容 │
│  lease（租约状态机+心跳+驱逐）  ws hub（按 user/device 路由消息）          │   │ 存储     │
│  Postgres（元数据，服务端不存任何明文登录态）                              │   └────────┘
└──────────────────────────────────────────────────────────────────────┘

┌─ test-site/（Go 编写的带登录态测试站，仅测试用）──────────────────────────┐
│  登录/会话 cookie（各属性变体）/ whoami / 会话管理台 / 指纹回显页 / 风控模拟 │
└──────────────────────────────────────────────────────────────────────┘
```

**信任模型：E2E 加密是硬性要求。** cookie 即凭证，服务端与 S3 上只允许出现密文；服务端只持有元数据（环境名、快照大小/哈希、租约状态）。

---

## 2. 关键技术决策（ADR 摘要）

| # | 决策 | 理由 | 依据 |
|---|---|---|---|
| D1 | **分阶段内核策略**：M1–M4 用 Electron 内置 Chromium（`session.fromPartition('persist:<envId>')` 做环境隔离）；M5 引入外挂指纹内核（fingerprint-chromium 构建，CDP 驱动）；M6 内核补丁（os_crypt 可漫游）解锁全保真文件快照 | ① partition 方案零内核构建成本，一周内可跑通全流程；② 结构化数据面（cookie/localStorage）天然绕开 OS 加密绑定（调研 4.2：DPAPI/Keychain/ABE 与漫游不兼容）；③ 指纹与全保真是渐进增强，不该阻塞核心链路 | 调研 3.2/3.3/4.2 |
| D2 | **数据面 L1 结构化优先**：cookie 走 `session.cookies` API（可读写含 httpOnly 的全部 cookie，明文操作，无 OS 加密问题），localStorage 走 `executeJavaScript` + 自维护 origin 清单 | 可移植性最好（与设备/OS 解耦）；代价：不覆盖 IndexedDB/Service Worker（列为已知限制，M6 解决） | 调研 4.2 结论路线 B 的壳内版本 |
| D3 | **E2E 加密**：主密码 Argon2id 派生 KEK → 包裹随机 DEK → DEK 经 HKDF 派生每快照子密钥 → AES-256-GCM | 服务端/S3 零明文；参数沿用 Donut 已验证实现（Argon2id m=19456KiB,t=2,p=1） | 调研 3.2、5 |
| D4 | **服务端 Go + chi + pgx/sqlc + gorilla/websocket + aws-sdk-go-v2；元数据 Postgres；S3 用 presign 直传直下** | 服务端无状态薄层（Donut Sync 架构验证过）；presign 模式下流量不过服务端 | 调研 3.2/5 |
| D5 | **本地开发栈**：docker-compose 一键起 Postgres + MinIO（S3 兼容）+ server；不依赖任何真实云与真实网站 | 用户要求：测试不碰真实站点 | — |
| D6 | **模式二协议自建**（租约+驱逐+搬迁），WebSocket 信令 | 公开世界无现成实现（调研结论 5） | 调研 5 |
| D7 | **快照信封格式向前兼容 L2**：manifest 明文头 + 加密载荷；载荷 M2 起是结构化 JSON，M6 起可承载文件树 | 一套格式两级数据面 | 调研 3.4 |
| D8 | 桌面端 UI 用 **Vue3 + Element Plus**，构建 electron-vite + TS | VirtualBrowser 的环境管理 UI（同栈、BSD-3 开源）可直接当交互与代码参考，其指纹字典 JSON 也能直接复用 | 调研 2.3 |
| D9 | **代理为环境一级属性**（Electron `session.setProxy` / M5 后 `--proxy-server`），跨设备克隆时代理配置随环境同步（凭证在 E2E 密文内） | 换 IP 触发风控是已知现实（调研 4.3）；「环境一致」= 指纹+IP 都一致 | 调研 4.3/5 |

---

## 3. 桌面端设计（apps/desktop）

### 3.1 进程与模块

- **Main 进程**（核心逻辑全在这里）：
  - `EnvManager`：环境 CRUD、打开/关闭、partition 目录管理（`userData/Partitions/<envId>`）、per-env 代理与 UA 覆写（`webRequest.onBeforeSendHeaders` 做最小 UA 伪装，真正的指纹面 M5 解决）
  - `BrowserHost`：M1–M4 环境窗口 = `WebContentsView`（每环境一个 BrowserWindow，共享 app 但 partition 隔离）；M5 起实现 `ExternalKernelHost`（spawn 内核进程 + `--user-data-dir` + `--fingerprint=<seed>` + CDP attach），两者实现同一 `BrowserHost` 接口，环境可逐个切换承载方式
  - `DataPlane`（接口化，两级实现）：
    - `L1StructuredPlane.capture(session, origins)` → `{cookies[], localStorage{origin:k-v}}`；`restore(session, data)` 反向注入（cookie 逐条 `session.cookies.set`，注意用 domain/path/secure 重建 URL、sameSite 映射）
    - origin 清单由 BrowserHost 在每次导航时记录（我们控制壳，能完整记录访问过的站点）
  - `SnapshotEngine`：组包 manifest、加密、上传/下载、本地缓存（`userData/Snapshots/`）、原子写（`.partial` → rename，参考 Prism）
  - `CloudClient`：REST + WS，断线重连，信令分发
  - `LeaseAgent`：模式二客户端状态机（见 §6）
- **Renderer（Vue3）**：登录/注册、环境列表（分组/搜索/批量）、环境编辑（名称/模式/代理/指纹种子）、环境窗口（地址栏/标签页/快照状态指示）、设置（云账号、E2E 密码、缓存管理）
- **IPC**：contextBridge 暴露类型化 API，协议定义放 `packages/contracts`

### 3.2 环境数据模型（本地 + 云端同步）

```ts
interface Environment {
  id: string            // uuid
  name: string
  mode: 'snapshot' | 'exclusive'
  fingerprint: {        // M1 仅 seed + ua 覆写；M5 后映射到内核 flags
    seed: string        // 确定性种子：同环境在任何设备上指纹一致
    platform?: string; uaOverride?: string
    surfaces?: Record<string, {mode: 0|1|2, value: any}>   // M5：25-surface 覆盖（模型借自 VirtualBrowser）
  }
  proxy?: { scheme, host, port, username?, password? }    // 密码仅存 E2E 密文
  homepage?: string
  createdAt, updatedAt
}
```

### 3.3 模式一客户端流程

```
打开环境：
  acquireEnv(env) →
    [模式二才需要租约，模式一直接走]
    CloudClient.getLatestBase(env) → 无则本地冷启动
    有则下载密文 → 解密 → DataPlane.restore 注入 partition → 启动窗口（= 分支开始）
关闭环境：
  模式一默认：直接丢弃本地 partition 中的登录态变更
    （实现：restore 前清空 partition 对应存储，或用非 persist 的内存 session + 预注入——
      决定：用临时 partition 目录，关闭即删，保证「分支」语义干净）
  用户提供「更新基线」入口：capture → 加密 → 上传 → 成为新基线（云端保留版本链，可回滚）
登录引导：
  环境首次打开时提示「完成登录后点击[保存基线]」；后续每次自动从基线分支
```

### 3.4 本地安全

- E2E 主密码不落盘（内存 + 系统锁屏锁 Keychain/DPAPI 可选记忆）
- 快照本地缓存为密文；「清除本地缓存」一键删除
- 本地 API（若 M5 提供 CDP/HTTP 自动化口）必须带 token（VirtualBrowser 的反例，调研 2.5）

---

## 4. 服务端设计（server/，Go）

### 4.1 技术栈

chi（路由）· pgx + sqlc（DB 访问，类型安全）· golang-migrate（迁移）· gorilla/websocket · aws-sdk-go-v2（S3，兼容 MinIO）· golang.org/x/crypto/argon2（仅用于口令 verifier）· zap（日志）。部署：单二进制 + compose；服务端不接触任何明文登录态。

### 4.2 数据模型（Postgres）

```sql
users(id uuid PK, email citext UNIQUE, verifier bytea,   -- Argon2id(password, serverSalt) 仅登录校验
      wrapped_dek bytea, kdf_params jsonb,               -- E2E 密钥信封（密文）
      created_at timestamptz)
devices(id uuid PK, user_id FK, name text, platform text, last_seen_at)
environments(id uuid PK, user_id FK, name text, mode text CHECK(mode IN('snapshot','exclusive')),
      config_enc bytea,          -- 环境配置（含代理密码）的 E2E 密文
      latest_base_id uuid NULL,  -- → snapshots.id
      deleted_at timestamptz NULL, created_at, updated_at)
snapshots(id uuid PK, env_id FK, based_on uuid NULL, device_id uuid,
      state text CHECK(state IN('uploading','ready','failed')),
      size bigint, sha256 char(64), created_at)
leases(env_id uuid PK REFERENCES environments, holder_device_id uuid,
      state text CHECK(state IN('active','evicting')),
      acquired_at, heartbeat_at, evict_deadline timestamptz NULL)
```

### 4.3 REST API（`/v1`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /auth/register | {email, verifier, wrappedDEK, kdfParams} 注册即完成 E2E 信封托管 |
| POST | /auth/login | 校验 verifier，签发 session token；返回 wrappedDEK |
| POST | /auth/password | 密码轮换（重包裹 DEK，旧包裹作废） |
| GET/POST | /envs · /envs/:id | 环境列表/创建/改名/删除（config_enc 原样存取） |
| POST | /envs/:id/snapshots | 申请上传 → {snapshotId, presignedUrls{manifest, blob}} |
| POST | /envs/:id/snapshots/:sid/commit | {sha256,size} → ready；若模式一且 based_on=当前基线 → 更新 latest_base |
| GET | /envs/:id/base | 返回最新 ready 基线 {snapshotId, presignedGetUrls, meta} |
| DELETE | /envs/:id/snapshots/:sid | 删除版本（保留策略：默认链上最多 N 份） |

presign 有效期 1h；上传 key：`u/<userId>/envs/<envId>/snapshots/<snapshotId>/{manifest.json, blob.enc}`。

### 4.4 WebSocket（`/v1/ws`，认证后连接，服务端按 user→devices 路由）

| 消息 | 方向 | 载荷 | 说明 |
|---|---|---|---|
| `lease.acquire` | C→S | {envId} | 模式二：请求打开环境 |
| `lease.pending` | S→C | {envId, holderDevice, deadlineMs} | 已有持有者，正在驱逐 |
| `lease.evict` | S→C(A 持有者) | {envId, deadlineMs} | 命令：保存并下线 |
| `lease.release` | C→S | {envId, snapshotId?} | 持有者主动关闭或驱逐完成后释放（附新快照） |
| `lease.granted` | S→C(B) | {envId, snapshotId?, stale:boolean} | 获得租约；snapshotId=待下载快照；stale=持有者失联，用的是旧基线 |
| `lease.heartbeat` | C→S | {envId} | 每 15s；30s 无心跳判失联 |
| `env.updated` | S→C | {envId} | 配置/基线变更通知（多设备列表刷新） |

### 4.5 租约状态机（服务端权威）

```
IDLE ──acquire(B)──► GRANTED(B)                    （无持有者，直接下发最新基线）
HELD(A) ──acquire(B)──► EVICTING(A,B)
    S→A: lease.evict(deadline=15s)
    A 正常: A 上传快照 → lease.release{snapshotId} → GRANTED(B, snapshotId)
    A 失联/超时:       → GRANTED(B, latest_base, stale=true)
任何时刻服务端崩溃恢复: lease 表持久化，重启后 heartbeat 超时自然回收
防误驱逐缓冲: 同一设备 5s 内重复 acquire 幂等；B 在驱逐完成前取消 → 回滚
```

### 4.6 治理

快照保留策略（每环境默认保留最近 5 个基线）；30 天未用环境提示归档；S3 生命周期规则配合；审计日志表（登录、快照上传/下载、租约事件——只记元数据）。

---

## 5. 快照格式规范（packages/contracts/snapshot-schema）

```jsonc
// manifest.json —— 明文头（不含任何登录态内容）
{
  "schema": "onebrowser.snapshot/v1",
  "kind": "structured",            // v2 增加 "files"
  "envId": "uuid", "snapshotId": "uuid", "basedOn": "uuid|null",
  "createdAt": "...", "deviceId": "...", "platform": "darwin",
  "cipher": { "alg": "AES-256-GCM", "kdf": "argon2id", "kdfParams": {...}, "subkeyInfo": "HKDF(dek, snapshotId)" },
  "payload": { "format": "json", "encSha256": "...", "encSize": 123 }
}
// blob.enc —— 加密载荷（L1: 结构化 JSON）
{
  "cookies": [ /* session.cookies.getAll 全量字段：name,value,domain,path,secure,httpOnly,sameSite,expirationDate */ ],
  "localStorage": { "<origin>": { "k": "v" } },
  "envConfig": { /* 环境配置副本，含代理（密码在内，整体已加密） */ }
}
// v2 (L2) 变化仅 kind:"files" + blob 为逐文件加密的 tar 清单（文件清单/排除表沿用 Donut 的清单，
//  排除 Cache/-wal/-shm/LOCK 等；此项依赖 M6 内核补丁，见调研 3.2）
```

**E2E 密钥体系**（D3 细化）：

```
masterPassword ──Argon2id(salt_s, m=19456KiB,t=2,p=1)──► KEK
random DEK(32B) ──AES-GCM(KEK)──► wrapped_dek（存服务端，密码轮换只重包裹）
per-snapshot key = HKDF-SHA256(DEK, info=snapshotId)   // 一快照一密钥
恢复码（可选 M3+）：额外用恢复码派生 KEK 包裹一份 DEK，防主密码丢失
服务端登录 verifier 与 KEK 派生用不同 salt/context，服务器无法从 verifier 推导 KEK
```

---

## 6. 模式二客户端流程（LeaseAgent 状态机）

```
closed ──open──► acquiring ──granted──► restoring(下载+注入) ──► running
                     │                                          │
                     │ pending(evict 他人)                       │ 收到 lease.evict
                     ▼                                          ▼
                 waiting_evict ──granted──► restoring           evicting:
                                                              优雅关闭窗口 → DataPlane.capture
                                                              → 加密上传 → commit → release → evicted
运行期：每 15s 心跳；网络断开 → 指数退避重连；心跳失败 30s → 本地标记「租约可能丢失」，
UI 降级提示，禁止再写敏感操作（防止双活写冲突）
被驱逐 UX：窗口自动关闭 + 系统通知「[环境名] 已被设备 [B] 接管，最新状态已保存上云」
```

---

## 7. 测试站点（test-site/，Go）与测试矩阵

### 7.1 站点设计（`go run ./test-site`，默认 :8080）

| 路由 | 行为 |
|---|---|
| `GET /` | 登录页（表单：用户名/密码，任意非空即登录成功） |
| `POST /login` | 设置三种 cookie 变体：`sid`（HttpOnly+SameSite=Lax+30d，服务端会话）、`token`（非 HttpOnly 供 JS 读）、`short`（会话级）；页面 JS 同时写 `localStorage.theme_token` 与 `sessionStorage.tmp`；302 → /app |
| `GET /app` | 已登录主页：显示身份、各 cookie 属性、localStorage 回显 |
| `GET /api/whoami` | JSON：{user, sid 状态, 登录时间, 最近请求 IP/UA} —— 自动化断言用 |
| `GET /sessions` | 管理台：列出所有服务端会话（sid、IP、UA、登录/活跃时间）——验证「A 下线 B 接管」的直观工具 |
| `POST /api/expire?sid=` | 使指定会话失效——模拟 cookie 过期/站点踢会话 |
| `POST /api/bind-ip?on=1` | 开启「IP 绑定校验」：换 IP 请求返回 401 要求重新验证——模拟风控，验证代理绑定价值 |
| `GET /logout` | 清会话 |
| `GET /fp` | 指纹回显页：UA/平台/时区/语言/屏幕/canvas hash/WebGL vendor——M5 指纹一致性测试用 |

会话存储用内存 map + 过期清理即可（测试站不引入 DB）。

### 7.2 双机模拟（同机即可）

两份客户端实例 = `pnpm dev:desktop -- --user-data-dir=/tmp/obA` 与 `obB`（Electron 支持自定义 userData 目录实现完全隔离），浏览器窗口都指向 `http://127.0.0.1:8080`。

### 7.3 测试矩阵（里程碑验收标准）

| # | 场景 | 验收 |
|---|---|---|
| T1 | A 登录测试站 → 保存基线 → B 克隆打开 | B 的 /api/whoami 返回已登录，localStorage.theme_token 存在 |
| T2 | 分支语义 | B 上 /logout 后关闭；再次打开（从基线克隆）→ 仍是登录态；云端基线未被污染 |
| T3 | 模式二接管 | A 运行中，B 请求 → A 窗口自动关闭并提示；B 打开后 whoami 已登录且会话为 A 退出的最新 sid |
| T4 | A 失联兜底 | kill A 进程 → 30s 心跳超时 → B 获得旧基线（stale 提示） |
| T5 | E2E 验证 | MinIO 控制台/抓包看到的对象与 Postgres 行全部为密文；错误密码无法解密 |
| T6 | 会话过期 | /api/expire 后打开环境 → 站点显示未登录 → 客户端提示「基线已失效，请重新登录并更新基线」 |
| T7 | IP 风控 | bind-ip 开启 + 无代理 → 401；配置固定代理（本地起 2 个 socks 代理模拟）→ 通过 |
| T8 | 并发/幂等 | 双端同时 acquire；evict 中 B 取消；上传中断重试 |

单元测试：SnapshotEngine 加解密 round-trip、cookie 字段映射（sameSite/hostOnly/secure URL 重建）为必须覆盖的重点；服务端租约状态机用 Go 单测穷举。

---

## 8. 仓库结构（monorepo）

```
OneBrowser/
├── apps/
│   └── desktop/                 # Electron（electron-vite + TS + Vue3 + Element Plus）
│       ├── src/main/            # env-manager / browser-host / data-plane / snapshot-engine / cloud-client / lease-agent
│       ├── src/preload/
│       └── src/renderer/
├── server/                      # Go 服务端
│   ├── cmd/onesrv/main.go
│   ├── internal/{auth,envs,snapshots,leases,ws,s3,store}/
│   └── migrations/
├── test-site/                   # Go 测试站（§7.1）
├── packages/
│   └── contracts/               # REST/WS 消息 + 快照 manifest 的 TS/Go 双侧定义（单一事实来源，JSON Schema 生成）
├── deploy/
│   └── docker-compose.yml       # postgres + minio + server + test-site 一键开发栈
├── docs/                        # research-report.md / project-plan.md（本文件）
└── scripts/                     # dev 脚手架（双实例启动等）
```

---

## 9. 里程碑

| 里程碑 | 内容 | 验收 | 预估 |
|---|---|---|---|
| **M0 脚手架** | monorepo、compose 栈（PG+MinIO+server 骨架+test-site 骨架）、Electron 空壳跑通、CI（lint+test） | `docker compose up` 一键起全栈；Electron 打开空白窗口 | 1 周 |
| **M1 本地浏览** | EnvManager + BrowserHost(partition) + 环境列表 UI + 测试站登录 | T1 的本地版（同实例内环境隔离） | 1–2 周 |
| **M2 快照引擎** | DataPlane L1（capture/restore）+ 快照信封 + 本地导出/导入文件 | 手工拷贝快照文件到另一实例 → T1 通过（无云） | 2 周 |
| **M3 上云（模式一）** | Go 服务端全量 API + E2E + presign + 桌面端云同步；快照版本链 | T1/T2/T5/T6 | 2–3 周 |
| **M4 模式二** | WS hub + 租约状态机 + LeaseAgent + 驱逐 UX | T3/T4/T8 | 2 周 |
| **M5 指纹内核** | ExternalKernelHost（fingerprint-chromium 构建/下载）+ CDP DataPlane + 25-surface 配置 + 指纹字典 + /fp 一致性测试 | 同 seed 跨设备 /fp 全一致；T7 代理链路 | 3–4 周（含内核构建调研） |
| **M6 全保真** | os_crypt 可漫游补丁 + L2 文件级快照（Donut 清单/排除表）+ IndexedDB 站点验证 | 重度 IndexedDB 站点快照迁移通过 | 3–4 周（内核补丁风险最高，独立预研先行） |

MVP 对外演示点 = **M4 完成**（双机互斥接管在测试站全链路演示）。M5/M6 与 M3/M4 解耦，可并行预研（M6 的内核补丁从现在起就可以开预研分支，因为它是最大不确定项——见调研报告 Phase 0）。

---

## 10. 风险与开放问题

| 风险 | 等级 | 缓解 |
|---|---|---|
| Electron `session.cookies` 对 SameSite/hostOnly/分区 cookie(CHIPS) 的映射边角 | 中 | M2 首个任务就写 cookie round-trip 单测；测试站覆盖各属性变体；M5 后 CDP 通道兜底 |
| L1 不含 IndexedDB/SW（部分站点登录态不全） | 中 | 已知限制明示；M6 全保真解决；测试站不依赖 IndexedDB 以保证 MVP 演示 |
| localStorage 需要枚举 origin | 低 | 壳层记录导航历史（我们控制浏览器 UI）；快照内维护 origin 清单 |
| 内核补丁（M6）维护成本 | 中 | 基于 fingerprint-chromium 补丁体系（BSD）；跟随其版本分支；预研先行 |
| DBSC（Google）阻断 Google 会话共享 | 高·不可解 | 产品口径：Google 列为已知受限站点（调研 4.3），不承诺 |
| presign 时钟偏移/大对象上传中断 | 低 | 1h 窗口 + 分块重试；快照体积上限告警（首版 50MB） |
| Electron 多 partition 内存占用 | 低 | 同时打开环境数提示；单窗口按需创建销毁 |
| 法律/合规（存储用户凭证） | 中 | E2E 架构使平台无法读取用户数据；隐私声明；目标市场法务评审（上线前） |

**开放问题（默认按括号内方案执行，可推翻）**：账号体系用「邮箱+密码」（暂不做第三方登录/无账号 chain）；快照保留策略默认 5 份；M1 不做团队/多用户共享（issue #95 验证的团队需求列为远期路线）。

---

## 11. 下一步

按 M0 → M1 开始实施：搭 monorepo、compose 栈与两端骨架。M6 的内核预研（fingerprint-chromium 构建 + os_crypt 补丁实验）可与主线并行启动。
