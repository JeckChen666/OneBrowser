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
  /** 优雅停止（先 Browser.close，兜底强杀/删容器） */
  stop(): Promise<void>
}

export interface KernelLauncher {
  launch(args: string[], onExit: () => void): Promise<KernelLaunch>
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
    await execFileP('docker', [
      'run', '-d', '--rm', '--name', name,
      '-p', `127.0.0.1:${port}:${this.containerPort}`,
      this.image,
      ...args
    ])
    // docker wait 在容器退出时返回 → 触发 onExit
    execFileP('docker', ['wait', name]).then(() => onExit(), () => onExit())
    await waitEndpoint(port, 45000)
    return {
      port,
      stop: async () => {
        await browserClose(port).catch(() => undefined)
        await execFileP('docker', ['rm', '-f', name]).catch(() => undefined)
      }
    }
  }
}
