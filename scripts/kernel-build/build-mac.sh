#!/usr/bin/env bash
# macOS 构建（x64 本机或 arm64）：GN 配置 + autoninja
# 预算：8 核机器约 6–12h；磁盘峰值再 +40GB（out/）。
set -euo pipefail
WORK="${1:?用法: build-mac.sh <bootstrap 的工作目录>}"
SRC="$WORK/build/src"
OUT="$SRC/out/OneBrowser"

mkdir -p "$OUT"
cp "$WORK/fp-chromium/flags.gn" "$OUT/args.gn"
cat >> "$OUT/args.gn" <<'GN'
# OneBrowser 内核（指纹环境专用）
is_official_build = true
symbol_level = 0
GN

cd "$SRC"
gn gen "$OUT"
autoninja -C "$OUT" chrome
echo "产物: $OUT/Chromium.app"
