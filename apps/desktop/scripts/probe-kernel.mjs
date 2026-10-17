// KI-1 探针：裸 Node（不经 Electron）连容器 CDP，执行指纹读取，报告是否挂死
// 用法: node scripts/probe-kernel.mjs <port> [label]
import WebSocket from 'ws'

const port = Number(process.argv[2] || 9223)
const label = process.argv[3] || `port-${port}`
// PROBE_EXPR：覆盖测试表达式；PROBE_NEWTAB：先开新标签页到该 URL 再测；PROBE_TIMEOUT_MS：evaluate 超时
const CUSTOM_EXPR = process.env.PROBE_EXPR
const NEWTAB_URL = process.env.PROBE_NEWTAB
const EVAL_TIMEOUT = Number(process.env.PROBE_TIMEOUT_MS || 25000)
const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(`超时: ${what} ${ms}ms`)), ms))

const t0 = Date.now()
const step = (m) => console.log(`[${label} +${Date.now() - t0}ms] ${m}`)

const FP_EXPR = `(() => {
  function djb2(s){let h=5381;for(let i=0;i<s.length;i++){h=((h<<5)+h+s.charCodeAt(i))|0}return (h>>>0).toString(16)}
  const cv=document.createElement('canvas');cv.width=220;cv.height=40;const ctx=cv.getContext('2d');
  ctx.textBaseline='top';ctx.font='16px Arial';ctx.fillStyle='#f60';ctx.fillRect(10,5,80,20);
  ctx.fillStyle='#069';ctx.fillText('OneBrowser,fp',15,10);ctx.fillStyle='rgba(102,204,0,.7)';ctx.fillText('OneBrowser,fp',15,20);
  let gl='-',glr='-';
  try{const g=document.createElement('canvas').getContext('webgl');
  const e=g.getExtension('WEBGL_debug_renderer_info');
  gl=e?g.getParameter(e.UNMASKED_VENDOR_WEBGL):g.getParameter(g.VENDOR);
  glr=e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER)}catch(err){}
  return JSON.stringify({ua:navigator.userAgent,canvas:'0x'+djb2(cv.toDataURL()),gl,glr,hc:navigator.hardwareConcurrency})
})()`

try {
  // 1. 等 endpoint
  let ver = null
  for (let i = 0; i < 90 && !ver; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      ver = await r.json()
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  if (!ver) throw new Error('CDP endpoint 未就绪')
  step(`browser ws 就绪 webSocketDebuggerUrl=${ver.Browser}`)

  // 2. browser-level 连接 + attach 首个 page target（与产品 cdp.ts 同构）
  const ws = new WebSocket(ver.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((res, rej) => {
    ws.once('open', res)
    ws.once('error', rej)
  })
  step('WebSocket open')

  let mid = 0
  const pending = new Map()
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++mid
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
    }
  })
  const cmd = (method, params, sessionId, ms = 20000) =>
    Promise.race([send(method, params, sessionId), timeout(ms, method)])

  // 3. 找 page target
  let targets = await cmd('Target.getTargets')
  let page = targets.targetInfos.find((t) => t.type === 'page')
  if (!page) throw new Error('无 page target: ' + JSON.stringify(targets.targetInfos.map((t) => ({ t: t.type, u: t.url }))))
  step(`page target url=${page.targetId} ${page.url}`)
  const { sessionId } = await cmd('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  step(`attached sessionId=${sessionId.slice(0, 8)}…`)
  await cmd('Page.enable', {}, sessionId)

  // 可选：新开标签页到指定 URL 并等它加载，然后测那个页面
  let testSession = sessionId
  if (NEWTAB_URL) {
    const { targetId } = await cmd('Target.createTarget', { url: NEWTAB_URL })
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500))
      const ts = await cmd('Target.getTargets')
      const t = ts.targetInfos.find((x) => x.targetId === targetId)
      if (t && t.url !== 'about:blank' && !NEWTAB_URL.startsWith('about:')) break
      if (t && NEWTAB_URL.startsWith('about:')) break
    }
    const a2 = await cmd('Target.attachToTarget', { targetId, flatten: true })
    testSession = a2.sessionId
    await cmd('Page.enable', {}, testSession)
    step(`新标签页 attached: ${targetId.slice(0, 8)}…`)
  }

  // 4. evaluate（若页面已非 about:blank 则直接读）
  const res = await cmd('Runtime.evaluate', { expression: CUSTOM_EXPR || FP_EXPR, returnByValue: true }, testSession, EVAL_TIMEOUT)
  if (CUSTOM_EXPR) {
    step(`自定义表达式结果: ${JSON.stringify(res.result?.value ?? res.result).slice(0, 300)}`)
  } else {
    const fp = JSON.parse(String(res.result?.value))
    step(`指纹读取成功 ua=${String(fp.ua).slice(0, 50)}… canvas=${fp.canvas} glr=${fp.glr}`)
  }
  console.log(`[${label}] ✅ PASS`)
  ws.close()
  process.exit(0)
} catch (e) {
  console.log(`[${label}] ❌ FAIL: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
}
