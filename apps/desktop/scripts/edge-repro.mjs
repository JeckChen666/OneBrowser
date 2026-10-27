import { spawn } from 'node:child_process'
import WebSocket from 'ws'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const UD = 'C:/temp/ob-edge-repro'
const PORT = 9780
const proc = spawn(EDGE, [
  `--user-data-dir=${UD}`, '--onebrowser-hosting=browser', '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking',
  `--remote-debugging-port=${PORT}`, 'http://127.0.0.1:18080/fp'
], { stdio: 'ignore' })
proc.on('exit', (c, s) => console.log('[spawn-proc EXIT]', c, s))
console.log('[spawn pid]', proc.pid)

const wait = (ms) => new Promise(r => setTimeout(r, ms))
async function waitEndpoint() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); return } catch {}
    await wait(500)
  }
  throw new Error('endpoint timeout')
}
await waitEndpoint()
console.log('[endpoint up]')

let ws, targetId
const targets = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
for (let i = 0; i < 24; i++) {
  const ts = await targets()
  const page = ts.find(t => t.type === 'page')
  console.log(`[t${i}] targets=${ts.length} pages=${ts.filter(t=>t.type==='page').length} page-url=${page?.url?.slice(0,50)}`)
  if (page && page.url.includes('/fp')) {
    if (!ws) {
      targetId = page.id
      ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
      ws.on('open', () => console.log('[page ws open]'))
      ws.on('close', (c, r) => console.log('[page ws CLOSE]', c, r?.toString()))
      ws.on('error', (e) => console.log('[page ws ERR]', e.message))
    }
  }
  if (ws && ws.readyState === 1) {
    // keepalive probe
  }
  if (proc.exitCode !== null) { console.log('[browser proc EXITED mid-loop]'); break }
  await wait(500)
}
console.log('[final] browser proc exitCode =', proc.exitCode, '| spawned still alive =', proc.exitCode === null)
process.exit(0)
