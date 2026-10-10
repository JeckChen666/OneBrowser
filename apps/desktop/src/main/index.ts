import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppService } from './core/appService'
import type { CreateEnvInput, MainEvent, ProxyConfig } from '@shared/types'

const serverUrl = process.env.ONEBROWSER_SERVER || 'http://127.0.0.1:8787'
const appDir = fileURLToPath(new URL('.', import.meta.url))
const e2eMode = process.argv.includes('--e2e')

let svc: AppService
let managerWin: BrowserWindow | null = null

function sendEvent(e: MainEvent): void {
  managerWin?.webContents.send('ob:event', e)
}

function createManager(): void {
  managerWin = new BrowserWindow({
    width: 1100,
    height: 740,
    title: 'OneBrowser',
    webPreferences: {
      preload: path.join(appDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  managerWin.on('closed', () => {
    managerWin = null
  })
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) managerWin.loadURL(devUrl)
  else managerWin.loadFile(path.join(appDir, '../renderer/index.html'))
}

function registerIPC(): void {
  const handle = (channel: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { ok: true, data: await fn(...(args as never[])) }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    })
  }
  handle('ob:getState', () => svc.getState())
  handle('ob:register', (email: string, password: string) => svc.register(email, password))
  handle('ob:login', (email: string, password: string) => svc.login(email, password))
  handle('ob:logout', () => svc.logout())
  handle('ob:createEnv', (input: CreateEnvInput) => svc.createEnv(input))
  handle('ob:updateEnv', (id: string, patch: { name?: string; homepage?: string; proxy?: ProxyConfig }) =>
    svc.updateEnv(id, patch)
  )
  handle('ob:deleteEnv', (id: string) => svc.deleteEnv(id))
  handle('ob:openEnv', (id: string) => svc.openEnv(id))
  handle('ob:closeEnv', (id: string) => svc.closeEnv(id))
  handle('ob:saveBase', (id: string) => svc.saveBase(id))
}

function registerMenu(): void {
  const withFocusedEnv = (fn: (envId: string) => void): void => {
    const focused = BrowserWindow.getFocusedWindow()
    if (!focused) return
    for (const [envId, re] of svc.host.runningEntries()) {
      if (re.win === focused) fn(envId)
    }
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: '环境',
      submenu: [
        {
          label: '保存为基线快照',
          accelerator: 'CmdOrCtrl+S',
          click: () =>
            withFocusedEnv((id) => {
              svc.saveBase(id).catch((e) => sendEvent({ type: 'notify', level: 'error', message: `保存失败：${e}` }))
            })
        },
        {
          label: '关闭环境（exclusive 会先保存并释放）',
          accelerator: 'CmdOrCtrl+W',
          click: () =>
            withFocusedEnv((id) => {
              svc.closeEnv(id).catch((e) => sendEvent({ type: 'notify', level: 'error', message: `关闭失败：${e}` }))
            })
        },
        { type: 'separator' },
        { label: '返回管理窗口', click: () => managerWin?.focus() }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  if (process.argv.includes('--e2e')) {
    const { runE2E } = await import('./e2e-run')
    const code = await runE2E()
    app.exit(code)
    return
  }

  const shotIdx = process.argv.indexOf('--screenshot')
  if (shotIdx !== -1) {
    const { captureManager } = await import('./screenshot')
    const out = process.argv[shotIdx + 1]?.startsWith('-') ? '/tmp/ob-manager.png' : process.argv[shotIdx + 1]
    await captureManager(
      path.join(appDir, '../preload/index.cjs'),
      path.join(appDir, '../renderer/index.html'),
      out || '/tmp/ob-manager.png'
    )
    return
  }

  if (process.argv.includes('--screenshot-loggedin')) {
    svc = new AppService(serverUrl, sendEvent)
    registerIPC()
    const { captureManager } = await import('./screenshot')
    await captureManager(
      path.join(appDir, '../preload/index.cjs'),
      path.join(appDir, '../renderer/index.html'),
      '/tmp/ob-envs.png',
      { email: `shot-${Date.now()}@t.local`, password: 'shot-password-123' },
      (w) => {
        managerWin = w // 状态推送（登录后切页）需要指向本窗口
      }
    )
    return
  }

  svc = new AppService(serverUrl, sendEvent)
  registerIPC()
  registerMenu()

  // 环境代理的认证凭据（按 session 匹配对应环境）
  app.on('login', (event, webContents, _request, _authInfo, callback) => {
    if (!webContents) return
    const envId = svc.host.findEnvIdBySession(webContents.session)
    const view = envId ? svc.getState().envs.find((v: import('@shared/types').EnvView) => v.env.id === envId) : undefined
    const proxy = view?.env.proxy
    if (proxy?.username) {
      event.preventDefault()
      callback(proxy.username, proxy.password || '')
    }
  })

  createManager()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().filter((w) => w !== managerWin).length === 0 && !managerWin) createManager()
  })
})

app.on('window-all-closed', () => {
  // e2e 模式没有常驻管理窗口，环境窗口的开关不应退出应用
  if (!e2eMode) app.quit()
})
