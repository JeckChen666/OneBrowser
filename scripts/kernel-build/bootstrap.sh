#!/usr/bin/env bash
# OneBrowser 内核构建 bootstrap：fingerprint-chromium(148) + OneBrowser 补丁
# 产出 build/src 可编译源码树。用法: bash bootstrap.sh <工作目录>
# 预算：磁盘 ~40GB（源码+缓存）；网络视 downloads.ini（官方 tarball）。
set -euo pipefail
WORK="${1:?用法: bootstrap.sh <工作目录>}"
FP_DIR="$WORK/fp-chromium"

mkdir -p "$WORK"
cd "$WORK"

# 1) fingerprint-chromium（ungoogled-chromium + fingerprint 补丁集，148 分支）
if [ ! -d fp-chromium ]; then
  git clone --depth 1 --branch 148.0.7778.215 \
    https://github.com/adryfish/fingerprint-chromium.git fp-chromium
fi
cd fp-chromium

# 2) 拉取 Chromium 官方源码包（最大的一步，网络主导）
mkdir -p "$WORK/build/download_cache"
./utils/downloads.py retrieve -c "$WORK/build/download_cache" -i downloads.ini
./utils/downloads.py unpack  -c "$WORK/build/download_cache" -i downloads.ini -- "$WORK/build/src"

# 3) 剪除二进制 → 应用 ungoogled/fingerprint 补丁 → 域名替换
./utils/prune_binaries.py "$WORK/build/src" pruning.list
./utils/patches.py apply "$WORK/build/src" patches
./utils/domain_substitution.py apply -r domain_regex.list -f domain_substitution.list \
  -c "$WORK/build/domsubcache.tar.gz" "$WORK/build/src"

# 4) OneBrowser 补丁（os_crypt 密钥注入）
#    基于 148 原始文件 diff；ungoogled 补丁集不触及这三个文件，无冲突
patch -d "$WORK/build/src" -p1 --forward \
  < "$(dirname "$0")/patches/onebrowser/100-os-crypt-key.patch"

echo "bootstrap 完成：$WORK/build/src（接下来: bash build-mac.sh $WORK）"
