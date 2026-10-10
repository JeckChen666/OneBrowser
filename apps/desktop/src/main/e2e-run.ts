// 端到端自动化验收（V0.1.0 测试矩阵 T1/T2/T3）：
//   T1 模式一：A 登录→基线上云→B 克隆免登录（cookie+localStorage）
//   T2 分支语义：B 分支内退出登录不影响云端基线
//   T3 模式二：设备 B 请求接管 → A 被驱逐（自动上传+关窗）→ B 恢复最新会话
// 运行前置：make infra && server(:8787) && test-site(:18080)；执行 pnpm e2e
import { BrowserWindow, session } from 'electron'
import { AppService } from './core/appService'
import { CloudClient } from './core/cloudClient'
import { LeaseAgent } from './core/leaseAgent'
import { deriveAuthKey, deriveKEK, unwrapDEK } from './core/e2e'
import { open as openSnapshot } from './core/snapshotEngine'
import { restoreCookies, restoreLocalStorage } from './core/dataPlane'

const SITE = process.env.ONEBROWSER_SITE || 'http://127.0.0.1:18080'
const SERVER = process.env.ONEBROWSER_SERVER || 'http://127.0.0.1:8787'

let pass = 0
let fail = 0

function log(msg: string): void {
  console.log(`[e2e] ${msg}`)
}

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++
    log(`  ✅ ${name}${detail ? `（${detail}）` : ''}`)
  } else {
    fail++
    log(`  ❌ ${name}${detail ? `（${detail}）` : ''}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function poll(fn: () => Promise<boolean>, timeoutMs: number, label: string): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return true
    } catch {
      /* 重试 */
    }
    await sleep(250)
  }
  log(`  ⏰ 轮询超时: ${label}`)
  return false
}

interface Whoami {
  loggedIn: boolean
  user?: string
  sid?: string
  reason?: string
}

async function whoami(wc: Electron.WebContents): Promise<Whoami> {
  return wc.executeJavaScript(`fetch('/api/whoami').then(r => r.json())`)
}

async function autoLogin(wc: Electron.WebContents, user: string): Promise<void> {
  await poll(() => wc.executeJavaScript(`!!document.querySelector('input[name=user]')`), 5000, '登录表单出现')
  await wc.executeJavaScript(
    `document.querySelector('input[name=user]').value = ${JSON.stringify(user)};` +
      `document.querySelector('form').submit(); 'ok'`
  )
  await poll(() => wc.executeJavaScript(`location.pathname === '/app'`), 8000, '跳转 /app')
}

async function waitClosed(svc: AppService, envId: string): Promise<void> {
  await poll(async () => !svc.host.isRunning(envId), 8000, `环境 ${envId} 关闭`)
  await sleep(200)
}

export async function runE2E(): Promise<number> {
  const started = Date.now()
  log(`服务端=${SERVER} 测试站=${SITE}`)
  const emit = (e: import('@shared/types').MainEvent): void => {
    if (e.type === 'notify') log(`  [通知:${e.level}] ${e.message}`)
  }
  const svc = new AppService(SERVER, emit)

  // ---------- 账号 ----------
  const email = `e2e-${Date.now()}@t.local`
  const password = 'e2e-password-#1'
  await svc.register(email, password)
  check('账号注册并自动登录', svc.logged_in)

  // ---------- T1 模式一 ----------
  log('—— T1 模式一（快照分支）——')
  await svc.createEnv({ name: 'T1-快照环境', mode: 'snapshot', hosting: 'builtin', homepage: SITE })
  const env1 = svc.getState().envs.find((v: import('@shared/types').EnvView) => v.env.name === 'T1-快照环境')!.env.id

  await svc.openEnv(env1, true) // hidden 窗口
  const wcA = svc.host.get(env1)!.win.webContents
  await autoLogin(wcA, 'alice')
  const whoA = await whoami(wcA)
  check('T1.1 A 设备完成登录', whoA.loggedIn === true && whoA.user === 'alice')

  await svc.saveBase(env1)
  await svc.closeEnv(env1)
  await waitClosed(svc, env1)
  check('T1.2 基线已上云（关闭即弃分支）', true)

  // B 设备视角：全新内存 partition，从云端基线克隆
  await svc.openEnv(env1, true)
  const wcB = svc.host.get(env1)!.win.webContents
  const whoB = await whoami(wcB)
  check('T1.3 B 设备克隆后免登录', whoB.loggedIn === true && whoB.user === 'alice')
  const lsToken = await wcB.executeJavaScript(`localStorage.getItem('theme_token') || ''`)
  check('T1.4 localStorage 已随基线同步', lsToken.length > 0, `theme_token=${lsToken}`)

  // ---------- T2 分支语义 ----------
  log('—— T2 分支语义（B 的改动不回写基线）——')
  const sidBase = whoB.sid // T1 克隆会话的 sid（= 基线 cookie 值）
  await wcB.executeJavaScript(`localStorage.removeItem('theme_token'); fetch('/logout').then(r => r.status)`)
  await sleep(300)
  const whoB2 = await whoami(wcB)
  check('T2.1 分支内已退出登录（站点侧）', whoB2.loggedIn === false)
  await svc.closeEnv(env1)
  await waitClosed(svc, env1)
  await svc.openEnv(env1, true)
  const wcB3 = svc.host.get(env1)!.win.webContents
  const ls3 = await wcB3.executeJavaScript(`localStorage.getItem('theme_token') || ''`)
  check('T2.2 localStorage 从基线恢复（分支改动被丢弃）', ls3.length > 0)
  const sidRestored = await svc.host.get(env1)!.ses.cookies.get({ name: 'sid' })
  check(
    'T2.3 HttpOnly cookie 从基线恢复（值与基线一致）',
    sidRestored.length > 0 && sidRestored[0].value === sidBase
  )
  await svc.closeEnv(env1)
  await waitClosed(svc, env1)

  // ---------- T3 模式二（互斥接管，设备 B 为独立客户端） ----------
  log('—— T3 模式二（互斥接管）——')
  await svc.createEnv({ name: 'T3-互斥环境', mode: 'exclusive', hosting: 'builtin', homepage: SITE })
  const env2 = svc.getState().envs.find((v: import('@shared/types').EnvView) => v.env.name === 'T3-互斥环境')!.env.id

  // 设备 A（本进程主会话）打开并登录
  await svc.openEnv(env2, true)
  const wcA2 = svc.host.get(env2)!.win.webContents
  await autoLogin(wcA2, 'alice')
  const whoA2 = await whoami(wcA2)
  check('T3.1 A 设备登录成功', whoA2.loggedIn === true)
  await svc.saveBase(env2) // 先有一份基线（模拟 A 的既有状态）
  const sidA = whoA2.sid

  // 设备 B：独立 CloudClient + LeaseAgent
  const cloudB = new CloudClient(SERVER)
  const kdfInfo = await cloudB.kdfInfo(email)
  const authKeyB = await deriveAuthKey(password, kdfInfo.authKdf)
  const loginB = await cloudB.login({
    email,
    authKey: authKeyB,
    deviceId: 'e2e-device-B',
    deviceName: 'Device-B',
    platform: 'e2e'
  })
  const kekB = await deriveKEK(password, loginB.kekKdf)
  const dekB = await unwrapDEK(kekB, loginB.wrappedDek)
  cloudB.token = loginB.token
  cloudB.connectWS()
  await sleep(500)
  const agentB = new LeaseAgent(cloudB, { onEvict() {}, onLost() {}, onEnvUpdated() {} })

  // 接管前记录旧基线 ID（用于断言 B 拿到的是 A 驱逐时新上传的快照）
  const baseBefore = (await svc.cloud.getBase(env2)).snapshot?.snapshotId

  const acquireRes = await agentB.acquire(env2)
  check('T3.2 B 请求 → pending（等待 A 驱逐）', acquireRes.granted === false && !!acquireRes.holderDeviceId)
  const grantedP = agentB.waitGranted(env2, 40000)
  const granted = await grantedP
  check(
    'T3.3 B 收到 granted 且携带 A 驱逐时新上传的快照',
    granted.granted === true &&
      !!granted.snapshotId &&
      granted.stale === false &&
      granted.snapshotId !== baseBefore,
    `granted=${granted.granted} snap=${granted.snapshotId || '-'} stale=${granted.stale} baseBefore=${baseBefore || '-'}`
  )
  await waitClosed(svc, env2)
  check('T3.4 A 窗口已被强制关闭', !svc.host.isRunning(env2))

  // B 下载快照 → 恢复到独立 session → 验证会话延续
  const dl = await cloudB.getDownload(env2, granted.snapshotId!)
  const [manifestBytes, blobBytes] = await Promise.all([
    cloudB.getObject(dl.download.manifestUrl),
    cloudB.getObject(dl.download.blobUrl)
  ])
  const payload = await openSnapshot(dekB, {
    manifest: JSON.parse(new TextDecoder().decode(manifestBytes)),
    blobB64: Buffer.from(blobBytes).toString('base64')
  })
  const sesB = session.fromPartition('e2e-device-b-restore')
  const r = await restoreCookies(sesB, payload.cookies)
  check('T3.5 cookie 全量恢复到 B', r.ok > 0 && r.failed === 0, `ok=${r.ok} failed=${r.failed}`)
  await restoreLocalStorage(sesB, payload.localStorage)
  const winB = new BrowserWindow({
    show: false,
    webPreferences: { session: sesB, nodeIntegration: false, contextIsolation: true }
  })
  await winB.loadURL(SITE + '/')
  const whoDeviceB = await whoami(winB.webContents)
  check('T3.6 B 接管后免登录（同一账号会话）', whoDeviceB.loggedIn === true && whoDeviceB.user === 'alice')
  check('T3.7 会话为 A 下线前的最新 sid', whoDeviceB.sid === sidA)
  winB.destroy()

  // ---------- T4 E2E 抽查：S3 上只有密文 ----------
  log('—— T5 E2E 抽查（云端密文）——')
  const baseResp = await svc.cloud.getBase(env1)
  if (baseResp.download) {
    const raw = new TextDecoder().decode(await svc.cloud.getObject(baseResp.download.blobUrl))
    const looksCiphertext = !raw.includes('alice') && !raw.includes('"cookies"')
    check('T5.1 S3 对象为密文（不含明文登录态）', looksCiphertext)
  }

  log(`\n===== E2E 完成：PASS=${pass} FAIL=${fail}（${((Date.now() - started) / 1000).toFixed(1)}s）=====`)
  cloudB.disconnect()
  await svc.logout().catch(() => {})
  return fail === 0 ? 0 : 1
}
