// 共享类型（主进程与渲染进程共用）
export type EnvMode = 'snapshot' | 'exclusive'

/** 承载方式：builtin=Electron 内存 partition（轻量）；kernel=外挂指纹内核 */
export type Hosting = 'builtin' | 'kernel'

export interface ProxyConfig {
  scheme: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username?: string
  password?: string
}

/** 指纹配置（kernel 模式；seed 驱动整套指纹，其余为覆盖项） */
export interface FingerprintConfig {
  platform?: string // fingerprint-platform：Windows / macOS / Linux
  timezone?: string // 空 = 由 seed/后续 auto 决定
  lang?: string
}

/** 环境配置（完整定义仅存在客户端；云端 name/mode 为明文列，其余为 E2E 密文 configEnc） */
export interface EnvConfig {
  id: string
  name: string
  mode: EnvMode
  hosting: Hosting
  homepage: string
  seed: string
  proxy?: ProxyConfig
  fingerprint?: FingerprintConfig
  kernelVersion?: string
  createdAt: string
  updatedAt: string
}

export interface BaseMeta {
  snapshotId: string
  createdAt: string
  sizeBytes: number
  sha256: string
  deviceId: string
}

export interface LeaseMeta {
  holderDeviceId: string
  state: 'active' | 'evicting'
}

/** 服务端环境行（name/mode 明文 + configEnc 密文） */
export interface CloudEnvRow {
  id: string
  name: string
  mode: EnvMode
  configEnc: string
  createdAt: string
  updatedAt: string
  base: BaseMeta | null
  lease: LeaseMeta | null
}

export type EnvPhase =
  | 'idle'
  | 'opening'
  | 'downloading-kernel'
  | 'acquiring'
  | 'waiting-evict'
  | 'running'
  | 'saving'
  | 'evicting'
  | 'closing'

export interface EnvView {
  env: EnvConfig
  phase: EnvPhase
  message?: string
  hasBase: boolean
  baseCreatedAt?: string
  leaseHolder?: string
}

export interface AccountInfo {
  email: string
  deviceId: string
  serverUrl: string
}

export interface AppState {
  account: AccountInfo | null
  envs: EnvView[]
}

export interface CreateEnvInput {
  name: string
  mode: EnvMode
  hosting?: Hosting // 缺省 kernel（UI 默认）；e2e 显式传 builtin
  homepage: string
  proxy?: ProxyConfig
  fingerprint?: FingerprintConfig
}

export interface KernelStatus {
  ready: boolean
  source: 'github' | 'local' | 'none'
  version?: string
  message?: string
  downloading?: boolean
  progress?: { status: string; percent?: number; message?: string }
}

/** 主进程 → 渲染进程事件 */
export type MainEvent =
  | { type: 'state'; state: AppState }
  | { type: 'notify'; level: 'success' | 'warning' | 'error'; message: string }
  | { type: 'kernel'; status: KernelStatus }
