// 浏览器承载层（builtin）：每个环境 = 独立内存 partition + 独立窗口。
// 非 persist partition：关闭即弃 —— 严格实现模式一「每次从基线分支」语义。
import { BrowserWindow, session } from 'electron'
import type { Session } from 'electron'
import { randomId } from './e2e'
import { captureCookies, captureLocalStorage, restoreCookies, restoreLocalStorage, originOf, type StructuredData } from './dataPlane'
import type { EnvConfig } from '@shared/types'
import type { BuiltinRunningEnv, Host, RunningEnv } from './host'

export class BrowserHost implements Host {
  private running = new Map<string, BuiltinRunningEnv>()
  onClosed: ((envId: string) => void) | null = null

  isRunning(envId: string): boolean {
    return this.running.has(envId)
  }

  /** 供菜单等遍历：[envId, RunningEnv] */
  runningEntries(): IterableIterator<[string, BuiltinRunningEnv]> {
    return this.running.entries()
  }

  get(envId: string): BuiltinRunningEnv | undefined {
    return this.running.get(envId)
  }

  findEnvIdBySession(ses: Session): string | undefined {
    for (const [envId, r] of this.running) if (r.ses === ses) return envId
    return undefined
  }

  async open(env: EnvConfig, opts: { restore?: StructuredData | null; hidden?: boolean } = {}): Promise<RunningEnv> {
    if (this.running.has(env.id)) throw new Error('环境已在运行中')
    const runToken = randomId()
    const ses = session.fromPartition(`env-${env.id}-${runToken}`)

    if (env.proxy?.host) {
      await ses.setProxy({
        proxyRules: `${env.proxy.scheme}://${env.proxy.host}:${env.proxy.port}`,
        proxyBypassRules: '<local>'
      })
    }

    // 先注入登录态，再开可见窗口（分支起点 = 基线状态）
    if (opts.restore) {
      await restoreCookies(ses, opts.restore.cookies)
      await restoreLocalStorage(ses, opts.restore.localStorage)
    }

    const win = new BrowserWindow({
      width: 1200,
      height: 820,
      show: !opts.hidden,
      title: `${env.name} · OneBrowser`,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true
      }
    })
    const re: BuiltinRunningEnv = { kind: 'builtin', envId: env.id, runToken, ses, win, origins: new Set(opts.restore?.origins || []) }

    const track = (url: string): void => {
      const o = originOf(url)
      if (o) re.origins.add(o)
    }
    win.webContents.on('did-navigate', (_e, url) => track(url))
    win.webContents.on('did-navigate-in-page', (_e, url) => track(url))
    win.on('closed', () => {
      this.running.delete(env.id)
      this.onClosed?.(env.id)
    })
    this.running.set(env.id, re)
    await win.loadURL(env.homepage || 'about:blank')
    return re
  }

  /** 抓取运行中环境的登录态（cookie + 已访问 origin 的 localStorage） */
  async capture(envId: string): Promise<StructuredData> {
    const re = this.running.get(envId)
    if (!re) throw new Error('环境未运行，无法抓取')
    const cookies = await captureCookies(re.ses)
    const origins = [...re.origins]
    const ls = await captureLocalStorage(re.ses, origins)
    return { cookies, localStorage: ls, origins }
  }

  closeWindow(envId: string): void {
    this.running.get(envId)?.win.close()
  }

  closeAll(): void {
    for (const re of this.running.values()) re.win.close()
  }
}
