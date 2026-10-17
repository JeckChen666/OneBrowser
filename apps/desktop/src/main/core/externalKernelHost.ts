// 外挂指纹内核承载（kernel 模式）：spawn fingerprint-chromium + CDP 数据面。
// 快照格式与 builtin 完全一致（结构化 JSON）→ 云端基线双承载互迁移。
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { randomId } from './e2e'
import type { KernelLauncher } from './kernelLauncher'
import type { EnvConfig } from '@shared/types'
import type { Host, KernelRunningEnv, OpenOptions, RunningEnv } from './host'
import { attachPage, CdpConnection, closeTab, newTab } from './cdp'  // CdpConnection 用于临时标签页（不跨进程切换，页面级 ws 安全）
import { tarDir } from './profileArchive'
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
    // 无空格、浅层路径：容器内内核对深层/含空格 user-data-dir 存在 CDP 挂死问题（S3 排障）
    // L2 恢复时直接复用已解包的 profile 目录（restoreDir）——数据已在其中，无需注入
    const userDataDir =
      opts.restoreDir || path.join(app.getPath('temp'), 'ob-kp', `${env.id}-${runToken}`)
    fs.mkdirSync(userDataDir, { recursive: true })

    // 初始页直接为目标站点：规避「attach 后 Page.navigate + 代理」组合导致的渲染器挂起
    // （进程切换 + 代理路径下 renderer 无响应；直接以 URL 启动等价于已验证的 new-tab 场景）
    const startUrl = env.homepage && /^https?:/.test(env.homepage) ? env.homepage : 'about:blank'
    const args: string[] = [
      `--user-data-dir=${userDataDir}`,
      `--fingerprint=${env.seed}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      startUrl
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
    console.log(`[kernel] 启动环境 ${env.id}（launcher=${this.launcher.constructor.name}）`)
    let connRef: import('./cdp').CdpConnection | null = null
    // 退出通知可能在 re 赋值前到达（docker wait 早退等时序），挂 pending 标志在 open 完成后补做清理
    let pendingExit = false
    const handleExit = (): void => {
      if (!re) {
        pendingExit = true
        return
      }
      if (this.running.get(env.id) === re) {
        this.running.delete(env.id)
        try {
          connRef?.close()
        } catch {
          /* ignore */
        }
        this.onClosed?.(env.id)
        // per-run profile 目录随环境关闭清理（快照上传均发生在关闭前，分支语义=关闭即弃）
        const dir = re.launch.profileDir
        if (dir) fs.rm(dir, { recursive: true, force: true }, () => undefined)
      }
    }
    const launch = await this.launcher.launch(args, handleExit)
    try {
      const { session, conn } = await attachPage(launch.port)
      connRef = conn
      await session.send('Page.enable')
      // 注意：不启用 Network 域——与指纹 platform flag 组合会毒化浏览器 Runtime（S3 排障）；
      // 数据面走 Storage API，无需 Network 域

      // 代理认证：--proxy-server 不带凭据，经 CDP Fetch 域响应 407 挑战
      if (env.proxy?.username) {
        await session.send('Fetch.enable', { handleAuthRequests: true }).catch(() => undefined)
        session.on('Fetch.authRequired', (p: any) => {
          session
            .send('Fetch.continueWithAuth', {
              requestId: p.requestId,
              authChallengeResponse: {
                response: 'ProvideCredentials',
                username: env.proxy!.username || '',
                password: env.proxy!.password || ''
              }
            })
            .catch(() => undefined)
        })
        session.on('Fetch.requestPaused', (p: any) => {
          session.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => undefined)
        })
      }

      re = { kind: 'kernel', envId: env.id, runToken, launch, port: launch.port, page: session, origins: new Set(opts.restore?.origins || []) }
      const cur = re

      // origin 跟踪（导航事件）
      session.on('Page.frameNavigated', (params: any) => {
        const url: string = params?.frame?.url || ''
        if (!/^https?:/.test(url)) return
        try {
          cur.origins.add(new URL(url).origin)
        } catch {
          /* ignore */
        }
      })

      this.running.set(env.id, re)
      if (pendingExit) handleExit() // launch 期间已收到退出通知

      // 结构化注入：L1 恢复（restore 单独使用）；L2 恢复时叠加（restoreDir + restore 并用）——
      // 会话 cookie 不落盘（快照 tar 里没有）、LevelDB 惰性刷盘也可能滞后，
      // 双写快照的 L1 副本恰好补齐这两类数据
      if (opts.restore) {
        await this.restoreData(re, opts.restore, launch.port)
      }

      return re
    } catch (e) {
      await launch.stop().catch(() => undefined)
      throw e
    }
  }

  /** 数据注入：cookie + localStorage（临时 tab 执行，不打扰用户 tab） */
  private async restoreData(re: KernelRunningEnv, data: StructuredData, port: number): Promise<void> {
    let lsCount = 0
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
      lsCount += entries.length
      const tab = await newTab(port, origin + '/')
      try {
        const conn = new CdpConnection(tab.webSocketDebuggerUrl!)
        await conn.ready()
        const script =
          '(() => {' + entries.map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('') + '})()'
        await conn.send('Runtime.evaluate', { expression: script, awaitPromise: false })
        // 等待 LevelDB 落盘后再关 tab，避免写入丢失
        await new Promise((r) => setTimeout(r, 400))
        conn.close()
      } finally {
        await closeTab(port, tab.id)
      }
    }
    if (lsCount > 0) {
      console.log(`[kernel] localStorage 注入 ${lsCount} 项`)
      // 主页面若已加载（startUrl 直载），刷新一次使其读到注入后的存储
      try {
        await re.page.send('Page.reload')
      } catch {
        /* ignore */
      }
    }
  }

  /** 抓取：cookie（Storage.getCookies）+ 逐 origin localStorage（临时 tab） */
  async capture(envId: string): Promise<StructuredData> {
    const re = this.running.get(envId)
    if (!re) throw new Error('环境未运行，无法抓取')
    const { cookies } = await re.page.send('Storage.getCookies', {})
    const origins = [...re.origins]
    console.log(`[kernel] capture origins=${JSON.stringify(origins)} cookies=${(cookies || []).length}`)
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

  /** L2 抓取：冻结容器（docker pause）后在宿主侧打包整个 profile 目录（tar + zstd/gzip）。
   *  环境保持运行，用户无感。原生承载不支持（quiesce 为 no-op，一致性无保证）。 */
  async captureProfile(envId: string): Promise<{ bytes: Buffer; format: 'tar+zstd' | 'tar+gzip' }> {
    const re = this.running.get(envId)
    if (!re) throw new Error('环境未运行，无法抓取 profile')
    if (!re.launch.profileDir) throw new Error('该承载未暴露 profile 目录（原生内核 L2 暂不支持）')
    const dir = re.launch.profileDir
    const t0 = Date.now()
    const packed = await re.launch.quiesce(() => tarDir(dir))
    console.log(
      `[kernel] L2 抓取 ${dir}：${packed.format} ${(packed.bytes.length / 1024).toFixed(0)}KB（${((Date.now() - t0) / 1000).toFixed(1)}s，含冻结）`
    )
    return packed
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
