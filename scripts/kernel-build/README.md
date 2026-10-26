# OneBrowser 内核构建（V0.4-A）

目的：自带 `--os-crypt-key=<hex>` 补丁的 fingerprint-chromium（148.0.7778.215），
解锁 mac/win 原生内核的 L2 profile 漫游（`docs/v0.4.0-plan.md` §1）。

## 用法

```bash
bash bootstrap.sh /Users/macos/Code/ob-kernel-build   # 源码+补丁（~40GB，网络主导）
bash build-mac.sh  /Users/macos/Code/ob-kernel-build   # 编译（8 核 6–12h）
```

## 补丁内容（patches/onebrowser/100-os-crypt-key.patch，2026-10-26 补齐 win 端）

- `os_crypt::switches::kOsCryptKey`（"os-crypt-key"，跨平台，common/os_crypt_switches.h）
- mac（`os_crypt_mac.mm`）/ linux（`os_crypt_linux.cc`）：DeriveKey/DeriveV11Key
  开头识别 switch → hex 解码为派生密钥（长度强校验 **16B**）→ 跳过 Keychain/keyring。
- **win（`os_crypt_win.cc`，W2）**：`InitWithExistingKey` 开头识别 switch → 注入 16B 密钥
  → 跳过 DPAPI + Local State。**漫游模式改变线格式**：写入/读取 mac/linux 的 v11 线格式
  （AES-128-CBC、16B key、16 空格定 IV，`crypto::aes_cbc`），使同一 profile 三平台互解；
  win 原生 v10（AES-256-GCM/32B）与 DPAPI 裸数据路径不变（无 switch 时行为与上游完全一致）。
- 客户端由用户 DEK 经 HKDF 派生 **16 字节**密钥注入（三端内核均按 16B 校验；产品侧接线
  见计划 §1 A3 与 `appService.ts`）。148 源码核验：mac `kDerivedKeySize=16`、
  linux `kDerivedKeyBytes=16`、win 漫游对齐 16B；win 原生 AES-256-GCM 为 32B（仅 v10 路径）。

## 已验证 / 待验证

- [x] 补丁基于 googlesource 148.0.7778.215 原始文件精确 diff；
      ungoogled 补丁集不触及这四个文件（grep 全 patches/ 确认，唯一 os_crypt 引用是
      bromite 补丁对 async 头的 include，改的是别的文件），apply 无冲突
- [x] **win 段（W2，2026-10-26）**：四文件全量补丁对 googlesource 148 原始源码
      `git apply --check` + GNU `patch -p1 --dry-run` 双通道干净应用（Windows 本机验证）；
      应用结果与手改版逐字节一致、旧 mac/linux 段反演一致（改动内容未变）
- [x] **补丁文件 LF 防护**：`.gitattributes` 固化 `*.patch eol=lf`（autocrlf 会把补丁转成
      CRLF，对 LF 源码 git apply/patch 静默不可应用——2026-10-26 在 Windows 实测踩坑）
- [x] KI-1 根因源码级确认：`std::stoull(非法 seed)` 抛异常（005 号补丁），
      支持上游 issue 与客户端校验的双防线
- [x] 源码树 apply 实测：126 个上游补丁 + 域名替换后 OneBrowser 补丁（mac/linux/switches 三文件）
      干净应用（2026-10-18，`/Users/macos/Code/ob-kernel-build/build/src`；win 段待 W3 源码树重放）
- [x] 产品侧接线：DEK→HKDF('os-crypt:<envId>')→16B hex 恒定注入内核 flag，
      旧内核忽略未知 switch（e2e:l2 7/7），容器实参捕获确认
- [ ] 自建内核构建产物 + os-crypt-roaming PoC 通过（双 profile 拷贝互解，跨平台）
      ——mac 现场存档见下；win 构建转 W3（VS Build Tools）

## Windows 路线（2026-10-25 起，主线转 Windows）

**Windows 开发不需要本仓库的构建流程**——官方 Releases 有 win x64 预编译内核
（`windows_x64.zip`），kernelManager 直接下载。本目录流程仅当需要**自带 os_crypt
补丁的自建内核**时使用，且 Windows 本机构建用 VS Build Tools（官方支持），
mac/Linux 走 WSL2 或 CI。win 端补丁（os_crypt_win.cc 的 DPAPI 路径）尚未写——
参照 100-os-crypt-key.patch 的 mac/linux 写法在 `components/os_crypt/win/` 实现。

## 构建现场（2026-10-18 起，进度；10-25 已暂停存档）

工作目录 `/Users/macos/Code/ob-kernel-build/`：`fp-chromium`（148 补丁仓库）、
`build/src`（126 上游补丁 + OneBrowser 补丁全部应用，7.5GB）、`depot_tools`、
`out/OneBrowser/{args.gn, gn}`（gn 已自举编译）。

**已过步骤**：源码下载（lite tar.xz 1.5GB，哈希校验）→ unpack/prune/patches/domsub →
OneBrowser 补丁三文件干净应用 → clang 预编译包（316MB，注意：domsub 会替换
update.py 下载域，需先还原 `tools/` 下的假域再下载）→ gn 自举 → rust 工具链
构建启动（`build_rust.py --entire-toolchain`，148 的 Chromium 硬依赖 Rust 且无
预编译成品，2–4h，日志 /tmp/ob-rust.log）。

**接力点**（rust 完成后）：
```bash
cd /Users/macos/Code/ob-kernel-build/build/src
./buildtools/mac/gn gen out/OneBrowser        # 若报缺件对照 DEPS hooks 补
autoninja -C out/OneBrowser chrome            # 8 核 6–12h
```
产物用于：1) `os-crypt-roaming-poc`（同 `--os-crypt-key` 双 profile 拷贝互解）；
2) kernelManager 本地内核路径跑全套 kernel e2e；3) arm64 包（--args target_cpu="arm64"）。

**坑备忘**（全部实测踩过）：
1. gclient runhooks 要求 git 仓库（tarball 不行，hook 手动跑：clang 用
   `update.py`、rust 用 `build_rust.py`，均以系统 python3 直跑——vpython3 会
   拉私有 Python 源，且 `--entire-toolchain` 下 rust 需自编译 2–4h）；
2. **域名替换必须排除 tools/ 与 build/**（bootstrap 已内置）：否则 clang/CIPD/
   rust stage0 下载走镜像域 SSL 必挂；手动反向还原极易把 `.com` 弄丢
   （appspot.com 整体被替换为 8pp2p8t.qjz9zk）；
3. lite 包不带 gn，需 `tools/gn/bootstrap/bootstrap.py` 自举后拷入 buildtools/mac/。

## 备注

- fingerprint-chromium 的惯例：N 版源码随 N+1 发布放出——150 内核源码等 151。
  148 用于补丁验证；150 源码放出后同流程重放（chromium_version.txt 对齐）。
- Linux 构建可复用 `scripts/kernel-docker/` 的 Ubuntu 22.04 环境（容器内跑
  bootstrap+build，产物替换镜像内 /usr/local/bin/kernel 即得自建 Linux 内核）。
