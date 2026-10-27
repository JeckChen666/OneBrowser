// 极简 CDP 客户端。
// 关键经验（V0.2.0-S3 排障）：页面级 WebSocket 在导航引发渲染进程切换后会失效
// （canvas/WebGL 类 evaluate 永久无响应）；因此产品路径一律使用
// browser-level 连接 + Target.attachToTarget(flatten) 的 PageSession。
import WebSocket from 'ws'

export interface CdpEvent {
  method: string
  params: unknown
}

/** 可发送命令的最小接口（CdpConnection / PageSession 通用，测试与宿主共用） */
export interface CanSend {
  send<T = any>(method: string, params?: Record<string, unknown>): Promise<T>
}

export class CdpConnection {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private listeners = new Map<string, Set<(params: unknown) => void>>()
  /* 内部：PageSession 事件路由 */
  sessionListeners = new Map<string, Set<(params: unknown) => void>>()
  private closed = false

  constructor(
    private url: string,
    onDisconnect?: () => void,
    private cmdTimeoutMs = 20000
  ) {
    this.ws = new WebSocket(url, { perMessageDeflate: false })
    this.ws.on('message', (raw) => this.handle(raw.toString()))
    this.ws.on('close', () => {
      this.closed = true
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('CDP 连接已关闭'))
      }
      this.pending.clear()
      onDisconnect?.()
    })
    this.ws.on('error', () => {})
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN && !this.closed
  }

  async ready(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return
    if (this.closed) throw new Error('CDP 连接已关闭')
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve())
      this.ws.once('error', (e) => reject(e))
    })
  }

  private handle(raw: string): void {
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(`${msg.error.message || 'CDP 调用失败'}`))
        else p.resolve(msg.result)
      }
      return
    }
    if (msg.sessionId) {
      const set = this.sessionListeners.get(`${msg.sessionId}:${msg.method}`)
      if (set) for (const fn of set) fn(msg.params)
      return
    }
    const set = this.listeners.get(msg.method)
    if (set) for (const fn of set) fn(msg.params)
  }

  async send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    await this.ready()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 命令超时（${method}，${this.cmdTimeoutMs}ms）——页面可能已无响应`))
      }, this.cmdTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params: params || {}, ...(sessionId ? { sessionId } : {}) }), (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  on(method: string, handler: (params: unknown) => void): void {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set())
    this.listeners.get(method)!.add(handler)
  }

  /** browser 级事件（如 Target.targetDestroyed） */
  close(): void {
    this.closed = true
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

/** flatten 模式的页面会话：send 自动带 sessionId；事件按 sessionId 路由 */
export class PageSession implements CanSend {
  constructor(
    private conn: CdpConnection,
    public sessionId: string
  ) {}

  send<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.conn.send<T>(method, params, this.sessionId)
  }

  on(method: string, handler: (params: unknown) => void): void {
    const key = `${this.sessionId}:${method}`
    if (!this.conn.sessionListeners.has(key)) this.conn.sessionListeners.set(key, new Set())
    this.conn.sessionListeners.get(key)!.add(handler)
  }
}

// --- HTTP 端点辅助 ---

export interface CdpTarget {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

export async function waitEndpoint(port: number, timeoutMs = 20000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })
      if (resp.ok) return
    } catch {
      /* 重试 */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`等待内核 CDP 端点超时（port=${port}）`)
}

async function browserWsUrl(port: number): Promise<string> {
  const resp = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })
  const info = (await resp.json()) as { webSocketDebuggerUrl?: string }
  if (!info.webSocketDebuggerUrl) throw new Error('无法获取浏览器级 CDP 地址')
  return info.webSocketDebuggerUrl
}

export async function listTargets(port: number): Promise<CdpTarget[]> {
  const resp = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })
  return (await resp.json()) as CdpTarget[]
}

/** 新建标签页（新版 Chromium 要求 PUT） */
export async function newTab(port: number, url: string): Promise<CdpTarget> {
  const resp = await fetch(`http://127.0.0.1:${port}/json/new?${new URLSearchParams({ url })}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(8000)
  })
  const tab = (await resp.json()) as CdpTarget
  // 等标签页真正到达目标 URL 再返回：立即 evaluate 会落在 about:blank 的
  // 空上下文上（LS 读写全丢，且无任何报错——V0.3.0 排障）
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const t = (await listTargets(port).catch(() => [] as CdpTarget[])).find((x) => x.id === tab.id)
    if (t && t.url === url) return t
    await new Promise((r) => setTimeout(r, 150))
  }
  return tab // 超时就原样返回，让调用方的 evaluate 自行暴露问题
}

export async function closeTab(port: number, targetId: string): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined)
}

/**
 * 连接 browser 级 CDP 并 attach 到第一个 page target（flatten 会话）。
 * 该会话跨渲染进程切换稳定（页面级 ws 在进程切换后会失效）。
 */
export async function attachPage(port: number, createUrl = 'about:blank'): Promise<{ conn: CdpConnection; session: PageSession; targetId: string }> {
  console.log(`[cdp] attachPage port=${port}（browser-level flatten）`)
  const conn = new CdpConnection(await browserWsUrl(port))
  await conn.ready()
  let target = (await listTargets(port)).find((t) => t.type === 'page')
  if (!target) {
    const created = await conn.send<{ targetId: string }>('Target.createTarget', { url: createUrl })
    target = { id: created.targetId, type: 'page', url: createUrl }
  }
  // 等待初始 tab 完成启动导航：过早 attach 的会话会在随后的渲染进程切换后失效
  if (!target.url || target.url === 'about:blank') {
    const start = Date.now()
    while (Date.now() - start < 12000) {
      await new Promise((r) => setTimeout(r, 500))
      const fresh = (await listTargets(port)).find((t) => t.id === target!.id) || (await listTargets(port)).find((t) => t.type === 'page')
      if (fresh && fresh.url && fresh.url !== 'about:blank' && fresh.url !== '') {
        target = fresh
        break
      }
    }
  }
  // 渲染器稳定等待：URL 就绪 ≠ 渲染器初始化完成（SwiftShader/GPU 初始化窗口期
  // 过早下发命令会导致 renderer 消息循环阻塞，一切 CDP 命令无响应——见 V0.2.0-S3 排障记录）
  await new Promise((r) => setTimeout(r, 4000))
  const att = await conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target.id, flatten: true })
  console.log(`[cdp] attached target=${target.id.slice(0, 8)} url=${target.url}`)
  return { conn, session: new PageSession(conn, att.sessionId), targetId: target.id }
}

/** 直连页面会话：页面级 ws 本身即会话（无 sessionId 路由）。
 *  Edge 156+ 已移除 browser-ws 上 flatten 会话的页面域命令路由（'Page.enable' wasn't found），
 *  标准浏览器承载必须走此路径；fingerprint 内核继续用 flatten（attachPage）。 */
export class DirectSession implements CanSend {
  constructor(private conn: CdpConnection) {}

  send<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.conn.send<T>(method, params)
  }

  on(method: string, handler: (params: unknown) => void): void {
    this.conn.on(method, handler)
  }
}

/** 页面级直连 attach（标准浏览器承载用）：与 attachPage 同返回形状。
 *  复用「等初始导航 + 渲染器稳定窗口」逻辑；后续 localStorage 等临时 tab 的
 *  页面级 ws 用法与本路径一致，已在 V0.2.0-S3 验证过。 */
export async function attachPageDirect(port: number): Promise<{ conn: CdpConnection; session: DirectSession; targetId: string }> {
  console.log(`[cdp] attachPageDirect port=${port}（page-level direct）`)
  let target = (await listTargets(port)).find((t) => t.type === 'page')
  if (!target || !target.url || target.url === 'about:blank' || target.url === '') {
    const start = Date.now()
    while (Date.now() - start < 12000) {
      await new Promise((r) => setTimeout(r, 500))
      const fresh = (await listTargets(port)).find((t) => t.id === target?.id) || (await listTargets(port)).find((t) => t.type === 'page')
      if (fresh && fresh.url && fresh.url !== 'about:blank' && fresh.url !== '') {
        target = fresh
        break
      }
    }
  }
  if (!target) throw new Error('标准浏览器未产生页面 target')
  await new Promise((r) => setTimeout(r, 4000))
  const conn = new CdpConnection(target.webSocketDebuggerUrl!)
  await conn.ready()
  await conn.send('Page.enable')
  console.log(`[cdp] direct-attached target=${target.id.slice(0, 8)} url=${target.url}`)
  return { conn, session: new DirectSession(conn), targetId: target.id }
}

/** 优雅关闭整个浏览器进程 */
export async function browserClose(port: number): Promise<void> {
  const conn = new CdpConnection(await browserWsUrl(port))
  await conn.ready()
  await conn.send('Browser.close').catch(() => undefined)
  conn.close()
}
