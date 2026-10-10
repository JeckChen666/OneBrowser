#!/bin/sh
# 下载 fingerprint-chromium 的 Linux x64 预编译产物并解压到 ./kernel/
set -eu
cd "$(dirname "$0")"
VERSION="${1:-150.0.7871.186}"
MIRROR="${ONEBROWSER_KERNEL_MIRROR:-}"
FILE="ungoogled-chromium-${VERSION}-1-x86_64_linux.tar.xz"
URL="https://github.com/adryfish/fingerprint-chromium/releases/download/${VERSION}/${FILE}"

if [ -n "$MIRROR" ]; then URL="${MIRROR%/}/$URL"; fi

if [ ! -f "$FILE" ]; then
  echo "下载 $URL"
  curl -fL --retry 3 -o "$FILE" "$URL"
fi
rm -rf kernel && mkdir -p kernel
tar -xJf "$FILE" -C kernel --strip-components=1
BIN=$(find kernel -type f \( -name chrome -o -name chromium \) | head -1)
echo "内核二进制: $BIN"
