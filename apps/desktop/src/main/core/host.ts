// 承载层接口：builtin（Electron 内存 partition）与 kernel（外挂指纹内核）共用，
// 保证 AppService/快照/云端/租约逻辑与承载方式解耦（docs/v0.2.0-plan.md §2）。
import type { Session, BrowserWindow } from 'electron'
import type { StructuredData } from './dataPlane'
import type { PageSession } from './cdp'
import type { KernelLaunch } from './kernelLauncher'
import type { EnvConfig } from '@shared/types'

export interface OpenOptions {
  restore?: StructuredData | null
  /** kernel 模式忽略（内核窗口自带 UI） */
  hidden?: boolean
  /** 指纹 flags（仅 kernel 模式） */
  fingerprint?: { seed: string; platform?: string; timezone?: string; lang?: string }
}

export type RunningEnv = BuiltinRunningEnv | KernelRunningEnv

export interface BuiltinRunningEnv {
  kind: 'builtin'
  envId: string
  runToken: string
  ses: Session
  win: BrowserWindow
  origins: Set<string>
}

export interface KernelRunningEnv {
  kind: 'kernel'
  envId: string
  runToken: string
  launch: KernelLaunch
  port: number
  /** 页面级 CDP 连接（用于数据面与导航） */
  page: PageSession
  origins: Set<string>
}

export interface Host {
  open(env: EnvConfig, opts?: OpenOptions): Promise<RunningEnv>
  capture(envId: string): Promise<StructuredData>
  isRunning(envId: string): boolean
  closeWindow(envId: string): void
  runningEntries(): IterableIterator<[string, RunningEnv]>
  onClosed: ((envId: string) => void) | null
}
