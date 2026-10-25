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

## 基础设施（对应 mac 的 `make infra`）

`scripts/dev-infra.sh` 是 bash + mac 原生 MinIO 二进制；Windows 两条路：

**路线 A（推荐，全 Docker）**：
```powershell
docker compose -f deploy/docker-compose.yml up -d   # Postgres
# MinIO：官方 Docker Hub 镜像已停发（V0.2 排障结论），用 mc 官方镜像或 mcr 镜像：
docker run -d --name onebrowser-minio -p 9000:9000 -p 9001:9001 `
  -e MINIO_ROOT_USER=onebrowser -e MINIO_ROOT_PASSWORD=onebrowser123 `
  -v minio-data:/data mcr.microsoft.com/mirror/minio/minio server /data --console-address ":9001"
```

**路线 B（WSL2）**：在 Ubuntu 里 `git clone` 后直接 `make infra`（脚本原生可跑）。

服务端/测试站：`make server` / `make site`（PowerShell 里 `cd server; go run ./cmd/onesrv` 同效）。

## e2e 在 Windows 的注意点

- kernel 系列 e2e（interop/fp/l2/kernel-smoke）依赖 Docker 容器访问宿主服务：
  `ONEBROWSER_SITE` 默认取局域网 IP 的逻辑不变；**Windows 防火墙首次会弹窗**，
  放行 Node/Go 的入站即可，否则容器访问不到 :18080/:8787。
- `os-crypt-roaming-poc.mjs` / `probe-kernel.mjs`（apps/desktop/scripts/）纯 Node + docker，
  Windows 直接可跑。
- mac 特有的坑在 Windows **不存在**：bsdtar 流式 zstd 截断（profileArchive 已做平台无关
  的临时文件中转）、hdiutil、Metal Toolchain 等。

## V0.4-A（os_crypt 漫游）在 Windows 的新路线

| 阶段 | 内容 | 说明 |
|---|---|---|
| W1 | 官方 win x64 内核跑通产品全链路（kernel-smoke/指纹 e2e） | 零编译；验证 kernelManager win 分支 |
| W2 | **win 端 os_crypt 补丁**（`os_crypt_win.cc` 的 DPAPI 路径加 `--os-crypt-key`） | 补丁的第三端（mac/linux 已写好：`scripts/kernel-build/patches/onebrowser/100-os-crypt-key.patch`）；参考 148 源码 `components/os_crypt/win/` |
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
