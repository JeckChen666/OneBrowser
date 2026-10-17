# OneBrowser 内核构建（V0.4-A）

目的：自带 `--os-crypt-key=<hex>` 补丁的 fingerprint-chromium（148.0.7778.215），
解锁 mac/win 原生内核的 L2 profile 漫游（`docs/v0.4.0-plan.md` §1）。

## 用法

```bash
bash bootstrap.sh /Users/macos/Code/ob-kernel-build   # 源码+补丁（~40GB，网络主导）
bash build-mac.sh  /Users/macos/Code/ob-kernel-build   # 编译（8 核 6–12h）
```

## 补丁内容（patches/onebrowser/100-os-crypt-key.patch）

- `os_crypt::switches::kOsCryptKey`（"os-crypt-key"，跨平台）
- mac（`os_crypt_mac.mm`）/ linux（`os_crypt_linux.cc`）：DeriveKey/DeriveV11Key
  开头识别 switch → hex 解码为派生密钥（长度强校验）→ 跳过 Keychain/keyring。
  客户端由用户 DEK 经 HKDF 派生 32 字节密钥注入（产品侧接线见计划 §1 A3）。

## 已验证 / 待验证

- [x] 补丁基于 googlesource 148.0.7778.215 原始文件精确 diff；
      ungoogled 补丁集不触及这三个文件（grep 全 patches/ 确认），apply 无冲突
- [x] KI-1 根因源码级确认：`std::stoull(非法 seed)` 抛异常（005 号补丁），
      支持上游 issue 与客户端校验的双防线
- [x] 源码树 apply 实测：126 个上游补丁 + 域名替换后 OneBrowser 补丁三文件
      干净应用（2026-10-18，`/Users/macos/Code/ob-kernel-build/build/src`）
- [x] 产品侧接线：DEK→HKDF('os-crypt:<envId>')→16B hex 恒定注入内核 flag，
      旧内核忽略未知 switch（e2e:l2 7/7），容器实参捕获确认
- [ ] mac 构建产物 + os-crypt-roaming PoC 通过（双 profile 拷贝互解）
      ——构建进行中/待续：`ob-kernel-build` 目录，见下「构建现场」

## 构建现场（2026-10-18 起，进度）

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

**坑备忘**：gclient runhooks 要求 git 仓库（tarball 不行，hook 需手动跑）；
`.gclient` 的 solution name 必须匹配实际相对路径（`build/src`）。

## 备注

- fingerprint-chromium 的惯例：N 版源码随 N+1 发布放出——150 内核源码等 151。
  148 用于补丁验证；150 源码放出后同流程重放（chromium_version.txt 对齐）。
- Linux 构建可复用 `scripts/kernel-docker/` 的 Ubuntu 22.04 环境（容器内跑
  bootstrap+build，产物替换镜像内 /usr/local/bin/kernel 即得自建 Linux 内核）。
