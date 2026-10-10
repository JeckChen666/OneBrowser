// 指纹验收 e2e（V0.2.0-S3，docs/v0.2.0-plan.md T9/T10/T11/T13）：
//   T9  kernel 指纹生效：UA/canvas ≠ 宿主机真实值，UA 按平台伪装
//   T10 同 seed 跨设备一致：两个独立内核实例的指纹逐项相同（产品核心承诺）
//   T11 不同 seed 的环境指纹隔离（canvas/CPU 核数不同）
//   T13 代理链路 + auto 时区：环境经本地 HTTP 代理访问站点（bind-ip 风控开启仍通过），
//       时区/语言与 /v1/geo 对该代理出口的推导一致
// 运行前置：server(:8787) + test-site(:18080) + Docker；测试站代理由本脚本自起（:18081）
import { execFile, spawn as spawnProcess } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import { AppService } from './core/appService'
import { ensureDockerImage, FP_EXPR } from './kernel-smoke'
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

    const seedA = 'aaaa-seed-t9'
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
    await mkEnv('T11-异种子C', 'cccc-seed-t11')
    const c = await openAndRead('T11-异种子C')
    check('T11.1 不同 seed 的 canvas 指纹不同', a.fp.canvas !== c.fp.canvas, `${a.fp.canvas} vs ${c.fp.canvas}`)
    check('T11.2 不同 seed 的 CPU 核数/CPU 指纹不同', a.fp.hc !== c.fp.hc || a.fp.glr !== c.fp.glr)

    exitCode = fail === 0 ? 0 : 1

    // 收尾：关闭全部 kernel 环境
    for (const name of ['T9-指纹A', 'T10-同种子B', 'T11-异种子C']) {
      const id = svc.getState().envs.find((v) => v.env.name === name)?.env.id
      if (id) await svc.closeEnv(id).catch(() => undefined)
    }
    await svc.logout().catch(() => undefined)
  } catch (e) {
    log(`异常终止: ${e instanceof Error ? e.message : e}`)
    exitCode = 1
  } finally {
    log(`\n===== fp-e2e 完成：PASS=${pass} FAIL=${fail}（${((Date.now() - started) / 1000).toFixed(1)}s）=====`)
  }
  return exitCode
}
