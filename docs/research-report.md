# OneBrowser 早期技术调研报告

> 调研日期：2026-10-10。项目定位：基于 Chromium 内核的指纹浏览器 + 浏览器登录态云端存储/跨设备共享。
> 两种目标模式：
> - **模式一（快照分支）**：登录时抓取一份登录态快照上云，之后每次打开都从该快照克隆分支；
> - **模式二（互斥接管）**：A 机正在使用某站点时，B 机请求打开 → A 机被强制下线，A 机最新数据回传云端再下发到 B 机。
>
> 说明：所有仓库 star 数 / 日期 / 版本均经 GitHub API 或仓库页实时验证；标注【官方】= 官方文档/源码确认，【社区】= 社区经验/研究，【推断】= 基于事实的综合推断。
> v1.1（2026-10-10）：用户确认重点项目 "virtual borders" 即 VirtualBrowser，已补充源码级深挖（第 2 节）。

---

## 0. TL;DR

1. **用户指定的重点项目已确认为 [VirtualBrowser](https://github.com/Virtual-Browser/VirtualBrowser)**，源码级深挖见第 2 节。一句话结论：**开源的只有管理器 UI（Vue）与自动化示例；内核补丁、账号体系，以及它已经上线的 WebDAV 云同步全部闭源**。对我们的价值在客户端层：WebUI 原生桥（chrome.send）、25-surface 指纹数据模型、指纹字典 JSON、内核可插拔分发——都可借鉴；内核层与云同步层仍需以 fingerprint-chromium + Donut 为蓝本。
2. **最有价值的发现：[Donut Browser](https://github.com/zhom/donutbrowser)** —— 目前全网唯一把「多 profile 指纹浏览器 + profile 跨设备云同步 + E2E 加密 + 可自建服务端」整条链路开源的项目，其同步引擎源码（增量 manifest、排除表、Argon2id→AES-256-GCM、S3 presign 服务端）几乎就是我们模式一的工程蓝本。AGPL 协议，**学方案、重写代码**。
3. 推荐组合拳：**内核用 [fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium)（BSD，补丁全公开）+ 本地管理/快照格式参考 [Prism](https://github.com/DFarm6/Prism-Browser-Community)（MIT）+ 云同步架构参考 Donut（AGPL，只学不抄）+ 所有权模型参考 [Brave Sync chain](https://github.com/brave/brave-browser/wiki/Brave-Sync-v2)（无账号端到端）**。
4. **两个硬技术事实**（决定架构）：
   - Chromium 的 cookie/密码文件被 OS 级加密绑定到本机（Windows DPAPI/ABE、macOS Keychain），Google 官方原文明说 **ABE 与 profile 跨机漫游不兼容**。直接拷贝 profile 目录到另一台机器，cookie 解不开。解法有两条：**我们控制内核 → 改造 os_crypt 为可漫游密钥**（Donut 走的就是这条路，【推断】）；或走 CookieCloud 式**扩展 API 明文搬运**（绕开 OS 加密但只覆盖 cookie+localStorage）。
   - **Google 已全量启用 DBSC（设备绑定会话）**：2026 年 5 月 GA、含个人账号、默认开启且无任何关闭开关。**「在 A 机登录 Google、把登录态搬到 B 机用」这条路已被 Google 实质性阻断**（会话续期需要原机 TPM 私钥签名）。对未部署 DBSC 的站点（目前绝大多数，如 B 站）方案依然可行。
5. **模式二没有任何现成开源实现**（Steel 的 profileId+persistProfile 语义最接近模式一），互斥锁 + 会话搬迁协议需要自建，报告第 6 节给出设计草案。

---

## 1. 需求技术拆解

把两种模式翻译成工程语言：

| 需求 | 工程本质 | 现状 |
|---|---|---|
| 指纹浏览器 | Chromium fork 在 C++ 层伪装指纹面（canvas/webgl/audio/字体/时区/UA/WebRTC/CPU/内存…），多「环境」= 多个独立 `--user-data-dir` | 成熟，有开源补丁集可抄 |
| 模式一 | profile（user-data-dir 中登录态子集）的**快照（snapshot）→ 云端存储 → 异地克隆（clone/branch）**，Steel 云版的 `profileId + persistProfile=false` 就是这个语义 | 有完整开源参考（Donut） |
| 模式二 | profile 的**分布式租约（lease）+ 强制驱逐（evict）+ 数据回传再下发**，本质是「会话搬迁」 | 无现成实现，需自建协议 |

关键洞察：**模式二是模式一的加强版**——二者的数据管道（序列化/上传/下载/克隆）完全同一条，模式二只是多了「云端互斥锁 + 控制通道 + 驱逐握手」。所以架构上先做模式一，模式二是在同一管道上加协调层。

---

## 2. 重点项目 VirtualBrowser（用户指定）源码级深挖

用户确认 "virtual borders" 即 **https://github.com/Virtual-Browser/VirtualBrowser**（3,157★，v2.3.1，2026-07-30；中文圈最有名的「半开源」指纹浏览器）。以下结论全部来自对仓库文件、Releases、Issues 的实际读取；内核源码闭源不可见处如实标注。

### 2.1 一句话定位

商业产品（virtualbrowser.cc / vbbrowser.com），「开源 UI 引流 + 内核闭源 + 高级功能收费」模式：仓库内只有两个 Vue 前端工程（管理器 UI + 环境内新标签页）和 Playwright 示例；**内核 C++ 补丁在 [VirtualBrowser-core](https://github.com/Virtual-Browser/VirtualBrowser-core)（仓库 0KB，仅二进制 Releases，月更跟随 Chromium 151→153）**；账号/授权、本地 API(:9000)、代理商城全部闭源。社区对其「假开源」争议不小（[#108](https://github.com/Virtual-Browser/VirtualBrowser/issues/108)、[#111](https://github.com/Virtual-Browser/VirtualBrowser/issues/111)）。

**关键事实**：其闭源客户端**已经上线了我们想做的东西**——v2.2.15（2026-04）云同步增强 + 云空间占用显示；v2.2.16（2026-05）**新增 WebDAV 云同步**、多服务器切换；v2.3.0（2026-07）代理商城。但开源仓库里**一行同步代码都没有**，其增量/加密策略无任何公开资料。

### 2.2 最有参考价值：WebUI + chrome.send 原生桥

管理器 UI 不是独立 App，而是**内核内置的 WebUI 页面**，通过 Chromium 标准 `chrome.send(name, [callbackName, ...args])` + `cr.webUIResponse` 回调与内核通信（每次调用生成 uuid 回调名 + 超时控制）。内核暴露的原生 API 面只有 9 个方法（[server/src/api/native.js](https://github.com/Virtual-Browser/VirtualBrowser/blob/main/server/src/api/native.js) 全文精读）：

| 方法 | 作用 |
|---|---|
| `getGlobalData` / `setGlobalData` | 全局设置读写（权威存储在内核侧） |
| `getBrowserList` / `setBrowserList` | 环境列表读写（整对象一次序列化写入；UI 双写 localStorage 作缓存） |
| `deleteBrowser` | 删除环境（内核侧清数据目录） |
| `launchBrowser` | 启动环境（只传 id，内核自行读配置） |
| `getRuningBrowser` / `getBrowserVersion` | 查询运行中环境 / 内核版本 |
| `checkProxy` | 内核侧代理连通性检测 |

反向推送：内核直接调 UI 的 `window.updateLaunchState()`。

**设计启示**：桥面极小、UI 与内核彻底解耦、**零端口暴露**（对比本地 HTTP API 方案）。其「内核→UI 事件推送」机制正是我们模式二「被驱逐通知」在客户端内的同构形态。

### 2.3 环境数据模型（可直接复用）

- 环境数据目录：`%LOCALAPPDATA%\VirtualBrowser\Workers\<workerId>`，内核参数 `--worker-id=<id>`
- 环境条目 schema（[index.vue](https://github.com/Virtual-Browser/VirtualBrowser/blob/main/server/src/views/browser/index.vue) `getDefaultForm()`）：id/name/group/os/chrome_version + proxy（支持轮换代理 API 拉取地址）+ cookie（**Playwright 格式 JSON 预注入**：name/value/domain/path/sameSite…）+ homepage + **25 个指纹 surface**
- **指纹建模：分 surface 显式值**，每个 surface `{mode, value}` 三态：`0`=不伪装 / `1`=自定义值 / `2`=按代理出口 IP 自动匹配（语言/时区/地理位置）——比单一 seed 更细粒度；可与 fingerprint-chromium 的 seed 模式结合（seed 出默认值 + surface 级覆盖）
- **可直接复用的资产**：`server/src/utils/` 下的指纹字典 JSON——timezones（29KB）、languages（10KB）、webgl vendor 列表（8.6KB）、speech-voices、ua-full-versions、fonts 等。协议：根 LICENSE 为 BSD-3，server/ 内另含 vue-element-admin 的 MIT 上游声明，保留版权即可复用
- schema 版本迁移的简单做法：`processUpdateData()` 在每次加载列表时自动迁移旧格式

### 2.4 内核可插拔分发

客户端与内核包**双仓库、双版本节奏**：客户端 1~2 月一版；内核包月更跟随 Chromium（151.0.7922.71 / 152.0.7977.83 / 153.0.8010.47，[core releases](https://github.com/Virtual-Browser/VirtualBrowser-core/releases)，win.zip 约 220MB）；客户端支持多内核并存、**按环境选择内核版本**。「客户端版本与内核版本解耦分发」值得直接借鉴——避免内核升级绑架客户端发版。

### 2.5 自动化接入

两种方式（[automation/](https://github.com/Virtual-Browser/VirtualBrowser/blob/main/automation/README.md)）：① 直接 `launchPersistentContext(user-data-dir, {args: ['--worker-id=<id>']})`；② 本地 HTTP API `POST :9000/api/launchBrowser {id}` → 返回 `debuggingPort` → `connectOverCDP`。**其本地 API 无任何鉴权，我们实现时必须补 token**。

### 2.6 值得注意的信号与坑

- **社区强需求未被满足**：[#95](https://github.com/Virtual-Browser/VirtualBrowser/issues/95) 详细请求团队多用户、环境分配、权限分级（含「可导出 cookie」权限）、操作审计——官方未回复。多设备/团队共享正是我们的差异化方向
- **指纹实现坑**：canvas/WebGL 用全局 r/g/b/a 色彩偏移 → [#98 上传图片变色](https://github.com/Virtual-Browser/VirtualBrowser/issues/98)、[#102 CreepJS DOMRect 标红](https://github.com/Virtual-Browser/VirtualBrowser/issues/102)。我们应采用 per-seed 确定性噪声（fingerprint-chromium 的做法）
- **元数据管理坑**：分组只存 UI localStorage、从不走原生桥——清浏览器数据即丢；权威数据源必须统一（内核侧/服务端）
- **隐私减分项**：启动时经 `http://`（明文）请求更新接口并**上报本机环境数量**
- **开源口碑坑**：「UI 开源引流 + 内核闭源 + 收费」招致「假开源」争议——我们的开源/收费边界要一开始就说清楚

### 2.7 取舍结论

| 层 | VirtualBrowser 能给什么 | 不能给什么（转向） |
|---|---|---|
| 客户端 | WebUI 原生桥设计、环境 schema / 25-surface 数据模型、指纹字典 JSON、UI 交互范式 | — |
| 内核 | `--worker-id` 式环境参数设计、可插拔分发模式 | 全部 C++ 补丁（→ fingerprint-chromium） |
| 云同步 | **WebDAV 作为「用户自带存储」后端的产品验证**；「云空间」形态的商业先例 | 全部实现（→ Donut Browser） |
| 商业 | 高级功能收费、代理商城形态参考 | — |

---

## 3. 开源指纹浏览器全景（12+ 个项目，全部实测验证）

### 3.1 总览表

| 项目 | Stars | 协议 | 内核 | 实现方式 | 可借鉴度 |
|---|---|---|---|---|---|
| [zhom/donutbrowser](https://github.com/zhom/donutbrowser) | 3,993 | **AGPL-3.0** | 自家 Wayfern fork（内核闭源） | Tauri 管理器 + 引擎级伪装 | **高（云同步）** |
| [adryfish/fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium) | 3,127 | **BSD-3** | Ungoogled Chromium 132→150 | 原生 C++ 补丁 | **高（内核）** |
| [DFarm6/Prism-Browser-Community](https://github.com/DFarm6/Prism-Browser-Community) | 675 | **MIT** | Chromium 144（二进制分发） | Electron 管理器 + 外挂内核 | **高（客户端/快照）** |
| [CloakHQ/CloakBrowser](https://github.com/CloakHQ/CloakBrowser) + [Manager](https://github.com/CloakHQ/CloakBrowser-Manager) | 32,001 / 975 | wrapper MIT，**内核补丁专有** | Chromium | 自动化 wrapper + 闭源引擎 | 中 |
| [ProxyShard/ShardBrowser](https://github.com/ProxyShard/ShardBrowser) | 1,213 | MIT（启动器） | 补丁 Chromium 152（补丁未开源） | 引擎级 + 开源启动器 | 中（指纹验收表） |
| [Virtual-Browser/VirtualBrowser](https://github.com/Virtual-Browser/VirtualBrowser) | 3,157 | BSD-3（仅 UI） | Chromium（内核闭源包） | UI 开源 | **中-高（客户端架构，见第 2 节）** |
| [Simprint/simprint](https://github.com/Simprint/simprint) | 643 | AGPL-3.0 | Chromium | Tauri2+Rust 管理器 | 中（可跟踪） |
| [daijro/camoufox](https://github.com/daijro/camoufox) | 12,433 | MPL-2.0/MIT | Firefox（补丁全开源） | C++ 层拦截 | 中（对照） |
| [ovobrowsersupport/ovobrowser](https://github.com/ovobrowsersupport/ovobrowser) | 848 | MIT | Chromium 138/144/150（补丁未随仓库） | 引擎级 | 低-中（中文文档） |
| [itbrowser-net/undetectable-fingerprint-browser](https://github.com/itbrowser-net/undetectable-fingerprint-browser) | 871 | **无协议** | — | — | 低（法律不可用） |
| [black-ant/Ant-Browser](https://github.com/black-ant/Ant-Browser) | 1,960 | **无协议** | 外接 fingerprint-chromium | 启动器 | 低（法律不可用） |
| patchright / nodriver / undetected-chromedriver | 4,807 / 4,824 / 12,862 | Apache-2.0 / AGPL-3.0 / GPL-3.0 | 纯净 Chrome | 自动化库 | 低（仅自动化接入参考） |

附：**Surfinite 确认闭源**（GitHub 无 `surfinite-browser` 组织，404）；[N4darae/anti-mage](https://github.com/N4darae/anti-mage)（2,067★，MIT）是反向检测工具，**建议留作我们产品的自测靶子**。

### 3.2 Donut Browser —— 模式一的工程蓝本（重点深挖）

仓库：https://github.com/zhom/donutbrowser （AGPL-3.0，Rust + Tauri + React，官网 [donutbrowser.com](https://donutbrowser.com)，已实测确认存在与功能）。

**功能面**：无限 profile、每 profile 独立 cookies/扩展/代理（HTTP/SOCKS5/**WireGuard**）、一次性 profile、从 Chrome/Edge/Brave 导入、cookie 导入导出、跨设备云同步（官方 Donut Sync 或 Docker 自建，可选 E2E 加密）、本地 REST API + CDP + MCP。

**云同步实现（源码级，直接对应我们的需求）：**

客户端 `src-tauri/src/sync/`（已验证目录存在，12 个文件）：
- [`engine.rs`](https://github.com/zhom/donutbrowser/blob/main/src-tauri/src/sync/engine.rs)：每 profile 异步锁；并发 32 上传/下载、单文件重试 3 次；**登录态关键文件清单**：`Cookies`、`Login Data`、`Local Storage`、`Local State`、`Preferences`、`Secure Preferences`、`Web Data`、`Extension Cookies`（任一失败即中止）
- [`manifest.rs`](https://github.com/zhom/donutbrowser/blob/main/src-tauri/src/sync/manifest.rs)：**增量同步**——内容哈希缓存 + diff 只传变化文件；`DEFAULT_EXCLUDE_PATTERNS` 排除一切易变文件（各类 Cache、Session Storage、blob_storage、Crashpad、`*-journal/-wal/-shm`、LOCK、favicons……）→ 同步的是「登录态最小集 + 持久化数据」
- [`encryption.rs`](https://github.com/zhom/donutbrowser/blob/main/src-tauri/src/sync/encryption.rs)：E2E = **Argon2id（m=19456KiB, t=2, p=1）派生 AES-256-GCM 密钥**，每实体独立 salt，支持改密轮换；服务端只见密文
- 冲突处理：对象元数据 `x-amz-meta-updated-at` 做 last-write-wins；`pending_deletes.rs` 墓碑机制同步删除

服务端 `donut-sync/`（NestJS，可 Docker 自建）：[`sync.service.ts`](https://github.com/zhom/donutbrowser/blob/main/donut-sync/src/sync/sync.service.ts) 本质是 **S3 兼容存储上的 presign 薄层**——JWT 认证 + 预签名 URL + 每作用域一个 manifest 标记对象。**「自建服务器只是 S3 presign 网关」这个架构对我们极有参考价值**（服务端无状态、成本极低）。

**一个关键推断【推断】**：Donut 直接同步 `Cookies`/`Local State` 原始文件且宣称跨设备可用，但按第 4.2 节，这些文件本应被 OS 密钥（DPAPI/Keychain/ABE）绑死本机——唯一的解释是 **Wayfern 内核对 os_crypt 做了「可漫游」改造**（内核代码闭源无法直接确认）。这给我们的启示是：**只要控制内核，"整文件级快照同步"就是可行且最完整的路线**（这也是我们选定自研内核补丁的理由）。

**协议警示**：AGPL-3.0 有强传染性，直接复用代码会导致整个客户端必须开源。策略：**只学方案（文件清单/排除表/manifest/加密参数），代码全部重写**。

### 3.3 fingerprint-chromium —— 内核层最佳起点

仓库：https://github.com/adryfish/fingerprint-chromium （BSD-3-Clause，release 150.0.7871.186，2026-10-02）。

- 唯一**补丁源码公开且持续跟进新版**（132→150）的 Chromium 指纹内核；补丁放在版本分支（如 [`148.0.7778.215`](https://github.com/adryfish/fingerprint-chromium/tree/148.0.7778.215)），沿用 ungoogled-chromium 的 patches 基础设施
- 补丁文件（`patches/extra/fingerprint/`，实读验证）：`000-add-fingerprint-switches`、`002-user-agent-fingerprint`、`003-audio-fingerprint`、`005-hardware-concurrency`、`006-font`、`011-gpu-info`、`012/013-canvas`、`014-client-rects`、`015-measure-text`、`016-webgl-readPixels`、`018-timezone`、`021-device-memory-cap` 等 21+ 个
- 用法：`--fingerprint=[种子]` + `--fingerprint-platform/--brand` + `--timezone/--lang` + `--proxy-server`，**种子决定整套指纹，天然满足「同一环境跨设备指纹一致」**——这对我们至关重要（A 机 B 机克隆出的环境指纹必须相同，否则站点风控会看到「环境突变」）
- 无 profile 管理、无同步 → 正好由我们自建

**对项目特别重要的一点**：它的基座是 ungoogled-chromium，而 **ABE（App-Bound Encryption）是 Chrome 品牌特性**，在这类构建上默认不启用【推断，需原型验证】——意味着 Windows 上我们改造 os_crypt 的工作量更小。

### 3.4 Prism —— 「profile 快照」标准格式（MIT，可直接复用）

仓库：https://github.com/DFarm6/Prism-Browser-Community （MIT；注意 README 声明 v0.3.17 起源码不再例行同步，复用时固定某个 release 快照）。

[`src/main/profile-backup.ts`](https://github.com/DFarm6/Prism-Browser-Community/blob/main/src/main/profile-backup.ts)（实读源码）定义了完整的导出/导入格式：
- 整棵 user-data-dir → staging 目录 + `manifest.json`：`schemaVersion`、`exportedAt`、`sourcePlatform`、`sourceAppVersion`、`totalBytes`、`fileCount`、`contentSha256`（对「相对路径+大小+内容」流式 sha256）
- 原子性：先写 `.partial` 再 rename；上限保护（100 万文件 / 500GB）
- 安全细节：**导出时代理密码强制置空**（值得抄）
- 支持三级迁移粒度：cookie / 单 profile / 整工作区

把它「复制到本地目录」的目标端换成「加密打包上传云端」，就是模式一的上传/下载层。

### 3.5 其他值得记录的项目（简评）

- **[ShardX/ShardBrowser](https://github.com/ProxyShard/ShardBrowser)**：补丁不公开，但 README 的「Fingerprint surfaces patched」是**业界最细的指纹面清单**（含 TLS ClientHello/JA4 洗牌、QUIC over SOCKS5 UDP、`x-client-data` 头复现、WebAuthn、Android 移动指纹全套）——可直接当我们内核的**需求验收表**。本地 HTTP API（JWT）+ openapi.yaml 设计可参考
- **[CloakBrowser-Manager](https://github.com/CloakHQ/CloakBrowser-Manager)**：自托管多用户 profile 管理器（Python + React + SQLite）+ Linux 容器/KasmVNC 远程浏览器，可作我们**服务端多用户形态**参考；但其引擎闭源需付费许可
- **[camoufox](https://github.com/daijro/camoufox)**：Firefox 系对照——「指纹生成器（fpgen，按真实流量分布生成一致性身份）与内核分离」的思路值得借鉴
- **[ovobrowser](https://github.com/ovobrowsersupport/ovobrowser)**：`docs/zh/FINGERPRINT.md`、`FLAGS.md` 中文文档质量高，可当 flags 手册
- **自动化三件套**（patchright/nodriver/undetected-chromedriver）：与云同步需求不直接相关；若我们开放 CDP/本地 API 供自动化接入，可参考 patchright 对 CDP 泄露面的处理

---

## 4. 登录态同步的底层技术事实（决定架构的两个硬约束）

### 4.1 登录态存在哪些文件里

【社区·高质量取证共识，与 Chromium 源码结构一致】

| 文件/目录 | 内容 | 格式 | OS 加密 |
|---|---|---|---|
| `Network/Cookies`（Chrome 96 起移入 Network/） | **cookie** | SQLite | ✅ 是 |
| `Login Data` / `Login Data For Account` | 保存的密码 | SQLite | ✅ 是 |
| `Web Data` | 自动填充/支付 | SQLite | ✅ 是 |
| `Local Storage/leveldb` | localStorage | LevelDB | ❌ 否 |
| `IndexedDB/`（每源一个目录） | IndexedDB | LevelDB | ❌ 否 |
| `Service Worker/` | SW 脚本缓存+存储 | LevelDB | ❌ 否 |
| `Sessions/` | 当前会话标签页快照 | — | ❌ 否 |
| `Preferences` / `Secure Preferences` | 设置 | JSON | 部分 |
| `Local State`（User Data 根，全局） | **加密密钥等** | JSON | — |

### 4.2 OS 加密层：与「跨机器拷贝」直接冲突

【官方】（源码：[os_crypt README](https://chromium.googlesource.com/chromium/src/+/main/components/os_crypt/README.md)）

- **macOS**：随机密钥存 Keychain（"Chrome Safe Storage"），派生对称密钥加密 cookie 值 → 拷到别的 Mac，Keychain 里没有这个条目，解不开
- **Windows 旧机制**：`Local State` 里 `os_crypt.encrypted_key` = DPAPI 加密的随机密钥（绑定本机用户）→ 拷走解不开
- **Windows 新机制 ABE（Chrome 127 起，先用于 cookies）**：密钥换成 `app_bound_encrypted_key`（"APPB" 前缀），解密需本机 SYSTEM 权限 elevation service。[Google 安全博客原文](https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html)：**"App-Bound Encryption strongly binds the encryption key to the machine, so will not function correctly in environments where Chrome profiles roam between multiple machines"** —— 官方明说与 profile 漫游不兼容；企业策略 `ApplicationBoundEncryptionEnabled` 可关（我们自有内核则无此负担）

**结论**：对「原版 Chrome」做整目录同步不可行；可行路线只有两条：

1. **路线 A（我们选定）：控制内核 → 改造 os_crypt**。在我们自己的 Chromium 构建里，让 cookie/密码加密使用**应用层密钥**（例如由同步口令派生、或随 profile 走的密钥文件），使 `Cookies` 等文件天然可漫游；云端再叠加 E2E（Donut 方案）。优点：登录态 100% 完整（含 IndexedDB/SW）；缺点：必须维护内核补丁。Donut 的实践（同步 `Local State`+`Cookies` 原文件且跨设备可用）证明此路线已跑通【推断其内核如此实现，其内核闭源无法直接确认】。
2. **路线 B（对照组）：CookieCloud 式扩展 API 搬运**。`browser.cookies` API 给的是明文，天然绕开全部 OS 加密；[CookieCloud](https://github.com/easychen/CookieCloud) 源码已验证（读 `cookies.getAll` 写 `cookies.set`；localStorage 靠 content script；服务端只存密文；AES-CBC + MD5 派生——加密强度弱，仅思路可取）。缺点：只覆盖 cookie+localStorage，IndexedDB/SW/密码全丢。适合作为「兼容原版 Chrome 的降级通道」，不做主路线。

### 4.3 DBSC：Google 会话已被设备绑定（本产品最大的外部风险）

【官方时间线，全部经核实】

| 日期 | 事件 |
|---|---|
| 2024-04 | Google 首次宣布 DBSC |
| 2025-03~2025 下半年 | Chrome origin trial（135–139、142–144），Chrome 145 shipped |
| 2026-04-09 | DBSC 公开可用（Windows Chrome 146）；Google 称部署一年来「会话盗用显著下降」；私钥存 TPM/Secure Enclave，**"cannot be exported from the machine"**（[blog.google](https://blog.google/security/protecting-cookies-with-device-bound-session-credentials/)） |
| 2026-05-25 起 | **GA 并对 Google Workspace + 个人 Google 账号默认启用**，"no administrator control to disable it"，"no end user setting"，60 天内全量（[Workspace 更新](https://workspaceupdates.googleblog.com/2026/05/prevent-account-takeovers-with-DBSC-now-generally-available-in-the-Chrome-browser-for-Windows.html)）——即 **2026 年 7 月底前已全量** |
| 2026-10（现在） | Chrome 稳定版 155；Windows 上 DBSC 已全量约 5 个月，macOS 推进中 |

**机制**（[W3C 草案](https://w3c.github.io/webappsec-dbsc/) + [Chrome 文档](https://developer.chrome.com/docs/web-platform/device-bound-session-credentials)）：登录时浏览器生成**每会话非对称密钥对**（私钥在 TPM，不可导出），长寿命 cookie 换成短寿命 cookie（分钟级），到期必须用私钥签名 challenge 才能续期。

**对我们两个模式的直接影响**：
1. 把 Google 登录态搬到 B 机：受 DBSC 保护的会话短 cookie 过期后**无法在 B 机续期**（需 A 机 TPM 私钥）→ **「A 机登 Google、B 机免登录用」对 Google 不可行**，无论文件拷贝还是结构化导出都绕不过（TPM 私钥不在 profile 里）。整 profile 克隆也一样【官方机制 + 时间线综合推断】
2. 例外口子：目标站点未部署 DBSC（目前绝大多数站点）→ 方案照常；规范允许浏览器不支持 DBSC 时**降级回普通 cookie**——理论上「不支持 DBSC 的自定义内核」会拿到传统长寿命 cookie，但 Google 同时有盗用 cookie 检测 + 异常 IP 登录挑战（【官方】KB 确认），这条路既不稳定也有对抗性质，**不建议作为产品承诺**
3. **产品口径建议**：把 Google 列为「已知受限站点」（用户会看到登录被重新要求验证），主打对 DBSC 之外的站点（B 站等）的完美体验；并在文档中如实说明原因。这也符合对用户诚实原则，避免产品背上「对抗 Google 风控」的定位
4. 附带事实：Google `SID/HSID` cookie 官方有效期 2 年【官方】；换 IP 触发重新验证为官方确认行为【官方】——即使没有 DBSC，跨 IP 搬会话也可能被要求验证，**每个环境绑定固定代理（指纹浏览器标配）可以显著缓解**

---

## 5. 现有「同步/云」架构参考（借设计不借代码）

| 参考 | 借什么 |
|---|---|
| **Chromium 自带 Sync**（[components/sync](https://chromium.googlesource.com/chromium/src/+/main/components/sync/README.md)【官方】） | 结构化数据类型 + Nigori 端到端加密的设计思想；注意 **cookie 不在其同步范围**（官方确认）——Google 自己都不碰 cookie 同步，反衬此问题的特殊性 |
| **Brave Sync v2**（[设计 wiki](https://github.com/brave/brave-browser/wiki/Brave-Sync-v2)【官方】） | **「密钥即身份」的无账号 chain**：首设备生成 32 字节 seed（BIP39 24 词/二维码），HKDF-SHA512 派生 Ed25519 密钥对做服务器认证，scrypt 拉伸 + AES-CTR-HMAC 加密，服务器只见密文元数据 → 直接借鉴为云端 profile 的所有权模型（避免账号系统的密码学负担） |
| **Donut Sync**（上文 3.2） | 文件清单/排除表/增量 manifest/Argon2id+AES-GCM/S3 presign 服务端 |
| **Steel 云版 Profiles API**（[文档](https://docs.steel.dev/overview/profiles-api/overview)【官方】） | **模式一的 API 语义**：profile = user-data-dir 快照（300MB 上限、30 天回收）；session 带 `profileId` 复用快照，`persistProfile: true` 才写回——「默认不累积 = 快照分支」语义与我们模式一完全一致；官方还建议「一 profile 一固定 IP」 |
| **Prism profile-backup**（上文 3.4） | 快照格式（manifest + sha256 + 原子写 + 密码剥离） |
| **CookieCloud** | 扩展 API 明文通道（路线 B）；`browser.alarms` 定时对齐推送的触发模型 |

**模式二现状**：公开方案里**没有**「多客户端互斥接管 + 数据回传再下发」的现成实现（Steel 未定义并发互斥；BrowserBox 的「席位」是天然独占但无搬迁语义）→ 需自建，设计草案见下节。

---

## 6. 两种模式的推荐架构

### 6.1 总体分层

```
┌─ 客户端管理器（Tauri/Electron，参考 Prism）
│    ├─ 环境列表 UI、指纹配置（种子）、代理绑定
│    ├─ 快照引擎（参考 Prism manifest 格式 + Donut 文件清单/排除表）
│    └─ 本地 REST/CDP API（参考 ShardX）
├─ 内核（fingerprint-chromium 为底座，自维护补丁）
│    ├─ 指纹面（种子驱动，跨设备一致）
│    └─ os_crypt 可漫游改造（应用层密钥）★关键自研点
├─ 同步层（参考 Donut：Argon2id→AES-256-GCM，E2E）
│    └─ 增量 manifest + 内容哈希 diff + LWW + 墓碑
└─ 云端（薄服务，参考 Donut Sync + Brave chain）
     ├─ 认证：Brave 式 seed/Ed25519「密钥即身份」（或传统账号）
     ├─ 存储：S3 兼容 + presign，服务端无状态；可选「用户自带 WebDAV」后端（VirtualBrowser 已验证该需求）
     └─ 控制通道：WebSocket（模式二的租约/驱逐信令）
```

客户端壳的两条路线（第 2 节深挖结论）：① **独立壳（Tauri/Electron）+ 外挂内核**——Prism/Ant-Browser 模式，不依赖内核构建、生态成熟；② **管理器即内核 WebUI**（VirtualBrowser 模式）——UI 打包进内核、经 `chrome.send` 桥调用原生能力，零端口暴露、发版统一，但前端工程受 WebUI 约束。MVP 建议先走 ①（解耦内核构建节奏），产品化时评估 ②。

### 6.2 模式一（快照分支）流程

1. 用户在 A 机某环境内完成登录（手动或引导）
2. 管理器对该 profile 触发**快照捕获**：关闭（或冻结）该环境浏览器 → 按 Donut 式文件清单+排除表打包 → manifest（sha256、平台、版本）→ E2E 加密 → 上传 S3，云端记录为该环境的 `base snapshot`
3. 任意设备打开该环境：下载最新快照 → 解密 → 还原到本地新 `user-data-dir` → 以该环境固定指纹种子 + 代理启动 → **本地变更默认丢弃**（= Steel `persistProfile=false` 语义，严格符合「每次从登录状态分支出去」）
4. 可选 `写回`：会话结束再抓一份新快照，云端保留快照版本链（支持回滚/分支）——注意这就是模式二需要的管道
5. 快照保鲜问题：cookie 有有效期，长期不用会过期 → 借鉴 CookieCloud 的 keep_live（云端或任一客户端定时静默访问保活）或提示用户重新登录刷新快照

### 6.3 模式二（互斥接管）协议草案（自研，无现成可抄）

核心：**每个环境一个云端租约（lease），持有者独占**。

```
状态机：环境 ∈ { IDLE(有快照), LEASED(被某设备持有) }

B 机请求打开环境 E：
  1. B → 云：acquire(E)
  2. 云若 IDLE：直接下发快照 → B 启动，转 LEASED(B)
  3. 云若 LEASED(A)：
     a. 云经 WebSocket 向 A 下发 evict(E, deadline=T)
     b. A 收到：优雅关闭环境内页面 → 触发快照捕获（复用模式一管道）→ 上传新快照 → A 回 ack(released, snapshot_id)
        （A 离线/超时 → 云用最后一份快照继续，数据可能略旧）
     c. 云下发 snapshot_id 给 B → B 下载启动，转 LEASED(B)
  4. A 被驱逐的本地表现：页面被关闭 + 提示「环境已被设备 B 接管」
```

工程要点：
- **优雅关闭优先**：让浏览器正常退出再抓快照，避免 SQLite/LevelDB 处于 WAL 中间态（Donut 排除表已排除 `-wal/-shm`，但正常关闭仍更稳）
- **租约心跳**：持有设备定期心跳，掉线超时自动释放（防 A 机断电导致死锁）；心跳里可带上「活跃站点」用于 UI 展示谁在用
- **同一站点粒度**：需求描述以「站点」为粒度（YouTube），实现上建议先以「环境」为粒度（一个环境一组站点），站点级粒度需要 per-site cookie 切片（cookie 按域抽取，CookieCloud 的按域字典结构可参考），作为 v2 演进
- **与 DBSC/风控的关系**：搬迁 = 换 IP + 环境，敏感站点可能触发重新验证；绑定固定代理可大幅缓解；Google 依旧受限（4.3 节）

### 6.4 安全底线

- cookie = 凭证。云端**必须 E2E**（Donut 的 Argon2id→AES-256-GCM 参数可直接沿用；不要学 CookieCloud 的 MD5 短口令派生）
- 快照中**代理密码剥离**（Prism 的做法）或单独加密
- 本地快照缓存磁盘加密；多用户设备的锁屏锁（Donut 有密码锁 profile 的先例）

---

## 7. 推荐 MVP 路线（先解决最大不确定性）

**Phase 0：技术风险验证（最优先，1~2 周）**——两个实验直接决定整个项目成败：
1. **可漫游加密验证**：基于 fingerprint-chromium 构建内核，补一个「os_crypt 使用应用层固定密钥」的补丁 → 在 Mac A 登录 B 站 → 拷贝 user-data-dir 到 Mac B 打开 → 验证免登录可用（顺带验证 Windows/跨平台）
2. **DBSC 影响实测**：同一管道对 Google 账号实测，确认 4.3 节结论在最新 Chrome 155 下的实际表现（含我们内核不支持 DBSC 时的降级行为），形成对用户的准确预期

**Phase 1：客户端骨架（2~4 周）**：Tauri/Electron 管理器 + 环境（=独立 user-data-dir + 指纹种子 + 代理）+ 本地快照导出/导入（Prism 格式）。环境表单与指纹字典可直接复用 VirtualBrowser 的 25-surface 数据模型及 `server/src/utils/` 字典 JSON（BSD-3，保留版权声明）。此阶段纯本地，无云端。

**Phase 2：模式一上云（4~6 周）**：E2E 加密 + S3 presign 薄服务端（Donut 架构）+ 快照版本链 + 克隆启动。

**Phase 3：模式二（3~4 周）**：WebSocket 控制通道 + 租约/驱逐/搬迁协议（6.3 草案）。

**Phase 4：指纹面打磨（持续）**：对照 ShardX 的指纹面清单逐项补齐；用 anti-mage 做自测；跨设备一致性测试（同种子 A/B 机指纹必须逐位一致）。

---

## 8. 风险清单

| 风险 | 等级 | 应对 |
|---|---|---|
| Google DBSC 阻断 Google 会话共享（已全量） | **高·不可解** | 产品口径明确「Google 受限」；主打其他站点；不承诺对抗 |
| ABE/DPAPI/Keychain 与漫游冲突 | 高·可解 | 自研内核改 os_crypt（Phase 0 验证） |
| 站点风控：换 IP 触发重验证 | 中 | 每环境绑定固定代理（指纹浏览器标配能力） |
| cookie 自然过期，快照失效 | 中 | keep_alive + 快照版本链 + 重新登录刷新提示 |
| 开源协议：Donut/simprint=AGPL、两个仓库无协议 | 中 | 只学方案不抄代码；只用 BSD/MIT/Apache 代码 |
| 内核补丁维护成本（Chromium 版本跟进） | 中 | 基于 fingerprint-chromium 的 patch 体系（BSD），跟随其版本分支 |
| 法律/合规：存储用户凭证、指纹伪装用途 | 中 | E2E 加密、用户自有数据定位；产品定位「个人多设备自用」；上线前法务过一遍目标市场 |
| 快照体积（IndexedDB 大的站点可到数百 MB） | 低 | Donut 排除表 + 增量 manifest + S3 低成本；Steel 上限 300MB 可参考 |

---

## 9. 参考链接汇总

**核心借鉴对象**
- Donut Browser：https://github.com/zhom/donutbrowser （同步引擎 `src-tauri/src/sync/`、服务端 `donut-sync/`、自建文档 https://donutbrowser.com/docs/self-hosting）
- fingerprint-chromium：https://github.com/adryfish/fingerprint-chromium （补丁在版本分支）
- Prism：https://github.com/DFarm6/Prism-Browser-Community （`src/main/profile-backup.ts`）
- Brave Sync v2 设计：https://github.com/brave/brave-browser/wiki/Brave-Sync-v2
- Steel Profiles API：https://docs.steel.dev/overview/profiles-api/overview
- CookieCloud：https://github.com/easychen/CookieCloud

**官方技术文档**
- os_crypt：https://chromium.googlesource.com/chromium/src/+/main/components/os_crypt/README.md
- ABE 官宣（含「与漫游不兼容」原文）：https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html
- DBSC：https://developer.chrome.com/docs/web-platform/device-bound-session-credentials · W3C 草案：https://w3c.github.io/webappsec-dbsc/
- DBSC GA（默认启用、无开关）：https://workspaceupdates.googleblog.com/2026/05/prevent-account-takeovers-with-DBSC-now-generally-available-in-the-Chrome-browser-for-Windows.html
- DBSC 公告：https://blog.google/security/protecting-cookies-with-device-bound-session-credentials/
- Chromium Sync 组件：https://chromium.googlesource.com/chromium/src/+/main/components/sync/README.md

**其他项目**
- ShardBrowser：https://github.com/ProxyShard/ShardBrowser （指纹面验收清单）
- VirtualBrowser（用户指定重点项目）：https://github.com/Virtual-Browser/VirtualBrowser · 原生桥源码：https://github.com/Virtual-Browser/VirtualBrowser/blob/main/server/src/api/native.js · 环境列表 UI：https://github.com/Virtual-Browser/VirtualBrowser/blob/main/server/src/views/browser/index.vue · 指纹字典：https://github.com/Virtual-Browser/VirtualBrowser/tree/main/server/src/utils · 内核包发布：https://github.com/Virtual-Browser/VirtualBrowser-core/releases
- Camoufox：https://github.com/daijro/camoufox · anti-mage（自测靶）：https://github.com/N4darae/anti-mage
- steel-browser（OSS）：https://github.com/steel-dev/steel-browser · BrowserBox：https://github.com/BrowserBox/BrowserBox
- ABE 解密研究：https://github.com/xaitax/Chrome-App-Bound-Encryption-Decryption
