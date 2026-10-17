# M6 预研：文件级快照（L2 数据面）可行性研究

> 日期：2026-10-17。V0.3 Go/No-Go 的前置研究。核心问题：**profile 目录级快照能否跨设备漫游**——
> 即在另一台机器/实例上，把整个 user-data-dir 放回去后，浏览器能否原样恢复登录态与全部站点数据。

## 结论（TL;DR）

**GO。** Linux 内核（我们当前的 kernel 承载路径）上，profile 目录**原样拷贝即可漫游**，无需任何补丁：

| 验证 | 结果 |
|---|---|
| Cookies SQLite 跨容器解密（os_crypt v10） | ✅ 全新容器、异 seed、原生 flags，读回一致 |
| 整 profile 目录拷贝后浏览器正常启动 | ✅ |
| 持久 cookie / localStorage / IndexedDB 三类数据 | ✅ 全部读回 |

mac/Windows **原生**内核漫游仍需 os_crypt 补丁（Keychain/DPAPI 绑定本机），但那是后续「原生内核」路线的事，不阻塞 V0.3。

## PoC：可复跑的验收脚本

`apps/desktop/scripts/os-crypt-roaming-poc.mjs`（裸 Node + Docker，双容器互拷）：

```
容器 A（seed=777777）：Storage.setCookies 写入持久 cookie → Browser.close 落盘 → 拷出 Cookies SQLite
容器 B（seed=888888，全新 profile）：先启动一次生成目录结构 → 注入 A 的 Cookies 文件 → docker start
→ Storage.getCookies 读回 == 原值 ✅
```

DB 侧确认：`Default/Cookies` 行的 `encrypted_value` 以 `v10` 开头（os_crypt 信封），`host_key`/`name` 为明文列。

### 实验中的重大教训（记录以免重蹈）

1. **会话 cookie（无 `expires`）重启即被丢弃——这是 cookie 语义，不是加密失败。**
   早期 PoC 用无 expires 的 cookie 测试，得出「自重启都解不开 → os_crypt 每次启动随机密钥」的
   **错误结论**，一度把方向带偏到「必须打 os_crypt 补丁」。改用持久 cookie 后全部通过。
   （错误结论的旁证当时看似完美：peanuts 各变体离线解不开 v10、Chromium 确实移除了硬编码回退。）
2. `docker start` 重入容器时 Xvfb 的 `/tmp/.X99-lock` 残留导致内核无显示退出——entrypoint 已修
   （启动前清锁，`scripts/kernel-docker/entrypoint.sh`）。
3. 每次调用新开 WebSocket 的 CDP 客户端在 `Target.attachToTarget` 上不可靠——用持久连接
   （与产品 `cdp.ts` 一致）。
4. `docker exec` 不能用于已停止的容器（清理步骤要靠 `docker cp` 覆盖空文件等手段）。

## os_crypt 现状分析（为什么 Linux 容器能漫游）

- 上游 Chromium 已移除 Linux 无密钥库时的硬编码密钥回退（"peanuts"），改为 libsecret/KWallet/
  XDG Secret Portal，迁移机制见 [issues.chromium.org/40464669](https://issues.chromium.org/issues/40464669)。
- 本内核镜像（ungoogled-chromium 系 Linux 构建）在容器内无任何密钥库可用，实测 os_crypt 密钥
  **在同一镜像内是固定的**（跨容器、跨 seed、跨 profile 均可互解；具体派生方式未逆向，不影响结论）。
- 含义：**同一内核构建内，profile 中所有 os_crypt 加密数据（Cookies、保存的密码等）可随目录搬运**。
  不同内核版本/构建之间不保证——L2 快照必须**绑定内核版本**（快照 manifest 记录 kernelVersion，
  恢复时校验，不一致则提示重新登录）。
- 安全注意：密钥镜像内固定 = 拿到 profile 目录的任何人都能解出 cookie。我们的存储管道本来就是
  E2E 加密（DEK 信封），云端不存在明文 profile；本地 profile 是一次性运行目录（kernel 模式位于
  temp，关闭即弃/可清）。风险面等价于「能读本地 profile 目录的本地进程」，可接受。

## 源码与构建（若未来需要原生内核/自定义补丁）

- fingerprint-chromium 基于 ungoogled-chromium，**源码（patch）比二进制晚一个大版本发布**
  （Chrome 150 的源码要等 151 发布后可用；当前可用最新为 148 系）。
- 构建体系即 ungoogled-chromium 的 build 系统（submodule 指向 fingerprint-browser 补丁仓库）；
  本机（Intel Xeon iMac）可行路径：Docker 内构建 Linux x64（约 100GB 磁盘 + 数小时），
  或 fork 其 GitHub Actions 出多平台产物。
- os_crypt 补丁设计（原生 mac/win 路线时）：给 `OSCrypt::GetKey` 加 `--os-crypt-key=<hex>` 注入
  每环境密钥（由我们的 DEK 经 HKDF 派生，与现有快照密钥体系同构）——侵入面小（单文件，
  components/os_crypt），但依赖源码可用性，放 V0.4+。

## V0.3 L2 数据面设计草图（基于以上结论）

1. **快照单位**：kernel 环境 = 整个 user-data-dir 的 tar.zstd 打包（首版全量；增量优化后续），
   内嵌 manifest（kernelVersion、fingerprint seed、hosting）。
2. **加密**：与 L1 相同的 E2E 信封（DEK→HKDF→每快照子密钥→AES-256-GCM 流式加密包体）。
3. **恢复**：下载 → 解密 → 解包到全新 per-run profile 目录 → 启动内核 → **无需数据面注入**。
4. **兼容**：保留 L1 结构化数据面（builtin 承载 + 跨承载互迁移仍需它）；L2 仅对 kernel 承载开放，
   manifest 里标注 plane=l2。
5. **验收（进 e2e）**：T-L2.1 kernel 登录（含 IndexedDB 写入）→ 保存基线（L2）→ 新实例克隆 →
   cookie/localStorage/IndexedDB 全部读回；T-L2.2 跨内核版本恢复 → 提示基线失效。

## V0.3 Go/No-Go

**GO**——L2 的核心风险（os_crypt 绑定本机）经实证不存在于 Linux 内核路径；profile 体积与打包/解包
性能是工程问题而非可行性问题。首版建议直接在 V0.3 实现 L2 全量快照，L1 保留为 builtin 承载与
降级路径。
