// 渲染进程对 preload API 的类型化封装
import type { AppState, CreateEnvInput, MainEvent, ProxyConfig } from '@shared/types'

interface ObApi {
  getState(): Promise<AppState>
  register(email: string, password: string): Promise<void>
  login(email: string, password: string): Promise<void>
  logout(): Promise<void>
  createEnv(input: CreateEnvInput): Promise<void>
  updateEnv(id: string, patch: { name?: string; homepage?: string; proxy?: ProxyConfig }): Promise<void>
  deleteEnv(id: string): Promise<void>
  openEnv(id: string): Promise<void>
  closeEnv(id: string): Promise<void>
  saveBase(id: string): Promise<void>
  onEvent(cb: (e: MainEvent) => void): () => void
}

declare global {
  interface Window {
    ob: ObApi
  }
}

export const ob = window.ob
