# NextStep.md —— 下一步做什么

> **本文件是项目的「工作指针」**：任何时刻打开它，就能知道项目接下来该做什么、当前处于什么状态。
> 维护规则见 README 的「工作流约定」。每次开始/完成一段开发工作，都必须先更新本文件。

---

## 使用规则

1. **接手任何工作前**：先读本文件，从「下一步」列表的第一项开始。
2. **完成一项后**：立即把它移入「已完成归档」，并更新「当前状态」快照。
3. **计划变更时**：同步修订本文件（它必须始终反映真实的下一步，而不是过期的愿望清单）。
4. 相关背景文档：总体规划 `docs/project-plan.md` · 版本计划 `docs/v0.2.0-plan.md` · 排障与已知问题 `docs/v0.2.0-s3-notes.md`。

## 当前状态（快照，2026-10-27，V0.4.1 已发版；UI/UX 交互优化整合完成）

- **UI/UX 交互优化整合已完成（本工作单元）**：管理界面从「能用」到「好用」——
  ①登录页注册态强制「主密码不可找回」警示+勾选确认（E2E 数据安全底线）；②新建/编辑对话框
  模式与承载改为说明卡片；编辑首次接入指纹三件套/种子/代理清除/承载切换（主进程 updateEnv
  早已支持、UI 一直没接）；③环境详情抽屉（种子可复制/指纹/代理/基线/租约全量展示）；
  ④快照模式「丢弃改动关闭」二次确认、登出确认、每行操作 busy 态；⑤内核状态 popover
  （版本/来源/下载进度条/本地导入/未就绪小红点）；⑥空状态三步引导+CTA、帮助弹卡、
  错误信息美化（剥 Electron IPC 包装）。主进程新增 ob:appInfo / ob:sync，updateEnv 放开
  seed（isValidSeed 防 KI-1 毒化）/proxy null 清除。截图冒烟升级 `--screenshot-tour`
  六站巡航（注册视图→空态→新建→表格→详情→编辑）。
  **验证**：typecheck 双绿 · builtin e2e 17/17（7.3s）· 六站截图逐张目检通过。
- **V0.4.1 已发版（tag `v0.4.1`）**：标准浏览器承载（本机 Edge/Chrome，无指纹免下载）；
  打包形态双绿（e2e 17/17 + browser-smoke 3/3）；Edge 启动器进程交接与 156 flatten 移除
  两大坑修复（attachPageDirect 页级直连 ws）。
- **W3 已砍削暂停（范围决策）**：win 自建内核构建现场存档 `D:/ob-kernel-build`
  （停在 chrome.dll 链接段，`bootstrap-win.sh` 全程可复现，ninja 续跑即可出包）；
  win 原生 L2 缺口改走「上游 PR 优先、自建内核为可选高级件」路线。
- **V0.4.0 已发版（tag `v0.4.0`）**：Windows 安装包（nsis 120MB，未签名）实测验收；
  W1 全链路验证矩阵全绿（builtin 17/17 · smoke-docker 7/7 · smoke-native 6/6 · fp 10/10 ·
  interop 13/13 · l2 7/7 · Go 全绿）；W2 win 端 os_crypt 补丁入库（漫游模式对齐 mac/linux
  v11 线格式，三平台互解）。
- **Windows 十二坑全部修复入库**（详见 `docs/windows-migration.md`）：CRLF/docker 上下文/
  chrome.exe --version 行为/**150 win 内核 canvas 死锁（KNOWN_BAD 规避选 148）**/容器挂载
  路径/无扩展名 spawn/go build 管道继承/GNU tar 盘符/Singleton LX symlink/迁移竞态等。
- **运行环境**：server(:8787，DATABASE_URL→:55432 + S3_ENDPOINT→:4566) / test-site(:18080) /
  Postgres(docker :55432) / localstack S3(:4566) 本机常驻；本地 S3 用 localstack 3.8.1
  （MinIO 已全渠道停发）。
- **内核验证环境**：`scripts/kernel-docker/`（Linux x64 内核 + Xvfb + SwiftShader + socat；
  镜像 `onebrowser-kernel-smoke`）。

## 下一步（按优先级）

1. **推送远端**：`git push origin main --tags`（v0.4.0 / v0.4.0-win-prepared / v0.4.1 及全部提交仍在本地）。
2. **0.4.2 安装包重出 + 打包形态验收**（含本次 UI/UX 优化；dist:win → 静默安装 → e2e + tour 截图）；
   随后：代码签名证书（现未签名，SmartScreen 会拦）、正式图标、electron-updater 自动更新。
3. **Win 原生 L2（不阻塞）**：os_crypt 4 文件补丁提 PR 给 fingerprint-chromium 上游；
   接受则 Windows L2 免费跟随官方发布；拒绝则 W3 存档的自建内核作为可选高级件
   （构建现场 `D:/ob-kernel-build` 停在 chrome.dll 链接段，`bootstrap-win.sh` 可复现，
   ninja 续跑即可出包）。
4. **服务端生产部署演练**：deploy/production.md 全流程走一遍（域名 + TLS + Caddy）。
5. **V0.5 规划**：增量快照、自动更新、团队协作。

## 已完成归档

- **[2026-10-27] UI/UX 交互优化整合（V0.4.2 待发）**：注册主密码不可找回警示+勾选门禁；
  新建/编辑对话框说明卡片化，编辑接入指纹三件套/种子/代理清除/承载切换（updateEnv 既有
  能力 UI 首次接线，seed 补丁走 isValidSeed 防 KI-1）；环境详情抽屉（种子复制/指纹/代理/
  基线/租约）；快照丢弃关闭二次确认 + 登出确认 + 每行 busy；内核 popover（进度条/来源/
  导入/未就绪提醒点）；空状态三步引导；帮助弹卡；错误信息剥 Electron IPC 包装（fmt.ts）。
  主进程：ob:appInfo / ob:sync / updateEnv seed+proxy-null；截图冒烟新增 `--screenshot-tour`
  六站巡航。验证：typecheck 双绿 · e2e 17/17 · 六站截图目检。

- **[2026-10-27] V0.4.0 初步可用发版（tag `v0.4.0`）**：Windows 安装包（nsis 120MB，未签名）
  实测验收——静默安装 → builtin e2e 17/17（7.6s）→ 原生内核冒烟 6/6（官方 148 自动下载）；
  `dist:win` 脚本入库；README 版本/平台徽章/已知限制（win 内核=指纹+L1，L2 需 Linux/docker，
  150 上游死锁规避）更新。**范围决策**：W3 自建内核砍削暂停（能力盘点：产品核心=指纹+登录态
  漫游在 win 已全绿，win 原生 L2 唯一缺口走上游 PR/可选件），构建现场存档于 D:/ob-kernel-build
  （bootstrap-win.sh 全程可复现，停在 chrome.dll 链接段）。

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
