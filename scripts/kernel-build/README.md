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
      ——mac 现场存档见下；win 构建 W3 进行中：管线全通（gn gen 28,840 目标，
      ninja 52k 步长跑），见「Windows 构建纪要」

## Windows 路线（2026-10-25 起，主线转 Windows；2026-10-27 W3 管线全通）

**日常开发/验证不需要本目录流程**——官方 Releases 有 win x64 预编译内核（已由 W1 验证）。
本目录流程产出**自带 os_crypt 补丁的自建内核**（解锁跨平台 L2 漫游，W4 PoC 用）。

**Windows 构建纪要（2026-10-26/27，D:/ob-kernel-build 实测，全部免管理员）**：

- 入口：`bash bootstrap-win.sh D:/ob-kernel-build` → `bash build-win.sh D:/ob-kernel-build`。
  脚本按实测流程固化；下述每一条坑都已在脚本内规避。
- **源码包**：`downloads.py retrieve`（SSL 瞬时抖动重跑即可，支持断点续传）；解包必须
  7z（`--7z-path` 指到 NanaZip：它不写注册表，脚本自身的注册表探测还会抛异常）；
  System32 bsdtar 对该包报 empty filename 不可用。
- **prune 过剪**：`v8/test/torque/test-torque.tq` 被剪但 v8 构建引用 → 从缓存 tarball 单文件
  恢复（脚本已做）。
- **rust 工具链**：走 DEPS 的 Win 预编译 gcs 包（sha256 校验），**不要** build_rust.py 源码
  编译（mac 上 2-4h 的坑在 Windows 同样存在且毫无必要）。lite 包丢 vendor crate 自带的
  import lib（windows.0.52.0.lib）→ 从 crates.io 原包补回后必须重跑 `gnrt gen`
  （否则 native_libs 不进 BUILD.gn，cxxbridge 链接 `could not open 'windows.0.52.0.lib'`）。
- **rust GN 规则**：`gnrt gen` + `gnrt gen --for-std=third_party/rust-toolchain/lib/rustlib/src/rust`
  （预编译包的 std 源在该路径）；需 `RUSTC_BOOTSTRAP=1`（内部 cargo metadata 用 -Z）；
  Windows 下 gnrt 调 `gn.bat`，PATH 要同时有 buildtools/win 的 gn.exe 与 depot_tools。
- **gn 自举**：新版 depot_tools 不带 gn（CIPD 是 Googler 渠道）；`tools/gn/bootstrap/bootstrap.py`
  有 Windows 目标名 bug（调 `gn`，实际 `gn.exe`）——让它生成 build.ninja 后失败，
  手工 `ninja gn.exe`。需要完整 MSVC 环境 + `CL=/utf-8`（中文系统 C4819 警告被 /WX
  升级为错误）+ SDK bin 入 PATH（链接期 mt.exe）。
- **VS 残装检测**：默认工具集 14.40 可能只有 bin/lib 没有 include（运行库残件）——
  找**带 include/ 的**完整工具集（本机为 14.37.32822）。
- **vs-shim**：本机 VS 的 vcvarsall.bat 缺失（Program Files 不可写没法补）→ 手写
  `vs-shim/VC/vcvarsall.bat` 复刻 env（setup_toolchain.py 经 GYP_MSVS_OVERRIDE_PATH 执行
  并解析 include/lib/libpath/path）。**bat 必须纯 ASCII**：cmd 按系统 ANSI（GBK）解析，
  UTF-8 中文注释会把 bat 撕成乱码命令。
- **SDK overlay（26100 ABI 头，统一取自 Microsoft.Windows.SDK.cpp NuGet 包）**：148 对
  SDK 头有 26100 时代的依赖，本机 22621 缺三样——①`sdkddkver.h` 无 `NTDDI_WIN11_GE`
  常量（→ NTDDI 求值 0，NTDDI 门控声明全消失，`FILE_INFO_BY_HANDLE_CLASS` 未知类型）；
  ②wincrypt.h 缺 `WINCRYPT_USE_SYMBOL_PREFIX` 防护（26100 新增，Chromium 全局启用该宏
  却跳不过 `#define X509_NAME ((LPCSTR)7)` 遗留块 → 撞 boringssl typedef）；③WinRT/COM
  新接口缺失（webrtc 要 `IGraphicsCaptureSession6`、ui/gl 要 `IDCompositionDynamicTexture`）。
  overlay（bootstrap 自动从 nupkg 提取）：`sdk-overlay/sdkddkver.h`（仓库自带）+
  um/wincrypt.h + winrt/windows.graphics.capture.h + um/dcomp.h + um/dcompanimation.h。
  注意 ABI 头在 SDK 顶层 `winrt/` 目录（`<windows.graphics.capture.h>` 的解析处），
  与 cppwinrt 的 `winrt/` 投影是两回事，别放错 overlay 相对路径。
- **SDK 版本**：gn 自动探测要求 26100，本机 22621 → `WINDOWSSDKVERSION=10.0.22621.0`
  环境变量 + vs_toolchain.py 101 补丁（dbghelp 缺 Debuggers 特性时落 System32、
  本地工具链模式输出 env 指定的 SDK 版本）。
- **rlz**：ungoogled 把 `enable_rlz_support` 硬编 false，但 Windows 安装器无条件依赖
  `//rlz:rlz_lib_no_network` → gn gen 失败。102 补丁恢复上游 is_win 条件（enable_rlz
  仍 false，无行为差异）。
- **icacls GBK**：set_appcontainer_acls 用 subprocess 读 icacls 输出，本机 PYTHONUTF8=1
  下 GBK 输出解码崩溃 → 103 补丁 `errors='replace'`。
- **ATL**：base/win atl.h 等生产代码真用 ATL，VS 残装没有 atlmfc → VS 引导器 `--layout`
  免管理员拉 ATL 14.44 包（payload.vsix 用 7z 解），头进 overlay、atls.lib 目录进 shim LIB。
- **python3 别名**：WindowsApps 的 python3.exe 是 Store 占位（exec_script 拿 9009）→
  bin/python3.exe 放真身；args.gn 里 `script_executable` 亦可。
- **rc.exe**：资源编译器包装由 DEPS gcs hook 分发（build/toolchain/win/rc/win/ 只留 sha1）；
  lite 树内 third_party/depot_tools 的 download_from_google_storage.py 是剪剩空壳（静默
  无效）——必须用独立 clone 的 depot_tools 里的脚本下载。
- **midl 黄金链**：`midl()` 目标把新产出与 `third_party/win_build_output/midl`（黄金文件）
  比对，tlb 缺失时会自造 0 字节占位并在 overwrite_guids 断言炸掉。lite 包不含任何 .tlb
  （本机共缺 13 个：updater 9 + elevation_service + service_program + elevated_tracing +
  remoting chromoting_lib）→ 全部从 googlesource 148 tag 还原（`?format=TEXT` base64 可
  直接解二进制）。midl.exe 用 Microsoft.Windows.SDK.BuildTools NuGet 包的 26100 版
  （8.01.0628；须与 14.37 cl.exe 同 PATH 作预处理器，组装的 14.44 树没有 bin）；shim
  PATH 里 sdkbt 目录必须排在 KIT bin 之前（否则解析到 22621 midl，IID 与黄金不一致）。
  版本差导致的黄金二进制偏差按 midl.py 指引重整基线（copy 临时目录 → 黄金目录）。
- **空静态库**：ungoogled 用 `if (false)` 清空部分 static_library 源码（safe_browsing、
  chromedriver）→ Windows 的 lld-link /lib 在 /WX 下拒绝写空库（Linux/mac 的 ar 无此
  症状，上游不炸）→ 106 补丁给 arflags 全局加 `/ignore:emptyoutput`。
- **lite 包缺二进制资源件**：updater 黄金 .tlb×13 之外，还有
  `third_party/win_build_output/mc/chrome/common/win/MSG00409.bin`、
  `chrome/app/etw_events/MSG00001.bin` 与 `chrome_events_winTEMP.BIN`
  （ETW WEVT_TEMPLATE 资源；名字带 TEMP 但上游就是 checked-in 的正式文件）——
  全部从 googlesource 148 tag 还原。缺件排查通用法：报错 "failed to open file"，
  用 googlesource 目录 JSON 列表（`<dir>/?format=JSON`）比对本地树。
- **ungoogled 改名丢常量**：signin_pref_names.h/cc 被合并改名为 signin_prefs.*，
  `prefs::kBoundSessionCredentialsEnabled` 丢失而 policy 工厂表仍引用 → 107 补丁
  把常量（值取自上游 signin_pref_names）补进 chrome/common/pref_names.h
  （本地 bound_session 模块已改走 switches 路径，仅此一处引用）。
- **LLVM OOM**：默认 -j=逻辑核数（20），net/ 等 heavy TU（thin-LTO）单进程峰值 3-4GB，
  47.7GB 内存扛不住 → 降并发；j12 下 blink animation 区出现 clang 0xC000001D 崩溃
  （单文件重跑必过，高内存并发下的非确定性不稳定）→ 最终 `-j8` 稳定。
- **C11 threads.h（pthreadpool）**：既不在任何 Windows SDK，也只在 MSVC 14.38+ 的
  include 里（本机 14.37 没有、22621 SDK 也没有）→ VS 引导器 `--layout` 免管理员拉
  `Microsoft.VisualStudio.Component.VC.Tools.x86.x64`，从各包 payload.vsix 组装 14.44
  工具集树（CRT.Headers→include；CRT.x64/x86.Desktop→lib；**delayimp.lib 只在 Store 包、
  oldnames.lib 在 Store 的 uwp/ 与 OneCore 包**，Store 版拷到 lib/x64 归位）。shim 的
  MSVC 指向组装树（bootstrap-win.sh `ensure_msvc_ge_1440` 已固化）。

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
