// 极简 CDP 客户端：页面级 WebSocket 连接（send/await + 事件订阅）。
import WebSocket from 'ws'

export interface CdpEvent {
  method: string
  params: unknown
}

export class CdpConnection {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private listeners = new Map<string, Set<(params: unknown) => void>>()
  private closed = false

  constructor(
    private url: string,
    onDisconnect?: () => void
  ) {
    this.ws = new WebSocket(url, { perMessageDeflate: false })
    this.ws.on('message', (raw) => this.handle(raw.toString()))
    this.ws.on('close', () => {
      this.closed = true
      for (const p of this.pending.values()) p.reject(new Error('CDP 连接已关闭'))
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
        if (msg.error) p.reject(new Error(`${msg.error.message || 'CDP 调用失败'}`))
        else p.resolve(msg.result)
      }
      return
    }
    const set = this.listeners.get(msg.method)
    if (set) for (const fn of set) fn(msg.params)
  }

  async send<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    await this.ready()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params: params || {} }), (err) => {
        if (err) {
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

  close(): void {
    this.closed = true
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
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
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (resp.ok) return
    } catch {
      /* 重试 */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`等待内核 CDP 端点超时（port=${port}）`)
}

export async function listTargets(port: number): Promise<CdpTarget[]> {
  const resp = await fetch(`http://127.0.0.1:${port}/json`)
  return (await resp.json()) as CdpTarget[]
}

/** 新建标签页（新版 Chromium 要求 PUT） */
export async function newTab(port: number, url: string): Promise<CdpTarget> {
  const resp = await fetch(`http://127.0.0.1:${port}/json/new?${new URLSearchParams({ url })}`, {
    method: 'PUT'
  })
  return (await resp.json()) as CdpTarget
}

export async function closeTab(port: number, targetId: string): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`).catch(() => undefined)
}

/** 取（或创建）第一个 page 类型标签页的 CDP 连接 */
export async function attachPage(port: number, createUrl = 'about:blank'): Promise<{ conn: CdpConnection; targetId: string }> {
  let targets = (await listTargets(port)).filter((t) => t.type === 'page')
  let target = targets[0]
  if (!target) {
    target = await newTab(port, createUrl)
  }
  if (!target.webSocketDebuggerUrl) throw new Error('目标无 WebSocket 调试地址')
  const conn = new CdpConnection(target.webSocketDebuggerUrl)
  await conn.ready()
  return { conn, targetId: target.id }
}

/** 优雅关闭整个浏览器进程 */
export async function browserClose(port: number): Promise<void> {
  const resp = await fetch(`http://127.0.0.1:${port}/json/version`)
  const info = (await resp.json()) as { webSocketDebuggerUrl?: string }
  if (!info.webSocketDebuggerUrl) throw new Error('无法获取浏览器级 CDP 地址')
  const conn = new CdpConnection(info.webSocketDebuggerUrl)
  await conn.ready()
  await conn.send('Browser.close').catch(() => undefined)
  conn.close()
}
