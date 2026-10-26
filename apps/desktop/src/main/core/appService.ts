// 应用服务：编排全部核心模块（auth/envs/快照/租约/窗口），并对渲染进程提供 IPC 面。
import net from 'node:net'
import os from 'node:os'
import { CloudClient, ApiError } from './cloudClient'
import { LeaseAgent } from './leaseAgent'
import { BrowserHost } from './browserHost'
import { ExternalKernelHost } from './externalKernelHost'
import { DockerKernelLauncher, NativeKernelLauncher } from './kernelLauncher'
import { KernelManager } from './kernelManager'
import { LocalStore } from './localStore'
import type { Host, RunningEnv } from './host'
import {
  DEFAULT_KDF,
  deriveAuthKey,
  deriveKEK,
  generateDEK,
  newKdfParams,
  unwrapDEK,
  wrapDEK,
  sha256Hex,
  randomId,
  randomSeed,
  isValidSeed,
  type KdfParamsJson
} from './e2e'
import {
  seal,
  open as openStructured,
  openFiles,
  sealFiles,
  sealConfig,
  openConfig,
  manifestJson,
  blobBytes,
  type SnapshotManifest,
  type SealedSnapshot,
  type SnapshotPayload
} from './snapshotEngine'
import { untarTo } from './profileArchive'
import { subkey } from './e2e'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type {
  AppState,
  CreateEnvInput,
  EnvConfig,
  EnvPhase,
  EnvView,
  KernelStatus,
  MainEvent,
  ProxyConfig
} from '@shared/types'

interface PhaseEntry {
  phase: EnvPhase
  message?: string
}

export class AppService {
  readonly cloud: CloudClient
  readonly agent: LeaseAgent
  /** builtin 承载（Electron 内存 partition，轻量模式） */
  readonly host = new BrowserHost()
  /** kernel 承载（外挂指纹内核） */
  readonly kernelHost: ExternalKernelHost
  readonly kernelManager: KernelManager
  readonly store = new LocalStore()

  private dek: Uint8Array | null = null
  private kdf: KdfParamsJson = newKdfParams()
  private envs = new Map<string, EnvConfig>()
  private phases = new Map<string, PhaseEntry>()
  private baseMetas = new Map<string, { snapshotId: string; createdAt: string }>()
  private leaseInfo = new Map<string, string>() // envId → holderDeviceId
  private email: string | null = null

  constructor(
    public serverUrl: string,
    private emit: (e: MainEvent) => void
  ) {
    this.cloud = new CloudClient(serverUrl)
    this.agent = new LeaseAgent(this.cloud, {
      onEvict: (envId) => this.handleEvicted(envId),
      onLost: (envId) => {
        this.setPhase(envId, 'idle', '租约已丢失（心跳超时）')
        this.host.closeWindow(envId)
        this.kernelHost.closeWindow(envId)
        this.notify('warning', '环境租约已丢失，窗口已关闭')
      },
      onEnvUpdated: () => this.refreshEnvs().catch(() => {}),
      onReleased: () => {}
    })
    this.kernelManager = new KernelManager(
      () => this.store.kernelLocalExe,
      (p) => this.emit({ type: 'kernel', status: this.kernelStatus(p) })
    )
    // ONEBROWSER_KERNEL_DOCKER=1：内核跑在 Docker（无原生内核平台的开发/CI 验证路径）
    this.kernelHost = process.env.ONEBROWSER_KERNEL_DOCKER === '1'
      ? new ExternalKernelHost(new DockerKernelLauncher(process.env.ONEBROWSER_KERNEL_IMAGE || 'onebrowser-kernel-smoke'))
      : new ExternalKernelHost(
          new NativeKernelLauncher(async () => {
            const info = await this.kernelManager.ensureReady()
            if (!info.exePath) throw new Error('内核不可用')
            return info.exePath
          })
        )
    const wireClosed = (h: { onClosed: ((envId: string) => void) | null }): void => {
      h.onClosed = (envId) => {
        if ((this.phases.get(envId)?.phase || 'idle') !== 'evicting') {
          this.setPhase(envId, 'idle')
          this.refreshEnvs().catch(() => {})
        }
      }
    }
    wireClosed(this.host)
    wireClosed(this.kernelHost)
  }

  /** 环境对应的承载 */
  private hostFor(env: Pick<EnvConfig, 'hosting'>): Host {
    return env.hosting === 'kernel' ? this.kernelHost : this.host
  }

  /** 任一承载运行中 */
  private isEnvRunning(envId: string): boolean {
    return this.host.isRunning(envId) || this.kernelHost.isRunning(envId)
  }

  /** docker 内核模式（跳过原生内核就绪检查） */
  get kernelDockerMode(): boolean {
    return process.env.ONEBROWSER_KERNEL_DOCKER === '1'
  }

  /** L2 manifest 的内核构建标识：profile 含 os_crypt 数据，跨构建不保证可解 */
  private kernelTag(): string {
    return this.kernelDockerMode
      ? `docker:${process.env.ONEBROWSER_KERNEL_IMAGE || 'onebrowser-kernel-smoke'}`
      : `native:${this.kernelManager.status().version || 'unknown'}`
  }

  // ---------- 指纹解析（seed / auto(按代理出口 geo) / manual） ----------

  private async resolveFingerprint(env: EnvConfig): Promise<{
    seed: string
    platform?: string
    timezone?: string
    lang?: string
  }> {
    const fp = env.fingerprint || {}
    const tzMode = fp.timezoneMode ?? (fp.timezone ? 'manual' : 'seed')
    const langMode = fp.langMode ?? (fp.lang ? 'manual' : 'seed')
    const out: { seed: string; platform?: string; timezone?: string; lang?: string } = {
      seed: env.seed,
      platform: fp.platform
    }
    const needGeo = tzMode === 'auto' || langMode === 'auto'
    const geo = needGeo ? await this.geoLookup(env.proxy).catch(() => null) : null
    if (tzMode === 'manual' && fp.timezone) out.timezone = fp.timezone
    else if (tzMode === 'auto' && geo?.timezone) out.timezone = geo.timezone
    if (langMode === 'manual' && fp.lang) out.lang = fp.lang
    else if (langMode === 'auto' && geo?.lang) out.lang = geo.lang
    if (needGeo && !geo) this.notify('warning', '地理位置查询失败，时区/语言回退为跟随种子')
    return out
  }

  /** 经（可选）代理查询出口 IP 的地理信息。
   * 注意：刻意不走 Electron/Chromium 网络栈——setProxy(<-loopback) 会污染
   * 网络服务的后续请求（V0.2.0-S3 排障记录），故用 Node 原生 socket 实现
   * HTTP 代理 GET（socks 代理暂不支持 auto，回退种子模式）。 */
  private async geoLookup(proxy?: ProxyConfig): Promise<{ ip: string; timezone: string; lang: string } | null> {
    try {
      const target = new URL(this.serverUrl + '/v1/geo')
      if (!proxy?.host || proxy.scheme === 'socks5') {
        const resp = await fetch(target, { signal: AbortSignal.timeout(5000) })
        const geo = (await resp.json()) as { ip?: string; timezone?: string; lang?: string }
        return { ip: String(geo.ip || ''), timezone: String(geo.timezone || ''), lang: String(geo.lang || '') }
      }
      const viaProxy = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(proxy.port, proxy.host, () => {
          socket.write(
            `GET ${target.href} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`
          )
        })
        socket.setTimeout(5000, () => {
          socket.destroy()
          reject(new Error('geo 查询超时'))
        })
        let data = ''
        socket.on('data', (chunk) => (data += chunk.toString()))
        socket.on('end', () => resolve(data))
        socket.on('error', reject)
      })
      const body = viaProxy.slice(viaProxy.indexOf('\r\n\r\n') + 4)
      const geo = JSON.parse(body) as { ip?: string; timezone?: string; lang?: string }
      return { ip: String(geo.ip || ''), timezone: String(geo.timezone || ''), lang: String(geo.lang || '') }
    } catch (e) {
      console.warn('[geo] 查询失败:', e instanceof Error ? e.message : e)
      return null
    }
  }

  // ---------- 内核 ----------

  kernelStatus(progress?: { status: string; percent?: number; message?: string }): KernelStatus {
    const s = this.kernelManager.status()
    return { ...s, downloading: this.kernelManager.status().ready ? false : undefined, progress }
  }

  async downloadKernel(): Promise<KernelStatus> {
    const info = await this.kernelManager.downloadLatest()
    this.emit({ type: 'kernel', status: this.kernelStatus() })
    this.notify('success', `指纹内核就绪（${info.version}）`)
    return this.kernelStatus()
  }

  async setKernelLocalPath(exePath: string | undefined): Promise<KernelStatus> {
    if (exePath) {
      const ok = await this.kernelManager.validateLocalExe(exePath)
      if (!ok) throw new Error('该文件无法作为内核运行（--version 校验失败）')
    }
    this.store.setKernelLocalExe(exePath)
    this.emit({ type: 'kernel', status: this.kernelStatus() })
    return this.kernelStatus()
  }

  // ---------- 状态 ----------

  get logged_in(): boolean {
    return this.cloud.token != null && this.dek != null
  }

  getState(): AppState {
    const envs: EnvView[] = [...this.envs.values()].map((env) => {
      const p = this.phases.get(env.id) || { phase: 'idle' as EnvPhase }
      const base = this.baseMetas.get(env.id)
      return {
        env,
        phase: this.isEnvRunning(env.id) && p.phase === 'idle' ? 'running' : p.phase,
        message: p.message,
        hasBase: !!base,
        baseCreatedAt: base?.createdAt,
        leaseHolder: this.leaseInfo.get(env.id)
      }
    })
    return {
      account: this.logged_in
        ? { email: this.email || '', deviceId: this.store.deviceId, serverUrl: this.serverUrl }
        : null,
      envs
    }
  }

  private push(): void {
    this.emit({ type: 'state', state: this.getState() })
  }

  private notify(level: 'success' | 'warning' | 'error', message: string): void {
    this.emit({ type: 'notify', level, message })
  }

  private setPhase(envId: string, phase: EnvPhase, message?: string): void {
    this.phases.set(envId, { phase, message })
    this.push()
  }

  // ---------- 账号 ----------

  async register(email: string, password: string): Promise<void> {
    const authKdf = newKdfParams()
    const kekKdf = newKdfParams()
    const authKey = await deriveAuthKey(password, authKdf)
    const kek = await deriveKEK(password, kekKdf)
    const dek = generateDEK()
    await this.cloud.register({
      email,
      authKey,
      authKdf,
      wrappedDek: await wrapDEK(kek, dek),
      kekKdf
    })
    await this.login(email, password)
    this.notify('success', '注册成功，已自动登录')
  }

  async login(email: string, password: string): Promise<void> {
    const { authKdf } = await this.cloud.kdfInfo(email)
    const authKey = await deriveAuthKey(password, authKdf)
    const resp = await this.cloud.login({
      email,
      authKey,
      deviceId: this.store.deviceId,
      deviceName: os.hostname(),
      platform: process.platform
    })
    const kek = await deriveKEK(password, resp.kekKdf)
    this.dek = await unwrapDEK(kek, resp.wrappedDek)
    this.kdf = { ...DEFAULT_KDF, salt: resp.kekKdf.salt }
    this.cloud.token = resp.token
    this.email = email
    this.store.setLastEmail(email)
    this.cloud.connectWS()
    await this.refreshEnvs()
    this.notify('success', `已登录：${email}`)
  }

  async logout(): Promise<void> {
    this.agent.stopAll()
    this.host.closeAll()
    this.kernelHost.closeAll()
    try {
      await this.cloud.logout()
    } catch {
      /* token 可能已失效 */
    }
    this.cloud.disconnect()
    this.cloud.token = null
    this.dek = null
    this.email = null
    this.envs.clear()
    this.phases.clear()
    this.push()
  }

  // ---------- 环境 ----------

  async refreshEnvs(): Promise<void> {
    if (!this.logged_in) {
      this.push()
      return
    }
    const { envs } = await this.cloud.listEnvs()
    const next = new Map<string, EnvConfig>()
    const seedBackfills: Array<{ row: (typeof envs)[number]; cfg: Record<string, unknown>; seed: string }> = []
    for (const row of envs) {
      let cfg: {
        hosting?: EnvConfig['hosting']
        homepage?: string
        seed?: string
        proxy?: ProxyConfig
        fingerprint?: EnvConfig['fingerprint']
        kernelVersion?: string
        sessionCheck?: EnvConfig['sessionCheck']
        l1SnapshotId?: string
      } = {}
      try {
        cfg = await openConfig<typeof cfg>(this.dek!, row.id, row.configEnc)
      } catch {
        // 配置解密失败（如密钥轮换后旧数据）——降级为默认配置
      }
      // seed 回填：旧环境/解密降级可能缺 seed。必须持久化回写，否则每次刷新
      // 重新随机 → 同一环境指纹漂移；且随机值必须为合法 32 位整数（KI-1）
      let seed = cfg.seed || ''
      if (!isValidSeed(seed)) {
        seed = randomSeed()
        seedBackfills.push({ row, cfg, seed })
      }
      next.set(row.id, {
        id: row.id,
        name: row.name,
        mode: row.mode,
        hosting: cfg.hosting === 'kernel' ? 'kernel' : 'builtin', // 旧环境缺省 builtin，保持兼容
        homepage: cfg.homepage || '',
        seed,
        proxy: cfg.proxy,
        fingerprint: cfg.fingerprint,
        kernelVersion: cfg.kernelVersion,
        sessionCheck: cfg.sessionCheck,
        l1SnapshotId: cfg.l1SnapshotId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      })
      if (row.base) this.baseMetas.set(row.id, { snapshotId: row.base.snapshotId, createdAt: row.base.createdAt })
      else this.baseMetas.delete(row.id)
      if (row.lease) this.leaseInfo.set(row.id, row.lease.holderDeviceId)
      else this.leaseInfo.delete(row.id)
    }
    this.envs = next
    // 回写缺 seed 的环境配置（best-effort；失败则下次刷新重试）
    for (const { row, cfg, seed } of seedBackfills) {
      try {
        const configEnc = await sealConfig(this.dek!, row.id, { ...cfg, seed })
        await this.cloud.updateEnv(row.id, { name: row.name, configEnc })
      } catch (e) {
        console.warn(`[refreshEnvs] seed 回填失败 ${row.id}:`, e instanceof Error ? e.message : e)
      }
    }
    this.push()
  }

  async createEnv(input: CreateEnvInput): Promise<void> {
    if (!this.logged_in) throw new Error('未登录')
    if (input.seed !== undefined && !isValidSeed(input.seed)) {
      // 非法 seed 会毒化内核（KI-1）：必须在此拦下，不能静默换值
      throw new Error('指纹种子必须是 1~2147483647 的整数')
    }
    const id = randomId()
    const hosting = input.hosting === 'builtin' ? 'builtin' : 'kernel'
    const configEnc = await sealConfig(this.dek!, id, {
      hosting,
      homepage: input.homepage,
      seed: input.seed || randomSeed(),
      proxy: input.proxy,
      fingerprint: input.fingerprint,
      sessionCheck: input.sessionCheck
    })
    await this.cloud.createEnv({ id, name: input.name, mode: input.mode, configEnc })
    await this.refreshEnvs()
    this.notify('success', `环境「${input.name}」已创建（${hosting === 'kernel' ? '指纹内核' : '内置轻量'}）`)
  }

  async updateEnv(
    id: string,
    patch: {
      name?: string
      homepage?: string
      proxy?: ProxyConfig
      fingerprint?: EnvConfig['fingerprint']
      hosting?: EnvConfig['hosting']
      sessionCheck?: EnvConfig['sessionCheck'] | null
    }
  ): Promise<void> {
    const cur = this.envs.get(id)
    if (!cur) throw new Error('环境不存在')
    const configEnc = await sealConfig(this.dek!, id, {
      hosting: patch.hosting !== undefined ? patch.hosting : cur.hosting,
      homepage: patch.homepage !== undefined ? patch.homepage : cur.homepage,
      seed: cur.seed,
      proxy: patch.proxy !== undefined ? patch.proxy : cur.proxy,
      fingerprint: patch.fingerprint !== undefined ? patch.fingerprint : cur.fingerprint,
      // null=显式清除；undefined=不修改
      sessionCheck: patch.sessionCheck == null ? (patch.sessionCheck === null ? undefined : cur.sessionCheck) : patch.sessionCheck,
      kernelVersion: cur.kernelVersion,
      l1SnapshotId: cur.l1SnapshotId
    })
    await this.cloud.updateEnv(id, {
      name: patch.name !== undefined ? patch.name : cur.name,
      configEnc
    })
    await this.refreshEnvs()
  }

  async deleteEnv(id: string): Promise<void> {
    if (this.isEnvRunning(id)) throw new Error('环境运行中，请先关闭')
    await this.cloud.deleteEnv(id)
    this.envs.delete(id)
    this.phases.delete(id)
    await this.refreshEnvs()
  }

  // ---------- 打开 / 关闭 ----------

  async openEnv(envId: string, hidden = false): Promise<void> {
    const env = this.envs.get(envId)
    if (!env) throw new Error('环境不存在')
    if (this.isEnvRunning(envId)) throw new Error('环境已打开')
    const host = this.hostFor(env)
    const fingerprint = await this.resolveFingerprint(env)
    // os_crypt 每环境密钥：DEK→HKDF（同账号跨设备一致，env 级隔离）→ 16B hex。
    // 三端内核（mac/linux/win 补丁）均按 16 字节强校验并以此跨平台互解
    // （win 漫游模式直接采用 mac/linux 的 v11 AES-CBC 线格式，见 kernel-build README）
    const osCryptKey =
      env.hosting === 'kernel' && this.dek
        ? Buffer.from(subkey(this.dek, `os-crypt:${envId}`).slice(0, 16)).toString('hex')
        : undefined

    // kernel 承载：先确保内核就绪（可能触发首次下载）；docker 模式无需原生内核
    if (env.hosting === 'kernel' && !this.kernelDockerMode && !this.kernelManager.status().ready) {
      this.setPhase(envId, 'downloading-kernel', '准备指纹内核（首次需下载，约 200MB）…')
      await this.kernelManager.ensureReady()
      this.emit({ type: 'kernel', status: this.kernelStatus() })
    }

    if (env.mode === 'snapshot') {
      this.setPhase(envId, 'opening')
      console.log(`[openEnv] ${envId} 下载基线…`)
      const plan = await this.downloadBase(envId)
      console.log(`[openEnv] ${envId} 打开（hosting=${env.hosting}, restore=${plan ? plan.kind : '首次'}）`)
      if (plan?.kind === 'files') {
        // L2：profile 已解包到 plan.dir，内核直接以它为 user-data-dir 启动；
        // 叠加 L1 结构化注入补齐会话 cookie 与惰性刷盘的 localStorage（双写快照的副本）
        const l1 = env.l1SnapshotId ? await this.fetchL1Payload(envId, env.l1SnapshotId) : null
        await host.open(env, { restoreDir: plan.dir, restore: l1 || undefined, hidden, fingerprint, osCryptKey })
        this.setPhase(envId, 'running', '已从云端基线克隆（文件级 L2）')
        if (plan.kernelVersion !== this.kernelTag()) {
          this.notify('warning', `「${env.name}」基线来自不同版本的内核，如登录态异常请重新登录并更新基线`)
        }
        if (env.sessionCheck) this.probeSession(env).catch(() => undefined)
        return
      }
      const restore = plan?.kind === 'structured' ? plan.payload : null
      await host.open(env, { restore, hidden, fingerprint, osCryptKey })
      this.setPhase(
        envId,
        'running',
        restore
          ? `已从云端基线克隆${env.hosting === 'kernel' ? '（指纹内核）' : ''}`
          : '首次打开：请登录后点击「保存为基线」'
      )
      if (restore && env.sessionCheck) this.probeSession(env).catch(() => undefined)
      return
    }

    // exclusive：先取租约
    this.setPhase(envId, 'acquiring')
    let outcome = await this.agent.acquire(envId)
    if (!outcome.granted) {
      this.setPhase(envId, 'waiting-evict', `正在接管：等待设备 ${outcome.holderDeviceId} 下线…`)
      outcome = await this.agent.waitGranted(envId, (outcome.deadlineMs || 15000) + 20000)
    }
    this.setPhase(envId, 'opening')
    const plan = outcome.snapshotId
      ? await this.downloadSnapshot(envId, outcome.snapshotId)
      : await this.downloadBase(envId)
    if (plan?.kind === 'files') {
      const l1 = env.l1SnapshotId ? await this.fetchL1Payload(envId, env.l1SnapshotId) : null
      await host.open(env, { restoreDir: plan.dir, restore: l1 || undefined, hidden, fingerprint, osCryptKey })
      if (plan.kernelVersion !== this.kernelTag()) {
        this.notify('warning', `「${env.name}」基线来自不同版本的内核，如登录态异常请重新登录并更新基线`)
      }
    } else {
      await host.open(env, { restore: plan?.kind === 'structured' ? plan.payload : null, hidden, fingerprint, osCryptKey })
    }
    this.agent.startHeartbeat(envId)
    this.setPhase(envId, 'running', outcome.stale ? '已接管（旧基线：对方设备未及时上传）' : '已接管')
    this.notify('success', `已打开互斥环境「${env.name}」`)
  }

  /** 会话健康检查：恢复基线后探测登录态是否仍有效（按 env.sessionCheck 配置）。
   * 在环境自己的会话上下文里发请求（builtin=页面 fetch 带 cookie；kernel=CDP
   * 页面内 fetch），响应不含 loggedInMarker 判定基线失效并提示重新登录。
   * 探测失败（网络/页面未就绪）静默忽略——不能因探测误报打扰使用。 */
  private async probeSession(env: EnvConfig): Promise<void> {
    const sc = env.sessionCheck
    if (!sc || !this.isEnvRunning(env.id)) return
    let body = ''
    try {
      const re = this.host.get(env.id)
      if (re && re.kind === 'builtin') {
        body = String(
          await re.win.webContents.executeJavaScript(
            `fetch(${JSON.stringify(sc.urlPath)}, { credentials: 'include' }).then(r => r.text()).catch(() => '')`
          )
        )
      } else {
        const k = this.kernelHost.get(env.id)
        if (!k) return
        const r = await k.page.send('Runtime.evaluate', {
          expression: `fetch(${JSON.stringify(sc.urlPath)}).then(r => r.text()).catch(() => '')`,
          awaitPromise: true,
          returnByValue: true
        })
        body = String(r.result?.value ?? '')
      }
    } catch {
      return
    }
    if (!body.includes(sc.loggedInMarker)) {
      console.log(`[probeSession] 基线失效 ${env.id}（marker 不在响应中）`)
      this.notify('warning', `「${env.name}」基线失效，请重新登录并更新基线`)
      this.setPhase(env.id, 'running', '基线失效：请重新登录后点击「保存为基线」')
      this.push()
    }
  }

  async closeEnv(envId: string): Promise<void> {
    const env = this.envs.get(envId)
    if (!env || !this.isEnvRunning(envId)) return
    const host = this.hostFor(env)
    if (env.mode === 'exclusive' && this.logged_in) {
      this.setPhase(envId, 'saving', '保存最新状态到云端…')
      let snapId: string | undefined
      try {
        snapId = await this.uploadSnapshot(envId)
      } catch (e) {
        this.notify('warning', `状态上传失败（${err(e)}），将以云端旧基线释放`)
      }
      this.agent.stopHeartbeat(envId)
      this.agent.release(envId, snapId)
      this.setPhase(envId, 'closing')
    } else {
      this.setPhase(envId, 'closing')
    }
    host.closeWindow(envId) // onClosed → idle + refresh
  }

  /** 保存为基线（模式一主入口；模式二也可手动触发） */
  async saveBase(envId: string): Promise<void> {
    if (!this.isEnvRunning(envId)) throw new Error('环境未运行')
    this.setPhase(envId, 'saving', '抓取并上传基线快照…')
    const snapId = await this.uploadSnapshot(envId)
    this.setPhase(envId, 'running', `基线已更新（${snapId.slice(0, 8)}…）`)
    this.notify('success', '基线快照已保存到云端')
    await this.refreshEnvs()
  }

  /** 被驱逐：抓取→上传→释放→关窗（服务端 lease.evict 指令） */
  private async handleEvicted(envId: string): Promise<void> {
    const env = this.envs.get(envId)
    const host = env ? this.hostFor(env) : this.host
    if (!this.isEnvRunning(envId)) {
      this.agent.stopHeartbeat(envId)
      this.agent.release(envId)
      return
    }
    this.setPhase(envId, 'evicting', '被请求接管：保存并下线…')
    let snapId: string | undefined
    try {
      snapId = await this.uploadSnapshot(envId)
      console.log(`[evict] 上传完成 snapId=${snapId}`)
    } catch (e) {
      this.notify('warning', `驱逐前上传失败（${err(e)}）`)
    }
    console.log(`[evict] 发送 release snapId=${snapId}`)
    this.agent.stopHeartbeat(envId)
    this.agent.release(envId, snapId)
    this.setPhase(envId, 'closing')
    host.closeWindow(envId)
    this.notify('warning', `环境「${env?.name || envId}」已被其他设备接管，最新状态已保存上云`)
    this.refreshEnvs().catch(() => {})
  }

  // ---------- 快照管道 ----------

  private async downloadBase(envId: string): Promise<RestorePlan | null> {
    if (!this.logged_in) return null
    const base = await this.cloud.getBase(envId)
    if (!base.hasBase || !base.download || !base.snapshot) return null
    return this.fetchRestore(envId, base.download.manifestUrl, base.download.blobUrl, base.snapshot.snapshotId)
  }

  private async downloadSnapshot(envId: string, snapId: string): Promise<RestorePlan | null> {
    const d = await this.cloud.getDownload(envId, snapId)
    return this.fetchRestore(envId, d.download.manifestUrl, d.download.blobUrl, snapId)
  }

  /** 取 L1 兜底快照的结构化载荷（L2 恢复时叠加注入） */
  private async fetchL1Payload(envId: string, snapshotId: string): Promise<SnapshotPayload | null> {
    try {
      const plan = await this.downloadSnapshot(envId, snapshotId)
      return plan?.kind === 'structured' ? plan.payload : null
    } catch (e) {
      console.warn(`[restore] L1 兜底快照获取失败（仅用 L2）: ${e instanceof Error ? e.message : e}`)
      return null
    }
  }

  /** 把 L1 兜底快照 id 记入环境配置（E2E 密文），builtin 打开 L2 基线时回退用 */
  private async rememberL1Snapshot(env: EnvConfig, snapshotId: string): Promise<void> {
    try {
      const cfgEnc = await sealConfig(this.dek!, env.id, {
        hosting: env.hosting,
        homepage: env.homepage,
        seed: env.seed,
        proxy: env.proxy,
        fingerprint: env.fingerprint,
        kernelVersion: env.kernelVersion,
        sessionCheck: env.sessionCheck,
        l1SnapshotId: snapshotId
      })
      await this.cloud.updateEnv(env.id, { configEnc: cfgEnc })
      this.envs.set(env.id, { ...env, l1SnapshotId: snapshotId })
    } catch (e) {
      console.warn('[upload] l1SnapshotId 记录失败:', e instanceof Error ? e.message : e)
    }
  }

  private async fetchRestore(
    envId: string,
    manifestUrl: string,
    blobUrl: string,
    expectSnapId: string
  ): Promise<RestorePlan> {
    const [manifestBytes, blob] = await Promise.all([
      this.cloud.getObject(manifestUrl),
      this.cloud.getObject(blobUrl)
    ])
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as SnapshotManifest
    if (manifest.snapshotId !== expectSnapId) throw new Error('快照 ID 不匹配')

    if (manifest.kind === 'files') {
      const env = this.envs.get(envId)
      // builtin（Electron partition）无法消费 profile 目录 → 回退到双写时的 L1 结构化快照
      if (env && env.hosting !== 'kernel') {
        if (env.l1SnapshotId) {
          console.log(`[restore] builtin 打开 L2 基线 → 回退 L1 快照 ${env.l1SnapshotId.slice(0, 8)}…`)
          const d = await this.cloud.getDownload(envId, env.l1SnapshotId)
          return this.fetchRestore(envId, d.download.manifestUrl, d.download.blobUrl, env.l1SnapshotId)
        }
        throw new Error('该基线为文件级快照（L2），builtin 承载需先在内核设备重新保存基线以生成结构化副本')
      }
      const t0 = Date.now()
      const tarBytes = openFiles(this.dek!, { manifest, blob })
      const dir = path.join(path.join(os.tmpdir(), 'ob-restore'), `${envId}-${randomBytes(4).toString('hex')}`)
      await untarTo(Buffer.from(tarBytes), dir, manifest.payload.format)
      console.log(
        `[restore] L2 解包 ${dir}（${manifest.payload.format} ${(blob.length / 1024).toFixed(0)}KB，解密+解包 ${((Date.now() - t0) / 1000).toFixed(1)}s）`
      )
      return { kind: 'files', dir, kernelVersion: manifest.kernel.version }
    }

    const sealed: SealedSnapshot = {
      manifest,
      blobB64: Buffer.from(blob).toString('base64')
    }
    return { kind: 'structured', payload: await openStructured(this.dek!, sealed) }
  }

  /** 抓取运行中环境 → 加密 → 上传 → commit，返回 snapshotId。
   *  kernel 承载走 L2 文件级（整 profile tar.gz，含 IndexedDB/SW/密码库）；
   *  builtin 保持 L1 结构化（cookie + localStorage）。 */
  async uploadSnapshot(envId: string): Promise<string> {
    if (!this.logged_in) throw new Error('未登录')
    const env = this.envs.get(envId)
    if (!env) throw new Error('环境不存在')
    const basedOn = this.baseMetas.get(envId)?.snapshotId || null
    const up = await this.cloud.createUpload(envId, this.store.deviceId)

    if (env.hosting === 'kernel') {
      // 双写：L1 结构化快照先 commit（临时成为基线），L2 后 commit（最终基线）。
      // builtin 设备打开 L2 基线时经 env.l1SnapshotId 回退到 L1（双承载互迁移不回退）。
      // commit 顺序天然保证最终 latest_base_id=L2，服务端零改动。
      let l1SnapshotId: string | undefined
      try {
        const data = await this.kernelHost.capture(envId)
        const up1 = await this.cloud.createUpload(envId, this.store.deviceId)
        const sealed1 = await seal({
          dek: this.dek!,
          kdf: this.kdf,
          envId,
          snapshotId: up1.snapshotId,
          basedOn,
          deviceId: this.store.deviceId,
          payload: { ...data, env: { homepage: env.homepage } }
        })
        const blob1 = blobBytes(sealed1)
        await Promise.all([
          this.cloud.putObject(up1.upload.manifestUrl, manifestJson(sealed1.manifest)),
          this.cloud.putObject(up1.upload.blobUrl, blob1)
        ])
        await this.cloud.commitSnapshot(envId, up1.snapshotId, sha256Hex(blob1), blob1.length)
        l1SnapshotId = up1.snapshotId
      } catch (e) {
        console.warn('[upload] L1 兜底快照失败（继续 L2）:', e instanceof Error ? e.message : e)
      }

      const packed = await this.kernelHost.captureProfile(envId)
      const sealed = await sealFiles({
        dek: this.dek!,
        kdf: this.kdf,
        envId,
        snapshotId: up.snapshotId,
        basedOn,
        deviceId: this.store.deviceId,
        tarBytes: packed.bytes,
        format: packed.format,
        kernel: { version: this.kernelTag(), seed: env.seed }
      })
      const blob = new Uint8Array(sealed.blob)
      await Promise.all([
        this.cloud.putObject(up.upload.manifestUrl, manifestJson(sealed.manifest)),
        this.cloud.putObject(up.upload.blobUrl, blob)
      ])
      await this.cloud.commitSnapshot(envId, up.snapshotId, sha256Hex(blob), blob.length)
      console.log(
        `[upload] L2 ${packed.format} ${(blob.length / 1024).toFixed(0)}KB（快照 ${up.snapshotId.slice(0, 8)}…）`
      )

      if (l1SnapshotId && env.l1SnapshotId !== l1SnapshotId) {
        await this.rememberL1Snapshot(env, l1SnapshotId)
      }
      return up.snapshotId
    }

    const host = this.hostFor(env)
    const data = await host.capture(envId)
    const sealed = await seal({
      dek: this.dek!,
      kdf: this.kdf,
      envId,
      snapshotId: up.snapshotId,
      basedOn,
      deviceId: this.store.deviceId,
      payload: { ...data, env: { homepage: env.homepage } }
    })
    const blob = blobBytes(sealed)
    await Promise.all([
      this.cloud.putObject(up.upload.manifestUrl, manifestJson(sealed.manifest)),
      this.cloud.putObject(up.upload.blobUrl, blob)
    ])
    await this.cloud.commitSnapshot(envId, up.snapshotId, sha256Hex(blob), blob.length)
    return up.snapshotId
  }
}

/** 恢复计划：L1 结构化载荷 / L2 已解包 profile 目录 */
type RestorePlan =
  | { kind: 'structured'; payload: SnapshotPayload }
  | { kind: 'files'; dir: string; kernelVersion: string }

function err(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}`
  return e instanceof Error ? e.message : String(e)
}
