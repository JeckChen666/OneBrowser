// V0.5-C 阶段 b：electron-updater 全量差分自动更新（默认休眠）。
//
// 启用条件（同时满足才激活，缺一退回阶段 a 的手动「检查更新」）：
//   1. ONEBROWSER_AUTO_UPDATE=1（显式开启；证书到位前保持休眠——未签名安装包的
//      静默安装会被 SmartScreen 拦截，见 docs/v0.5.0-plan.md §1）
//   2. app.isPackaged（开发模式不走更新器）
//
// 行为：update-available 通知 → autoDownload 后台差分下载（blockmap）→
// update-downloaded 通知 → **退出应用时自动安装并重启**（autoInstallOnAppQuit，
// 不主动打断运行中的环境/互斥租约——这是选择「退出时装」而非「就绪即装」的原因）。
import { app } from 'electron'
import type { MainEvent } from '@shared/types'

const CHECK_INTERVAL_MS = 24 * 3600 * 1000

export async function startAutoUpdater(emit: (e: MainEvent) => void): Promise<void> {
  if (process.env.ONEBROWSER_AUTO_UPDATE !== '1' || !app.isPackaged) return
  try {
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('update-available', (info) => {
      emit({ type: 'notify', level: 'warning', message: `发现新版 v${info.version}，正在后台下载…` })
    })
    autoUpdater.on('update-downloaded', (info) => {
      emit({
        type: 'notify',
        level: 'success',
        message: `新版 v${info.version} 已就绪：退出 OneBrowser 时将自动安装并重启（运行中的环境会先正常关闭）`
      })
    })
    autoUpdater.on('error', (e) => {
      // 后台链路失败不打扰用户（阶段 a 手动检查仍可用）
      console.warn('[auto-update]', e instanceof Error ? e.message : e)
    })
    await autoUpdater.checkForUpdates()
    setInterval(() => {
      autoUpdater.checkForUpdates().catch((e) => console.warn('[auto-update] 周期检查失败:', String(e)))
    }, CHECK_INTERVAL_MS)
  } catch (e) {
    console.warn('[auto-update] 初始化失败（退回手动检查）:', e instanceof Error ? e.message : e)
  }
}
