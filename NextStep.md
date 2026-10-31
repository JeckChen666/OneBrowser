# NextStep.md —— 下一步做什么

> **本文件是项目的「工作指针」**：任何时刻打开它，就能知道项目接下来该做什么、当前处于什么状态。
> 维护规则见 README 的「工作流约定」。每次开始/完成一段开发工作，都必须先更新本文件。

---

## 使用规则

1. **接手任何工作前**：先读本文件，从「下一步」列表的第一项开始。
2. **完成一项后**：立即把它移入「已完成归档」，并更新「当前状态」快照。
3. **计划变更时**：同步修订本文件（它必须始终反映真实的下一步，而不是过期的愿望清单）。
4. 相关背景文档：总体规划 `docs/project-plan.md` · 版本计划 `docs/v0.2.0-plan.md` · 排障与已知问题 `docs/v0.2.0-s3-notes.md`。

## 当前状态（快照，2026-10-31，V0.4.3 已发版；远端同步至 015b92a）

- **V0.4.3 发版收口（本工作单元，tag `v0.4.3`）**：①运维工作台补齐附录 A.6 唯一未落地项——
  团队只读视图（新 tab：团队/发起人/成员/待接受/环境/快照占用；概览卡加团队数；环境归属列
  标 👥团队；真实 7 团队数据目检过，密文不可见声明在页头）；②README 升级 V0.4.3 口径
  （团队协作功能段/架构图 teams+admin/徽章/已知限制改「团队边界」）；③版本 0.4.2→0.4.3
  出包（120MB，含 V0.6 全部）+ tag。**打包验收三绿**（e2e=0/bsmoke=0/tour=0；tour 八站含
  团队页与关于弹层真实更新检查：v0.4.3 > 远端最新 tag v0.4.2 → 正确显示「已是最新」）。
  过程排障：dist:win 瞬态网络失败重试即过；验收首跑因 test-site 又被杀卡死（e2e 打不开
  测试站 ERR_CONNECTION_REFUSED），拉起后重跑过。**待用户确认**：Release 资产挂 GitHub
  （--publish=always，对外动作）。

- **统一测试批已收口（本工作单元，全绿）**：
  ①本地栈重启（Docker 引擎/PG/localstack 隔夜又断，已恢复）+ 0002 迁移落测试库 ✅
  ②server 全量回归绿（admin/auth/leases/ratelimit/snapshots）
  ③**新 teams 服务端测试 2 组全绿**（TestTeamsFullFlow：建团/公钥查询/邀请 pending→accept
  角色闸/member 建环境归因 owner/快照归因/轮换覆盖校验/吊销 owner 拦截/吊销断访/重邀拒绝；
  TestSetIdentityBackfill：回填+不可覆盖）——**修掉 1 个真 bug**（HandleSetIdentity SQL
  占位参数多余导致恒 409）
  ④desktop e2e 17×2 绿（身份对注册未破坏旧链路）
  ⑤**新 e2e-teams 17 项全绿**（A邀B免登录共享/吊C断访/S3密文/轮换语义）——**测出 1 个真
  设计缺陷并修复**：DEK 轮换使旧根密封的环境配置解密降级（homepage 归零）→ owner 轮换时
  同时重密封团队环境配置；旧基线不可解 → 打开降级冷启动+警示，重登录存新基线恢复
  （轮换语义已回写附录 A.5；TM.5 三段断言）
  ⑥browser-smoke 3 绿；**tour 扩到八站**（新增团队页真实建团+关于弹层真实更新检查
  releases/latest→tags 回退），全走 frame-sub，截图目检过
  ⑦**增量快照量化门：不立项**（10/50/200MB 三档实测：二次保存 0.3/0.8/2.4s，50MB 远低
  5s 门限；加密吞吐 764–1284MB/s，上传占比最大；bench 脚本入库 scripts/snapshot-bench.mjs，
  踩 GNU tar 盘符老坑已绕）
  ⑧dist:win 出包 + 打包形态验收三绿（静默安装 e2e=0/bsmoke=0/tour=0）。
  **遗留**：V0.6 团队流尚未在真实多设备/多用户环境复验（本地 e2e 是同机三实例）；
  tour 的对话框关闭用 ESC 兜底仍偶发遮挡截图（工具性瑕疵，不阻断）。

- **V0.6 团队协作实现代码已完成（本工作单元，未测，归统一测试批）**：按附录 A 蓝本全量落地——
  **服务端**：0002_teams 迁移（users 身份对两列 + teams/team_members + environments.team_id）；
  teams 包（建团/列表/公钥查询/邀请 push 模型/成员/吊销/DEK 轮换全覆盖校验/接受拒绝）；
  auth 身份密钥对（注册可选字段 + 登录返回 + /v1/auth/identity 空态一次性回填）；
  envs 团队可见性谓词 + 创建归属（user_id 归因团队 owner）；snapshots envAccess/snapAccess
  统一谓词 + 全管线 owner 归因（S3 key/配额/prune）；leases 团队谓词 + pending 附 holderEmail；
  ws 新增 team.updated；router 团队扇出广播（env.updated 团队环境广播全体成员）。
  **客户端**：e2e.ts 新增 X25519 身份对 + wrapFor/unwrapWith（ECDH→HKDF→AES-GCM，eph 公钥
  兼 HKDF salt）；注册生成身份对、旧账号登录回填；refreshTeams + teamDeks 缓存 +
  **rootKeyFor 换根**（配置/快照 L1L2/os-crypt 全管线，snapshotEngine 零改动）；团队九个
  IPC 通道；UI：TeamsPanel（待接受邀请/建团/成员管理/邀请/吊销/轮换）+ 顶栏 环境/团队 视图
  切换（待接受角标）+ 新建环境归属选择 + 行内团队标签 + 详情抽屉归属行。
  **编译自检**：desktop typecheck 绿 + server build/vet 绿。**未跑任何测试**（统一测试批）。
- **工作方式（用户指令）**：①代码先行、测试统一后置；②**不主动推送远端**（push 弹登录打扰，
  仅用户明确要求时执行；待推提交本地攒着）。
- **V0.5-A 阶段 a 自动更新代码已完成（未测）**：`src/main/updater.ts`（net.fetch 走
  系统代理；releases/latest 优先、无正式 Release 时回退 tags 取最高语义版本；semver
  比较）+ IPC `ob:checkUpdate`/`ob:openUrl`（仅放行 github.com 域）+ preload/api 封装 +
  渲染层「关于」弹层（版本号可点：当前/Electron 版本/检查更新/有新版→打开下载页）+
  App.vue 24h 节流后台检查（有新版→常驻通知点击直达）+ electron-builder
  `publish: github`（阶段 b electron-updater 更新源预留）。**注意**：仓库尚无正式
  GitHub Release（只有 tag），tags 回退路径是当前实际生效路径；正式发布动作
  （--publish=always 挂安装包资产）归测试批且需用户确认。typecheck 绿（仅编译自检）。
- **已推送远端（截至 403be18）**：main 全部提交 + 四个 tag 均在 github.com/JeckChen666/
  OneBrowser。**工作规矩（用户指令，2026-10-28）**：此后一律只本地提交，
  **不主动推送远端**——push 会弹 GitHub 登录打扰用户，仅在用户明确要求时执行。
  本地待推提交可随时 `git -c http.proxy= -c https.proxy= push origin main` 一键补推
  （默认代理 7897 未起时需绕过）。
- **V0.5 规划已出（本工作单元）**：`docs/v0.5.0-plan.md`——①自动更新两阶段
  （a 无签名过渡「检查更新→直达 Releases」/ b 证书到位后 electron-updater 全量差分，
  blockmap 原料已在产出）；②增量快照**先量化后决定**（决策门：50MB 档二次保存
  <5s 则不做；若做走客户端编排方案，服务端零改动——per-snapshot 密钥派生本就支持）；
  ③团队协作 E2E 设计定稿（用户 X25519 身份密钥对 + team DEK 成员信封 + 吊销=轮换，
  实现切 V0.6）。V0.5 最小交付 = A+B 共 5 天，无外部依赖。
- **os_crypt 上游 PR 材料已备（未提交，等用户过目）**：`scripts/kernel-build/upstream-pr/`
  ——中性化补丁 `os-crypt-key-switch.patch`（品牌措辞与 onebrowser_* 标识符全替换；
  离线往返法验证与原补丁逐 hunk 等价：本地 148 树逆向还原原始文件后干净应用）+
  英文 PR 文案 `pr-body-draft.md`（动机/三平台改动/兼容性/测试证据）。目标
  `adryfish/fingerprint-chromium`；101–107 工具链补丁明确排除。
- **品牌图标已落地（本工作单元）**：`build/icon.svg`（蓝底白色指纹涡纹×地球经纬，
  椭圆缺口同心环设计）→ `scripts/gen-icon.mjs`（sharp 渲染 512px）→ `build/icon.png`
  → electron-builder 自动转 ico/icns。默认 Electron 图标警告消失，exe 内嵌图标已抽取
  目检（32px 可辨）；带图标安装包重出并重跑打包验收三绿（e2e 17/17 · bsmoke 3/3 ·
  tour 0，六站 frame-sub）。
- **V0.4.2 打包验收三绿（tag `v0.4.2`）**：含桌面 UI/UX 优化整合 +
  服务端运维工作台。**排掉两个打包形态深坑**（均已固化修复）：
  ①截图模式 GPU 合成器不出帧抛 UnknownVizError（capturePage 抛异常挂死流水线）
  → 截图模式禁用硬件加速 + capturePng 重试 + tour 失败保底 app.exit(1) 不挂死；
  ②后台节流停发帧：窗口被判后台后合成器不出新帧，capturePage 返回旧帧（overlay
  随机丢失）、beginFrameSubscription 无帧——`backgroundThrottling: false` + moveTop
  后订阅恢复正常，六站全部 via=frame-sub。tour 升级为「条件等待 + 帧订阅取图 +
  沉降兜底」的确定性流水线；固定 sleep 已淘汰。
- **服务端运维工作台已完成（提交 4494a6c）**：`server/internal/admin`（Go 包 + go:embed
  单页，零前端构建）——设 `ADMIN_TOKEN` 后开放 `https://<DOMAIN>/admin/`，未设则路由
  整体不存在。只读四视图（概览/账号/环境/快照）；口令恒时比较 + HttpOnly cookie（12h）
  + Bearer 双通道；登录复用认证限流；E2E 密文不可见边界写入页面与 production.md。
  全量 Go 测试绿；本机实跑浏览器四 tab 目检；修复 overview 治理参数「声明未赋值」回归。
- **UI/UX 交互优化已完成（提交 8e401ee）**：注册主密码不可找回警示+勾选门禁；新建/编辑
  对话框说明卡片化，编辑接入指纹三件套/种子/代理清除/承载切换；环境详情抽屉；快照丢弃
  关闭二次确认/登出确认/每行 busy；内核 popover；空状态三步引导；错误信息剥 IPC 包装。
- **W3 已砍削暂停（范围决策）**：win 自建内核构建现场存档 `D:/ob-kernel-build`
  （停在 chrome.dll 链接段，`bootstrap-win.sh` 全程可复现，ninja 续跑即可出包）。
- **V0.4.0/V0.4.1 已发版**：win 安装包两条线验收过（0.4.0 双绿、0.4.1 双绿）；150 win
  内核 canvas 死锁 KNOWN_BAD 规避选 148；Edge 启动器交接与 156 flatten 移除两坑修复。
- **运行环境**：server(:8787，dev 实例隔夜重启后需手动拉起：ADMIN_TOKEN=dev-admin-123
  + DATABASE_URL→:55432 + S3_ENDPOINT→:4566) / test-site(:18080) / Postgres(:55432) /
  localstack S3(:4566)；**注意本机代理 127.0.0.1:7897 重启后也需手动拉起**（googlesource
  等外网依赖它，本轮即因未起改走离线验证）。
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

1. **推送远端**：本地积压 V0.4.3 发版提交 + v0.4.3 tag，**等用户明确说推送再执行**
   （`git -c http.proxy= -c https.proxy= push origin main --tags`）；
   可选同批：GitHub Release 挂 0.4.3 安装包资产（对外，需确认 + 代理需先拉起）。
2. **os_crypt 上游 PR 提交**：材料在 `scripts/kernel-build/upstream-pr/`，
   **需用户过目 pr-body-draft.md 后放行**（对外动作）。
3. **代码签名证书**（需用户决策采购）：签发后随 V0.5-C 全量自动更新一起接入。
4. **服务端生产部署演练**：需域名与对外主机；production.md 流程已备（含 ADMIN_TOKEN）。
5. **V0.6 真实多设备复验**（可选）：两台真机走邀请→共享→吊销（本地 e2e 为同机三实例）。

## 已完成归档

- **[2026-10-31] V0.5-C 阶段 b 代码先行 + 文档收口**：`core/autoUpdate.ts`（electron-updater
  差分更新，默认休眠：ONEBROWSER_AUTO_UPDATE=1 + 打包形态才激活；「退出时装」避免打断
  运行中环境/互斥租约——证书到位后设一个环境变量即启用）；v0.5.0-plan 执行状态块
  （全主题收口：阶段a✅ / 量化门不立项 / 附录A✅ / V0.6 已实现全测 / 阶段b 代码就绪）；
  `docs/changelog.md` 建立（v0.4.0–v0.4.3）。**至此自主代码队列清零**——剩余事项全部
  等外部输入（推送指令/PR 放行/证书/域名/第二台设备）。

- **[2026-10-31] V0.4.3 发版（tag `v0.4.3`）**：运维工作台团队只读视图（附录 A.6 收尾，
  实跑目检）+ README V0.4.3 口径 + 打包验收三绿；真实更新检查闭环（v0.4.3 vs v0.4.2）。

- **[2026-10-28] V0.6 团队协作实现（代码完成，未测）**：服务端（迁移+teams 包+auth 身份对+
  envs/snapshots/leases 团队化+扇出广播）与客户端（X25519 原语+身份对管理+rootKeyFor 换根
  全管线+九 IPC+TeamsPanel UI）按附录 A 蓝本全量落地；typecheck/build/vet 三绿。

- **[2026-10-28] V0.5-B 团队协作设计定稿**：v0.5.0-plan.md 附录 A 八节全（密钥/迁移/
  派生/邀请与吊销时序/端点/实现清单/安全性质与开放问题决议）。V0.5 最小交付 A+B 完成。

- **[2026-10-28] V0.5-A 阶段 a 自动更新代码（未测，归统一测试批）**：updater 模块 +
  IPC/preload/渲染层三件（关于弹层/24h 后台检查/github 域白名单外链）+ publish:github
  配置。工作方式调整为「代码先行、测试后置」。

- **[2026-10-28] V0.5 规划 + os_crypt 上游 PR 材料**：`docs/v0.5.0-plan.md`（自动更新
  两阶段/增量快照量化门/团队协作 E2E 设计，含里程碑与裁剪顺序）；`scripts/kernel-build/
  upstream-pr/`（中性化补丁 + 英文 PR 文案 + 操作指南；离线往返法验证中性化补丁与原补丁
  逐 hunk 等价——本地 148 树逆向还原原始四文件后干净应用；googlesource 不可达因代理
  未起，已记入运行环境注意事项）。

- **[2026-10-27] V0.4.2 打包验收三绿（tag `v0.4.2`）**：版本 0.4.1→0.4.2，dist:win 出包；
  打包形态静默安装 → e2e 17/17 → browser-smoke 3/3 → screenshot-tour 六站确定性取帧全过。
  两个深坑修复入库：截图模式 UnknownVizError（GPU 不出帧抛异常挂死流水线）→ 禁硬件加速 +
  重试 + 失败保底退出；后台节流停发帧（overlay 随机丢失、订阅无帧）→ backgroundThrottling
  关闭 + moveTop，帧订阅恢复。tour 流水线升级为条件等待 + 帧订阅 + 沉降兜底。

- **[2026-10-27] 服务端运维工作台（/admin，只读）**：`server/internal/admin` + 内嵌单页
  （go:embed，零前端构建）；ADMIN_TOKEN 门禁（未设=不挂载）、恒时比较、HttpOnly cookie、
  Bearer 双通道、登录复用认证限流；概览/账号/环境/快照四只读视图（E2E 密文不可见边界写进
  页面与 production.md）；deploy 三件（prod compose/.env.example/production.md）同步。
  Go 测试 admin 包三组；本机实跑浏览器目检四 tab 全过；修复 overview 治理参数未接线回归。

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
