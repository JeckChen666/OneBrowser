import { contextBridge, ipcRenderer } from 'electron'
import type { AppInfo, AppState, CreateEnvInput, FingerprintConfig, Hosting, KernelStatus, MainEvent, ProxyConfig } from '@shared/types'

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
