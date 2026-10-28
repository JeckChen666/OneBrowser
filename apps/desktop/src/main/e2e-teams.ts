// 团队协作 e2e（V0.6，附录 A 出口标准）：
//   TM.1 A 建团（身份密钥对注册）→ 建团队环境 → 登录测试站 → 基线上云
//   TM.2 A 邀 B → B 接受 → B 免登录打开团队环境基线（E2E 团队 DEK 换根生效）
//   TM.3 A 邀 C → C 接受后可见 → A 吊销 C → C 看不到也打不开（断服务端访问）
//   TM.4 S3 密文抽查：团队环境对象不含明文登录态/用户名/团队名
// 运行前置：server(:8787) + test-site(:18080)；执行 pnpm e2e:teams
import { AppService } from './core/appService'
import type { MainEvent } from '@shared/types'

const SITE = process.env.ONEBROWSER_SITE || 'http://127.0.0.1:18080'
const SERVER = process.env.ONEBROWSER_SERVER || 'http://127.0.0.1:8787'

let pass = 0
let fail = 0

function log(msg: string): void {
  console.log(`[e2e-teams] ${msg}`)
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

async function whoami(wc: Electron.WebContents): Promise<{ loggedIn: boolean; user?: string; sid?: string }> {
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

const mkEmit = (tag: string): ((e: MainEvent) => void) => (e) => {
  if (e.type === 'notify') log(`  [${tag}][通知:${e.level}] ${e.message}`)
}

export async function runE2ETeams(): Promise<number> {
  const started = Date.now()
  log(`服务端=${SERVER} 测试站=${SITE}`)
  const svcA = new AppService(SERVER, mkEmit('A'))
  const svcB = new AppService(SERVER, mkEmit('B'))
  const svcC = new AppService(SERVER, mkEmit('C'))
  const suffix = Date.now()

  // ---------- TM.1 A 建团 + 团队环境 + 基线 ----------
  log('—— TM.1 A 建团并存基线 ——')
  await svcA.register(`a-${suffix}@t.local`, 'team-pass-#1')
  check('TM.1.1 A 注册（含身份密钥对）', svcA.logged_in)
  await svcA.createTeam('E2E测试团')
  const teamA = svcA.getTeams().find((t) => t.name === 'E2E测试团')
  check('TM.1.2 团队已创建（owner/active）', !!teamA && teamA.role === 'owner' && teamA.state === 'active')

  await svcA.createEnv({ name: '团队环境', mode: 'snapshot', hosting: 'builtin', homepage: SITE, teamId: teamA!.id })
  const envId = svcA.getState().envs.find((v) => v.env.name === '团队环境')!.env.id
  check('TM.1.3 团队环境归属正确', svcA.getState().envs.find((v) => v.env.id === envId)?.teamName === 'E2E测试团')

  await svcA.openEnv(envId, true)
  const wcA = svcA.host.get(envId)!.win.webContents
  await autoLogin(wcA, 'boss')
  const whoA = await whoami(wcA)
  check('TM.1.4 A 登录测试站', whoA.loggedIn === true && whoA.user === 'boss')
  await svcA.saveBase(envId)
  await svcA.closeEnv(envId)
  await poll(async () => !svcA.host.isRunning(envId), 8000, 'A 环境关闭')
  check('TM.1.5 团队基线已上云', true)

  // ---------- TM.2 B 接受邀请 → 免登录共享 ----------
  log('—— TM.2 A 邀 B，B 免登录打开团队基线 ——')
  await svcB.register(`b-${suffix}@t.local`, 'team-pass-#1')
  await svcA.inviteMember(teamA!.id, `b-${suffix}@t.local`)
  await svcB.refreshTeams() // ws team.updated 是异步推送，显式刷新保证确定性
  const pendingB = svcB.getTeams().find((t) => t.name === 'E2E测试团')
  check('TM.2.1 B 收到待接受邀请', pendingB?.state === 'pending')
  await svcB.acceptInvite(teamA!.id)
  const activeB = svcB.getTeams().find((t) => t.name === 'E2E测试团')
  check('TM.2.2 B 接受后成为 active 成员', activeB?.state === 'active')

  const envSeenByB = svcB.getState().envs.find((v) => v.env.id === envId)
  check('TM.2.3 B 环境列表可见团队环境', !!envSeenByB && envSeenByB.teamName === 'E2E测试团')

  await svcB.openEnv(envId, true)
  const wcB = svcB.host.get(envId)!.win.webContents
  const whoB = await whoami(wcB)
  check('TM.2.4 B 免登录（团队基线经 team DEK 解封恢复）', whoB.loggedIn === true && whoB.user === 'boss')
  await svcB.closeEnv(envId)
  await poll(async () => !svcB.host.isRunning(envId), 8000, 'B 环境关闭')

  // ---------- TM.3 C 被吊销 → 断访问 ----------
  log('—— TM.3 A 吊销 C，C 断访问 ——')
  await svcC.register(`c-${suffix}@t.local`, 'team-pass-#1')
  await svcA.inviteMember(teamA!.id, `c-${suffix}@t.local`)
  await svcC.acceptInvite(teamA!.id)
  check(
    'TM.3.1 C 接受后可见团队环境',
    !!svcC.getState().envs.find((v) => v.env.id === envId)
  )
  let revoked = false
  try {
    await svcA.revokeMember(teamA!.id, await userIdOf(svcC))
    revoked = true
  } catch {
    revoked = false
  }
  check('TM.3.2 A 吊销 C 成功', revoked)
  await svcC.refreshTeams()
  await svcC.refreshEnvs()
  check(
    'TM.3.3 C 环境列表不再可见',
    !svcC.getState().envs.find((v) => v.env.id === envId)
  )
  let openDenied = false
  try {
    await svcC.openEnv(envId, true)
  } catch {
    openDenied = true
  }
  check('TM.3.4 C 打开团队环境被拒', openDenied)

  // ---------- TM.4 S3 密文抽查 ----------
  log('—— TM.4 S3 密文抽查 ——')
  const baseResp = await svcA.cloud.getBase(envId)
  if (baseResp.download) {
    const blobRaw = new TextDecoder().decode(await svcA.cloud.getObject(baseResp.download.blobUrl))
    const manifestRaw = new TextDecoder().decode(await svcA.cloud.getObject(baseResp.download.manifestUrl))
    const leaks = ['boss', 'alice', 'cookies', 'E2E测试团', 'team-']
    const looksCipher = !leaks.some((s) => blobRaw.includes(s) || manifestRaw.includes(s))
    check('TM.4.1 团队环境 S3 对象为密文（服务端零明文）', looksCipher)
  } else {
    check('TM.4.1 团队环境 S3 对象为密文', false, '无下载链接')
  }

  // DEK 轮换（owner 全覆盖路径）：旧基线不可解（安全语义）→ 冷启动 → 存新基线恢复
  await svcA.rotateTeamDek(teamA!.id)
  check('TM.5.1 DEK 轮换成功（A+B 新副本）', true)
  await svcB.refreshTeams()
  await svcB.openEnv(envId, true)
  const wcB2 = svcB.host.get(envId)!.win.webContents
  log(`  [诊断] 冷启动窗口 URL=${wcB2.getURL()}`)
  await poll(() => wcB2.executeJavaScript(`!!document.querySelector('input[name=user]')`), 15000, '冷启动登录表单')
  const whoB2 = await whoami(wcB2)
  check('TM.5.2 轮换后旧基线不可解（冷启动）', whoB2.loggedIn === false)
  await autoLogin(wcB2, 'boss')
  await svcB.saveBase(envId) // 新基线以新 team DEK 加密
  await svcB.closeEnv(envId)
  await poll(async () => !svcB.host.isRunning(envId), 8000, 'B 环境关闭（TM.5）')
  await svcB.openEnv(envId, true)
  const wcB3 = svcB.host.get(envId)!.win.webContents
  await poll(() => wcB3.executeJavaScript(`location.origin === ${JSON.stringify(SITE)}`), 8000, '页面到达站点域')
  const whoB3 = await whoami(wcB3)
  check('TM.5.3 新基线免登录恢复（新 team DEK 加解密一致）', whoB3.loggedIn === true && whoB3.user === 'boss')

  log(`\n===== E2E-Teams 完成：PASS=${pass} FAIL=${fail}（${((Date.now() - started) / 1000).toFixed(1)}s）=====`)
  svcA.logout().catch(() => {})
  svcB.logout().catch(() => {})
  svcC.logout().catch(() => {})
  return fail === 0 ? 0 : 1
}

/** 经 lookupUser 拿自己的 userId（teams 服务端未在 client 暴露 me.id） */
async function userIdOf(svc: AppService): Promise<string> {
  const email = svc.getState().account?.email
  if (!email) throw new Error('未登录')
  const u = await svc.cloud.lookupUser(email)
  return u.userId
}
