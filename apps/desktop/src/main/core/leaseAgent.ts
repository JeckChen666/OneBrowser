// 租约代理：模式二的客户端状态机（acquire / waitGranted / evict / heartbeat / release）。
import type { CloudClient, WsOutMsg } from './cloudClient'

export interface AcquireOutcome {
  granted: boolean
  snapshotId?: string
  stale?: boolean
  holderDeviceId?: string
  deadlineMs?: number
}

interface Waiter {
  resolve: (v: AcquireOutcome) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface LeaseHandlers {
  onEvict: (envId: string, deadlineMs: number) => void
  onLost: (envId: string) => void
  onEnvUpdated?: (envId: string) => void
  onReleased?: (envId: string) => void
}

export class LeaseAgent {
  private waiters = new Map<string, Waiter>() // envId → waiter（acquire/waitGranted 共用）
  private heartbeats = new Map<string, ReturnType<typeof setInterval>>()

  constructor(
    private cloud: CloudClient,
    private handlers: LeaseHandlers
  ) {
    cloud.onWsMessage = (m) => this.dispatch(m)
  }

  private dispatch(m: WsOutMsg): void {
    if (!m.envId) return
    switch (m.type) {
      case 'lease.granted': {
        const w = this.waiters.get(m.envId)
        this.waiters.delete(m.envId)
        // stale 为 omitempty 布尔，归一化为 true/false
        w?.resolve({ granted: true, snapshotId: m.snapshotId, stale: m.stale === true })
        break
      }
      case 'lease.pending': {
        const w = this.waiters.get(m.envId)
        if (w) {
          // pending 只是中间态：保留 waiter 等待后续 granted（同一 waiter 继续等）
          w.resolve({ granted: false, holderDeviceId: m.holderDeviceId, deadlineMs: m.deadlineMs })
        }
        break
      }
      case 'lease.evict':
        this.handlers.onEvict(m.envId, m.deadlineMs || 15000)
        break
      case 'lease.lost':
        this.stopHeartbeat(m.envId)
        this.handlers.onLost(m.envId)
        break
      case 'lease.released':
        this.handlers.onReleased?.(m.envId)
        break
      case 'env.updated':
        this.handlers.onEnvUpdated?.(m.envId)
        break
      case 'error': {
        const w = this.waiters.get(m.envId)
        this.waiters.delete(m.envId)
        w?.reject(new Error(`${m.code}: ${m.message}`))
        break
      }
    }
  }

  private waitOnce(envId: string, timeoutMs: number, once: boolean): Promise<AcquireOutcome> {
    return new Promise((resolve, reject) => {
      const prev = this.waiters.get(envId)
      if (prev) {
        clearTimeout(prev.timer)
        this.waiters.delete(envId)
      }
      const timer = setTimeout(() => {
        this.waiters.delete(envId)
        reject(new Error('等待服务端响应超时'))
      }, timeoutMs)
      const w: Waiter = {
        resolve: (v) => {
          if (once) {
            clearTimeout(timer)
            this.waiters.delete(envId)
            resolve(v)
          } else if (v.granted) {
            clearTimeout(timer)
            this.waiters.delete(envId)
            resolve(v)
          }
          // once=false 且 v.granted=false（pending）：保留 waiter，继续等 granted
        },
        reject,
        timer
      }
      this.waiters.set(envId, w)
    })
  }

  /** 请求租约：返回 granted（直接获得，含基线 snapshotId）或 pending（需等待驱逐） */
  async acquire(envId: string): Promise<AcquireOutcome> {
    const p = this.waitOnce(envId, 20000, true)
    this.cloud.sendWS({ type: 'lease.acquire', envId })
    return p
  }

  /** pending 之后等待最终 granted（服务端驱逐完成或超时兜底） */
  waitGranted(envId: string, timeoutMs: number): Promise<AcquireOutcome> {
    return this.waitOnce(envId, timeoutMs, false)
  }

  release(envId: string, snapshotId?: string): void {
    this.cloud.sendWS({ type: 'lease.release', envId, snapshotId })
  }

  cancel(envId: string): void {
    this.cloud.sendWS({ type: 'lease.cancel', envId })
  }

  startHeartbeat(envId: string, intervalMs = 15000): void {
    this.stopHeartbeat(envId)
    this.heartbeats.set(
      envId,
      setInterval(() => {
        try {
          this.cloud.sendWS({ type: 'lease.heartbeat', envId })
        } catch {
          this.stopHeartbeat(envId)
        }
      }, intervalMs)
    )
  }

  stopHeartbeat(envId: string): void {
    const t = this.heartbeats.get(envId)
    if (t) {
      clearInterval(t)
      this.heartbeats.delete(envId)
    }
  }

  stopAll(): void {
    for (const envId of this.heartbeats.keys()) this.stopHeartbeat(envId)
    for (const w of this.waiters.values()) clearTimeout(w.timer)
    this.waiters.clear()
  }
}
