import { contextBridge, ipcRenderer } from 'electron'
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

interface IpcResult<T> {
  ok: boolean
  data?: T
  error?: string
}

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args).then((r: IpcResult<T>) => {
    if (!r.ok) throw new Error(r.error || '未知错误')
    return r.data as T
  })

const api = {
  appInfo: (): Promise<AppInfo> => invoke('ob:appInfo'),
  checkUpdate: (): Promise<UpdateCheck> => invoke('ob:checkUpdate'),
  openUrl: (url: string): Promise<void> => invoke('ob:openUrl', url),
  getState: (): Promise<AppState> => invoke('ob:getState'),
  register: (email: string, password: string): Promise<void> => invoke('ob:register', email, password),
  login: (email: string, password: string): Promise<void> => invoke('ob:login', email, password),
  logout: (): Promise<void> => invoke('ob:logout'),
  createEnv: (input: CreateEnvInput): Promise<void> => invoke('ob:createEnv', input),
  updateEnv: (
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
  ): Promise<void> => invoke('ob:updateEnv', id, patch),
  sync: (): Promise<void> => invoke('ob:sync'),
  // 团队（V0.6）
  teams: (): Promise<TeamInfo[]> => invoke('ob:teams'),
  teamsRefresh: (): Promise<void> => invoke('ob:teams:refresh'),
  teamCreate: (name: string): Promise<void> => invoke('ob:teams:create', name),
  teamInvite: (teamId: string, email: string, role?: 'admin' | 'member'): Promise<void> =>
    invoke('ob:teams:invite', teamId, email, role),
  teamMembers: (teamId: string): Promise<TeamMember[]> => invoke('ob:teams:members', teamId),
  teamRevoke: (teamId: string, userId: string): Promise<void> => invoke('ob:teams:revoke', teamId, userId),
  teamRotate: (teamId: string): Promise<void> => invoke('ob:teams:rotate', teamId),
  teamAccept: (teamId: string): Promise<void> => invoke('ob:teams:accept', teamId),
  teamDecline: (teamId: string): Promise<void> => invoke('ob:teams:decline', teamId),
  deleteEnv: (id: string): Promise<void> => invoke('ob:deleteEnv', id),
  openEnv: (id: string): Promise<void> => invoke('ob:openEnv', id),
  closeEnv: (id: string): Promise<void> => invoke('ob:closeEnv', id),
  saveBase: (id: string): Promise<void> => invoke('ob:saveBase', id),
  kernelStatus: (): Promise<KernelStatus> => invoke('ob:kernelStatus'),
  kernelDownload: (): Promise<KernelStatus> => invoke('ob:kernelDownload'),
  kernelSetLocal: (p: string | undefined): Promise<KernelStatus> => invoke('ob:kernelSetLocal', p),
  pickKernelPath: (): Promise<string | null> => invoke('ob:pickKernelPath'),
  onEvent: (cb: (e: MainEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: MainEvent): void => cb(ev)
    ipcRenderer.on('ob:event', listener)
    return () => ipcRenderer.off('ob:event', listener)
  }
}

contextBridge.exposeInMainWorld('ob', api)
export type ObApi = typeof api
