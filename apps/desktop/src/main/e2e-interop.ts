// 互迁移 e2e（V0.2.0-S2 出口标准，docs/v0.2.0-plan.md T12 + T3-kernel）：
//   T12  builtin 保存的基线 → kernel（Docker）打开免登录；kernel 再存 → builtin 打开仍免登录
//   T3k  混合互斥接管：A=kernel 持有，B 请求 → A 被驱逐（CDP 抓取上传）→ B 恢复最新会话
// 运行前置：make infra && server && test-site && Docker 镜像 onebrowser-kernel-smoke（脚本自动构建）
import { BrowserWindow, session } from 'electron'
import os from 'node:os'
import { AppService } from './core/appService'
import { CloudClient } from './core/cloudClient'
import { LeaseAgent } from './core/leaseAgent'
import { deriveAuthKey, deriveKEK, unwrapDEK } from './core/e2e'
import { open as openSnapshot } from './core/snapshotEngine'
import { restoreCookies, restoreLocalStorage } from './core/dataPlane'
import { ensureDockerImage } from './kernel-smoke'
import type { CanSend } from './core/cdp'
import type { MainEvent } from '@shared/types'

/** 宿主机局域网 IP：内核在 Docker 容器内访问宿主服务（127.0.0.1 在容器内不可达宿主） */
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
const log = (m: string): void => console.log(`[interop] ${m}`)
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

interface Whoami {
  loggedIn: boolean
  user?: string
  sid?: string
}

// --- CDP 侧辅助（kernel 环境） ---

async function cdpEval(page: CanSend, expression: string): Promise<any> {
  const res = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails) {
    throw new Error(String(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'eval 异常'))
  }
  return res.result?.value
}

async function cdpWhoami(page: CanSend): Promise<Whoami> {
  // 注意：页内 r.json() 偶发拿不到值（returnByValue 序列化问题），取文本在 Node 侧解析
  const text = await cdpEval(page, `fetch('/api/whoami').then(r => r.text())`)
  return JSON.parse(String(text))
}

async function cdpLogin(page: CanSend, user: string): Promise<void> {
  await cdpEval(
    page,
    `document.querySelector('input[name=user]') && ` +
      `(document.querySelector('input[name=user]').value = ${JSON.stringify(user)}, ` +
      `document.querySelector('form').submit(), 'submitted')`
  )
  await poll(() => cdpEval(page, `location.pathname === '/app'`), 10000, 'kernel 跳转 /app')
}

async function cdpLocalStorage(page: CanSend, key: string): Promise<string> {
  return String(await cdpEval(page, `localStorage.getItem(${JSON.stringify(key)}) || ''`))
}

async function waitClosed(svc: AppService, envId: string): Promise<void> {
  await poll(async () => !svc.host.isRunning(envId) && !svc.kernelHost.isRunning(envId), 15000, `环境 ${envId} 关闭`)
  await sleep(300)
}

// --- Electron 侧辅助（builtin 环境） ---

async function wcWhoami(wc: Electron.WebContents): Promise<Whoami> {
  return wc.executeJavaScript(`fetch('/api/whoami').then(r => r.json())`)
}

async function wcAutoLogin(wc: Electron.WebContents, user: string): Promise<void> {
  await poll(() => wc.executeJavaScript(`!!document.querySelector('input[name=user]')`), 5000, '登录表单出现')
  await wc.executeJavaScript(
    `document.querySelector('input[name=user]').value = ${JSON.stringify(user)};` +
      `document.querySelector('form').submit(); 'ok'`
  )
  await poll(() => wc.executeJavaScript(`location.pathname === '/app'`), 8000, '跳转 /app')
}

export async function runE2EInterop(): Promise<number> {
  const started = Date.now()
  log(`服务端=${SERVER} 测试站=${SITE} 内核=Docker`)
  await ensureDockerImage()

  const emit = (e: MainEvent): void => {
    if (e.type === 'notify') log(`  [通知:${e.level}] ${e.message}`)
  }
  const svc = new AppService(SERVER, emit)

  const email = `interop-${Date.now()}@t.local`
  const password = 'interop-password-#1'
  await svc.register(email, password)
  check('账号注册并登录', svc.logged_in)

  // =========== T12 双承载互迁移 ===========
  log('—— T12 双承载互迁移（builtin ↔ kernel）——')
  await svc.createEnv({ name: 'T12-互迁', mode: 'snapshot', hosting: 'builtin', homepage: SITE })
  const envId = svc.getState().envs.find((v) => v.env.name === 'T12-互迁')!.env.id

  // builtin：登录 + 存基线
  await svc.openEnv(envId, true)
  const wc = svc.host.get(envId)!.win.webContents
  await wcAutoLogin(wc, 'alice')
  check('T12.0 builtin 侧登录成功', (await wcWhoami(wc)).loggedIn === true)
  await svc.saveBase(envId)
  await svc.closeEnv(envId)
  await waitClosed(svc, envId)

  // 切换为 kernel（Docker）承载，打开同一基线
  await svc.updateEnv(envId, { hosting: 'kernel' })
  await svc.openEnv(envId)
  const okRunning = await poll(() => Promise.resolve(svc.kernelHost.isRunning(envId)), 30000, 'kernel 环境启动')
  if (!okRunning) {
    log('kernel 环境启动失败，中止')
    return 1
  }
  const page = svc.kernelHost.get(envId)!.page
  const whoKernel = await poll(
    async () => {
      const w = await cdpWhoami(page).catch(() => null)
      return w && w.loggedIn === true ? w : null
    },
    20000,
    'kernel 打开基线后免登录'
  )
  check(
    'T12.1 kernel 打开 builtin 存的基线 → 免登录',
    !!whoKernel && whoKernel.user === 'alice',
    whoKernel ? `user=${whoKernel.user} sid=${whoKernel.sid?.slice(0, 8)}…` : '未登录'
  )
  const lsKernel = await cdpLocalStorage(page, 'theme_token')
  check(
    'T12.2 localStorage 随基线恢复到 kernel',
    lsKernel.length > 0 && lsKernel !== 'undefined',
    `theme_token=${lsKernel}`
  )

  // kernel 侧再存基线 → 切回 builtin → 打开仍免登录
  await svc.saveBase(envId)
  await svc.closeEnv(envId)
  await waitClosed(svc, envId)
  await svc.updateEnv(envId, { hosting: 'builtin' })
  await svc.openEnv(envId, true)
  const wc2 = svc.host.get(envId)!.win.webContents
  const whoBack = await wcWhoami(wc2)
  check('T12.3 切回 builtin 打开 kernel 存的基线 → 免登录', whoBack.loggedIn === true && whoBack.user === 'alice')
  await svc.closeEnv(envId)
  await waitClosed(svc, envId)

  // =========== T3k 混合互斥接管（A=kernel，B=独立客户端） ===========
  log('—— T3k 混合模式互斥接管（A=kernel@Docker，B=独立会话）——')
  await svc.createEnv({ name: 'T3k-混合互斥', mode: 'exclusive', hosting: 'kernel', homepage: SITE })
  const env2 = svc.getState().envs.find((v) => v.env.name === 'T3k-混合互斥')!.env.id

  await svc.openEnv(env2)
  const okA = await poll(() => Promise.resolve(svc.kernelHost.isRunning(env2)), 30000, 'A(kernel) 启动')
  if (!okA) {
    log('A(kernel) 启动失败，中止')
    return 1
  }
  const pageA = svc.kernelHost.get(env2)!.page
  await poll(() => cdpEval(pageA, `!!document.querySelector('input[name=user]') || location.pathname === '/app'`), 20000, 'A 页面就绪')
  await cdpEval(
    pageA,
    `location.pathname !== '/app' && document.querySelector('input[name=user]') && ` +
      `(document.querySelector('input[name=user]').value = 'alice', document.querySelector('form').submit(), 'ok')`
  )
  const okApp = await poll(() => cdpEval(pageA, `location.pathname === '/app'`), 15000, 'A 登录跳转')
  const whoA = okApp ? await cdpWhoami(pageA) : { loggedIn: false }
  check(
    'T3k.1 A(kernel) 登录成功',
    whoA.loggedIn === true && whoA.user === 'alice' && !!whoA.sid,
    whoA.loggedIn ? `sid=${whoA.sid?.slice(0, 8)}…` : '未登录'
  )
  await svc.saveBase(env2)
  const sidA = whoA.sid || ''
  const baseBefore = (await svc.cloud.getBase(env2)).snapshot?.snapshotId

  // 设备 B
  const cloudB = new CloudClient(SERVER)
  const kdfInfo = await cloudB.kdfInfo(email)
  const authKeyB = await deriveAuthKey(password, kdfInfo.authKdf)
  const loginB = await cloudB.login({
    email,
    authKey: authKeyB,
    deviceId: 'interop-device-B',
    deviceName: 'B',
    platform: 'e2e'
  })
  const dekB = await unwrapDEK(await deriveKEK(password, loginB.kekKdf), loginB.wrappedDek)
  cloudB.token = loginB.token
  cloudB.connectWS()
  await sleep(500)
  const agentB = new LeaseAgent(cloudB, { onEvict() {}, onLost() {}, onEnvUpdated() {} })

  const acquireRes = await agentB.acquire(env2)
  check('T3k.2 B 请求 → pending', acquireRes.granted === false && !!acquireRes.holderDeviceId)
  const granted = await agentB.waitGranted(env2, 60000)
  check(
    'T3k.3 B 获 granted 且携带 A(kernel) 驱逐时新上传的快照',
    granted.granted === true && !!granted.snapshotId && granted.stale === false && granted.snapshotId !== baseBefore,
    `snap=${granted.snapshotId?.slice(0, 8)}…`
  )
  await waitClosed(svc, env2)
  check('T3k.4 A(kernel) 已被强制关闭', !svc.kernelHost.isRunning(env2))

  // B 下载快照恢复
  const dl = await cloudB.getDownload(env2, granted.snapshotId!)
  const [manifestBytes, blobBytes] = await Promise.all([
    cloudB.getObject(dl.download.manifestUrl),
    cloudB.getObject(dl.download.blobUrl)
  ])
  const payload = await openSnapshot(dekB, {
    manifest: JSON.parse(new TextDecoder().decode(manifestBytes)),
    blobB64: Buffer.from(blobBytes).toString('base64')
  })
  const sesB = session.fromPartition('interop-device-b')
  const r = await restoreCookies(sesB, payload.cookies)
  check('T3k.5 cookie 全量恢复（kernel 抓取的 HttpOnly sid）', r.ok > 0 && r.failed === 0)
  await restoreLocalStorage(sesB, payload.localStorage)
  const winB = new BrowserWindow({
    show: false,
    webPreferences: { session: sesB, nodeIntegration: false, contextIsolation: true }
  })
  await winB.loadURL(SITE + '/')
  const whoB = await winB.webContents.executeJavaScript(`fetch('/api/whoami').then(r => r.json())`)
  check('T3k.6 B 接管后免登录', whoB.loggedIn === true && whoB.user === 'alice')
  check('T3k.7 会话为 A 下线前最新 sid（kernel CDP 抓取保真）', !!whoB.sid && !!sidA && whoB.sid === sidA)
  winB.destroy()

  log(`\n===== interop 完成：PASS=${pass} FAIL=${fail}（${((Date.now() - started) / 1000).toFixed(1)}s）=====`)
  cloudB.disconnect()
  await svc.logout().catch(() => {})
  return fail === 0 ? 0 : 1
}
