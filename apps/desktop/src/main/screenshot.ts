// --screenshot 模式：加载管理窗口 → （可选）注册临时账号进入主界面 → 截图保存 → 退出
// 路径由入口模块传入（本文件可能被分割打包到 chunks/，自身相对路径不可靠）
import { BrowserWindow, app } from 'electron'
import fs from 'node:fs'

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
