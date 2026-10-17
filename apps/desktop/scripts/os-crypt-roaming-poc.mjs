// M6 预研 PoC：os_crypt 可漫游性验证（Linux 内核容器，basic password store）
// 思路：容器 A 写入持久 cookie → 优雅关闭（Cookies SQLite 落盘，os_crypt 加密）
//       → 拷出 DB 文件 → 拷入全新容器 B 的同名 profile 路径 → B 重启后能否解密读回。
// 值一致 = 同构内核间 Cookie 文件可直接漫游（M6 文件级快照的前提）。
// 用法: node scripts/os-crypt-roaming-poc.mjs
import WebSocket from 'ws'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const SITE = process.env.ONEBROWSER_SITE || 'http://192.168.31.220:18080'
const IMAGE = 'onebrowser-kernel-smoke'
const HOSTNAME = new URL(SITE).hostname
// 必须是持久 cookie（带 expires）：无 expires 的会话 cookie 重启即被丢弃，
// 那是 cookie 语义而非加密问题——早期 PoC 版本曾因此得出错误的失败结论
const COOKIE = {
  name: 'poc_roam', value: 'roam-ok-12345', domain: HOSTNAME, path: '/', secure: false,
  expires: Math.floor(Date.now() / 1000) + 86400
}

const step = (m) => console.log(`[poc] ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function waitTcp(port, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const start = Date.now()
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1')
      s.once('connect', () => { s.destroy(); resolve(true) })
      s.once('error', () => {
        s.destroy()
        if (Date.now() - start > timeoutMs) resolve(false)
        else setTimeout(tryOnce, 300)
      })
    }
    tryOnce()
  })
}

/** 每容器一条持久 browser-level ws（每次调用新开 ws 的写法在 attach 上不可靠） */
class KernelCdp {
  constructor(port) {
    this.port = port
  }
  async connect() {
    let ver = null
    for (let i = 0; i < 60 && !ver; i++) {
      try {
        ver = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json()
      } catch {
        await sleep(500)
      }
    }
    if (!ver) throw new Error('CDP /json/version 未就绪')
    this.ws = new WebSocket(ver.webSocketDebuggerUrl, { perMessageDeflate: false })
    await new Promise((r, j) => { this.ws.once('open', r); this.ws.once('error', j) })
    this.mid = 0
    this.pending = new Map()
    this.ws.on('message', (raw) => {
      const m = JSON.parse(String(raw))
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
      }
    })
    return this
  }
  send(method, params = {}, sessionId, ms = 20000) {
    return new Promise((resolve, reject) => {
      const id = ++this.mid
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`超时: ${method}`))
        }
      }, ms)
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  close() {
    try { this.ws.close() } catch { /* ignore */ }
  }
  /** 找已离开 about:blank 的初始 tab 并 attach（与产品 cdp.ts attachPage 同语义） */
  async attachPage() {
    let lastErr = null
    for (let i = 0; i < 30; i++) {
      try {
        const targets = await this.send('Target.getTargets')
        const page = targets.targetInfos.find((t) => t.type === 'page' && t.url && !t.url.startsWith('about:'))
        if (!page) throw new Error('初始 tab 尚未离开 about:blank')
        const { sessionId } = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }, undefined, 10000)
        return sessionId
      } catch (e) {
        lastErr = e
        await sleep(500)
      }
    }
    throw lastErr
  }
  async readCookie(name) {
    const sess = await this.attachPage()
    const got = await this.send('Storage.getCookies', {}, sess)
    return (got.cookies || []).find((c) => c.name === name)
  }
}

async function runKernel(name, port, dataDir, seed) {
  await execFileP('docker', ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:9223`, IMAGE,
    `--user-data-dir=${dataDir}`, `--fingerprint=${seed}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', SITE])
  if (!(await waitTcp(port))) throw new Error(`${name} CDP 端口未就绪`)
  return new KernelCdp(port).connect()
}

async function main() {
  // --- 容器 A：写入持久 cookie，优雅关闭落盘 ---
  step('启动容器 A（profile=/tmp/poc-a）')
  const cdpA = await runKernel('poc-a', 19301, '/tmp/poc-a', '777777')
  const sessA = await cdpA.attachPage()
  await cdpA.send('Storage.setCookies', { cookies: [COOKIE] }, sessA)
  const inA = await cdpA.readCookie(COOKIE.name)
  step(`A 读回（内存态）: ${inA?.value}`)
  cdpA.close()
  step('优雅关闭浏览器（Browser.close → 落盘）并停止容器')
  // Browser.close 需要在 ws 关闭前发——重连一次专用于关闭
  const cdpClose = await new KernelCdp(19301).connect()
  await cdpClose.send('Browser.close', {}, undefined, 15000).catch(() => undefined)
  cdpClose.close()
  await sleep(3000)
  await execFileP('docker', ['stop', '-t', '4', 'poc-a']).catch(() => undefined)

  // --- 拷出 Cookies SQLite（新版本在 Default/Network/Cookies） ---
  step('拷出 Cookies SQLite')
  const local = '/tmp/poc-Cookies'
  let dbPath = null
  for (const p of ['/tmp/poc-a/Default/Network/Cookies', '/tmp/poc-a/Default/Cookies']) {
    if (await execFileP('docker', ['cp', `poc-a:${p}`, local]).then(() => true, () => false)) {
      dbPath = p
      break
    }
  }
  if (!dbPath) throw new Error('未找到 Cookies 文件')
  step(`Cookies 文件: ${dbPath}（${(await execFileP('stat', ['-f%z', local])).stdout.trim()} bytes）`)

  // 密文形态：v10 前缀（os_crypt）；host_key/name 为明文列
  const bin = (await execFileP('xxd', [local])).stdout.replace(/\s+/g, '')
  const hasV10 = bin.includes('763130') // "v10" 的 hex（全文件扫描）
  const hasPlainName = (await execFileP('strings', [local])).stdout.includes(COOKIE.name)
  step(`DB 含 v10 密文前缀=${hasV10}；cookie 名明文列=${hasPlainName}`)

  // --- 容器 B：全新 profile 启动一次生成结构 → 注入 A 的 Cookies → 重启读回 ---
  step('启动容器 B（全新 profile=/tmp/poc-b）')
  const cdpB1 = await runKernel('poc-b', 19302, '/tmp/poc-b', '888888')
  cdpB1.close()
  const cdpB1c = await new KernelCdp(19302).connect()
  await cdpB1c.send('Browser.close', {}, undefined, 15000).catch(() => undefined)
  cdpB1c.close()
  await sleep(3000)
  await execFileP('docker', ['stop', '-t', '4', 'poc-b']).catch(() => undefined)

  step('把 A 的 Cookies 文件注入 B 的 profile 同路径')
  const dbPathB = dbPath.replace('poc-a', 'poc-b')
  await execFileP('docker', ['cp', local, `poc-b:${dbPathB}`])

  step('重启容器 B，尝试解密读回')
  await execFileP('docker', ['start', 'poc-b'])
  if (!(await waitTcp(19302))) throw new Error('容器 B 重启后 CDP 端口未就绪')
  await sleep(2000)
  const cdpB2 = await new KernelCdp(19302).connect()
  const inB = await cdpB2.readCookie(COOKIE.name)
  cdpB2.close()

  console.log('')
  if (inB?.value === COOKIE.value) {
    console.log('[poc] ✅ PASS：B（全新容器/异 seed）完整解密读回了 A 落盘的持久 cookie')
    console.log('[poc]    → Linux 内核 os_crypt 密钥镜像内固定，Cookie/SQLite 文件可直接漫游；')
    console.log('[poc]      M6 文件级快照（L2）在同构内核间成立，无需 os_crypt 补丁。')
    process.exit(0)
  } else {
    console.log(`[poc] ❌ FAIL：B 读回=${JSON.stringify(inB)}（未解密或丢失）`)
    process.exit(1)
  }
}

main()
  .catch((e) => { console.error('[poc] 失败:', e.message || e); process.exitCode = 1 })
  .finally(async () => {
    await execFileP('docker', ['rm', '-f', 'poc-a', 'poc-b']).catch(() => undefined)
  })
