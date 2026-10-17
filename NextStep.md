# NextStep.md —— 下一步做什么

> **本文件是项目的「工作指针」**：任何时刻打开它，就能知道项目接下来该做什么、当前处于什么状态。
> 维护规则见 README 的「工作流约定」。每次开始/完成一段开发工作，都必须先更新本文件。

---

## 使用规则

1. **接手任何工作前**：先读本文件，从「下一步」列表的第一项开始。
2. **完成一项后**：立即把它移入「已完成归档」，并更新「当前状态」快照。
3. **计划变更时**：同步修订本文件（它必须始终反映真实的下一步，而不是过期的愿望清单）。
4. 相关背景文档：总体规划 `docs/project-plan.md` · 版本计划 `docs/v0.2.0-plan.md` · 排障与已知问题 `docs/v0.2.0-s3-notes.md`。

## 当前状态（快照，2026-10-17）

- **V0.4-A 准备件 + V0.4-C 生产硬化已完成**：os_crypt 注入补丁（148 精确 diff）+ 构建脚本；限流/配额/深度健康检查 + 生产 compose（Caddy TLS）+ production.md；全量回归限流下全绿
- **V0.4-B mac 安装包已完成**：electron-builder 双架构 dmg（x64 144MB / arm64 140MB，ad-hoc 签名，不带内核首用下载）；**安装包内 app 实测 builtin e2e 17/17 + UI 截图冒烟通过**（asar/CJS preload/依赖收集全对）；`make dist-mac`
- **V0.3.1 已完成**：L2 快照 zstd 压缩（36KB vs gzip 50KB）+ 观测日志；修复 macOS bsdtar 流式 zstd 两大坑（stdout 静默截断 / stdin fork 失败 → 临时文件中转）；回归 l2 7/7 · interop 13/13
- **V0.4 规划已出**（`docs/v0.4.0-plan.md`）：原生内核 + os_crypt 补丁（148 源码先行）/ 安装包分发 / 生产硬化；builtin L2 评估结论=不做（L1 回退已闭环）
- **V0.3.0 已发版**：L2 文件级快照全链路（kernel 环境 profile 整体漫游 + 双写 L1 副本互迁移兜底）；验证基线 l2 7/7 · interop 13/13 · fp 10/10 · builtin 17/17 · kernel-smoke 7/7
- **M6 预研已完成（GO）**：Linux 内核 profile 目录原样拷贝即可漫游（cookie/localStorage/IndexedDB 全部读回，`apps/desktop/scripts/os-crypt-roaming-poc.mjs` 可复跑）；无需 os_crypt 补丁；教训：会话 cookie 重启即弃曾致误判（`docs/m6-research.md`）

- **版本**：V0.2.0 已发版（tag `v0.2.0`）——双承载（builtin ⇄ kernel 指纹内核）+ 代理/auto 时区 + 保留策略 + 会话健康检查
- **验证基线**：Go 测试（auth/leases/snapshots/testsite）· typecheck · kernel-smoke 7/7 · builtin e2e 17/17 · interop 12/12 · fp e2e 10/10（全绿）
- **KI-1/KI-2 已解决**：根因均为非法 seed（必须 32 位整数，读取 `navigator.hardwareConcurrency` 即死锁）；客户端已强校验 + 旧数据回填
- **运行环境**：server(:8787) / test-site(:18080) / Postgres(docker) / MinIO(:9000) 本机常驻
- **内核验证环境**：`scripts/kernel-docker/`（Linux x64 内核 + Xvfb + SwiftShader + socat；镜像 `onebrowser-kernel-smoke`）

## 下一步（按优先级，V0.4 执行）

1. **V0.4-A 内核补丁 PoC 收尾**：源码 tarball 已在 `/Users/macos/Code/ob-kernel-build/build/download_cache` 后台下载中（约 1.5G+，完成后跑 `scripts/kernel-build/bootstrap.sh` 的步骤 2–4 → `build-mac.sh`，8 核 6–12h）→ 产物跑 `os-crypt-roaming-poc` 验证（同 `--os-crypt-key` 双 profile 拷贝互解）→ 产品侧接线（DEK→HKDF 派生密钥注入 launcher）。
2. **V0.4-B 收尾（可选）**：win nsis / linux AppImage 交叉构建（CI 或其它平台机器上出包）；正式图标设计；签名证书。
3. **V0.5 规划**：增量快照、自动更新（electron-updater）、团队协作。

## 已完成归档

- **[2026-10-17] V0.4-A 准备 + V0.4-C（生产硬化）**：os-crypt-key 补丁（mac/linux 双端）+ bootstrap/build 脚本 + KI-1 源码级实锤；ratelimit（令牌桶+429）+ USER_QUOTA_GB + health?deep + deploy 生产栈与 production.md。
- **[2026-10-17] V0.4-B mac（安装包）**：electron-builder.yml + dist:mac/dist 脚本 + pnpm allowBuilds（electron-winstaller=false）；dmg 双架构构建与包内 e2e 验收。
- **[2026-10-17] V0.3.1（zstd + 观测）**：tar+zstd（gzip 兜底）+ format 入 manifest + 临时文件中转规避 bsdtar 流式缺陷 + 排除表补 Dawn 缓存 + 体积/耗时日志。
- **[2026-10-17] V0.3.0（L2 文件级快照）**：snapshotEngine kind=files 二进制信封；Docker 挂载直通 + docker pause 冻结抓取；双写（L2 基线 + L1 副本入环境配置）与 builtin 回退；L2 恢复叠加 L1 注入补会话 cookie；修复 newTab 时序竞态（evaluate 落 about:blank 空上下文）；e2e:l2 7/7。
- **[2026-10-17] M6 预研（GO）**：双容器 PoC 证实 Linux 内核 profile 可漫游（`docs/m6-research.md`）；entrypoint 修 X 锁重入；PoC 验收脚本入库。
- **[2026-10-17] V0.2.0-S4（验收与补强，发版）**：KI-1/KI-2 根因定位与修复（seed 必须 32 位整数；probe-kernel.mjs 裸 Node 二分法）；T13 补齐（代理 + auto 时区 e2e 10/10）；快照保留策略（SNAPSHOT_RETENTION + 残骸清扫 + 集成测试）；putObject 指数退避重试；T6R 会话过期提示（sessionCheck 探测 + e2e + UI 入口）；`/v1/geo` 本地时区解析修复；Makefile test-db。tag `v0.2.0`。
- **[2026-10-10] V0.2.0-S3（指纹与代理）**：三态指纹配置 + `/v1/geo` + 代理认证 + test-site 代理模式；CDP 客户端重大加固（browser-level flatten 会话、命令超时）；kernel-smoke 7/7（含 T10 同 seed 跨设备一致）。
- **[2026-10-10] V0.2.0-S2（CDP 数据面互迁移）**：KernelLauncher 抽象（Native/Docker）；T12 双承载互迁移 + T3k 混合互斥接管 e2e。
- **[2026-10-10] V0.2.0-S1（双承载骨架）**：kernelManager 下载/校验/自检；ExternalKernelHost + 指纹 flags；Docker 验证环境。
- **[2026-10-10] V0.1.0（MVP，M0–M4）**：两种模式全链路（快照分支/互斥接管）+ E2E 加密 + Go 服务端 + 测试站，tag `v0.1.0`。
