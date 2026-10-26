#!/usr/bin/env bash
# Windows 构建：ninja 全量编译 chrome（前置：bootstrap-win.sh 完成）
# 用法: bash build-win.sh <工作目录> ；产物 $WORK/build/src/out/OneBrowser/chrome.exe
# 预算：14C/20T 实测约 3-6h；磁盘峰值再 +60GB（out/）。
# 全部坑（vs-shim/CL=/utf-8/mt.exe/WINDOWSSDKVERSION 等）已由 bootstrap-win.sh 铺好，
# 此处仅重复注入环境变量（ninja 的 action 里还会用 python3/gn 等）。
set -euo pipefail
WORK="${1:?用法: build-win.sh <工作目录>}"
SRC="$WORK/build/src"

cat > "$WORK/ninja-build.bat" <<EOF
@echo off
set CL=/utf-8
set DEPOT_TOOLS_WIN_TOOLCHAIN=0
set GYP_MSVS_OVERRIDE_PATH=$(cygpath -w "$WORK/vs-shim" | sed 's/\\\\/\\\\/g')
set WINDOWSSDKVERSION=10.0.22621.0
set "PATH=$(cygpath -w "$WORK/bin");C:\\Python313;$(cygpath -w "$WORK/depot_tools");%PATH%"
cd /d $(cygpath -w "$SRC")
$(cygpath -w "$WORK/bin/ninja.exe") -C out\\OneBrowser -j12 chrome
EOF
cmd //c "$(cygpath -w "$WORK/ninja-build.bat")"
echo "产物: $SRC/out/OneBrowser/chrome.exe"
