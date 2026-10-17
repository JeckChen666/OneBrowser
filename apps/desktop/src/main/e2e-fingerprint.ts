// 指纹验收 e2e（V0.2.0-S3，docs/v0.2.0-plan.md T9/T10/T11/T13）：
//   T9  kernel 指纹生效：UA/canvas ≠ 宿主机真实值，UA 按平台伪装
//   T10 同 seed 跨设备一致：两个独立内核实例的指纹逐项相同（产品核心承诺）
//   T11 不同 seed 的环境指纹隔离（canvas/CPU 核数不同）
//   T13 代理链路 + auto 时区：环境经本地 HTTP 代理访问站点（bind-ip 风控开启仍通过），
//       时区/语言与 /v1/geo 对该代理出口的推导一致
// 运行前置：server(:8787) + test-site(:18080) + Docker；测试站代理由本脚本自起（:18081）
import { execFile, spawn as spawnProcess } from 'node:child_process'
import { promisify } from 'node:util'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import { AppService } from './core/appService'
import { ensureDockerImage, FP_EXPR } from './kernel-smoke'
import type { CanSend } from './core/cdp'
import type { MainEvent } from '@shared/types'

const execFileP = promisify(execFile)

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
const PROXY_PORT = 18081

let pass = 0
let fail = 0
const log = (m: string): void => console.log(`[fp-e2e] ${m}`)
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
    throw new Error(String(res.exceptionDetails.exception?.description || 'eval 异常'))
  }
  return res.result?.value
}

async function readFp(page: CanSend): Promise<any> {
  return JSON.parse(String(await cdpEval(page, FP_EXPR)))
}

function waitTcp(port: number, timeoutMs = 15000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now()
    const tryOnce = (): void => {
      const s = net.connect(port, '127.0.0.1')
      s.once('connect', () => {
        s.destroy()
        resolve(true)
      })
      s.once('error', () => {
        s.destroy()
        if (Date.now() - start > timeoutMs) resolve(false)
        else setTimeout(tryOnce, 300)
      })
    }
    tryOnce()
  })
}

export async function runE2EFingerprint(): Promise<number> {
  const started = Date.now()
  const host = lanIp()
  log(`站点=${SITE} 服务端=${SERVER} 内核=Docker（镜像假定已存在）`)

  const emit = (e: MainEvent): void => {
    if (e.type === 'notify') log(`  [通知:${e.level}] ${e.message}`)
  }
  const svc = new AppService(SERVER, emit)
  const email = `fp-${Date.now()}@t.local`
  const password = 'fp-password-#1'
  let exitCode = 1

  try {
    await svc.register(email, password)

    // 宿主机真实指纹（builtin 默认 session，无代理）
    const realWin = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } })
    await realWin.loadURL(SITE + '/fp')
    const realFp = JSON.parse(String(await realWin.webContents.executeJavaScript(FP_EXPR)))
    realWin.destroy()
    log(`宿主真实指纹：ua=${realFp.ua.slice(0, 60)}… canvas=${realFp.canvas}`)

    // seed 必须是 32 位整数：非整数 seed 会让内核渲染进程在读取
    // navigator.hardwareConcurrency 时死锁（KI-1，docs/v0.2.0-s3-notes.md）
    const seedA = '1000000009'
    const mkEnv = (name: string, seed: string): Promise<void> =>
      svc.createEnv({
        name,
        mode: 'snapshot',
        hosting: 'kernel',
        homepage: SITE,
        seed,
        fingerprint: { platform: 'Linux' }
      })

    const openAndRead = async (name: string): Promise<any> => {
      const id = svc.getState().envs.find((v) => v.env.name === name)!.env.id
      await svc.openEnv(id)
      const ok = await poll(() => Promise.resolve(svc.kernelHost.isRunning(id)), 40000, `${name} 内核启动`)
      if (!ok) throw new Error(`${name} 内核启动失败`)
      const page = svc.kernelHost.get(id)!.page
      let lastErr = '无'
      const fp = await poll(
        async () => {
          const v = await readFp(page).catch((e) => {
            lastErr = e instanceof Error ? e.message : String(e)
            return null
          })
          return v && v.ua ? v : null
        },
        25000,
        `${name} 指纹读取`
      )
      if (!fp) {
        log(`    [readFp 失败] ${lastErr}`)
        try {
          const re0 = svc.kernelHost.get(id)
          if (re0) {
            const { listTargets } = await import('./core/cdp')
            const ts = await listTargets(re0.port)
            log(`    [现场] targets=${JSON.stringify(ts.map((t) => ({ t: t.type, u: t.url })))}`)
            const { execFile: ef } = await import('node:child_process')
            const { promisify: pf } = await import('node:util')
            const efP = pf(ef)
            const cid = (await efP('docker', ['ps', '-q', '--filter', 'name=ob-kernel']).catch(() => ({ stdout: '' }))).stdout.split('\n')[0].trim()
            if (cid) {
              const logs = await efP('docker', ['logs', '--tail', '12', cid]).catch(() => ({ stdout: 'n/a' }))
              log('    [现场] docker logs 尾部: ' + logs.stdout.replace(/\n/g, ' | '))
            }
          }
        } catch (e2) {
          log(`    [现场] 转储失败: ${e2 instanceof Error ? e2.message : e2}`)
        }
      }
      return { id, page, fp }
    }

    // T9 + T13：指纹生效 + 代理 + auto 时区/语言
    await mkEnv('T9-指纹A', seedA)
    const a = await openAndRead('T9-指纹A')
    log(`T9 内核指纹：ua=${a.fp.ua}`)
    log(`              canvas=${a.fp.canvas} gl=${a.fp.gl} / ${a.fp.glr}`)
    log(`              tz=${a.fp.tz} lang=${a.fp.lang} hc=${a.fp.hc}`)

    check('T9.1 UA 按 platform 伪装（Linux 容器上用 Linux 平台）', /Linux x86_64/.test(a.fp.ua) || /X11/.test(a.fp.ua))
    check('T9.2 UA 与宿主机不同（不再暴露真实平台）', a.fp.ua !== realFp.ua, `host=${realFp.ua.slice(0, 40)}…`)
    check('T9.3 canvas 指纹与宿主机不同', a.fp.canvas !== realFp.canvas)

    // T10：同 seed 第二个内核实例（模拟另一台设备）→ 指纹逐项一致
    await mkEnv('T10-同种子B', seedA)
    const b = await openAndRead('T10-同种子B')
    log(`T10 内核指纹：canvas=${b.fp.canvas} gl=${b.fp.gl} / ${b.fp.glr} tz=${b.fp.tz} hc=${b.fp.hc}`)
    const fields = ['ua', 'canvas', 'gl', 'glr', 'tz', 'lang', 'hc', 'mem'] as const
    const diff = fields.filter((k) => String(a.fp[k]) !== String(b.fp[k]))
    check('T10 同 seed 跨设备指纹完全一致', diff.length === 0, diff.length ? `差异字段: ${diff.join(',')}` : fields.join('/'))

    // T11：不同 seed → 隔离
    await mkEnv('T11-异种子C', '2000000011')
    const c = await openAndRead('T11-异种子C')
    check('T11.1 不同 seed 的 canvas 指纹不同', a.fp.canvas !== c.fp.canvas, `${a.fp.canvas} vs ${c.fp.canvas}`)
    check('T11.2 不同 seed 的 CPU 核数/CPU 指纹不同', a.fp.hc !== c.fp.hc || a.fp.glr !== c.fp.glr)

    // 收起 A/B/C，让 T13 的容器是唯一的 ob-kernel-*（便于 docker inspect 取参）
    for (const name of ['T9-指纹A', 'T10-同种子B', 'T11-异种子C']) {
      const id = svc.getState().envs.find((v) => v.env.name === name)?.env.id
      if (id) await svc.closeEnv(id).catch(() => undefined)
    }

    // T13：代理链路 + auto 时区/语言（自起 test-site 代理 :18081，收尾关闭）
    // 注：Docker Desktop 下容器→宿主机流量经 host 栈 NAT，代理侧来源恒为宿主机 IP，
    // 无法用「来源=容器 IP」断言；改用「代理日志含页面请求 + 站点来源非 docker VM 网段」
    const testSiteDir = path.resolve(app.getAppPath(), '../../test-site')
    const proxyBin = path.join(os.tmpdir(), 'ob-testsite-proxy')
    await execFileP('go', ['build', '-o', proxyBin, '.'], { cwd: testSiteDir, timeout: 120000 })
    // 端口被占（上次运行的残留代理）会让 waitTcp 假成功——先拒绝启动
    const stale = await new Promise<boolean>((resolve) => {
      const s = net.connect(18081, '127.0.0.1')
      s.once('connect', () => {
        s.destroy()
        resolve(true)
      })
      s.once('error', () => {
        s.destroy()
        resolve(false)
      })
    })
    if (stale) throw new Error('端口 18081 被占用（残留的测试代理？请先清理）')
    let proxyLog = ''
    const proxyProc = spawnProcess(proxyBin, [], {
      env: { ...process.env, PROXY_LISTEN: ':18081' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    proxyProc.stdout!.on('data', (c) => (proxyLog += c.toString()))
    proxyProc.stderr!.on('data', (c) => (proxyLog += c.toString()))
    try {
      const portUp = await waitTcp(18081, 10000)
      if (!portUp || proxyProc.exitCode !== null) throw new Error('测试代理未就绪（:18081）')
      // 与 AppService.geoLookup 同路径：经代理查 /v1/geo，取 auto 模式应有的推导值
      const geoRaw = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(18081, '127.0.0.1', () => {
          socket.write(`GET ${SERVER}/v1/geo HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nConnection: close\r\n\r\n`)
        })
        socket.setTimeout(5000, () => {
          socket.destroy()
          reject(new Error('geo 经代理解析超时'))
        })
        let data = ''
        socket.on('data', (chunk) => (data += chunk.toString()))
        socket.on('end', () => resolve(data))
        socket.on('error', reject)
      })
      const geo = JSON.parse(geoRaw.slice(geoRaw.indexOf('\r\n\r\n') + 4)) as { timezone: string; lang: string }
      log(`T13 geo（经代理）：tz=${geo.timezone} lang=${geo.lang}`)

      await svc.createEnv({
        name: 'T13-代理D',
        mode: 'snapshot',
        hosting: 'kernel',
        homepage: `${SITE}/fp`,
        seed: '1500000013',
        proxy: { scheme: 'http', host, port: PROXY_PORT },
        fingerprint: { platform: 'Windows', timezoneMode: 'auto', langMode: 'auto' }
      })
      const d = await openAndRead('T13-代理D')
      const remoteAddr = String(
        await cdpEval(d.page, 'document.body.innerText.match(/RemoteAddr[^0-9]*([0-9a-f.:]+)/)?.[1] || ""')
      )
      log(`T13 页面指纹：tz=${d.fp.tz} lang=${d.fp.lang}；/fp RemoteAddr=${remoteAddr}`)

      // 内核进程实参：--proxy-server + auto 推导的 --timezone/--accept-lang
      const cid = (await execFileP('docker', ['ps', '-q', '--filter', 'name=ob-kernel-'])).stdout.trim().split('\n')[0]
      const cmdArgs = cid
        ? (JSON.parse((await execFileP('docker', ['inspect', '--format', '{{json .Config.Cmd}}', cid])).stdout) as string[])
        : []
      const has = (flag: string): boolean => cmdArgs.some((x) => x === flag || x.startsWith(flag + '='))
      check('T13.1 内核经代理启动（--proxy-server）', has(`--proxy-server=http://${host}:${PROXY_PORT}`))
      check(
        'T13.2 auto 时区/语言注入内核参数（与 /v1/geo 经代理推导一致）',
        has(`--timezone=${geo.timezone}`) && (has(`--accept-lang=${geo.lang}`) || has(`--lang=${geo.lang}`)),
        `期望 --timezone=${geo.timezone} --accept-lang=${geo.lang}`
      )
      check(
        'T13.3 页面请求确实经代理（代理日志含 /fp 请求；站点来源非 docker VM 直连网段）',
        proxyLog.includes(`GET ${SITE}/fp`) && !remoteAddr.startsWith('192.168.65.'),
        `代理日志见 ${SITE}/fp=${proxyLog.includes(`GET ${SITE}/fp`)}；RemoteAddr=${remoteAddr}`
      )
      check(
        'T13.4 页面侧 Intl 时区/语言与 geo 推导一致',
        d.fp.tz === geo.timezone && d.fp.lang === geo.lang,
        `页面 tz=${d.fp.tz} lang=${d.fp.lang}`
      )

      const dId = svc.getState().envs.find((v) => v.env.name === 'T13-代理D')?.env.id
      if (dId) await svc.closeEnv(dId).catch(() => undefined)
    } finally {
      proxyProc.kill()
    }

    exitCode = fail === 0 ? 0 : 1
    await svc.logout().catch(() => undefined)
  } catch (e) {
    log(`异常终止: ${e instanceof Error ? e.message : e}`)
    exitCode = 1
  } finally {
    log(`\n===== fp-e2e 完成：PASS=${pass} FAIL=${fail}（${((Date.now() - started) / 1000).toFixed(1)}s）=====`)
  }
  return exitCode
}
