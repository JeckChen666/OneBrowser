// profile 目录打包/解包（L2 快照用）：tar + zstd（gzip 兜底），排除体积大且可再生的缓存类目录。
// 打包/解包都在宿主侧执行（Docker 内核 profile 经 -v 挂载直通），只需宿主有 tar；
// zstd 可用则用之（体积/速度均优于 gzip），否则回退 gzip——格式记入 manifest payload.format。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type ArchiveFormat = 'tar+zstd' | 'tar+gzip'

/** 排除清单：命中即不入包（同名目录在 profile 根或 Default/ 下都不打包）。
 *  缓存/GPU shader/崩溃转储均随首访重建；Cookies、Local Storage、IndexedDB、
 *  Web Data、Preferences、Local State 等全部保留。 */
const EXCLUDES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'GPUPersistentCache',
  'GraphiteDawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'Crashpad',
  'component_crx_cache',
  'extensions_crx_cache',
  'tmp',
  'Safe Browsing'
]

function tarExcludeArgs(): string[] {
  // bsdtar/GNU tar 的 --exclude 都对成员路径做 glob 匹配：
  // 裸名匹配根级目录，'*/名' 匹配任意层级下的同名目录
  const args: string[] = []
  for (const name of EXCLUDES) {
    args.push('--exclude', name, '--exclude', `*/${name}`)
  }
  return args
}

let zstdBin: string | null | undefined
/** 探测 zstd：先按 PATH，再回查常见绝对路径（Electron GUI 进程的 PATH
 *  常缺 /usr/local/bin、/opt/homebrew/bin）。返回 null = 不可用（gzip 兜底）。 */
async function findZstd(): Promise<string | null> {
  if (zstdBin !== undefined) return zstdBin
  const ok = await new Promise<boolean>((resolve) => {
    const p = spawn('zstd', ['--version'])
    p.once('error', () => resolve(false))
    p.once('close', (code) => resolve(code === 0))
  })
  if (ok) {
    zstdBin = 'zstd'
    return zstdBin
  }
  for (const abs of ['/usr/local/bin/zstd', '/opt/homebrew/bin/zstd', '/usr/bin/zstd']) {
    if (fs.existsSync(abs)) {
      zstdBin = abs
      return zstdBin
    }
  }
  zstdBin = null
  return zstdBin
}

export interface PackedProfile {
  bytes: Buffer
  format: ArchiveFormat
}

/** 打包目录（优先 zstd，缺 zstd 时 gzip 兜底） */
export async function tarDir(srcDir: string): Promise<PackedProfile> {
  const base = [...tarExcludeArgs(), '-C', srcDir, '.']
  const zstd = await findZstd()
  if (zstd) {
    try {
      // macOS bsdtar 的 zstd 走 stdout 会静默截断（exit 0 但流不完整）、stdin 读
      // 会 fork 子进程失败——压缩/解压都必须走临时文件（文件→文件路径可靠）。
      // --zstd 为 bsdtar/GNU tar 共有选项（-I 在 bsdtar 上是输入文件列表，语义不同）
      const bytes = await tarViaTmpFile('--zstd', '.tar.zst', base)
      return { bytes, format: 'tar+zstd' }
    } catch (e) {
      console.warn('[profileArchive] zstd 打包失败，回退 gzip:', e instanceof Error ? e.message : e)
    }
  }
  return { bytes: await tarViaTmpFile('-z', '.tar.gz', base), format: 'tar+gzip' }
}

async function tarViaTmpFile(flag: string, ext: string, base: string[]): Promise<Buffer> {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ob-tar-')), `pack${ext}`)
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('tar', [flag, '-cf', tmp, ...base], { stdio: ['ignore', 'ignore', 'pipe'] })
      let errText = ''
      proc.stderr.on('data', (c: Buffer) => (errText += c.toString()))
      proc.on('error', reject)
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar(${code}): ${errText.slice(0, 300)}`))))
    })
    return await fs.promises.readFile(tmp)
  } finally {
    fs.rm(path.dirname(tmp), { recursive: true, force: true }, () => undefined)
  }
}

/** 解包到目录（自动创建）。先落盘临时文件再按 format 显式解压——
 *  macOS bsdtar 从 stdin 流式读 zstd 会 fork 外部 zstd 子进程且该路径有
 *  缺陷（Child process exited with status 1），必须给它可 seek 的文件输入；
 *  自动探测同样不可靠，解压 flag 由 manifest 的 format 显式指定 */
export async function untarTo(buffer: Buffer, destDir: string, format: ArchiveFormat = 'tar+zstd'): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true })
  const tmp = `${destDir}.tar${format === 'tar+zstd' ? '.zst' : '.gz'}`
  await fs.promises.writeFile(tmp, buffer)
  try {
    await new Promise<void>((resolve, reject) => {
      const flag = format === 'tar+zstd' ? '--zstd' : '-z'
      const proc = spawn('tar', [flag, '-xf', tmp, '-C', destDir], { stdio: ['ignore', 'ignore', 'pipe'] })
      let errText = ''
      proc.stderr.on('data', (c: Buffer) => (errText += c.toString()))
      proc.on('error', reject)
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar 解包失败(${code}): ${errText.slice(0, 300)}`))))
    })
  } finally {
    fs.rm(tmp, { force: true }, () => undefined)
  }
}

/** 目录体积（字节，含缓存——用于展示排除效果与快照体积对比） */
export function dirSize(dir: string): number {
  let total = 0
  const walk = (p: string): void => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) total += fs.statSync(full).size
    }
  }
  walk(dir)
  return total
}
