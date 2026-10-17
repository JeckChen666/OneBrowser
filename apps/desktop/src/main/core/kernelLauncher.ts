// 内核启动器：把「进程/端口/生命周期」抽象出来，原生 spawn 与 Docker 容器同一接口。
// Docker 模式用途：无原生内核的平台（如 Intel mac）开发/CI 验证；服务端云内核亦基于此扩展。
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomId } from './e2e'
import { freePort } from './kernelManager'
import { browserClose, waitEndpoint } from './cdp'

const execFileP = promisify(execFile)

export interface KernelLaunch {
  port: number
  /** profile 目录（宿主侧路径）。docker 模式经 -v 挂载直通：容器内同一物理目录，
   *  L2 快照的抓取/恢复都在宿主侧完成 */
  profileDir?: string
  /** 冻结内核进程执行 fn（一致性抓取用：docker pause → fn → unpause） */
  quiesce<T>(fn: () => Promise<T>): Promise<T>
  /** 优雅停止（先 Browser.close，兜底强杀/删容器） */
  stop(): Promise<void>
}

export interface KernelLauncher {
  launch(args: string[], onExit: () => void): Promise<KernelLaunch>
}

/** 从内核参数中取 --user-data-dir 的值 */
function userDataDirFromArgs(args: string[]): string | undefined {
  const flag = args.find((a) => a.startsWith('--user-data-dir='))
  return flag ? flag.slice('--user-data-dir='.length) : undefined
}

export class NativeKernelLauncher implements KernelLauncher {
  constructor(private exeProvider: () => Promise<string>) {}

  async launch(args: string[], onExit: () => void): Promise<KernelLaunch> {
    const exe = await this.exeProvider()
    const port = await freePort()
    const proc = spawn(exe, [...args, `--remote-debugging-port=${port}`], { stdio: 'ignore' })
    proc.once('exit', onExit)
    await waitEndpoint(port)
    return {
      port,
      profileDir: userDataDirFromArgs(args),
      quiesce: (fn) => fn(), // 原生进程冻结未实现（原生 L2 暂不支持，见 v0.3.0 计划）
      stop: async () => {
        await browserClose(port).catch(() => undefined)
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill('SIGKILL')
        }, 4000)
        await new Promise<void>((resolve) => {
          if (proc.exitCode !== null) return resolve()
          proc.once('exit', () => resolve())
          setTimeout(resolve, 6000)
        })
      }
    }
  }
}

export class DockerKernelLauncher implements KernelLauncher {
  constructor(
    private image: string,
    private containerPort = 9223 // headful CDP 经入口 socat 转发到 0.0.0.0:9223
  ) {}

  async launch(args: string[], onExit: () => void): Promise<KernelLaunch> {
    const port = await freePort()
    const name = `ob-kernel-${randomId()}`
    const profileDir = userDataDirFromArgs(args)
    const runArgs = [
      'run', '-d', '--rm', '--name', name,
      '-p', `127.0.0.1:${port}:${this.containerPort}`
    ]
    // profile 宿主目录挂载直通（L2 快照的数据面）：
    // 容器内内核直接读写宿主目录，抓取 = 冻结 + 宿主侧打包，恢复 = 预填充 + 正常启动
    if (profileDir) runArgs.push('-v', `${profileDir}:${profileDir}`)
    runArgs.push(this.image, ...args)
    // execFileP 等待命令完成（-d 返回即容器已创建）——spawn 事件仅代表进程创建，
    // 若不等完成，后续 docker wait 会在容器注册前执行而报 No such container
    await execFileP('docker', runArgs)
    // docker wait 在容器退出时返回 → 触发 onExit；stop() 完成后亦主动触发（幂等，事件可能不可靠）
    let exited = false
    const fireExit = (): void => {
      if (!exited) {
        exited = true
        onExit()
      }
    }
    const quiesce = async <T>(fn: () => Promise<T>): Promise<T> => {
      // pause 冻结容器内全部进程（含 Chromium 的 SQLite/LevelDB 写入），
      // 保证宿主侧读到一致性视图；无论成败都要 unpause
      await execFileP('docker', ['pause', name]).catch((e) => {
        throw new Error(`容器冻结失败: ${e instanceof Error ? e.message : e}`)
      })
      try {
        return await fn()
      } finally {
        await execFileP('docker', ['unpause', name]).catch(() => undefined)
      }
    }
    await waitEndpoint(port, 45000)
    return {
      port,
      profileDir,
      quiesce,
      stop: async () => {
        console.log(`[launcher] stop 开始 name=${name}`)
        await browserClose(port).catch((e) => console.log(`[launcher] browserClose 失败(忽略): ${e instanceof Error ? e.message : e}`))
        console.log(`[launcher] browserClose 完成`)
        await execFileP('docker', ['rm', '-f', name]).catch((e) => console.log(`[launcher] docker rm 失败(忽略): ${e instanceof Error ? e.message : e}`))
        console.log(`[launcher] docker rm 完成`)
        // 确认容器真正消失（最多 10s），随后主动触发 onExit
        for (let i = 0; i < 20; i++) {
          const alive = await execFileP('docker', ['ps', '-q', '--filter', `name=^${name}$`])
            .then((r) => r.stdout.trim().length > 0)
            .catch(() => false)
          if (!alive) break
          await new Promise((r) => setTimeout(r, 500))
        }
        console.log(`[launcher] 容器已消失，fireExit`)
        fireExit()
      }
    }
  }
}
