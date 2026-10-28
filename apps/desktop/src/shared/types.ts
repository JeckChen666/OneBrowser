// 共享类型（主进程与渲染进程共用）
export type EnvMode = 'snapshot' | 'exclusive'

/** 承载方式：builtin=Electron 内存 partition（轻量）；kernel=外挂指纹内核 */
export type Hosting = 'builtin' | 'kernel' | 'browser'

export interface ProxyConfig {
  scheme: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username?: string
  password?: string
}

/** 指纹覆盖项的三态：seed=跟随种子；auto=按代理出口 IP 地理推导；manual=显式指定 */
export type FpMode = 'seed' | 'auto' | 'manual'

/** 指纹配置（kernel 模式；seed 驱动整套指纹，其余为覆盖项） */
export interface FingerprintConfig {
  platform?: string // fingerprint-platform：Windows / macOS / Linux
  timezoneMode?: FpMode
  timezone?: string // manual 时的值；旧数据无 mode 但有值视为 manual
  langMode?: FpMode
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
  /** 会话健康检查（可选）：打开快照环境恢复登录态后，按此探测基线是否仍有效；
   * 响应体不含 loggedInMarker 时提示「基线失效，请重新登录并更新基线」 */
  sessionCheck?: { urlPath: string; loggedInMarker: string }
  /** L1 兜底快照 ID（kernel 环境双写时的结构化副本）：builtin 设备打开 L2 基线时回退使用 */
  l1SnapshotId?: string
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

/** 应用自身信息（关于/登录页版本号展示用） */
export interface AppInfo {
  version: string
  electron: string
  platform: string
}

/** 版本检查结果（V0.5 阶段 a：报告 + 直达下载页，不自动安装） */
export interface UpdateCheck {
  current: string
  latest: string | null
  hasUpdate: boolean
  releaseUrl: string | null
  publishedAt?: string
  notes?: string
}

export interface CreateEnvInput {
  name: string
  mode: EnvMode
  hosting?: Hosting // 缺省 kernel（UI 默认）；e2e 显式传 builtin
  homepage: string
  proxy?: ProxyConfig
  fingerprint?: FingerprintConfig
  sessionCheck?: { urlPath: string; loggedInMarker: string }
  seed?: string // 测试用：指定种子（缺省随机）
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
