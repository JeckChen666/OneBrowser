// 外挂指纹内核承载（kernel 模式）：spawn fingerprint-chromium + CDP 数据面。
// 快照格式与 builtin 完全一致（结构化 JSON）→ 云端基线双承载互迁移。
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { randomId } from './e2e'
import type { KernelLauncher } from './kernelLauncher'
import type { EnvConfig } from '@shared/types'
import type { Host, KernelRunningEnv, OpenOptions, RunningEnv } from './host'
import { attachPage, CdpConnection, closeTab, newTab } from './cdp'
import type { StructuredData } from './dataPlane'

/** Electron Cookie 形状（快照内） ↔ CDP cookie 映射（docker 冒烟亦复用） */
type SnapCookie = StructuredData['cookies'][number]

export function snapCookieToCdp(c: SnapCookie): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: c.name,
    value: c.value,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly
  }
  if (c.domain) out.domain = c.domain
  if (c.sameSite === 'no_restriction') out.sameSite = 'None'
  else if (c.sameSite === 'lax') out.sameSite = 'Lax'
  else if (c.sameSite === 'strict') out.sameSite = 'Strict'
  if (c.expirationDate) out.expires = c.expirationDate
  return out
}

function cdpCookieToSnap(c: any): SnapCookie {
  const sameSite =
    c.sameSite === 'None' ? 'no_restriction' : c.sameSite === 'Lax' ? 'lax' : c.sameSite === 'Strict' ? 'strict' : 'unspecified'
  const cookie: SnapCookie = {
    name: c.name,
    value: c.value,
    domain: c.domain || '',
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite
  }
  if (typeof c.expires === 'number' && c.expires > 0) cookie.expirationDate = c.expires
  return cookie
}

export class ExternalKernelHost implements Host {
  private running = new Map<string, KernelRunningEnv>()
  onClosed: ((envId: string) => void) | null = null

  constructor(
    private launcher: KernelLauncher
  ) {}

  isRunning(envId: string): boolean {
    return this.running.has(envId)
  }

  runningEntries(): IterableIterator<[string, KernelRunningEnv]> {
    return this.running.entries()
  }

  get(envId: string): KernelRunningEnv | undefined {
    return this.running.get(envId)
  }

  async open(env: EnvConfig, opts: OpenOptions = {}): Promise<RunningEnv> {
    if (this.running.has(env.id)) throw new Error('环境已在运行中')
    const runToken = randomId()
    const userDataDir = path.join(app.getPath('userData'), 'kernel-profiles', `${env.id}-${runToken}`)
    fs.mkdirSync(userDataDir, { recursive: true })

    const args: string[] = [
      `--user-data-dir=${userDataDir}`,
      `--fingerprint=${env.seed}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      'about:blank'
    ]
    const fp = opts.fingerprint
    if (fp?.platform) args.push(`--fingerprint-platform=${fp.platform}`)
    if (fp?.timezone) args.push(`--timezone=${fp.timezone}`)
    if (fp?.lang) {
      args.push(`--lang=${fp.lang}`)
      args.push(`--accept-lang=${fp.lang}`)
    }
    if (env.proxy?.host) {
      args.push(`--proxy-server=${env.proxy.scheme}://${env.proxy.host}:${env.proxy.port}`)
    }

    let re: KernelRunningEnv | null = null
    const launch = await this.launcher.launch(args, () => {
      if (!re || this.running.get(env.id) === re) {
        if (re) this.running.delete(env.id)
        try {
          re?.page.close()
        } catch {
          /* ignore */
        }
        this.onClosed?.(env.id)
      }
    })
    try {
      const { conn } = await attachPage(launch.port)
      await conn.send('Page.enable')
      await conn.send('Network.enable')

      re = { kind: 'kernel', envId: env.id, runToken, launch, port: launch.port, page: conn, origins: new Set(opts.restore?.origins || []) }
      const cur = re

      // origin 跟踪（导航事件）
      conn.on('Page.frameNavigated', (params: any) => {
        const url: string = params?.frame?.url || ''
        if (!/^https?:/.test(url)) return
        try {
          cur.origins.add(new URL(url).origin)
        } catch {
          /* ignore */
        }
      })

      this.running.set(env.id, re)

      // 注入登录态（cookie 直写；localStorage 用临时标签页逐 origin 注入）
      if (opts.restore) {
        await this.restoreData(re, opts.restore, launch.port)
      }

      if (env.homepage && /^https?:/.test(env.homepage)) {
        await conn.send('Page.navigate', { url: env.homepage })
      }
      return re
    } catch (e) {
      await launch.stop().catch(() => undefined)
      throw e
    }
  }

  /** 数据注入：cookie + localStorage（临时 tab 执行，不打扰用户 tab） */
  private async restoreData(re: KernelRunningEnv, data: StructuredData, port: number): Promise<void> {
    if (data.cookies?.length) {
      const payload = data.cookies.map(snapCookieToCdp)
      try {
        await re.page.send('Storage.setCookies', { cookies: payload })
        const got = await re.page.send('Storage.getCookies', {})
        console.log(
          `[kernel] cookie 注入 ${payload.length} 条 → 读回 ${got.cookies?.length || 0} 条：`,
          (got.cookies || []).map((c: { name: string; domain: string; path: string }) => `${c.name}@${c.domain}${c.path}`).join(' ')
        )
      } catch (e) {
        console.warn(`[kernel] Storage.setCookies 失败:`, e instanceof Error ? e.message : e)
      }
    }
    for (const [origin, kv] of Object.entries(data.localStorage || {})) {
      const entries = Object.entries(kv || {})
      if (!entries.length) continue
      const tab = await newTab(port, origin + '/')
      try {
        const conn = new CdpConnection(tab.webSocketDebuggerUrl!)
        await conn.ready()
        const script =
          '(() => {' + entries.map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('') + '})()'
        await conn.send('Runtime.evaluate', { expression: script, awaitPromise: false })
        conn.close()
      } finally {
        await closeTab(port, tab.id)
      }
    }
  }

  /** 抓取：cookie（Storage.getCookies）+ 逐 origin localStorage（临时 tab） */
  async capture(envId: string): Promise<StructuredData> {
    const re = this.running.get(envId)
    if (!re) throw new Error('环境未运行，无法抓取')
    const { cookies } = await re.page.send('Storage.getCookies', {})
    const origins = [...re.origins]
    const localStorageOut: Record<string, Record<string, string>> = {}
    for (const origin of origins) {
      const tab = await newTab(re.port, origin + '/')
      try {
        const conn = new CdpConnection(tab.webSocketDebuggerUrl!)
        await conn.ready()
        const res = await conn.send('Runtime.evaluate', {
          expression: 'JSON.stringify(Object.fromEntries(Object.entries(window.localStorage)))',
          returnByValue: true
        })
        localStorageOut[origin] = JSON.parse(String(res.result?.value || '{}'))
        conn.close()
      } catch (e) {
        console.warn(`[kernel] localStorage 抓取失败 ${origin}:`, e instanceof Error ? e.message : e)
      } finally {
        await closeTab(re.port, tab.id)
      }
    }
    return { cookies: (cookies || []).map(cdpCookieToSnap), localStorage: localStorageOut, origins }
  }

  /** 优雅关闭（launcher.stop：Browser.close → 兜底强杀/删容器） */
  closeWindow(envId: string): void {
    const re = this.running.get(envId)
    if (!re) return
    re.launch.stop().catch(() => undefined)
  }

  closeAll(): void {
    for (const envId of this.running.keys()) this.closeWindow(envId)
  }
}
