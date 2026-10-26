# NextStep.md —— 下一步做什么

> **本文件是项目的「工作指针」**：任何时刻打开它，就能知道项目接下来该做什么、当前处于什么状态。
> 维护规则见 README 的「工作流约定」。每次开始/完成一段开发工作，都必须先更新本文件。

---

## 使用规则

1. **接手任何工作前**：先读本文件，从「下一步」列表的第一项开始。
2. **完成一项后**：立即把它移入「已完成归档」，并更新「当前状态」快照。
3. **计划变更时**：同步修订本文件（它必须始终反映真实的下一步，而不是过期的愿望清单）。
4. 相关背景文档：总体规划 `docs/project-plan.md` · 版本计划 `docs/v0.2.0-plan.md` · 排障与已知问题 `docs/v0.2.0-s3-notes.md`。

## 当前状态（快照，2026-10-26，Windows 开发机 W1+W2 完成）

- **W2 已完成（win 端 os_crypt 补丁，2026-10-26）**：100-os-crypt-key.patch 补齐第四文件
  `os_crypt_win.cc`——switch 注入 16B 密钥跳过 DPAPI/Local State；**漫游模式对齐 mac/linux
  v11 线格式（AES-128-CBC/16B key/16 空格 IV）**，同一 profile 三平台互解；v10/DPAPI 原生
  路径与无 switch 行为不变。对 googlesource 148 原始源码双通道验证（git apply + GNU patch）
  干净应用、逐字节复现；顺带排掉补丁文件被 autocrlf 转 CRLF 的地雷（.gitattributes 补
  `*.patch eol=lf`）。**核验结论：三端密钥均为 16B，产品侧 16B 派生本就正确**。
- **W1 已完成（Windows 全链路验证通过，tag `v0.4.0-win-prepared`）**：builtin e2e 17/17 ·
  kernel-smoke(docker) 7/7 · kernel-smoke(native 官方 win 内核) 6/6 · e2e:fp 10/10 ·
  e2e:interop 13/13 · e2e:l2 7/7 · Go 单测全绿。kernelManager win 分支（下载/解压/自检）实战验证。
- **Windows 环境落地**：Node 24 + pnpm 12 + Go 1.24（GOTOOLCHAIN=auto 自动拉 1.26）+ Docker Desktop；
  本地 S3 用 localstack 3.8.1（MinIO 已全渠道停发）；Postgres 容器因宿主 5432 被原生服务占用
  改映射 55432（`deploy/docker-compose.override.yml`，不入库）。
- **Windows 十二坑全部修复入库**（详见 `docs/windows-migration.md`「W1 完成纪要」）：CRLF/
  docker build 上下文/chrome.exe --version 行为/**150 win 内核 canvas 死锁（KNOWN_BAD 规避选 148）**/
  容器挂载路径/无扩展名 spawn/go build 管道继承/GNU tar 盘符/Singleton LX symlink/迁移竞态等。
- **平台策略变更**：mac(Intel) 编译 Chromium 太慢（前台占用 1.5–2 天），开发切到 Windows。
- **mac 构建现场已存档**：`/Users/macos/Code/ob-kernel-build/` 停在 [2500/42722]（工具链+增量缓存全在，`ninja -C out/OneBrowser chrome` 可续）；九个构建坑全部记录在 `scripts/kernel-build/README.md`。
- **V0.4 进度**：B（mac 安装包）✅ C（生产硬化）✅；A 的 mac/linux 补丁+产品接线 ✅，win 端补丁与三端自建内核转 Windows 继续（W2–W4）。
- **V0.4-A 构建现场（网络大坑已排平，全链路看护中）**：机器 10-24 前后重启杀过流水线；本周排掉三个连环坑——①googlesource/GitHub 需走系统代理（127.0.0.1:7897，构建命令须显式注入）；②rust-src 与 llvm monorepo 的 googlesource 镜像不可达，build_rust.py/build.py 的 GIT_URL 已改 GitHub 官方源；③chromium 专属 llvm tag（llvmorg-23-init-5669-g8a0be0bc）在 GitHub 无同名 tag，已手动造 tag 指向同 commit（8a0be0bc3772…）实现复用。**当前：rust 工具链 LLVM 编译中（14:27 起）**，看护脚本自动接力 gn gen→autoninja（/tmp/ob-pipeline.log）；补丁代码未动，PoC 等产物。
- **V0.3.1 已完成**

- **V0.4-A 准备件 + V0.4-C 生产硬化已完成**：os_crypt 注入补丁（148 精确 diff）+ 构建脚本；限流/配额/深度健康检查 + 生产 compose（Caddy TLS）+ production.md；全量回归限流下全绿
- **V0.4-B mac 安装包已完成**：electron-builder 双架构 dmg（x64 144MB / arm64 140MB，ad-hoc 签名，不带内核首用下载）；**安装包内 app 实测 builtin e2e 17/17 + UI 截图冒烟通过**（asar/CJS preload/依赖收集全对）；`make dist-mac`
- **V0.3.1 已完成**：L2 快照 zstd 压缩（36KB vs gzip 50KB）+ 观测日志；修复 macOS bsdtar 流式 zstd 两大坑（stdout 静默截断 / stdin fork 失败 → 临时文件中转）；回归 l2 7/7 · interop 13/13
- **V0.4 规划已出**（`docs/v0.4.0-plan.md`）：原生内核 + os_crypt 补丁（148 源码先行）/ 安装包分发 / 生产硬化；builtin L2 评估结论=不做（L1 回退已闭环）
- **V0.3.0 已发版**：L2 文件级快照全链路（kernel 环境 profile 整体漫游 + 双写 L1 副本互迁移兜底）；验证基线 l2 7/7 · interop 13/13 · fp 10/10 · builtin 17/17 · kernel-smoke 7/7
- **M6 预研已完成（GO）**：Linux 内核 profile 目录原样拷贝即可漫游（cookie/localStorage/IndexedDB 全部读回，`apps/desktop/scripts/os-crypt-roaming-poc.mjs` 可复跑）；无需 os_crypt 补丁；教训：会话 cookie 重启即弃曾致误判（`docs/m6-research.md`）

- **版本**：V0.2.0 已发版（tag `v0.2.0`）——双承载（builtin ⇄ kernel 指纹内核）+ 代理/auto 时区 + 保留策略 + 会话健康检查
- **验证基线**：Go 测试（auth/leases/snapshots/testsite）· typecheck · kernel-smoke 7/7 · builtin e2e 17/17 · interop 12/12 · fp e2e 10/10（全绿）
- **KI-1/KI-2 已解决**：根因均为非法 seed（必须 32 位整数，读取 `navigator.hardwareConcurrency` 即死锁）；客户端已强校验 + 旧数据回填
- **运行环境**：server(:8787，DATABASE_URL→:55432 + S3_ENDPOINT→:4566) / test-site(:18080) / Postgres(docker :55432) / localstack S3(:4566) 本机常驻
- **内核验证环境**：`scripts/kernel-docker/`（Linux x64 内核 + Xvfb + SwiftShader + socat；镜像 `onebrowser-kernel-smoke`）

## 下一步（按优先级，Windows 开发机；迁移指南 docs/windows-migration.md）

1. **W3 Windows 本机自建内核**（VS Build Tools，官方支持）或 CI 三平台：bootstrap 出
   win 源码树（补丁已四文件齐，bootstrap.sh 的 patch 步骤直接可用）→ gn gen → autoninja；
   三端补丁齐后 mac x64 产物顺便在 CI 出。**注意 win 段补丁尚未经过编译器检验**（apply
   已验证，编译验证在 W3 源码树重放时完成）。
2. **W4 PoC 收口**：win 版 os-crypt-roaming（双 profile 拷贝互解）→ L2 漫游全平台（v11
   线格式已三端对齐，PoC 直接按同 key 跨内核验证）→ V0.4 正式发版。
3. **（并行）V0.5 规划**：增量快照、electron-updater 自动更新、团队协作。
4. **V0.4-B 收尾（可选）**：win nsis / linux AppImage 交叉构建（CI 或其它平台机器上出包）；正式图标设计；签名证书。

## 已完成归档

- **[2026-10-26] W2 win 端 os_crypt 补丁**：`100-os-crypt-key.patch` 第四文件 `os_crypt_win.cc`
  （InitWithExistingKey 注入 16B、漫游模式 v11 AES-CBC 线格式对齐 mac/linux、v10/DPAPI
  原生路径保留）；googlesource 148 原始源码 git apply + GNU patch 双通道干净应用、
  逐字节复现；补丁文件 CRLF 地雷修复（.gitattributes `*.patch eol=lf`）；三端密钥长度
  核验（全 16B，产品侧派生无需改）。win 段待 W3 编译检验。
- **[2026-10-26] W1 Windows 环境搭建 + 官方 win 内核全链路（tag `v0.4.0-win-prepared`）**：本地栈三件套落地（localstack 3.8.1 替 MinIO / Postgres 55432 规避端口冲突 / Go 1.26 工具链自拉）；验证矩阵全绿（builtin 17/17 · smoke-docker 7/7 · smoke-native 6/6 · fp 10/10 · interop 13/13 · l2 7/7 · Go 全绿）；kernelManager win 分支实战验证（含 KNOWN_BAD 版本规避）；Windows 十二坑修复入库（详见 docs/windows-migration.md「W1 完成纪要」）。
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
