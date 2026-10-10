// 共享类型（主进程与渲染进程共用）
export type EnvMode = 'snapshot' | 'exclusive'

export interface ProxyConfig {
  scheme: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username?: string
  password?: string
}

/** 环境配置（完整定义仅存在客户端；云端 name/mode 为明文列，其余为 E2E 密文 configEnc） */
export interface EnvConfig {
  id: string
  name: string
  mode: EnvMode
  homepage: string
  seed: string
  proxy?: ProxyConfig
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
  homepage: string
  proxy?: ProxyConfig
}

/** 主进程 → 渲染进程事件 */
export type MainEvent =
  | { type: 'state'; state: AppState }
  | { type: 'notify'; level: 'success' | 'warning' | 'error'; message: string }
