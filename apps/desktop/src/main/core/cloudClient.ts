// 云端客户端：REST + WebSocket（信令）。纯传输层，不含业务状态。
import WebSocket from 'ws'
import type { CloudEnvRow, EnvMode } from '@shared/types'

export interface WsInMsg {
  type: 'lease.acquire' | 'lease.release' | 'lease.heartbeat' | 'lease.cancel'
  envId: string
  snapshotId?: string
}

export interface WsOutMsg {
  type: string
  envId?: string
  snapshotId?: string
  stale?: boolean
  holderDeviceId?: string
  deadlineMs?: number
  code?: string
  message?: string
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message)
  }
}

interface AuthKdfResp {
  authKdf: { alg: 'argon2id'; m: number; t: number; p: number; salt: string }
}

export class CloudClient {
  token: string | null = null
  private ws: WebSocket | null = null
  private wsTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUs = false
  onWsMessage: ((m: WsOutMsg) => void) | null = null
  onWsStatus: ((ok: boolean) => void) | null = null

  constructor(public serverUrl: string) {}

  private wsUrl(): string {
    return this.serverUrl.replace(/^http/, 'ws') + '/v1/ws?token=' + encodeURIComponent(this.token || '')
  }

  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    const resp = await fetch(this.serverUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await resp.text()
    const data = text ? JSON.parse(text) : {}
    if (!resp.ok) {
      const err = (data as { error?: { code?: string; message?: string } }).error
      throw new ApiError(resp.status, err?.code || 'http_error', err?.message || `HTTP ${resp.status}`)
    }
    return data as T
  }

  // --- auth ---
  kdfInfo(email: string): Promise<AuthKdfResp> {
    return this.req('GET', `/v1/auth/kdf-info?email=${encodeURIComponent(email)}`)
  }

  register(body: {
    email: string
    authKey: string
    authKdf: AuthKdfResp['authKdf']
    wrappedDek: string
    kekKdf: AuthKdfResp['authKdf']
  }): Promise<{ userId: string }> {
    return this.req('POST', '/v1/auth/register', body)
  }

  login(body: {
    email: string
    authKey: string
    deviceId: string
    deviceName: string
    platform: string
  }): Promise<{
    token: string
    expiresAt: string
    deviceId: string
    userId: string
    email: string
    wrappedDek: string
    kekKdf: AuthKdfResp['authKdf']
  }> {
    return this.req('POST', '/v1/auth/login', body)
  }

  logout(): Promise<{ ok: boolean }> {
    return this.req('POST', '/v1/auth/logout', {})
  }

  // --- envs ---
  listEnvs(): Promise<{ envs: CloudEnvRow[] }> {
    return this.req('GET', '/v1/envs')
  }

  createEnv(body: { id: string; name: string; mode: EnvMode; configEnc: string }): Promise<CloudEnvRow> {
    return this.req('POST', '/v1/envs', body)
  }

  updateEnv(id: string, body: { name?: string; configEnc?: string }): Promise<{ ok: boolean }> {
    return this.req('PATCH', `/v1/envs/${id}`, body)
  }

  deleteEnv(id: string): Promise<{ ok: boolean }> {
    return this.req('DELETE', `/v1/envs/${id}`)
  }

  // --- snapshots ---
  createUpload(envId: string, deviceId: string): Promise<{
    snapshotId: string
    upload: { manifestUrl: string; blobUrl: string }
  }> {
    return this.req('POST', `/v1/envs/${envId}/snapshots`, { deviceId })
  }

  async putObject(url: string, bytes: Uint8Array): Promise<void> {
    const resp = await fetch(url, { method: 'PUT', body: Buffer.from(bytes) })
    if (!resp.ok) throw new Error(`S3 PUT 失败: HTTP ${resp.status}`)
  }

  async getObject(url: string): Promise<Uint8Array> {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`S3 GET 失败: HTTP ${resp.status}`)
    return new Uint8Array(await resp.arrayBuffer())
  }

  commitSnapshot(envId: string, snapId: string, sha256: string, sizeBytes: number): Promise<{ ok: boolean }> {
    return this.req('POST', `/v1/envs/${envId}/snapshots/${snapId}/commit`, { sha256, sizeBytes })
  }

  getBase(envId: string): Promise<{
    hasBase: boolean
    snapshot?: { snapshotId: string; createdAt: string; sizeBytes: number; sha256: string; deviceId: string }
    download?: { manifestUrl: string; blobUrl: string }
  }> {
    return this.req('GET', `/v1/envs/${envId}/base`)
  }

  getDownload(envId: string, snapId: string): Promise<{
    snapshot: { snapshotId: string; createdAt: string; sizeBytes: number; sha256: string; deviceId: string }
    download: { manifestUrl: string; blobUrl: string }
  }> {
    return this.req('GET', `/v1/envs/${envId}/snapshots/${snapId}/download`)
  }

  // --- WebSocket ---
  connectWS(): void {
    if (!this.token) return
    this.closedByUs = false
    const ws = new WebSocket(this.wsUrl())
    this.ws = ws
    ws.on('open', () => this.onWsStatus?.(true))
    ws.on('message', (raw) => {
      try {
        this.onWsMessage?.(JSON.parse(raw.toString()) as WsOutMsg)
      } catch (e) {
        console.warn('[ws] 解析消息失败', e)
      }
    })
    ws.on('close', () => {
      this.onWsStatus?.(false)
      if (!this.closedByUs) {
        this.wsTimer = setTimeout(() => this.connectWS(), 2000) // 断线重连
      }
    })
    ws.on('error', () => {}) // close 会跟随触发
  }

  get wsConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  sendWS(msg: WsInMsg): void {
    if (this.ws?.readyState !== WebSocket.OPEN) throw new Error('WebSocket 未连接')
    this.ws.send(JSON.stringify(msg))
  }

  disconnect(): void {
    this.closedByUs = true
    if (this.wsTimer) clearTimeout(this.wsTimer)
    this.ws?.close()
    this.ws = null
  }
}
