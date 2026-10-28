// 渲染进程对 preload API 的类型化封装
import type {
  AppInfo,
  AppState,
  CreateEnvInput,
  FingerprintConfig,
  Hosting,
  KernelStatus,
  MainEvent,
  ProxyConfig,
  TeamInfo,
  TeamMember,
  UpdateCheck
} from '@shared/types'

interface ObApi {
  appInfo(): Promise<AppInfo>
  checkUpdate(): Promise<UpdateCheck>
  openUrl(url: string): Promise<void>
  getState(): Promise<AppState>
  register(email: string, password: string): Promise<void>
  login(email: string, password: string): Promise<void>
  logout(): Promise<void>
  createEnv(input: CreateEnvInput): Promise<void>
  updateEnv(
    id: string,
    patch: {
      name?: string
      homepage?: string
      proxy?: ProxyConfig | null
      fingerprint?: FingerprintConfig
      hosting?: Hosting
      seed?: string
      sessionCheck?: { urlPath: string; loggedInMarker: string } | null
    }
  ): Promise<void>
  sync(): Promise<void>
  // 团队（V0.6）
  teams(): Promise<TeamInfo[]>
  teamsRefresh(): Promise<void>
  teamCreate(name: string): Promise<void>
  teamInvite(teamId: string, email: string, role?: 'admin' | 'member'): Promise<void>
  teamMembers(teamId: string): Promise<TeamMember[]>
  teamRevoke(teamId: string, userId: string): Promise<void>
  teamRotate(teamId: string): Promise<void>
  teamAccept(teamId: string): Promise<void>
  teamDecline(teamId: string): Promise<void>
  deleteEnv(id: string): Promise<void>
  openEnv(id: string): Promise<void>
  closeEnv(id: string): Promise<void>
  saveBase(id: string): Promise<void>
  kernelStatus(): Promise<KernelStatus>
  kernelDownload(): Promise<KernelStatus>
  kernelSetLocal(p: string | undefined): Promise<KernelStatus>
  pickKernelPath(): Promise<string | null>
  onEvent(cb: (e: MainEvent) => void): () => void
}

declare global {
  interface Window {
    ob: ObApi
  }
}

export const ob = window.ob
