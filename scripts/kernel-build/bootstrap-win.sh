#!/usr/bin/env bash
# OneBrowser 内核构建 bootstrap（Windows 版）：fingerprint-chromium(148) + OneBrowser 补丁
# 产出 build/src 可编译源码树 + 全部工具链 + gn + vs-shim + SDK overlay。
# 用法: bash bootstrap-win.sh <工作目录>
#
# 运行环境：Git Bash + python3 + NanaZip(7z.exe) + VS2022（含任一**完整** MSVC 工具集，
# 即带 include/ 与 lib/ 的那个）+ curl。全程免管理员。
#
# 2026-10-26/27 实测踩坑全记录见 README「Windows 构建纪要」。关键差异（相对 mac 版）：
#   - 域名替换跳过（本机直连 googlesource/GCS；mac 上该步骤还坑过 clang/CIPD 下载）
#   - 解包用 7z（--7z-path；System32 bsdtar 对该包报 empty filename；downloads.py 的
#     注册表 7z 探测在无 7-Zip 时抛异常——NanaZip 不写注册表，须显式传路径）
#   - 工具链全走预编译：clang(update.py)/rust(DEPS gcs 包,sha256)/node/gperf/dxheaders
#   - 恢复被 pruning 剪掉但 v8 构建引用的 v8/test/torque/test-torque.tq
#   - rust 补 vendor 缺件：lite 包丢 windows_x86_64_msvc-v0_52/lib/windows.0.52.0.lib，
#     从 crates.io 原包补回，再 gnrt gen 重新生成 native_libs（否则 cxxbridge 链接失败）
#   - rust GN 规则：cargo 构建 gnrt 后 `gnrt gen` + `gnrt gen --for-std=<工具链内 src>`，
#     需 RUSTC_BOOTSTRAP=1（gnrt 内部 cargo metadata 用 -Z）；Windows 下 gnrt 调 gn.bat，
#     PATH 需同时含 buildtools/win(gn.exe) 与 depot_tools
#   - gn 自举：bootstrap.py 的 Windows 目标名 bug（调 `gn`，实际目标是 gn.exe）——
#     让它生成 build.ninja 后失败，再手工 `ninja gn.exe`；需完整 MSVC 环境与
#     CL=/utf-8（中文系统 C4819×/WX）+ SDK bin 入 PATH（链接要 mt.exe）
#   - vs-shim：本机 VS 常残装（vcvarsall.bat 缺失/默认 14.40 工具集无 CRT 头）——
#     生成手写 vcvarsall.bat 复刻 env（纯 ASCII，cmd 按 GBK 解析 .bat）
#   - SDK overlay：148 编译旗标 -DNTDDI_VERSION=NTDDI_WIN11_GE，而 22621 头没有该常量
#     （→ NTDDI 求值 0，NTDDI 门控声明全部消失）；且 22621 的 wincrypt.h 缺
#     WINCRYPT_USE_SYMBOL_PREFIX 防护（26100 新增），X509_NAME 宏撞 boringssl typedef。
#     overlay 用 sdk-overlay/sdkddkver.h（本仓库自带）+ 从 SDK ISO 提取的 26100 wincrypt.h
#   - SDK ISO：https://learn.microsoft.com/windows/apps/windows-sdk/downloads 的 26100 表
#     （ISO fwlink 免管理员可下）；提取只需 msiexec /a（免提权）
set -euo pipefail
WORK="${1:?用法: bootstrap-win.sh <工作目录>}"
SRC="$WORK/build/src"
SEVENZIP="${SEVENZIP:-C:/Users/Sakura/AppData/Local/Microsoft/WindowsApps/7z.exe}"
REPO="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$WORK/bin"; cd "$WORK"

# ---------- 1) 仓库与基础工具 ----------
[ -d fp-chromium ] || git clone --depth 1 --branch 148.0.7778.215 \
  https://github.com/adryfish/fingerprint-chromium.git
[ -d depot_tools ] || git clone --depth 1 \
  https://chromium.googlesource.com/chromium/tools/depot_tools.git
[ -x bin/ninja.exe ] || { curl -sL -o bin/ninja-win.zip \
  https://github.com/ninja-build/ninja/releases/latest/download/ninja-win.zip \
  && "$SEVENZIP" x bin/ninja-win.zip -obin -y -bso0 && rm bin/ninja-win.zip; }
# python3.exe 真身（绕开 WindowsApps Store 别名——gn exec_script 调 python3 会拿 9009）
[ -x bin/python3.exe ] || cp "$(command -v python)" bin/python3.exe

# ---------- 2) 源码包（哈希校验；SSL 瞬时抖动重跑即可，支持断点续传） ----------
cd fp-chromium
[ -f "$WORK/build/download_cache/chromium-148.0.7778.215-lite.tar.xz" ] || \
  python utils/downloads.py retrieve -c ../build/download_cache -i downloads.ini
[ -f "$SRC/DEPS" ] || { mkdir -p ../build/src
  python utils/downloads.py unpack -c ../build/download_cache -i downloads.ini \
    --7z-path "$SEVENZIP" -- ../build/src; }

# ---------- 3) prune → 126 上游补丁 → 恢复被剪文件 → OneBrowser 补丁 ----------
python utils/prune_binaries.py "$SRC" pruning.list
python utils/patches.py apply "$SRC" patches
tar -xJf ../build/download_cache/chromium-148.0.7778.215-lite.tar.xz -C "$SRC" \
  --strip-components=1 chromium-148.0.7778.215/v8/test/torque/test-torque.tq
for p in "$REPO"/patches/onebrowser/*.patch; do
  patch -d "$SRC" -p1 --forward < "$p"
done

# ---------- 4) 工具链（全部预编译） ----------
cd "$SRC"
[ -x third_party/llvm-build/Release+Asserts/bin/clang-cl.exe ] || \
  python tools/clang/scripts/update.py
[ -x third_party/rust-toolchain/bin/rustc.exe ] || { mkdir -p third_party/rust-toolchain
  curl -fL -o third_party/rust-toolchain/rt.tar.xz \
    "https://commondatastorage.googleapis.com/chromium-browser-clang/Win/rust-toolchain-6f54d591c3116ee7f8ce9321ddeca286810cc142-7-llvmorg-23-init-5669-g8a0be0bc.tar.xz"
  python - <<'EOF'
import hashlib
h = hashlib.sha256(open('third_party/rust-toolchain/rt.tar.xz','rb').read()).hexdigest()
assert h == '37dd250549fed5a9765c3a88e3487409189e0c9c63b691fc77daa0b5f214bced', h
EOF
  "$SEVENZIP" x third_party/rust-toolchain/rt.tar.xz -othird_party/rust-toolchain -y -bso0
  "$SEVENZIP" x third_party/rust-toolchain/rt.tar -othird_party/rust-toolchain -y -bso0
  rm third_party/rust-toolchain/rt.tar.xz third_party/rust-toolchain/rt.tar; }
# rust vendor 缺件（lite 包丢失 crate 自带 import lib → cxxbridge 链接失败）
[ -f third_party/rust/chromium_crates_io/vendor/windows_x86_64_msvc-v0_52/lib/windows.0.52.0.lib ] || {
  curl -sL -o /tmp/w.crate https://static.crates.io/crates/windows_x86_64_msvc/windows_x86_64_msvc-0.52.0.crate
  tar -xzf /tmp/w.crate -C /tmp
  cp /tmp/windows_x86_64_msvc-0.52.0/lib/windows.0.52.0.lib \
    third_party/rust/chromium_crates_io/vendor/windows_x86_64_msvc-v0_52/lib/; }
[ -x third_party/node/win/node.exe ] || { mkdir -p third_party/node/win
  curl -fL -o third_party/node/win/node.exe \
    https://commondatastorage.googleapis.com/chromium-nodejs/2f710ced2db2beb7c3debf6097196c35ee5adb74
  curl -fL -o third_party/node/nm.tgz \
    https://commondatastorage.googleapis.com/chromium-nodejs/6c15205ac08a854251151c1fbeb8978d2ca5a022
  tar -xzf third_party/node/nm.tgz -C third_party/node && rm third_party/node/nm.tgz; }
[ -x third_party/gperf/bin/gperf.exe ] || { git clone --depth 1 \
  https://chromium.googlesource.com/chromium/deps/gperf.git third_party/gperf-tmp
  (cd third_party/gperf-tmp && git fetch --depth 1 origin e9eeea862a18e77b945d98eff7e1bf065d3daf8e \
    && git checkout FETCH_HEAD) && mv third_party/gperf-tmp third_party/gperf; }
[ -f third_party/microsoft_dxheaders/src/src/dxguids.cpp ] || { mkdir -p third_party/microsoft_dxheaders
  git clone --depth 1 https://chromium.googlesource.com/external/github.com/microsoft/DirectX-Headers.git third_party/dxh-tmp
  (cd third_party/dxh-tmp && git fetch --depth 1 origin 62c23d5ec700659453c6fe89d296554b2a5e7edc \
    && git checkout FETCH_HEAD) && mv third_party/dxh-tmp third_party/microsoft_dxheaders/src; }

# ---------- 5) rust GN 规则（gnrt） ----------
if [ ! -f third_party/rust/windows_x86_64_msvc/v0_52/BUILD.gn ] || \
   ! grep -q native_libs third_party/rust/windows_x86_64_msvc/v0_52/BUILD.gn 2>/dev/null; then
  export PATH="$SRC/third_party/rust-toolchain/bin:$PATH"
  export CARGO_HOME="$WORK/.cargo-home" RUSTC_BOOTSTRAP=1
  [ -x tools/crates/gnrt/target/release/gnrt.exe ] || \
    cargo run --release --manifest-path tools/crates/gnrt/Cargo.toml -- gen
  ./tools/crates/gnrt/target/release/gnrt.exe gen
  ./tools/crates/gnrt/target/release/gnrt.exe gen --for-std=third_party/rust-toolchain/lib/rustlib/src/rust
fi

# ---------- 6) gn 自举（完整 MSVC 工具集 + CL=/utf-8 + mt.exe） ----------
detect_msvc() {  # 找到带 include/ 的完整工具集（默认装只带运行库的残件会骗过粗检测）
  for d in "C:/Program Files/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC"/* \
           "C:/Program Files/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC"/*; do
    [ -d "$d/include" ] && { echo "$d"; return; }
  done
  echo "未找到完整 MSVC 工具集（需 include/+lib/）——VS Installer 补『MSVC v143 生成工具』" >&2
  return 1
}
if [ ! -x buildtools/win/gn.exe ]; then
  MSVC_WIN=$(cygpath -w "$(detect_msvc)")
  KIT_WIN='C:\Program Files (x86)\Windows Kits\10'
  SDKVER=10.0.22621.0
  cat > "$WORK/gn-build-env.bat" <<EOF
@echo off
set "MSVC=$MSVC_WIN"
set "KIT=$KIT_WIN"
set "SDK=$SDKVER"
set "PATH=%MSVC%\bin\Hostx64\x64;%KIT%\bin\%SDK%\x64;%PATH%"
set "INCLUDE=%MSVC%\include;%KIT%\Include\%SDK%\ucrt;%KIT%\Include\%SDK%\um;%KIT%\Include\%SDK%\shared;%KIT%\Include\%SDK%\winrt;%KIT%\Include\%SDK%\cppwinrt"
set "LIB=%MSVC%\lib\x64;%KIT%\Lib\%SDK%\ucrt\x64;%KIT%\Lib\%SDK%\um\x64"
set CL=/utf-8
cd /d $(cygpath -w "$SRC")
set NINJA=$(cygpath -w "$WORK/bin/ninja.exe")
python tools\gn\bootstrap\bootstrap.py || rem 最后一调 ninja 目标名是 gn（Windows bug），build.ninja 已生成
cd out\Release\gn_build
$(cygpath -w "$WORK/bin/ninja.exe") gn.exe
mkdir ..\..\..\buildtools\win 2>nul
copy /y gn.exe ..\..\..\buildtools\win\ >nul
EOF
  cmd //c "$(cygpath -w "$WORK/gn-build-env.bat")"
fi

# ---------- 7) vs-shim（手写 vcvarsall；纯 ASCII） + SDK overlay ----------
mkdir -p "$WORK/vs-shim/VC" "$WORK/sdk-overlay"
cp "$REPO/win-overlay/sdkddkver.h" "$WORK/sdk-overlay/"
if [ ! -f "$WORK/sdk-overlay/wincrypt.h" ]; then
  # 26100 ISO（免管理员下载）：https://learn.microsoft.com/windows/apps/windows-sdk/downloads
  ISO="${SDK26100_ISO:?请下载 26100 ISO 并以 SDK26100_ISO=<路径> 指定（免管理员 msiexec /a 提取）}"
  mkdir -p "$WORK/sdk-iso"
  "$SEVENZIP" x "$ISO" -o"$WORK/sdk-iso/iso" -y -bso0 >/dev/null
  cat > "$WORK/msi-x.bat" <<EOF
@echo off
msiexec /a "$(cygpath -w "$WORK/sdk-iso/iso/Installers/Windows SDK for Windows Store Apps Headers-x86_en-us.msi" | sed 's/\\\\/\\\\\\\\/g')" /qn TARGETDIR=$(cygpath -w "$WORK/sdk-extract/storeapps" | sed 's/\\\\/\\\\\\\\/g')
EOF
  cmd //c "$(cygpath -w "$WORK/msi-x.bat")"
  cp "$WORK/sdk-extract/storeapps/Windows Kits/10/Include/10.0.26100.0/um/wincrypt.h" \
     "$WORK/sdk-overlay/wincrypt.h"
fi
ATL_X64="$WORK/atl/x64/Contents/VC/Tools/MSVC/14.44.35207/atlmfc/lib/x64"
ATL_X86="$WORK/atl/x86/Contents/VC/Tools/MSVC/14.44.35207/atlmfc/lib/x86"
{
  echo '@echo off'
  echo 'rem OneBrowser shim: replicate vcvarsall env output (ASCII-only; cmd parses .bat as GBK)'
  echo "set \"MSVC=$MSVC_WIN\""
  echo "set \"KIT=$KIT_WIN\""
  echo "set \"SDK=$SDKVER\""
  echo "set \"VCINSTALLDIR=$MSVC_WIN\\..\\..\\..\\\""
  echo "set \"WindowsSdkDir=%KIT%\\\""
  echo "set \"WindowsSDKVersion=%SDK%\\\""
  echo "set \"INCLUDE=$(cygpath -w "$WORK/sdk-overlay" | sed 's/\\/\\\\/g');%MSVC%\\include;%KIT%\\Include\\%SDK%\\ucrt;%KIT%\\Include\\%SDK%\\um;%KIT%\\Include\\%SDK%\\shared;%KIT%\\Include\\%SDK%\\winrt;%KIT%\\Include\\%SDK%\\cppwinrt\""
  echo "set \"LIBPATH=%MSVC%\\lib\\x64\""
  echo 'if /i "%1"=="amd64_x86" goto x86'
  echo ':x64'
  echo "set \"PATH=%MSVC%\\bin\\Hostx64\\x64;%KIT%\\bin\\%SDK%\\x64;%PATH%\""
  echo "set \"LIB=%MSVC%\\lib\\x64;$(cygpath -w "$ATL_X64" | sed 's/\\/\\\\/g' 2>/dev/null || echo '');%KIT%\\Lib\\%SDK%\\ucrt\\x64;%KIT%\\Lib\\%SDK%\\um\\x64\""
  echo 'exit /b 0'
  echo ':x86'
  echo "set \"PATH=%MSVC%\\bin\\Hostx64\\x86;%KIT%\\bin\\%SDK%\\x86;%PATH%\""
  echo "set \"LIB=%MSVC%\\lib\\x86;%KIT%\\Lib\\%SDK%\\ucrt\\x86;%KIT%\\Lib\\%SDK%\\um\\x86\""
  echo 'exit /b 0'
} > "$WORK/vs-shim/VC/vcvarsall.bat"

# ---------- 8) args.gn + gn gen ----------
mkdir -p "$SRC/out/OneBrowser"
cp fp-chromium/flags.gn "$SRC/out/OneBrowser/args.gn"
grep -q is_official_build "$SRC/out/OneBrowser/args.gn" || cat >> "$SRC/out/OneBrowser/args.gn" <<'GN'

# OneBrowser 内核（指纹环境专用）
is_official_build = true
symbol_level = 0
script_executable = "C:/Python313/python.exe"
GN
cat > "$WORK/gn-gen.bat" <<EOF
@echo off
set CL=/utf-8
set DEPOT_TOOLS_WIN_TOOLCHAIN=0
set GYP_MSVS_OVERRIDE_PATH=$(cygpath -w "$WORK/vs-shim" | sed 's/\\\\/\\\\/g')
set WINDOWSSDKVERSION=$SDKVER
set "PATH=$(cygpath -w "$WORK/bin");C:\\Python313;$(cygpath -w "$WORK/depot_tools");%PATH%"
cd /d $(cygpath -w "$SRC")
buildtools\\win\\gn.exe gen out\\OneBrowser
EOF
cmd //c "$(cygpath -w "$WORK/gn-gen.bat")"

echo "bootstrap-win 完成：$SRC（接下来: bash build-win.sh $WORK）"
