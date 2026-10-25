// 内核指纹冒烟（V0.2.0-S1 出口标准）：
//   1) 内核就绪（必要时下载 fingerprint-chromium 官方预编译产物）
//   2) 以两个不同 seed spawn 内核，经 CDP 读取指纹值
//   断言：UA 已按 platform 伪装（≠宿主机）；不同 seed 的 canvas 指纹不同（种子隔离）
//
// runKernelSmokeDocker：本机无法原生运行 mac 预编译内核（arm64）时，
// 用 Linux x64 产物 + Docker(Xvfb) 验证同样的内核行为与 CDP 数据面。
import type { AppService } from './core/appService'
import { ExternalKernelHost } from './core/externalKernelHost'
import { snapCookieToCdp } from './core/externalKernelHost'
import { NativeKernelLauncher } from './core/kernelLauncher'
import type { CanSend } from './core/cdp'
import { attachPage, waitEndpoint } from './core/cdp'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { freePort } from './core/kernelManager'
import type { EnvConfig } from '@shared/types'

const execFileP = promisify(execFileCb)

/** 宿主机局域网 IP：Docker 内核在容器内访问宿主测试站（127.0.0.1 容器内不可达） */
function lanIp(): string {
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address
    }
  }
  return '127.0.0.1'
}

const SITE = process.env.ONEBROWSER_SITE || `http://${lanIp()}:18080`

let pass = 0
let fail = 0
const log = (m: string): void => console.log(`[kernel-smoke] ${m}`)
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

const FP_EXPR = `(() => {
  function djb2(s){let h=5381;for(let i=0;i<s.length;i++){h=((h<<5)+h+s.charCodeAt(i))|0}return (h>>>0).toString(16)}
  const cv=document.createElement('canvas');cv.width=220;cv.height=40;const ctx=cv.getContext('2d');
  ctx.textBaseline='top';ctx.font='16px Arial';ctx.fillStyle='#f60';ctx.fillRect(10,5,80,20);
  ctx.fillStyle='#069';ctx.fillText('OneBrowser,fp',15,10);ctx.fillStyle='rgba(102,204,0,.7)';ctx.fillText('OneBrowser,fp',15,20);
  let gl='-',glr='-',tz='-',lang='-',mem='-';
  try{const g=document.createElement('canvas').getContext('webgl');
  const e=g.getExtension('WEBGL_debug_renderer_info');
  gl=e?g.getParameter(e.UNMASKED_VENDOR_WEBGL):g.getParameter(g.VENDOR);
  glr=e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER)}catch(err){}
  try{tz=Intl.DateTimeFormat().resolvedOptions().timeZone;lang=navigator.language;mem=navigator.deviceMemory}catch(err){}
  return JSON.stringify({ua:navigator.userAgent,canvas:'0x'+djb2(cv.toDataURL()),gl,glr,
    tz,lang,mem,hc:navigator.hardwareConcurrency})
})()`

export { FP_EXPR }

// 注：容器内核上 Intl/locale 类读取曾存在挂死问题（KI-2），根因与 KI-1 同源——
// 非法 seed；seed 校验修复后 Intl 读取恢复稳定（V0.2.0-S4 验证），字段已全部恢复
interface Fp {
  ua: string
  canvas: string
  gl: string
  glr: string
  hc: number
}

async function readFp(page: CanSend): Promise<Fp> {
  const res = await page.send('Runtime.evaluate', { expression: FP_EXPR, returnByValue: true })
  return JSON.parse(String(res.result?.value))
}

function mockEnv(id: string, seed: string): EnvConfig {
  return {
    id,
    name: `smoke-${id}`,
    mode: 'snapshot',
    hosting: 'kernel',
    homepage: `${SITE}/fp`,
    seed,
    createdAt: '',
    updatedAt: ''
  }
}

async function waitExit(host: ExternalKernelHost, envId: string): Promise<void> {
  for (let i = 0; i < 40 && host.isRunning(envId); i++) await sleep(250)
}

export async function runKernelSmoke(svc: AppService): Promise<number> {
  const started = Date.now()

  log('确保指纹内核就绪（首次运行将下载官方预编译产物）…')
  const info = await svc.kernelManager.ensureReady()
  log(`内核：v${info.version}（${info.source}）→ ${info.exePath}`)
  check('内核就绪', !!info.exePath)

  const host = new ExternalKernelHost(new NativeKernelLauncher(async () => info.exePath!))

  // 实例 A：seed=11111111，伪装 Windows
  const envA = mockEnv('smoke-a', '11111111')
  const reA = await host.open(envA, { fingerprint: { seed: envA.seed, platform: 'Windows' } })
  if (reA.kind !== 'kernel') throw new Error('预期 kernel 承载')
  await sleep(2500) // 等首页 /fp 渲染
  const fpA = await readFp(reA.page)
  log(`A 指纹：ua=${fpA.ua}`)
  log(`          canvas=${fpA.canvas} gl=${fpA.gl} / ${fpA.glr} hc=${fpA.hc}`)
  host.closeWindow('smoke-a')
  await waitExit(host, 'smoke-a')

  // 实例 B：seed=22222222，同样伪装 Windows
  const envB = mockEnv('smoke-b', '22222222')
  const reB = await host.open(envB, { fingerprint: { seed: envB.seed, platform: 'Windows' } })
  if (reB.kind !== 'kernel') throw new Error('预期 kernel 承载')
  await sleep(2500)
  const fpB = await readFp(reB.page)
  log(`B 指纹：ua=${fpB.ua}`)
  log(`          canvas=${fpB.canvas} gl=${fpB.gl} / ${fpB.glr} hc=${fpB.hc}`)
  host.closeWindow('smoke-b')
  await waitExit(host, 'smoke-b')

  // 断言
  check('UA 按 platform 伪装为 Windows', /Windows NT/.test(fpA.ua) && /Windows NT/.test(fpB.ua))
  check(
    'UA 不再暴露宿主机（macOS）',
    !/Mac OS X/.test(fpA.ua) && !/Macintosh/.test(fpA.ua),
    `host=darwin`
  )
  check('不同 seed 的 canvas 指纹不同（环境隔离）', fpA.canvas !== fpB.canvas)
  check('canvas 指纹已生效（非空）', fpA.canvas.length > 4 && fpB.canvas.length > 4)
  check('WebGL 指纹可读', fpA.gl !== '-' || fpA.glr !== '-')

  log(`\n===== kernel-smoke 完成：PASS=${pass} FAIL=${fail}（${((Date.now() - started) / 1000).toFixed(1)}s）=====`)
  return fail === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------
// Docker 版：本机（Intel mac）无可用原生内核时，用 Linux x64 产物验证内核行为
// ---------------------------------------------------------------------------

const IMAGE = 'onebrowser-kernel-smoke'

function dockerDir(): string {
  // dev 模式：app.getAppPath() = apps/desktop → 仓库根/scripts/kernel-docker
  return path.resolve(app.getAppPath(), '../../scripts/kernel-docker')
}

export async function ensureDockerImage(): Promise<void> {
  const dir = dockerDir()
  if (!fs.existsSync(path.join(dir, 'entrypoint.sh'))) throw new Error(`未找到 ${dir}`)
  // 镜像已存在则直接复用：docker build 每次都要上传 ~500MB 构建上下文（Windows 命名管道
  // 下实测 10 分钟以上），每个 kernel e2e 都会调本函数，无条件重建不可接受。
  // 更换内核版本（fetch.sh 的 VERSION）属显式操作：docker rmi 后重跑即重建。
  const have = await execFileP('docker', ['image', 'inspect', IMAGE]).then(
    () => true,
    () => false
  )
  if (have) {
    log(`复用已有镜像 ${IMAGE}`)
    return
  }
  const kernelBin = findKernelBin(path.join(dir, 'kernel'))
  if (!kernelBin) {
    log('拉取 Linux x64 内核产物（fetch.sh）…')
    await execFileP('bash', [path.join(dir, 'fetch.sh')], { timeout: 15 * 60000 })
  }
  log('构建 Docker 镜像…')
  await execFileP('docker', ['build', '-q', '-t', IMAGE, dir], { timeout: 10 * 60000 })
}

/** 目录内递归找内核可执行文件（替代原 `find` 命令：Windows Electron 的 PATH 里
 *  System32 find.exe 不是 GNU find，bash/find 仅 Git Bash 环境可靠） */
function findKernelBin(dir: string): string | null {
  if (!fs.existsSync(dir)) return null
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      const hit = findKernelBin(full)
      if (hit) return hit
    } else if (e.name === 'chrome' || e.name === 'chromium') {
      return full
    }
  }
  return null
}

interface DockerKernel {
  name: string
  port: number
}

async function startDockerKernel(name: string, seed: string, platform: string, tz?: string): Promise<DockerKernel> {
  const port = await freePort()
  // headful CDP 只绑容器 127.0.0.1:9222，入口用 socat 转发到 0.0.0.0:9223
  const args = ['run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${port}:9223`, IMAGE,
    `--user-data-dir=/tmp/ks-${seed}`, `--fingerprint=${seed}`, `--fingerprint-platform=${platform}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    `${SITE}/`]
  if (tz) args.push(`--timezone=${tz}`)
  await execFileP('docker', args)
  await waitEndpoint(port, 45000)
  return { name, port }
}

async function stopDockerKernel(k: DockerKernel): Promise<void> {
  await execFileP('docker', ['rm', '-f', k.name]).catch(() => undefined)
}

export async function runKernelSmokeDocker(): Promise<number> {
  const started = Date.now()
  await ensureDockerImage()

  let kA: DockerKernel | null = null
  let kB: DockerKernel | null = null
  try {
    kA = await startDockerKernel('ob-ks-a', '11111111', 'Windows')
    const connA = await attachPage(kA.port)
    await connA.session.send('Page.enable')
    const fpA = await readFp(connA.session)
    log(`A 指纹：ua=${fpA.ua}`)
    log(`          canvas=${fpA.canvas} gl=${fpA.gl} / ${fpA.glr} hc=${fpA.hc}`)

    // T10：同 seed 第二个内核实例（模拟另一台设备）→ 指纹逐项一致
    const kA2 = await startDockerKernel('ob-ks-a2', '11111111', 'Windows')
    try {
      const connA2 = await attachPage(kA2.port)
      await connA2.session.send('Page.enable')
      await sleep(2500)
      const fpA2 = await readFp(connA2.session)
      connA2.conn.close()
      const t10Fields = ['ua', 'canvas', 'gl', 'glr', 'hc'] as const
      const t10Diff = t10Fields.filter((k) => String((fpA as unknown as Record<string, unknown>)[k]) !== String((fpA2 as unknown as Record<string, unknown>)[k]))
      check('T10 同 seed 跨设备指纹完全一致', t10Diff.length === 0, t10Diff.length ? `差异: ${t10Diff.join(',')}` : t10Fields.join('/'))
      log(`T10 第二实例：canvas=${fpA2.canvas} gl=${fpA2.glr} hc=${fpA2.hc}`)
    } finally {
      await stopDockerKernel(kA2)
    }

    // CDP 数据面：cookie 写入→读出 round-trip（复用产品代码的映射函数）
    await connA.session.send('Storage.setCookies', {
      cookies: [snapCookieToCdp({ name: 'ob_smoke', value: 'ok-123', domain: '127.0.0.1', path: '/', secure: false, httpOnly: true, sameSite: 'lax' })]
    })
    const got = await connA.session.send('Storage.getCookies', {})
    const found = (got.cookies || []).some((c: { name: string; value: string }) => c.name === 'ob_smoke' && c.value === 'ok-123')
    check('CDP cookie 数据面 round-trip（含 HttpOnly）', found)
    connA.conn.close()

    kB = await startDockerKernel('ob-ks-b', '22222222', 'Windows')
    const connB = await attachPage(kB.port)
    await connB.session.send('Page.enable')
    const fpB = await readFp(connB.session)
    log(`B 指纹：ua=${fpB.ua}`)
    log(`          canvas=${fpB.canvas} gl=${fpB.gl} / ${fpB.glr} hc=${fpB.hc}`)
    connB.conn.close()

    check('UA 按 platform 伪装为 Windows', /Windows NT/.test(fpA.ua) && /Windows NT/.test(fpB.ua))
    check('UA 不暴露 Linux 容器宿主', !/Linux x86_64/.test(fpA.ua) || /Windows NT/.test(fpA.ua))
    check('不同 seed 的 canvas 指纹不同（环境隔离）', fpA.canvas !== fpB.canvas)
    check('canvas 指纹已生效（非空）', fpA.canvas.length > 4 && fpB.canvas.length > 4)
    check('WebGL 指纹可读', fpA.gl !== '-' || fpA.glr !== '-')
  } finally {
    if (kA) await stopDockerKernel(kA)
    if (kB) await stopDockerKernel(kB)
  }

  log(`\n===== kernel-smoke(docker) 完成：PASS=${pass} FAIL=${fail}（${((Date.now() - started) / 1000).toFixed(1)}s）=====`)
  return fail === 0 ? 0 : 1
}
