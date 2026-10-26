# Windows 开发机迁移指南

> 日期：2026-10-25。背景：mac（Intel x64）构建 Chromium 耗时过长（前台占用下 1.5–2 天），
> 开发切换到 Windows 机器。本文是 Windows 环境的完整搭建路径与现状交接。

## 先说三个好消息

1. **Windows 不需要编译内核就能开发**：fingerprint-chromium 官方 Releases 提供
   **Windows x64 预编译包**（`windows_x64.zip` 便携版 + installer .exe），`kernelManager`
   的平台适配已就绪（V0.2 写好，本次补齐 zip/exe 解压分支）——产品首用下载即用。
2. **代码库全跨平台**：桌面端（Electron/Node）、服务端（Go）、测试站（Go）、e2e 均无
   mac 专属依赖；Docker 内核验证路径（`ONEBROWSER_KERNEL_DOCKER=1`）在 Docker Desktop
   （WSL2 后端）上同样工作。
3. **mac 构建现场已保留**：`/Users/macos/Code/ob-kernel-build/`（源码树 + 全部工具链 +
   增量编译缓存，停在 [2500/42722]）——回到那台机器 `ninja -C out/OneBrowser chrome`
   可续跑，无需重来。

## 环境清单（Windows）

| 组件 | 要求 | 备注 |
|---|---|---|
| Node ≥22 + pnpm ≥11 | 必装 | `winget install OpenJS.NodeJS.LTS`；pnpm：`npm i -g pnpm`（corepack 亦可） |
| Go ≥1.26 | 必装 | `winget install GoLang.Go` |
| Git | 必装 | `winget install Git.Git` |
| Docker Desktop | 必装（e2e/基础设施） | WSL2 后端；跑 Postgres + kernel 容器 |
| VS Build Tools | 可选 | 仅当要在 Windows 自建内核（官方支持，vs2022 工具集） |
| WSL2（Ubuntu） | 可选 | bash 脚本（dev-infra.sh/bootstrap.sh）在 WSL 里跑最省事 |

## 基础设施（对应 mac 的 `make infra`；2026-10-26 W1 实测更新）

**MinIO 已全渠道停发，Windows 本地 S3 用 localstack 3.8.1**（2026-10 实测，以下全部不可用：
Docker Hub `minio/minio` 拉取被拒、GitHub Releases 只剩源码包、`dl.min.io` 返回 410、
quay 匿名 401、`mcr.microsoft.com/mirror/minio/minio` 不存在、`public.ecr.aws/minio/minio` 404）：

```powershell
docker compose -f deploy/docker-compose.yml up -d   # Postgres（见下方端口冲突说明）
# S3 兼容：localstack 3.8.1（必须钉版本——2026 的 latest 连 S3 都要求 license token）
# PERSISTENCE=1 + 命名卷：社区版默认不持久化，容器重启桶就没了
docker run -d --name onebrowser-s3 -p 4566:4566 -e SERVICES=s3 -e PERSISTENCE=1 `
  -e LS_LOG=warn -v onebrowser-localstack:/var/lib/localstack localstack/localstack:3.8.1
```

服务端相应改为 `S3_ENDPOINT=http://127.0.0.1:4566`（localstack 不校验签名，presigned 直传直下
实测可用；builtin e2e 的 T5.1 密文抽查即跑在它上面）。若 localstack 重启后桶丢失，重启服务端
即自动重建（服务端只在启动时建桶）。

**Postgres 端口冲突**：本机若装有原生 Windows Postgres 服务（占 5432），docker 的端口发布会
**静默失效**（`docker port` 为空、宿主连到原生库、认证失败）。用 gitignore 的
`deploy/docker-compose.override.yml` 把容器映射到 55432（本机已配好），服务端/测试加：
`DATABASE_URL=postgres://onebrowser:onebrowser@127.0.0.1:55432/onebrowser?sslmode=disable`
（`TEST_DATABASE_URL` 同理指向 55432/onebrowser_test）。

服务端/测试站：`make server` / `make site`（PowerShell 里 `cd server; go run ./cmd/onesrv` 同效）。

## e2e 在 Windows 的注意点（2026-10-26 W1 实测）

- kernel 系列 e2e（interop/fp/l2/kernel-smoke）依赖 Docker 容器访问宿主服务：
  `ONEBROWSER_SITE` 默认取局域网 IP 的逻辑不变；**Windows 防火墙首次会弹窗**，
  放行 Node/Go 的入站即可，否则容器访问不到 :18080/:8787。
  本机（198.18.0.1 是代理 TUN 网卡）需显式指定真实局域网 IP：
  `ONEBROWSER_SITE=http://192.168.31.108:18080`（lanIp() 可能先命中 TUN 适配器）。
- `os-crypt-roaming-poc.mjs` / `probe-kernel.mjs`（apps/desktop/scripts/）纯 Node + docker，
  Windows 直接可跑。
- mac 特有的坑在 Windows **不存在**：bsdtar 流式 zstd 截断（profileArchive 已做平台无关
  的临时文件中转）、hdiutil、Metal Toolchain 等。
- kernel e2e 链路里的 `bash`/`find` 依赖 Git Bash 的 usr/bin 在 PATH 里——从 Git Bash /
  pnpm 起没问题；从纯 PowerShell 起需先补 PATH（ensureDockerImage 的 find 已改为 Node 原生遍历，
  仅 fetch.sh 兜底路径仍需 bash）。

## W1 完成纪要（2026-10-26，全部验证通过）

**验证基线（本机实测）**：builtin e2e 17/17 · kernel-smoke(docker) 7/7 · kernel-smoke(native
官方 win 内核) 6/6 · e2e:fp 10/10 · e2e:interop 13/13 · e2e:l2 7/7 · Go 单测全绿
（server + test-site）。kernelManager 的 win zip 下载/Expand-Archive 解压/自检/原生启动/
CDP 指纹断言全链路走通，tag `v0.4.0-win-prepared`。

**W1 期间排掉的 Windows 坑（代码均已修复入库）**：

1. **`.sh` 被 autocrlf 转成 CRLF** → 容器内 `exec /entrypoint.sh: no such file or directory`
   （shebang 变 `/bin/sh\r`）。修复：`.gitattributes` 固化 `*.sh text eol=lf` + 工作区文件转 LF。
2. **`ensureDockerImage` 每次全量重建** → ~500MB 构建上下文走 Windows 命名管道实测 10 分钟起。
   修复：镜像存在即跳过（`docker image inspect`）；换内核版本时 `docker rmi` 后重建。
   另加 `scripts/kernel-docker/.dockerignore` 排除 139MB tarball。
3. **`chrome.exe --version` 在 Windows 不是回显版本而是启动完整浏览器**（POSIX 专属约定）
   → kernelManager 自检挂 20s 且留下持锁进程、清理 rmSync 撞 EPERM。修复：win32 走
   PowerShell 读 PE `VersionInfo.ProductVersion`（不执行进程）；rmSync 带 `maxRetries`。
4. **fingerprint-chromium 150.0.7871.186 win x64 死锁**：`--fingerprint` 与
   `--fingerprint-platform` 同时启用时，canvas 像素回读（toDataURL/getImageData）挂死渲染
   进程（Page.enable 20s 超时；单开任一 flag 正常；Linux 容器同版本正常；148 win 正常）。
   修复：kernelManager 加 `KNOWN_BAD_VERSIONS`（win 跳过 150 → 自动选 148，恰好是 os_crypt
   补丁基线）。上游 bug，待反馈。
5. **DockerKernelLauncher 的 mac 式「同路径挂载」**：`C:\...` 不能作为 Linux 容器挂载目标。
   修复：win32 固定挂到 `/ob-profile` 并重写 `--user-data-dir` 参数（顺带规避深路径 CDP 挂死）。
6. **Node spawn 无扩展名 exe 直接 ENOENT**（`go build -o` 不带 .exe 的产物）→ fp e2e 的
   测试代理起不来。修复：产物名 win32 带 `.exe`。
7. **`go build` 孙进程继承 stdout 管道** → `execFile` 等 close 事件永久挂起（timeout 只杀已
   退出的进程）。修复：`stdio:'ignore'` + 只等 `exit` 事件。
8. **GNU tar 把 `C:\...` 当 host:path 远程语法**（"Cannot connect to C"）。修复：win32 用
   系统自带 System32 bsdtar 3.8.9（原生支持盘符路径，还内置 zstd）。
9. **容器内 Singleton\* 是 Linux symlink**，经 WSL2 挂载落到 NTFS 成 LX reparse point：
   Windows 侧 stat 报 EINVAL（宿主 tar 打包即失败、`--exclude` 挡不住 stat）、宿主删不掉
   （root 属主 EACCES）。修复：quiesce 冻结前 `docker exec` 进容器删（root 可删、运行中删
   无副作用——只在内核启动时创建）；EXCLUDES 加 Singleton\*；残留用
   `wsl -u root rm /mnt/c/.../Singleton*` 清。
10. **Go 迁移 check-then-apply 竞态**：`go test ./...` 并行测试二进制共享测试库，两个包同时
    apply 撞 pg_type 唯一键（慢 Windows 机必现，mac 时序侥幸）。修复：apply 事务内
    `pg_advisory_xact_lock` + 锁内复查（生产单进程不受影响）。
11. **GitHub API 未认证限流**（共享出口 IP，60 次/小时会耗尽，整点重置）——只影响
    releases 列表接口，资产下载 CDN 不受限；必要时 `ONEBROWSER_KERNEL_MIRROR` 走镜像。
12. kernel-smoke 曾硬编码旧 mac 机器的局域网 IP 当主页 → 改用 `SITE` 变量（默认 lanIp()）。

## V0.4-A（os_crypt 漫游）在 Windows 的新路线

| 阶段 | 内容 | 说明 |
|---|---|---|
| W1 | 官方 win x64 内核跑通产品全链路（kernel-smoke/指纹 e2e） | ✅ **2026-10-26 完成**（见上「W1 完成纪要」） |
| W2 | **win 端 os_crypt 补丁**（`os_crypt_win.cc` 加 `--os-crypt-key`） | ✅ **2026-10-26 补丁完成**：`100-os-crypt-key.patch` 第四文件；漫游模式对齐 mac/linux v11 线格式（AES-128-CBC/16B）实现三平台互解；对 googlesource 148 双通道 apply 验证（git apply + GNU patch），编译检验留 W3 |
| W3 | Windows 本机自建内核（VS Build Tools，官方支持）或 CI | 打上三端补丁；mac x64 产物也可顺便在 CI 出 |
| W4 | os-crypt-roaming PoC（win 双 profile 拷贝互解）→ L2 全平台 | `apps/desktop/scripts/os-crypt-roaming-poc.mjs` 思路，改 Windows 进程模型 |

注意：win 官方预编译内核**不含** os_crypt 补丁——W1 完成后 win 原生内核的 L2 快照不可用
（会话走叠加的 L1 注入仍可用，与旧版行为一致），L2 完整漫游要等 W3 的自建内核。

## mac 侧未竟事项（存档）

- 本地 Chromium 148 构建：停在 6%（[2500/42722]），工具链/缓存全在
  `/Users/macos/Code/ob-kernel-build/`，`ninja -C out/OneBrowser chrome` 可续；
  排障记录见 `scripts/kernel-build/README.md`（域名替换/代理/Metal/llvm-otool 等九坑）。
- os_crypt mac/linux 补丁：已 apply 实测（源码树三文件干净落盘），**尚未经过编译器检验**。
- mac dmg 安装包（V0.4-B 已完成的产物）与全部 git 历史：push 到远端即可带走。
