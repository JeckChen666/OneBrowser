// --screenshot 模式：加载管理窗口 → （可选）注册临时账号进入主界面 → 截图保存 → 退出
// 路径由入口模块传入（本文件可能被分割打包到 chunks/，自身相对路径不可靠）
import { BrowserWindow, app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

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
  const image = await win.webContents.capturePage()
  fs.writeFileSync(outPath, image.toPNG())
  console.log(`[screenshot] 已保存 ${outPath} (${image.toPNG().length} bytes)`)
  win.destroy()
  app.exit(0)
}

// --screenshot-tour 模式：注册后驱动真实 DOM 走完「空态 → 新建对话框 → 建环境 → 表格 → 详情抽屉 → 编辑对话框」，
// 每站截图，用于 UI/UX 回归目检
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false }
  })
  onWindow?.(win)
  fs.mkdirSync(outDir, { recursive: true })
  await win.loadFile(rendererPath)
  await sleep(1500)

  const shot = async (name: string): Promise<void> => {
    // 关掉残留通知，避免遮挡待检区域
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('.el-notification__closeBtn').forEach(b => b.click()), 'ok'`
    )
    await sleep(400)
    const image = await win.webContents.capturePage()
    const file = path.join(outDir, name)
    fs.writeFileSync(file, image.toPNG())
    console.log(`[tour] ${file} (${image.toPNG().length} bytes)`)
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

  // 注册视图：切到注册模式，拍「主密码不可找回」警示与确认勾选
  await clickButton('没有账号？注册一个')
  await sleep(600)
  await shot('00-login-register.png')

  await runJs(`window.ob.register(${JSON.stringify(loginAs.email)}, ${JSON.stringify(loginAs.password)}).then(() => 'ok')`)
  await sleep(1500)
  await shot('01-envs-empty.png')
  // 新建对话框（默认指纹内核承载 → 指纹配置可见）
  await clickButton('＋ 新建环境')
  await sleep(600)
  await runJs(`(() => { const i = document.querySelector('.el-dialog input[placeholder*="B 站号"]');
    if (!i) return 'no-name-input'; i.value = 'UI冒烟-指纹'; i.dispatchEvent(new Event('input', { bubbles: true })); return 'ok' })()`)
  await sleep(300)
  await shot('02-create-dialog.png')
  await clickButton('创建')
  await sleep(1200)

  // 第二个环境走 API（互斥 + 标准浏览器承载，表格形态更丰富）
  await runJs(`window.ob.createEnv({ name: 'UI冒烟-浏览器', mode: 'exclusive', hosting: 'browser', homepage: 'https://example.com' }).then(() => 'ok')`)
  await sleep(1200)
  await shot('03-envs-rows.png')

  // 详情抽屉
  await clickButton('详情')
  await sleep(800)
  await shot('04-detail-drawer.png')
  await runJs(`document.querySelector('.el-drawer__close-btn')?.click(), 'ok'`)
  await sleep(500)

  // 编辑对话框
  await clickButton('编辑')
  await sleep(800)
  await shot('05-edit-dialog.png')

  const finalState = await runJs(`window.ob.getState().then(s => JSON.stringify({ envs: s.envs.map(e => [e.env.name, e.env.hosting, e.phase]) }))`)
  console.log(`[tour] final=${finalState}`)
  win.destroy()
  app.exit(0)
}
