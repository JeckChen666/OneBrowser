// --screenshot 模式：加载管理窗口 → （可选）注册临时账号进入主界面 → 截图保存 → 退出
// 路径由入口模块传入（本文件可能被分割打包到 chunks/，自身相对路径不可靠）
import { BrowserWindow, app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** capturePage 在合成器未出帧时会抛 UnknownVizError（打包形态实测）：小退避重试 */
async function capturePng(win: BrowserWindow): Promise<Buffer> {
  let last: unknown
  for (let i = 0; i < 5; i++) {
    try {
      return (await win.webContents.capturePage()).toPNG()
    } catch (e) {
      last = e
      await sleep(500)
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

/**
 * 取「当前 DOM 状态下」的画面：
 * ① 帧订阅（确定性最好；打包软渲染/窗口遮挡场景实测可能无帧）；
 * ② 兜底反复 capturePage，直至连续两次字节一致（帧流沉降）或次数耗尽。
 */
function subscriptionPng(win: BrowserWindow, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (buf: Buffer | null): void => {
      if (settled) return
      settled = true
      try {
        win.webContents.endFrameSubscription()
      } catch {
        /* ignore */
      }
      resolve(buf)
    }
    try {
      win.webContents.beginFrameSubscription(true, (image) => finish(image.toPNG()))
      win.webContents.invalidate() // 强制重绘一帧
    } catch {
      finish(null)
    }
    setTimeout(() => finish(null), timeoutMs)
  })
}

async function captureFreshPng(win: BrowserWindow): Promise<{ png: Buffer; via: 'frame-sub' | 'settle' }> {
  const sub = await subscriptionPng(win, 2500)
  if (sub) return { png: sub, via: 'frame-sub' }
  let prev: Buffer | null = null
  for (let i = 0; i < 6; i++) {
    win.moveTop()
    win.webContents.invalidate()
    await sleep(700)
    try {
      const cur = (await win.webContents.capturePage()).toPNG()
      if (prev && cur.equals(prev)) return { png: cur, via: 'settle' }
      prev = cur
    } catch {
      /* UnknownVizError 等：下一轮再试 */
    }
  }
  if (prev) return { png: prev, via: 'settle' }
  throw new Error('取帧失败：订阅无帧且 capturePage 连续异常')
}

export async function captureManager(
  preloadPath: string,
  rendererPath: string,
  outPath: string,
  loginAs?: { email: string; password: string },
  onWindow?: (win: BrowserWindow) => void
): Promise<void> {
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    show: true,
    title: 'OneBrowser (screenshot smoke)',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  onWindow?.(win)
  await win.loadFile(rendererPath)
  await new Promise((r) => setTimeout(r, 1500))
  if (loginAs) {
    const probe = await win.webContents.executeJavaScript(`typeof window.ob`)
    console.log(`[screenshot] window.ob = ${probe}`)
    try {
      await win.webContents.executeJavaScript(
        `window.ob.register(${JSON.stringify(loginAs.email)}, ${JSON.stringify(loginAs.password)}).then(() => 'ok')`
      )
      const domState = await win.webContents.executeJavaScript(
        `JSON.stringify({ page: document.querySelector('.login-wrap') ? 'login' : (document.querySelector('.envs-page') ? 'envs' : 'other'),
            notifications: document.querySelectorAll('.el-notification').length,
            title: document.title, bodyStart: document.body.className })`
      )
      const apiState = await win.webContents.executeJavaScript(`window.ob.getState().then(s => JSON.stringify({account: s.account, envs: s.envs.length}))`)
      console.log(`[screenshot] dom=${domState} api=${apiState}`)
    } catch (e) {
      console.log(`[screenshot] register 失败: ${e instanceof Error ? e.message : String(e)}`)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  const image = await capturePng(win)
  fs.writeFileSync(outPath, image)
  console.log(`[screenshot] 已保存 ${outPath} (${image.length} bytes)`)
  win.destroy()
  app.exit(0)
}

// --screenshot-tour 模式：注册后驱动真实 DOM 走完「空态 → 新建对话框 → 建环境 → 表格 → 详情抽屉 → 编辑对话框」，
// 每站截图，用于 UI/UX 回归目检。失败必须退出（保底 app.exit(1)），否则验证流水线会挂死

export async function tourManager(
  preloadPath: string,
  rendererPath: string,
  outDir: string,
  loginAs: { email: string; password: string },
  onWindow?: (win: BrowserWindow) => void
): Promise<void> {
  const win = new BrowserWindow({
    width: 1100,
    height: 740,
    show: true,
    title: 'OneBrowser (ui tour)',
    // 关后台节流：验证窗口可能被判遮挡而停发帧（打包形态 DOM 活着、帧不出时的头号嫌疑）
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win.moveTop()
  win.focus()
  try {
    await tourRun(win, rendererPath, outDir, loginAs, onWindow)
  } catch (e) {
    console.error(`[tour] 失败: ${e instanceof Error ? e.message : String(e)}`)
    win.destroy()
    app.exit(1)
  }
}

async function tourRun(
  win: BrowserWindow,
  rendererPath: string,
  outDir: string,
  loginAs: { email: string; password: string },
  onWindow?: (win: BrowserWindow) => void
): Promise<void> {
  onWindow?.(win)
  fs.mkdirSync(outDir, { recursive: true })
  await win.loadFile(rendererPath)
  await sleep(1500)

  const shot = async (name: string): Promise<void> => {
    // 关掉残留通知，避免遮挡待检区域
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('.el-notification__closeBtn').forEach(b => b.click()), 'ok'`
    )
    await sleep(250)
    const { png, via } = await captureFreshPng(win)
    const file = path.join(outDir, name)
    fs.writeFileSync(file, png)
    console.log(`[tour] ${file} (${png.length} bytes, via=${via})`)
  }
  /** 按可见文本点按钮（el-button 文本在 span 里）；返回命中个数便于巡检断言 */
  const clickButton = async (text: string): Promise<number> => {
    const n = await win.webContents.executeJavaScript(
      `(() => { const bs = [...document.querySelectorAll('button')].filter(x => x.getClientRects().length && x.textContent.trim() === ${JSON.stringify(text)});
        if (!bs.length) return 0; bs[0].click(); return bs.length })()`
    )
    console.log(`[tour] click "${text}" -> ${n}`)
    return n
  }
  const runJs = (expr: string): Promise<string> => win.webContents.executeJavaScript(`Promise.resolve(${expr}).then(v => String(v))`)
  /** 条件等待：expr 为真值 DOM 表达式；打包形态软件渲染慢，固定 sleep 会拍到旧帧 */
  const waitFor = async (expr: string, desc: string, timeoutMs = 10000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      let ok = false
      try {
        ok = await win.webContents.executeJavaScript(`!!(${expr})`)
      } catch {
        ok = false
      }
      if (ok) return
      if (Date.now() > deadline) throw new Error(`等待超时: ${desc}`)
      await sleep(200)
    }
  }
  const overlayVisible = `[...document.querySelectorAll('.el-overlay')].some(o => getComputedStyle(o).display !== 'none')`

  // 注册视图：切到注册模式，拍「主密码不可找回」警示与确认勾选
  await clickButton('没有账号？注册一个')
  await sleep(600)
  await shot('00-login-register.png')

  await runJs(`window.ob.register(${JSON.stringify(loginAs.email)}, ${JSON.stringify(loginAs.password)}).then(() => 'ok')`)
  await waitFor(`document.querySelector('.envs-page')`, '登录后切到环境页')
  await sleep(400)
  await shot('01-envs-empty.png')
  // 新建对话框（默认指纹内核承载 → 指纹配置可见）
  await clickButton('＋ 新建环境')
  await waitFor(overlayVisible, '新建对话框打开')
  await runJs(`(() => { const i = document.querySelector('.el-dialog input[placeholder*="B 站号"]');
    if (!i) return 'no-name-input'; i.value = 'UI冒烟-指纹'; i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok' })()`)
  await sleep(300)
  await shot('02-create-dialog.png')
  await clickButton('创建')
  await waitFor(`document.querySelector('.el-table__body tr')`, '环境行出现在表格')
  await sleep(600)

  // 第二个环境走 API（互斥 + 标准浏览器承载，表格形态更丰富）
  await runJs(`window.ob.createEnv({ name: 'UI冒烟-浏览器', mode: 'exclusive', hosting: 'browser', homepage: 'https://example.com' }).then(() => 'ok')`)
  await waitFor(`document.querySelectorAll('.el-table__body tr').length >= 2`, '第二行出现在表格')
  await sleep(600)
  await shot('03-envs-rows.png')

  // 详情抽屉
  await clickButton('详情')
  await waitFor(`document.querySelector('.el-drawer') && ${overlayVisible}`, '详情抽屉打开')
  await sleep(400)
  await shot('04-detail-drawer.png')
  await runJs(`document.querySelector('.el-drawer__close-btn')?.click(), 'ok'`)
  await sleep(500)

  // 编辑对话框
  await clickButton('编辑')
  await waitFor(`document.querySelector('.el-dialog') && ${overlayVisible}`, '编辑对话框打开')
  await sleep(400)
  await shot('05-edit-dialog.png')

  const finalState = await runJs(`window.ob.getState().then(s => JSON.stringify({ envs: s.envs.map(e => [e.env.name, e.env.hosting, e.phase]) }))`)
  console.log(`[tour] final=${finalState}`)
  win.destroy()
  app.exit(0)
}
