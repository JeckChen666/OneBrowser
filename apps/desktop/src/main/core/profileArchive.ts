// profile 目录打包/解包（L2 快照用）：tar.gz，排除体积大且可再生的缓存类目录。
// 经系统 tar（macOS bsdtar / Linux GNU tar 的公共子集），流式收集，避免大字符串拼接。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** 排除清单：命中即不入包（同名目录在 profile 根或 Default/ 下都不打包）。
 *  缓存/GPU shader/崩溃转储均随首访重建；Cookies、Local Storage、IndexedDB、
 *  Web Data、Preferences、Local State 等全部保留。 */
const EXCLUDES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'GPUPersistentCache',
  'GraphiteDawnCache',
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

/** 打包目录 → tar.gz Buffer */
export function tarDir(srcDir: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-czf', '-', ...tarExcludeArgs(), '-C', srcDir, '.'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let total = 0
    let errText = ''
    proc.stdout.on('data', (c: Buffer) => {
      chunks.push(c)
      total += c.length
    })
    proc.stderr.on('data', (c: Buffer) => (errText += c.toString()))
    proc.on('error', reject)
    proc.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(chunks, total)) : reject(new Error(`tar 打包失败(${code}): ${errText.slice(0, 300)}`))
    )
  })
}

/** 解包 tar.gz Buffer 到目录（自动创建） */
export function untarTo(buffer: Buffer, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true })
    const proc = spawn('tar', ['-xzf', '-', '-C', destDir], { stdio: ['pipe', 'ignore', 'pipe'] })
    let errText = ''
    proc.stderr.on('data', (c: Buffer) => (errText += c.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar 解包失败(${code}): ${errText.slice(0, 300)}`))))
    // 大 buffer 分块写 stdin，避免 EAGAIN
    const CHUNK = 1 << 20
    let off = 0
    const writeNext = (): void => {
      while (off < buffer.length) {
        const slice = buffer.subarray(off, off + CHUNK)
        off += CHUNK
        if (!proc.stdin.write(slice)) {
          proc.stdin.once('drain', writeNext)
          return
        }
      }
      proc.stdin.end()
    }
    writeNext()
  })
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
