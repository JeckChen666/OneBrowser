// 应用服务：编排全部核心模块（auth/envs/快照/租约/窗口），并对渲染进程提供 IPC 面。
import os from 'node:os'
import { CloudClient, ApiError } from './cloudClient'
import { LeaseAgent } from './leaseAgent'
import { BrowserHost } from './browserHost'
import { LocalStore } from './localStore'
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
  type KdfParamsJson
} from './e2e'
import { seal, open, sealConfig, openConfig, manifestJson, blobBytes, type SealedSnapshot, type SnapshotPayload } from './snapshotEngine'
import type {
  AppState,
  CreateEnvInput,
  EnvConfig,
  EnvPhase,
  EnvView,
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
  readonly host = new BrowserHost()
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
        this.notify('warning', '环境租约已丢失，窗口已关闭')
      },
      onEnvUpdated: () => this.refreshEnvs().catch(() => {}),
      onReleased: () => {}
    })
    this.host.onClosed = (envId) => {
      if ((this.phases.get(envId)?.phase || 'idle') !== 'evicting') {
        this.setPhase(envId, 'idle')
        this.refreshEnvs().catch(() => {})
      }
    }
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
        phase: this.host.isRunning(env.id) && p.phase === 'idle' ? 'running' : p.phase,
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
    for (const row of envs) {
      let cfg: { homepage?: string; seed?: string; proxy?: ProxyConfig } = {}
      try {
        cfg = await openConfig<{ homepage?: string; seed?: string; proxy?: ProxyConfig }>(
          this.dek!,
          row.id,
          row.configEnc
        )
      } catch {
        // 配置解密失败（如密钥轮换后旧数据）——降级为默认配置
      }
      next.set(row.id, {
        id: row.id,
        name: row.name,
        mode: row.mode,
        homepage: cfg.homepage || '',
        seed: cfg.seed || randomId(),
        proxy: cfg.proxy,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      })
      if (row.base) this.baseMetas.set(row.id, { snapshotId: row.base.snapshotId, createdAt: row.base.createdAt })
      else this.baseMetas.delete(row.id)
      if (row.lease) this.leaseInfo.set(row.id, row.lease.holderDeviceId)
      else this.leaseInfo.delete(row.id)
    }
    this.envs = next
    this.push()
  }

  async createEnv(input: CreateEnvInput): Promise<void> {
    if (!this.logged_in) throw new Error('未登录')
    const id = randomId()
    const configEnc = await sealConfig(this.dek!, id, {
      homepage: input.homepage,
      seed: randomId(),
      proxy: input.proxy
    })
    await this.cloud.createEnv({ id, name: input.name, mode: input.mode, configEnc })
    await this.refreshEnvs()
    this.notify('success', `环境「${input.name}」已创建`)
  }

  async updateEnv(id: string, patch: { name?: string; homepage?: string; proxy?: ProxyConfig }): Promise<void> {
    const cur = this.envs.get(id)
    if (!cur) throw new Error('环境不存在')
    const configEnc = await sealConfig(this.dek!, id, {
      homepage: patch.homepage !== undefined ? patch.homepage : cur.homepage,
      seed: cur.seed,
      proxy: patch.proxy !== undefined ? patch.proxy : cur.proxy
    })
    await this.cloud.updateEnv(id, {
      name: patch.name !== undefined ? patch.name : cur.name,
      configEnc
    })
    await this.refreshEnvs()
  }

  async deleteEnv(id: string): Promise<void> {
    if (this.host.isRunning(id)) throw new Error('环境运行中，请先关闭')
    await this.cloud.deleteEnv(id)
    this.envs.delete(id)
    this.phases.delete(id)
    await this.refreshEnvs()
  }

  // ---------- 打开 / 关闭 ----------

  async openEnv(envId: string, hidden = false): Promise<void> {
    const env = this.envs.get(envId)
    if (!env) throw new Error('环境不存在')
    if (this.host.isRunning(envId)) throw new Error('环境已打开')

    if (env.mode === 'snapshot') {
      this.setPhase(envId, 'opening')
      const restore = await this.downloadBase(envId)
      await this.host.open(env, { restore, hidden })
      this.setPhase(
        envId,
        'running',
        restore ? '已从云端基线克隆' : '首次打开：请登录后点击「保存为基线」'
      )
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
    const restore = outcome.snapshotId
      ? await this.downloadSnapshot(envId, outcome.snapshotId)
      : await this.downloadBase(envId)
    await this.host.open(env, { restore, hidden })
    this.agent.startHeartbeat(envId)
    this.setPhase(envId, 'running', outcome.stale ? '已接管（旧基线：对方设备未及时上传）' : '已接管')
    this.notify('success', `已打开互斥环境「${env.name}」`)
  }

  async closeEnv(envId: string): Promise<void> {
    const env = this.envs.get(envId)
    if (!env || !this.host.isRunning(envId)) return
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
    this.host.closeWindow(envId) // onClosed → idle + refresh
  }

  /** 保存为基线（模式一主入口；模式二也可手动触发） */
  async saveBase(envId: string): Promise<void> {
    if (!this.host.isRunning(envId)) throw new Error('环境未运行')
    this.setPhase(envId, 'saving', '抓取并上传基线快照…')
    const snapId = await this.uploadSnapshot(envId)
    this.setPhase(envId, 'running', `基线已更新（${snapId.slice(0, 8)}…）`)
    this.notify('success', '基线快照已保存到云端')
    await this.refreshEnvs()
  }

  /** 被驱逐：抓取→上传→释放→关窗（服务端 lease.evict 指令） */
  private async handleEvicted(envId: string): Promise<void> {
    if (!this.host.isRunning(envId)) {
      this.agent.stopHeartbeat(envId)
      this.agent.release(envId)
      return
    }
    const env = this.envs.get(envId)
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
    this.host.closeWindow(envId)
    this.notify('warning', `环境「${env?.name || envId}」已被其他设备接管，最新状态已保存上云`)
    this.refreshEnvs().catch(() => {})
  }

  // ---------- 快照管道 ----------

  private async downloadBase(envId: string): Promise<SnapshotPayload | null> {
    if (!this.logged_in) return null
    const base = await this.cloud.getBase(envId)
    if (!base.hasBase || !base.download || !base.snapshot) return null
    return this.fetchAndOpen(envId, base.download.manifestUrl, base.download.blobUrl, base.snapshot.snapshotId)
  }

  private async downloadSnapshot(envId: string, snapId: string): Promise<SnapshotPayload | null> {
    const d = await this.cloud.getDownload(envId, snapId)
    return this.fetchAndOpen(envId, d.download.manifestUrl, d.download.blobUrl, snapId)
  }

  private async fetchAndOpen(
    envId: string,
    manifestUrl: string,
    blobUrl: string,
    expectSnapId: string
  ): Promise<SnapshotPayload> {
    const [manifestBytes, blobB64bytes] = await Promise.all([
      this.cloud.getObject(manifestUrl),
      this.cloud.getObject(blobUrl)
    ])
    const sealed: SealedSnapshot = {
      manifest: JSON.parse(new TextDecoder().decode(manifestBytes)),
      blobB64: Buffer.from(blobB64bytes).toString('base64')
    }
    if (sealed.manifest.snapshotId !== expectSnapId) throw new Error('快照 ID 不匹配')
    return open(this.dek!, sealed)
  }

  /** 抓取运行中环境 → 加密 → 上传 → commit，返回 snapshotId */
  async uploadSnapshot(envId: string): Promise<string> {
    if (!this.logged_in) throw new Error('未登录')
    const data = await this.host.capture(envId)
    const env = this.envs.get(envId)
    if (!env) throw new Error('环境不存在')
    const basedOn = this.baseMetas.get(envId)?.snapshotId || null
    const up = await this.cloud.createUpload(envId, this.store.deviceId)
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

function err(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}`
  return e instanceof Error ? e.message : String(e)
}
