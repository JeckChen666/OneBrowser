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

- **版本**：V0.2.0 已发版（tag `v0.2.0`）——双承载（builtin ⇄ kernel 指纹内核）+ 代理/auto 时区 + 保留策略 + 会话健康检查
- **验证基线**：Go 测试（auth/leases/snapshots/testsite）· typecheck · kernel-smoke 7/7 · builtin e2e 17/17 · interop 12/12 · fp e2e 10/10（全绿）
- **KI-1/KI-2 已解决**：根因均为非法 seed（必须 32 位整数，读取 `navigator.hardwareConcurrency` 即死锁）；客户端已强校验 + 旧数据回填
- **运行环境**：server(:8787) / test-site(:18080) / Postgres(docker) / MinIO(:9000) 本机常驻
- **内核验证环境**：`scripts/kernel-docker/`（Linux x64 内核 + Xvfb + SwiftShader + socat；镜像 `onebrowser-kernel-smoke`）

## 下一步（按优先级，M6 预研）

1. **M6 预研（V0.3 Go/No-Go 的前置）**：产出 `docs/m6-research.md`：
   - fingerprint-chromium **源码构建**跑通（官方预编译 mac 仅 arm64；Intel 需自建 Linux/mac x64 产物）；
   - **os_crypt 可漫游 PoC**：给内核打补丁（固定 os_crypt 密钥 / 换可跨机派生方案），双机拷贝 Cookies 文件验证可解密——这是 M6「文件级快照（L2 数据面）」成立的前提；
   - 结论需包含：构建耗时/复现步骤、补丁侵入面评估、L2 与现有 L1 结构化数据面的融合方案。
2. **V0.3 规划**：基于 M6 结论规划 L2 数据面（IndexedDB/SW/密码库漫游）；若 PoC 失败，改为「结构化扩展（IndexedDB 导出导入）」路线。

## 已完成归档

- **[2026-10-17] V0.2.0-S4（验收与补强，发版）**：KI-1/KI-2 根因定位与修复（seed 必须 32 位整数；probe-kernel.mjs 裸 Node 二分法）；T13 补齐（代理 + auto 时区 e2e 10/10）；快照保留策略（SNAPSHOT_RETENTION + 残骸清扫 + 集成测试）；putObject 指数退避重试；T6R 会话过期提示（sessionCheck 探测 + e2e + UI 入口）；`/v1/geo` 本地时区解析修复；Makefile test-db。tag `v0.2.0`。
- **[2026-10-10] V0.2.0-S3（指纹与代理）**：三态指纹配置 + `/v1/geo` + 代理认证 + test-site 代理模式；CDP 客户端重大加固（browser-level flatten 会话、命令超时）；kernel-smoke 7/7（含 T10 同 seed 跨设备一致）。
- **[2026-10-10] V0.2.0-S2（CDP 数据面互迁移）**：KernelLauncher 抽象（Native/Docker）；T12 双承载互迁移 + T3k 混合互斥接管 e2e。
- **[2026-10-10] V0.2.0-S1（双承载骨架）**：kernelManager 下载/校验/自检；ExternalKernelHost + 指纹 flags；Docker 验证环境。
- **[2026-10-10] V0.1.0（MVP，M0–M4）**：两种模式全链路（快照分支/互斥接管）+ E2E 加密 + Go 服务端 + 测试站，tag `v0.1.0`。
