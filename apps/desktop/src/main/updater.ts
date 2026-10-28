// 版本检查（V0.5 阶段 a，无签名过渡形态）：
// GitHub Releases/latest API 比对版本 → 有新版由渲染层提示并直达 Releases 页下载。
// 尚无正式 Release 时回退 tags 接口（tag 已随推送存在），保证今天就能用。
// 阶段 b（签名证书到位后）切 electron-updater 全量差分，本模块退役为兜底。
import { app, net, shell } from 'electron'
import type { UpdateCheck } from '@shared/types'

const REPO = 'JeckChen666/OneBrowser'
const API = `https://api.github.com/repos/${REPO}`
const UA = 'OneBrowser-Desktop-Updater'

/** 语义化版本比较：返回 >0 表示 a 更新 */
export function semverCmp(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

async function ghJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    // net.fetch 走系统代理与 Electron 网络栈（避免 Node fetch 直连被墙环境失效）
    const r = await net.fetch(API + path, {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' }
    })
    if (!r.ok) return null
    return (await r.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function checkUpdate(): Promise<UpdateCheck> {
  const current = app.getVersion()
  const base: UpdateCheck = { current, latest: null, hasUpdate: false, releaseUrl: null }

  const rel = await ghJson('/releases/latest')
  if (rel && typeof rel.tag_name === 'string') {
    const tag = rel.tag_name.replace(/^v/, '')
    return {
      current,
      latest: tag,
      hasUpdate: semverCmp(tag, current) > 0,
      releaseUrl: typeof rel.html_url === 'string' ? rel.html_url : `https://github.com/${REPO}/releases/latest`,
      publishedAt: typeof rel.published_at === 'string' ? rel.published_at : undefined,
      notes: typeof rel.body === 'string' ? rel.body.slice(0, 500) : undefined
    }
  }

  // 无正式 Release（未挂安装包）时回退 tags：取最近 tag 里语义版本最高的
  const tags = await ghJson('/tags?per_page=20')
  if (Array.isArray(tags)) {
    let best = ''
    for (const t of tags) {
      const name = (t as { name?: unknown }).name
      if (typeof name === 'string' && /^\d+\.\d+\.\d+$/.test(name.replace(/^v/, ''))) {
        if (!best || semverCmp(name, best) > 0) best = name.replace(/^v/, '')
      }
    }
    if (best) {
      return {
        current,
        latest: best,
        hasUpdate: semverCmp(best, current) > 0,
        releaseUrl: `https://github.com/${REPO}/releases/tag/v${best}`
      }
    }
  }
  return base
}

/** 外部浏览器打开（下载页直达） */
export function openExternal(url: string): void {
  if (/^https:\/\/github\.com\//.test(url)) void shell.openExternal(url)
}
