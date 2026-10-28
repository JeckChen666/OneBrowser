// 云端客户端：REST + WebSocket（信令）。纯传输层，不含业务状态。
import WebSocket from 'ws'
import type { CloudEnvRow, EnvMode, TeamInfo, TeamMember } from '@shared/types'

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
  holderEmail?: string
  deadlineMs?: number
  teamId?: string
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
    identityPub?: string
    wrappedIdentityPriv?: string
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
    identityPub: string
    wrappedIdentityPriv: string
  }> {
    return this.req('POST', '/v1/auth/login', body)
  }

  logout(): Promise<{ ok: boolean }> {
    return this.req('POST', '/v1/auth/logout', {})
  }

  /** 身份密钥对回填（旧账号一次性写入；服务端只允许空态覆盖） */
  setIdentity(body: { identityPub: string; wrappedIdentityPriv: string }): Promise<{ ok: boolean }> {
    return this.req('POST', '/v1/auth/identity', body)
  }

  // --- teams（V0.6）---
  listTeams(): Promise<{ teams: TeamInfo[] }> {
    return this.req('GET', '/v1/teams')
  }

  createTeam(body: { name: string; wrappedSelfDek: string }): Promise<{ teamId: string }> {
    return this.req('POST', '/v1/teams', body)
  }

  lookupUser(email: string): Promise<{ userId: string; identityPub: string }> {
    return this.req('GET', `/v1/users?email=${encodeURIComponent(email)}`)
  }

  addTeamMember(teamId: string, body: { userId: string; wrappedTeamDek: string; role?: string }): Promise<{ ok: boolean }> {
    return this.req('POST', `/v1/teams/${teamId}/members`, body)
  }

  listTeamMembers(teamId: string): Promise<{ members: TeamMember[] }> {
    return this.req('GET', `/v1/teams/${teamId}/members`)
  }

  revokeTeamMember(teamId: string, userId: string): Promise<{ ok: boolean }> {
    return this.req('POST', `/v1/teams/${teamId}/members/${userId}/revoke`, {})
  }

  rotateTeamDek(teamId: string, items: Array<{ userId: string; wrappedTeamDek: string }>): Promise<{ ok: boolean }> {
    return this.req('PUT', `/v1/teams/${teamId}/dek`, { items })
  }

  acceptInvite(teamId: string): Promise<{ ok: boolean }> {
    return this.req('POST', `/v1/invites/${teamId}/accept`, {})
  }

  declineInvite(teamId: string): Promise<{ ok: boolean }> {
    return this.req('POST', `/v1/invites/${teamId}/decline`, {})
  }

  // --- envs ---
  listEnvs(): Promise<{ envs: CloudEnvRow[] }> {
    return this.req('GET', '/v1/envs')
  }

  createEnv(body: { id: string; name: string; mode: EnvMode; configEnc: string; teamId?: string }): Promise<CloudEnvRow> {
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

  /** 上传到预签名 URL。瞬时故障（5xx/429/网络层异常）按指数退避重试至多 3 次；
   * 4xx 是确定性失败（签名/权限错误），重试无意义直接抛出。
   * 预签名 PUT 幂等（同内容覆写），重发安全。 */
  async putObject(url: string, bytes: Uint8Array): Promise<void> {
    const body = Buffer.from(bytes)
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)))
      let retryable = true
      try {
        const resp = await fetch(url, { method: 'PUT', body, signal: AbortSignal.timeout(60_000) })
        if (resp.ok) return
        lastErr = new Error(`S3 PUT 失败: HTTP ${resp.status}`)
        if (resp.status < 500 && resp.status !== 429) {
          retryable = false
          throw lastErr
        }
      } catch (e) {
        lastErr = e
        if (!retryable) throw e // 4xx：立即失败
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`S3 PUT 失败: ${String(lastErr)}`)
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
