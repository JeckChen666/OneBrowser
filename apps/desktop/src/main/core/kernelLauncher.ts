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
    // execFileP 等待命令完成（-d 返回即容器已创建）——spawn 事件仅代表进程创建，
    // 若不等完成，后续 docker wait 会在容器注册前执行而报 No such container
    await execFileP('docker', [
      'run', '-d', '--rm', '--name', name,
      '-p', `127.0.0.1:${port}:${this.containerPort}`,
      this.image,
      ...args
    ])
    // docker wait 在容器退出时返回 → 触发 onExit；stop() 完成后亦主动触发（幂等，事件可能不可靠）
    let exited = false
    const fireExit = (): void => {
      if (!exited) {
        exited = true
        onExit()
      }
    }
    await waitEndpoint(port, 45000)
    return {
      port,
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
