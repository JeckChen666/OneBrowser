// L2 文件级快照验收（V0.3.0，docs/v0.3.0-plan.md）：
//   T-L2.1 kernel 环境：登录 + IndexedDB/localStorage/持久 cookie → 保存基线 →
//        关闭（per-run profile 目录被清理）→ 新实例打开基线 → 三类数据全部读回且零结构化注入
//   T-L2.2 基线为文件级（manifest kind=files，tar+gzip，带 kernel 版本与 seed 绑定）
//   T-L2.3 builtin 设备打开 L2 基线 → 自动回退 L1 兜底快照（双承载互迁移不回退）
// 运行前置：server(:8787) + test-site(:18080) + Docker 镜像 onebrowser-kernel-smoke（自动构建）
import os from 'node:os'
import { AppService } from './core/appService'
import { ensureDockerImage } from './kernel-smoke'
import type { CanSend } from './core/cdp'
import type { MainEvent } from '@shared/types'

function lanIp(): string {
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address
    }
  }
  return '127.0.0.1'
}

const SITE = process.env.ONEBROWSER_SITE || `http://${lanIp()}:18080`
const SERVER = process.env.ONEBROWSER_SERVER || 'http://127.0.0.1:8787'

let pass = 0
let fail = 0
const log = (m: string): void => console.log(`[l2-e2e] ${m}`)
const check = (name: string, cond: boolean, detail?: string): void => {
  if (cond) {
    pass++
    log(`  ✅ ${name}${detail ? `（${detail}）` : ''}`)
  } else {
    fail++
    log(`  ❌ ${name}${detail ? `（${detail}）` : ''}`)
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function poll<T>(fn: () => Promise<T>, timeoutMs: number, label: string): Promise<T | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      /* 重试 */
    }
    await sleep(400)
  }
  log(`  ⏰ 轮询超时: ${label}`)
  return null
}

async function cdpEval(page: CanSend, expression: string): Promise<any> {
  const res = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails) {
    throw new Error(String(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'eval 异常'))
  }
  return res.result?.value
}

async function cdpWhoami(page: CanSend): Promise<{ loggedIn: boolean; user?: string; sid?: string }> {
  return JSON.parse(String(await cdpEval(page, `fetch('/api/whoami').then(r => r.text())`)))
}

async function waitClosed(svc: AppService, envId: string): Promise<void> {
  await poll(async () => !svc.host.isRunning(envId) && !svc.kernelHost.isRunning(envId), 20000, `环境关闭`)
  await sleep(500)
}

/** 页内写入三类持久数据：localStorage / IndexedDB / 持久 cookie（站点 API set-kvc 不存在，cookie 经登录态产生） */
async function writeSiteData(page: CanSend): Promise<void> {
  await cdpEval(
    page,
    `(async () => {
      localStorage.setItem('l2_ls', 'ls-value-42');
      const db = await new Promise((res, rej) => {
        const q = indexedDB.open('l2db', 1)
        q.onupgradeneeded = () => q.result.createObjectStore('s')
        q.onsuccess = () => res(q.result)
        q.onerror = () => rej(q.error)
      })
      await new Promise((res, rej) => {
        const tx = db.transaction('s', 'readwrite')
        tx.objectStore('s').put('idb-value-42', 'k')
        tx.oncomplete = res
        tx.onerror = () => rej(tx.error)
      })
      return 'written'
    })()`
  )
}

async function readSiteData(page: CanSend): Promise<{ ls: string; idb: string }> {
  return JSON.parse(
    String(
      await cdpEval(
        page,
        `(async () => {
          const ls = localStorage.getItem('l2_ls') || ''
          let idb = ''
          try {
            const db = await new Promise((res, rej) => {
              const q = indexedDB.open('l2db', 1)
              q.onsuccess = () => res(q.result)
              q.onerror = () => rej(q.error)
            })
            idb = await new Promise((res, rej) => {
              const tx = db.transaction('s', 'readonly')
              const g = tx.objectStore('s').get('k')
              g.onsuccess = () => res(g.result || '(none)')
              g.onerror = () => rej(g.error)
            })
          } catch (e) { idb = 'ERR:' + e.message }
          return JSON.stringify({ ls, idb })
        })()`
      )
    )
  )
}

export async function runE2EL2(): Promise<number> {
  const started = Date.now()
  log(`服务端=${SERVER} 测试站=${SITE} 内核=Docker（L2 文件级快照）`)
  await ensureDockerImage()

  const emit = (e: MainEvent): void => {
    if (e.type === 'notify') log(`  [通知:${e.level}] ${e.message}`)
  }
  const svc = new AppService(SERVER, emit)
  const email = `l2-${Date.now()}@t.local`
  const password = 'l2-password-#1'
  let exitCode = 1

  try {
    await svc.register(email, password)
    check('账号注册并登录', svc.logged_in)

    await svc.createEnv({
      name: 'T-L2-文件级',
      mode: 'snapshot',
      hosting: 'kernel',
      homepage: SITE,
      seed: '600000023',
      fingerprint: { platform: 'Windows' }
    })
    const envId = svc.getState().envs.find((v) => v.env.name === 'T-L2-文件级')!.env.id

    // ---- 第 1 轮：打开 → 登录 → 写数据 → 保存基线（双写）----
    await svc.openEnv(envId)
    const okRun1 = await poll(() => Promise.resolve(svc.kernelHost.isRunning(envId)), 40000, '内核启动')
    if (!okRun1) throw new Error('内核启动失败')
    const page1 = svc.kernelHost.get(envId)!.page
    await poll(() => cdpEval(page1, `!!document.querySelector('input[name=user]')`), 20000, '登录表单出现')
    await cdpEval(
      page1,
      `(document.querySelector('input[name=user]').value = 'alice', document.querySelector('form').submit(), 'ok')`
    )
    const who1 = await poll(async () => {
      const w = await cdpWhoami(page1).catch(() => null)
      return w && w.loggedIn === true ? w : null
    }, 20000, '登录完成')
    if (!who1) throw new Error('登录失败')
    await writeSiteData(page1)
    const sid1 = who1.sid
    log(`第 1 轮：登录成功（sid=${sid1?.slice(0, 8)}…），站点数据已写入`)

    await svc.saveBase(envId)
    await svc.closeEnv(envId)
    await waitClosed(svc, envId)

    // ---- T-L2.2：基线 manifest 为文件级 ----
    const base = await svc.cloud.getBase(envId)
    if (!base.hasBase || !base.download) throw new Error('基线不存在')
    const manifest = JSON.parse(
      new TextDecoder().decode(await svc.cloud.getObject(base.download.manifestUrl))
    ) as { kind: string; payload: { format: string; rawSize: number }; kernel?: { version: string; seed: string } }
    check(
      'T-L2.2 基线为文件级（kind=files，tar+zstd/gzip，带内核版本/种子绑定）',
      manifest.kind === 'files' &&
        (manifest.payload?.format === 'tar+zstd' || manifest.payload?.format === 'tar+gzip') &&
        !!manifest.kernel?.version &&
        manifest.kernel?.seed === '600000023',
      `format=${manifest.payload?.format} rawSize=${(manifest.payload?.rawSize / 1024).toFixed(0)}KB kernel=${manifest.kernel?.version}`
    )

    // ---- 第 2 轮：全新实例打开基线 → 三类数据读回（零结构化注入）----
    await svc.openEnv(envId)
    const okRun2 = await poll(() => Promise.resolve(svc.kernelHost.isRunning(envId)), 40000, '内核再启动')
    if (!okRun2) throw new Error('内核再启动失败')
    const page2 = svc.kernelHost.get(envId)!.page
    const who2 = await poll(async () => {
      const w = await cdpWhoami(page2).catch(() => null)
      return w && w.loggedIn === true ? w : null
    }, 25000, 'L2 克隆后免登录')
    check('T-L2.1a cookie 随 profile 恢复（免登录，零结构化注入）', !!who2 && who2.user === 'alice', who2 ? `sid=${who2.sid?.slice(0, 8)}…` : '未登录')
    check('T-L2.1b 会话为基线保存时的同一 sid', who2?.sid === sid1, `${who2?.sid?.slice(0, 8)}… vs ${sid1?.slice(0, 8)}…`)

    // localStorage / IndexedDB：页面当前停在 /app（L2 恢复后页面即登录页后的状态）——等页面可读
    const data2 = await poll(() => readSiteData(page2).catch(() => null), 20000, '站点数据读回')
    check('T-L2.1c localStorage 随 profile 恢复', data2?.ls === 'ls-value-42', `ls=${data2?.ls}`)
    check('T-L2.1d IndexedDB 随 profile 恢复', data2?.idb === 'idb-value-42', `idb=${data2?.idb}`)

    await svc.closeEnv(envId)
    await waitClosed(svc, envId)

    // ---- T-L2.3：builtin 打开 L2 基线 → 回退 L1 兜底（双承载互迁移不回退）----
    await svc.updateEnv(envId, { hosting: 'builtin' })
    await svc.openEnv(envId, true)
    const wc = svc.host.get(envId)!.win.webContents
    const whoB = await poll(async () => {
      const w = await wc.executeJavaScript(`fetch('/api/whoami').then(r => r.json()).catch(() => null)`)
      return w && w.loggedIn === true ? w : null
    }, 20000, 'builtin 回退 L1 后免登录')
    check('T-L2.3 builtin 打开 L2 基线 → L1 兜底生效（免登录）', !!whoB && whoB.user === 'alice', whoB ? `sid=${whoB.sid?.slice(0, 8)}…` : '未登录')
    await svc.closeEnv(envId)
    await waitClosed(svc, envId)

    exitCode = fail === 0 ? 0 : 1
    await svc.logout().catch(() => undefined)
  } catch (e) {
    log(`异常终止: ${e instanceof Error ? e.message : e}`)
    exitCode = 1
  } finally {
    log(`\n===== l2-e2e 完成：PASS=${pass} FAIL=${fail}（${((Date.now() - started) / 1000).toFixed(1)}s）=====`)
  }
  return exitCode
}
