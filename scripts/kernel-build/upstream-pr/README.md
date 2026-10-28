# os_crypt 补丁上游 PR 材料（未提交，等用户过目）

> 状态：**材料备齐，尚未对外提交**。PR 文案与补丁中性化版本均在本目录，
> 提交前需用户确认（对外动作）。

## 材料清单

| 文件 | 用途 |
|---|---|
| `os-crypt-key-switch.patch` | 中性化版补丁（四文件；所有 OneBrowser 品牌措辞与 `onebrowser_*` 标识符已替换为通用命名） |
| `pr-body-draft.md` | 英文 PR 文案草稿（Title + Body，含动机/改动/兼容性/测试证据/维护者注记） |

## 验证记录（2026-10-28，离线往返法）

原 W2 验证依赖 googlesource 拉原始文件（当前网络不可达），改用本地构建树等价验证：

```
cp D:/ob-kernel-build/build/src/components/os_crypt/{common,sync}/四文件 → 临时目录
git apply -R -p1 patches/onebrowser/100-os-crypt-key.patch   # 逆向还原出 148 原始文件
git apply --check -p1 upstream-pr/os-crypt-key-switch.patch  # 中性化版干净应用 ✅
git apply -p1 同上 && grep 确认 kOsCryptKey/RoamingKeyActive 落位 ✅
```

即：中性化只动了 `+` 新增行内的注释与标识符，与原补丁逐 hunk 等价。

## 提交流程（用户确认后执行）

1. fork `adryfish/fingerprint-chromium`，读其 README 确认补丁组织惯例
   （ungoogled-chromium 式 patches 目录则新增一个 patch 文件 + meta 行；
   若接受源码 PR 则按其分支基线）。
2. **版本对齐**：本补丁基于 **148.0.7778.215**。若上游源码已推进到 151+，
   需在对应版本源码上重放（方法同 W2：googlesource `?format=TEXT` 还原目标
   四文件 → `git apply --check` → 修正漂移的上下文行）。
3. 以 `pr-body-draft.md` 正文提 PR；标题用其首行。
4. 提交后在本文件登记 PR 链接与回复跟踪。

## 边界（勿混入）

- **101–107 补丁不要提交**：那些是本项目 Windows 自建内核的工具链补丁
  （本地 SDK 兜底/rlz/GBK/空库标志等），对上游无通用价值。
- PR 文案中「downstream product」不点名 OneBrowser（保持中性，避免广告嫌疑）；
  维护者问起再私下补充。

## 被拒的备选路径

上游拒绝 → W3 存档的自建内核作为可选高级件（`D:/ob-kernel-build` 停在
chrome.dll 链接段，`bootstrap-win.sh` 可复现，ninja 续跑即可出包）。
