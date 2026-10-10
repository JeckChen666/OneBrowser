// 数据面 L1（结构化）：cookie + localStorage 的抽取/注入。
// 不触碰 profile 文件，天然绕开 OS 加密（DPAPI/Keychain/ABE）与跨机绑定问题。
import { BrowserWindow, session as electronSession } from 'electron'
import type { Cookie, Session } from 'electron'

export interface StructuredData {
  cookies: Cookie[]
  localStorage: Record<string, Record<string, string>> // origin → kv
  origins: string[]
}

// --- Cookies ---

export async function captureCookies(ses: Session): Promise<Cookie[]> {
  return ses.cookies.get({})
}

/** 逐条重放；SameSite 'unspecified' 不可回写，跳过该字段 */
export async function restoreCookies(ses: Session, cookies: Cookie[]): Promise<{ ok: number; failed: number }> {
  let ok = 0
  let failed = 0
  for (const c of cookies) {
    try {
      const host = (c.domain || '').replace(/^\./, '') || 'localhost'
      const details: Electron.CookiesSetDetails = {
        url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly
      }
      if (c.domain) details.domain = c.domain
      if (c.sameSite && c.sameSite !== 'unspecified') details.sameSite = c.sameSite
      if (c.expirationDate) details.expirationDate = c.expirationDate
      await ses.cookies.set(details)
      ok++
    } catch (e) {
      failed++
      console.warn(`[dataplane] cookie 回放失败 ${c.name}@${c.domain}:`, e instanceof Error ? e.message : e)
    }
  }
  return { ok, failed }
}

// --- localStorage（隐藏窗口逐 origin 读写） ---

async function withOrigin<T>(ses: Session, origin: string, fn: (win: BrowserWindow) => Promise<T>): Promise<T> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true }
  })
  try {
    await win.loadURL(origin + '/')
    return await fn(win)
  } finally {
    win.destroy()
  }
}

export async function captureLocalStorage(
  ses: Session,
  origins: string[]
): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {}
  for (const origin of origins) {
    try {
      const json = await withOrigin(ses, origin, (win) =>
        win.webContents
          .executeJavaScript('JSON.stringify(Object.fromEntries(Object.entries(window.localStorage)))')
          .then((s: unknown) => String(s))
      )
      out[origin] = JSON.parse(json)
    } catch (e) {
      console.warn(`[dataplane] localStorage 抓取失败 ${origin}:`, e instanceof Error ? e.message : e)
    }
  }
  return out
}

export async function restoreLocalStorage(
  ses: Session,
  data: Record<string, Record<string, string>>
): Promise<void> {
  for (const [origin, kv] of Object.entries(data)) {
    const entries = Object.entries(kv || {})
    if (entries.length === 0) continue
    try {
      await withOrigin(ses, origin, async (win) => {
        const script =
          '(() => {' + entries.map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('') + '})()'
        await win.webContents.executeJavaScript(script)
      })
    } catch (e) {
      console.warn(`[dataplane] localStorage 注入失败 ${origin}:`, e instanceof Error ? e.message : e)
    }
  }
}

export function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (!/^https?:$/.test(u.protocol)) return null
    return u.origin
  } catch {
    return null
  }
}

export { electronSession }
