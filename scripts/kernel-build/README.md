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
- [ ] 源码树 apply 实测（bootstrap 步骤 4 的 patch --dry-run）
- [ ] mac 构建产物 + os-crypt-roaming PoC 通过（双 profile 拷贝互解）

## 备注

- fingerprint-chromium 的惯例：N 版源码随 N+1 发布放出——150 内核源码等 151。
  148 用于补丁验证；150 源码放出后同流程重放（chromium_version.txt 对齐）。
- Linux 构建可复用 `scripts/kernel-docker/` 的 Ubuntu 22.04 环境（容器内跑
  bootstrap+build，产物替换镜像内 /usr/local/bin/kernel 即得自建 Linux 内核）。
