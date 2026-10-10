# NextStep.md —— 下一步做什么

> **本文件是项目的「工作指针」**：任何时刻打开它，就能知道项目接下来该做什么、当前处于什么状态。
> 维护规则见 README 的「工作流约定」。每次开始/完成一段开发工作，都必须先更新本文件。

---

## 使用规则

1. **接手任何工作前**：先读本文件，从「下一步」列表的第一项开始。
2. **完成一项后**：立即把它移入「已完成归档」，并更新「当前状态」快照。
3. **计划变更时**：同步修订本文件（它必须始终反映真实的下一步，而不是过期的愿望清单）。
4. 相关背景文档：总体规划 `docs/project-plan.md` · 版本计划 `docs/v0.2.0-plan.md` · S3 排障与已知问题 `docs/v0.2.0-s3-notes.md`。

## 当前状态（快照，2026-10-10）

- **版本**：V0.2.0 开发中，S1–S3 已完成（git `215a256`）
- **验证基线**：builtin e2e 16/16 · interop 12/12 · kernel-smoke(docker) 7/7（全绿）
- **运行环境**：server(:8787) / test-site(:18080) / Postgres(docker) / MinIO(:9000) 本机常驻
- **内核验证环境**：`scripts/kernel-docker/`（Linux x64 内核 + Xvfb + SwiftShader + socat；镜像 `onebrowser-kernel-smoke`）

## 下一步（按优先级，V0.2.0-S4 收尾）

1. **排查 KI-1**（首要，`docs/v0.2.0-s3-notes.md`）：`e2e-fp` 中经 AppService 路径启动的容器，含 canvas/WebGL 的 `Runtime.evaluate` 挂死。手段：给内核加 `--v=2`/trace 日志、对比 AppService 前置动作逐项注入到 kernel-smoke 复现。产出：根因结论或进一步收窄的复现条件。
2. **快照保留策略**：服务端 `commit` 时保留每环境最近 N=5 份 ready 快照，超额删除（DB 行 + S3 对象，`S3_RETENTION` 可配）；删除前校验 `latest_base_id` 引用不被误删。
3. **上传重试**：`CloudClient.putObject` 网络错误指数退避重试 3 次。
4. **T6R 自动化**：会话过期（`/api/expire`）后打开环境 → 客户端呈现「基线失效，请重新登录并更新基线」提示，纳入 e2e 断言。
5. **S4 全量回归 + 发版**：三套验证全绿后打 tag `v0.2.0`，更新 README 特性清单。
6. **（版本后）M6 预研启动**：fingerprint-chromium 源码构建跑通 + **os_crypt 可漫游补丁 PoC**（双机拷贝 Cookies 文件验证可解密）→ 产出 `docs/m6-research.md` 与 V0.3 Go/No-Go 结论。

## 已完成归档

- **[2026-10-10] V0.2.0-S3（指纹与代理）**：三态指纹配置 + `/v1/geo` + 代理认证 + test-site 代理模式；CDP 客户端重大加固（browser-level flatten 会话、命令超时）；kernel-smoke 7/7（含 T10 同 seed 跨设备一致）。
- **[2026-10-10] V0.2.0-S2（CDP 数据面互迁移）**：KernelLauncher 抽象（Native/Docker）；T12 双承载互迁移 + T3k 混合互斥接管 e2e 13/13。
- **[2026-10-10] V0.2.0-S1（双承载骨架）**：kernelManager 下载/校验/自检；ExternalKernelHost + 指纹 flags；Docker 验证环境。
- **[2026-10-10] V0.1.0（MVP，M0–M4）**：两种模式全链路（快照分支/互斥接管）+ E2E 加密 + Go 服务端 + 测试站，tag `v0.1.0`。
