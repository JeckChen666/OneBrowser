// 内核管理：指纹内核（fingerprint-chromium 预编译产物）的下载/校验/解压/本地导入。
// 产物覆盖（2026-10 实测）：win x64(.zip/.exe) / linux x64(.tar.xz/.AppImage) / mac intel(仅部分版本 .dmg)。
// 无 ARM64 预编译 → 支持用户自备本地可执行文件（settings.kernel.localExe）。
import { app } from 'electron'
import { spawn, spawnSync, execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** Windows 下删除目录易被 Defender/索引器瞬时持锁（EPERM）→ 带重试；maxRetries 仅对 Windows 生效 */
function rmDirRobust(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
}

/** 轻量自检：能否真正执行（架构不匹配会 EBADARCH -86） */
function execOkSync(exe: string): boolean {
  if (process.platform === 'win32') {
    // Windows 的 chrome.exe --version 不回显版本而是启动完整浏览器（GUI 子系统行为，
    // 版本号输出是 POSIX 专属约定）——自检会挂 20s 并留下持锁进程。改读 PE 版本资源：
    // 不执行进程，校验文件结构有效且带 Chromium 版本号
    try {
      const out = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
          `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
        { timeout: 15000, encoding: 'utf8' }
      )
      return out.status === 0 && /\d+\.\d+/.test(out.stdout.trim())
    } catch {
      return false
    }
  }
  try {
    return spawnSync(exe, ['--version'], { timeout: 20000 }).status === 0
  } catch {
    return false
  }
}

const GITHUB_REPO = 'adryfish/fingerprint-chromium'
const API_BASE = process.env.ONEBROWSER_KERNEL_API || 'https://api.github.com/repos/' + GITHUB_REPO
const DL_MIRROR = process.env.ONEBROWSER_KERNEL_MIRROR || '' // 例：https://ghproxy.example/https://github.com

export interface KernelInfo {
  ready: boolean
  source: 'github' | 'local' | 'none'
  version?: string
  exePath?: string
  message?: string
}

export interface DownloadProgress {
  status: 'downloading' | 'extracting' | 'done' | 'error'
  percent?: number
  receivedMB?: number
  totalMB?: number
  message?: string
}

interface ReleaseAsset {
  name: string
  size: number
  browser_download_url: string
  digest?: string // "sha256:..."
}

function kernelsRoot(): string {
  const dir = path.join(app.getPath('userData'), 'kernels')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function platformAssetPattern(): { prefer: RegExp; accept?: RegExp } {
  switch (process.platform) {
    case 'darwin':
      return { prefer: /\.dmg$/i }
    case 'win32':
      return { prefer: /windows_x64\.zip$/i, accept: /_x64\.exe$/i }
    case 'linux':
      return { prefer: /x86_64_linux\.tar\.xz$/i, accept: /x86_64\.AppImage$/i }
    default:
      return { prefer: /never-match/
      }
  }
}

async function listReleases(): Promise<Array<{ tag_name: string; assets: ReleaseAsset[] }>> {
  const resp = await fetch(`${API_BASE}/releases?per_page=10`, {
    headers: { Accept: 'application/vnd.github+json' }
  })
  if (!resp.ok) throw new Error(`获取 releases 失败: HTTP ${resp.status}`)
  return (await resp.json()) as Array<{ tag_name: string; assets: ReleaseAsset[] }>
}

function pickAsset(release: { assets: ReleaseAsset[] }): ReleaseAsset | null {
  const { prefer, accept } = platformAssetPattern()
  return release.assets.find((a) => prefer.test(a.name)) || (accept ? release.assets.find((a) => accept.test(a.name)) : undefined) || null
}

/** 已知问题版本（按平台规避上游 bug，选版时跳过）：
 *  - 150.0.7871.186 (win)：--fingerprint 与 --fingerprint-platform 同时启用时，
 *    canvas 像素回读（toDataURL/getImageData）死锁渲染进程（Page.enable 超时）；
 *    同版本 Linux 容器内正常，148 win 正常。2026-10 Windows 实测定位。 */
const KNOWN_BAD_VERSIONS: Partial<Record<NodeJS.Platform, string[]>> = {
  win32: ['150.0.7871.186']
}

/** 找到当前平台可用的最新版本（从新到旧，跳过无产物版本与已知坏版本） */
async function findLatestForPlatform(): Promise<{ version: string; asset: ReleaseAsset }> {
  const bad = KNOWN_BAD_VERSIONS[process.platform] || []
  const releases = await listReleases()
  for (const rel of releases) {
    if (bad.includes(rel.tag_name)) continue
    const asset = pickAsset(rel)
    if (asset) return { version: rel.tag_name, asset }
  }
  throw new Error(`fingerprint-chromium 近 10 个版本均无 ${process.platform} 预编译产物（可改用本地导入）`)
}

function downloadUrl(assetUrl: string): string {
  return DL_MIRROR ? DL_MIRROR.replace(/\/$/, '') + assetUrl : assetUrl
}

async function downloadTo(url: string, dest: string, onProgress?: (p: DownloadProgress) => void): Promise<void> {
  const resp = await fetch(url)
  if (!resp.ok || !resp.body) throw new Error(`下载失败: HTTP ${resp.status}`)
  const total = Number(resp.headers.get('content-length') || 0)
  let received = 0
  const out = fs.createWriteStream(dest)
  const reader = resp.body as unknown as AsyncIterable<Uint8Array>
  for await (const chunk of reader) {
    received += chunk.length
    out.write(chunk)
    if (total && received % (2 << 20) < chunk.length) {
      onProgress?.({
        status: 'downloading',
        percent: Math.round((received / total) * 100),
        receivedMB: Math.round(received / 1048576),
        totalMB: Math.round(total / 1048576)
      })
    }
  }
  await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
  onProgress?.({ status: 'downloading', percent: 100, receivedMB: Math.round(received / 1048576), totalMB: total ? Math.round(total / 1048576) : undefined })
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (d) => hash.update(d))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** 解压到 dest/<version>/ 并返回内核可执行文件路径 */
async function extract(assetName: string, archive: string, version: string): Promise<string> {
  const dest = path.join(kernelsRoot(), version)
  rmDirRobust(dest)
  fs.mkdirSync(dest, { recursive: true })

  if (/\.dmg$/i.test(assetName)) {
    // macOS：挂载 → 拷贝 .app → 卸载 → 去隔离属性
    const mount = path.join(kernelsRoot(), `.mount-${version}`)
    fs.mkdirSync(mount, { recursive: true })
    await execFileP('hdiutil', ['attach', archive, '-nobrowse', '-mountpoint', mount])
    try {
      const apps = fs.readdirSync(mount).filter((n) => n.endsWith('.app'))
      if (apps.length === 0) throw new Error('DMG 中未找到 .app')
      await execFileP('cp', ['-R', path.join(mount, apps[0]), dest])
      await execFileP('xattr', ['-dr', 'com.apple.quarantine', path.join(dest, apps[0])]).catch(() => undefined)
    } finally {
      await execFileP('hdiutil', ['detach', mount]).catch(() => undefined)
      fs.rmSync(mount, { recursive: true, force: true })
    }
    const appDir = fs.readdirSync(dest).find((n) => n.endsWith('.app'))!
    const macosDir = path.join(dest, appDir, 'Contents', 'MacOS')
    const execName = fs.readdirSync(macosDir).find((n) => fs.statSync(path.join(macosDir, n)).isFile())
    if (!execName) throw new Error('未找到内核可执行文件')
    return path.join(macosDir, execName)
  }

  if (/\.tar\.xz$/i.test(assetName)) {
    await execFileP('tar', ['-xJf', archive, '-C', dest, '--strip-components=0'])
    // 目录内找可执行（ungoogled 的 chrome/chromium）
    const candidates = ['chrome', 'chromium', 'ungoogled-chromium', 'chrome-linux/chrome']
    for (const c of candidates) {
      const p = path.join(dest, c)
      if (fs.existsSync(p)) return p
    }
    throw new Error('解压后未找到内核可执行文件（linux）')
  }

  if (/windows_x64\.zip$/i.test(assetName)) {
    // Windows 便携版 zip：用 PowerShell Expand-Archive（系统自带，无第三方依赖）
    const psScript = `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`
    await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript])
    // 目录内找 chrome.exe（ungoogled 结构：顶层或 chrome-win/chrome.exe）
    for (const c of ['chrome.exe', 'ungoogled-chromium.exe', 'chrome-win/chrome.exe']) {
      const p = path.join(dest, c)
      if (fs.existsSync(p)) return p
    }
    // 兜底：递归找首个 chrome.exe
    const findExe = (dir: string): string | null => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          const hit = findExe(full)
          if (hit) return hit
        } else if (/^chrome.*\.exe$/i.test(e.name)) return full
      }
      return null
    }
    const found = findExe(dest)
    if (found) return found
    throw new Error('解压后未找到 chrome.exe（win）')
  }

  if (/_x64\.exe$/i.test(assetName)) {
    // Windows 安装器：/dir 静默解包（ungoogled 用 Inno Setup，7z 也可解但不可控），
    // 优先级最低（pickAsset 已优先 zip）；此分支仅在无 zip 的版本触发
    const exeDir = path.join(dest, 'installed')
    fs.mkdirSync(exeDir, { recursive: true })
    await execFileP(archive, ['/SP-', '/SILENT', '/SUPPRESSMSGBOXES', `/DIR=${exeDir}`], { timeout: 10 * 60000 })
    for (const c of ['chrome.exe', 'ungoogled-chromium.exe', 'chrome-win/chrome.exe']) {
      const p = path.join(exeDir, c)
      if (fs.existsSync(p)) return p
    }
    throw new Error('安装器执行后未找到 chrome.exe（win）')
  }

  if (/\.zip$/i.test(assetName)) {
    await execFileP('unzip', ['-q', archive, '-d', dest])
    const exe = process.platform === 'win32' ? 'chrome.exe' : 'chrome'
    const p = path.join(dest, exe)
    if (fs.existsSync(p)) return p
    throw new Error('解压后未找到内核可执行文件（zip）')
  }

  throw new Error(`暂不支持该产物格式: ${assetName}（请使用本地导入）`)
}

export class KernelManager {
  private downloading = false

  constructor(
    private getLocalExe: () => string | undefined,
    private onProgress?: (p: DownloadProgress) => void
  ) {}

  /** 就绪状态查询（不触发下载）；产物不可执行时自动清理 */
  status(): KernelInfo {
    const localExe = this.getLocalExe()
    if (localExe && fs.existsSync(localExe)) {
      if (!execOkSync(localExe)) {
        return { ready: false, source: 'local', exePath: localExe, message: '本地导入的内核无法在本机执行（架构不符？）' }
      }
      return { ready: true, source: 'local', exePath: localExe, version: 'local' }
    }
    const installed = this.installedVersion()
    if (installed) return { ready: true, source: 'github', version: installed.version, exePath: installed.exePath }
    const darwinX64 = process.platform === 'darwin' && process.arch === 'x64'
    return {
      ready: false,
      source: 'none',
      message: darwinX64
        ? '官方 mac 预编译内核为 ARM64，本机（Intel）无法运行：请本地导入自建 x64 内核，或在 Win/Linux/ARM Mac 上使用'
        : '内核未就绪：点击下载或本地导入'
    }
  }

  private installedVersion(): { version: string; exePath: string } | null {
    // 约定：kernels/<version>/.kernel-ready 内含 exe 路径；不可执行则自愈删除
    const bad = KNOWN_BAD_VERSIONS[process.platform] || []
    try {
      for (const name of fs.readdirSync(kernelsRoot())) {
        if (bad.includes(name)) continue // 已知坏版本不使用（见 KNOWN_BAD_VERSIONS 注释）
        const marker = path.join(kernelsRoot(), name, '.kernel-ready')
        if (fs.existsSync(marker)) {
          const exePath = fs.readFileSync(marker, 'utf8').trim()
          if (fs.existsSync(exePath) && execOkSync(exePath)) return { version: name, exePath }
          console.warn(`[kernel] ${name} 产物不可执行，清理`)
          rmDirRobust(path.join(kernelsRoot(), name))
        }
      }
    } catch {
      /* 目录不存在 */
    }
    return null
  }

  /** 确保内核可用：本地路径优先 → 已安装版本 → 下载最新 */
  async ensureReady(): Promise<KernelInfo> {
    const s = this.status()
    if (s.ready) return s
    return this.downloadLatest()
  }

  async downloadLatest(): Promise<KernelInfo> {
    if (this.downloading) throw new Error('内核正在下载中')
    this.downloading = true
    try {
      const { version, asset } = await findLatestForPlatform()
      const archive = path.join(kernelsRoot(), `${version}-${asset.name}`)
      this.onProgress?.({ status: 'downloading', message: `下载 ${asset.name}` })
      await downloadTo(downloadUrl(asset.browser_download_url), archive, this.onProgress)

      if (asset.digest?.startsWith('sha256:')) {
        const want = asset.digest.slice('sha256:'.length)
        const got = await sha256File(archive)
        if (want !== got) {
          fs.rmSync(archive, { force: true })
          throw new Error('内核校验失败（sha256 不匹配）')
        }
      }

      this.onProgress?.({ status: 'extracting', message: '解压内核…' })
      const exePath = await extract(asset.name, archive, version)
      if (!execOkSync(exePath)) {
        rmDirRobust(path.join(kernelsRoot(), version))
        throw new Error(
          process.platform === 'darwin'
            ? `产物架构与本机不符（macOS 预编译为 ARM64）：请本地导入自建内核`
            : '解压后的内核无法在本机执行'
        )
      }
      fs.writeFileSync(path.join(kernelsRoot(), version, '.kernel-ready'), exePath)
      fs.rmSync(archive, { force: true })
      this.onProgress?.({ status: 'done' })
      return { ready: true, source: 'github', version, exePath }
    } catch (e) {
      this.onProgress?.({ status: 'error', message: e instanceof Error ? e.message : String(e) })
      throw e
    } finally {
      this.downloading = false
    }
  }

  /** 本地导入的可执行文件自检（能输出版本号视为可用；win 走 PE 版本资源） */
  async validateLocalExe(exePath: string): Promise<boolean> {
    if (process.platform === 'win32') return execOkSync(exePath)
    try {
      const { stdout } = await promisify(execFile)(exePath, ['--version'], { timeout: 15000 })
      return /chrom/i.test(stdout)
    } catch {
      return false
    }
  }
}

export interface StandardBrowser { exePath: string; name: 'Edge' | 'Chrome' }

/** 探测本机已安装的标准浏览器（标准内核模式用，无需下载）。
 *  Windows 自带 Edge；Chrome 为可选。路径用正斜杠（Windows API 兼容，免转义坑）。 */
export function detectStandardBrowser(): StandardBrowser | null {
  const pf = process.env.ProgramFiles || 'C:/Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || pf
  const lad = process.env.LOCALAPPDATA || ''
  const candidates: Array<{ path: string; name: 'Edge' | 'Chrome' }> =
    process.platform === 'win32'
      ? [
          { path: `${pf86}/Microsoft/Edge/Application/msedge.exe`, name: 'Edge' },
          { path: `${pf}/Microsoft/Edge/Application/msedge.exe`, name: 'Edge' },
          { path: `${lad}/Microsoft/Edge/Application/msedge.exe`, name: 'Edge' },
          { path: `${pf}/Google/Chrome/Application/chrome.exe`, name: 'Chrome' },
          { path: `${pf86}/Google/Chrome/Application/chrome.exe`, name: 'Chrome' },
          { path: `${lad}/Google/Chrome/Application/chrome.exe`, name: 'Chrome' }
        ]
      : process.platform === 'darwin'
        ? [
            { path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', name: 'Edge' },
            { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', name: 'Chrome' }
          ]
        : [
            { path: '/usr/bin/microsoft-edge-stable', name: 'Edge' },
            { path: '/usr/bin/microsoft-edge', name: 'Edge' },
            { path: '/usr/bin/google-chrome-stable', name: 'Chrome' },
            { path: '/usr/bin/google-chrome', name: 'Chrome' },
            { path: '/usr/bin/chromium-browser', name: 'Chrome' },
            { path: '/usr/bin/chromium', name: 'Chrome' }
          ]
  for (const c of candidates) {
    try {
      if (fs.existsSync(c.path)) return { exePath: c.path, name: c.name }
    } catch {
      /* ignore */
    }
  }
  return null
}

/** 找一个空闲本地端口 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

export { spawn as spawnProcess }
