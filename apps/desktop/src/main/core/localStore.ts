// 本地持久化：设备标识 + 已登录账号提示 + 快照缓存目录
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomId } from './e2e'

interface LocalState {
  deviceId: string
  lastEmail?: string
}

export class LocalStore {
  private file: string
  state: LocalState = { deviceId: '' }

  constructor() {
    this.file = path.join(app.getPath('userData'), 'local-state.json')
    this.load()
  }

  private load(): void {
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      this.state = { deviceId: randomId() }
      this.save()
    }
    if (!this.state.deviceId) {
      this.state.deviceId = randomId()
      this.save()
    }
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2))
  }

  get deviceId(): string {
    return this.state.deviceId
  }

  setLastEmail(email: string): void {
    this.state.lastEmail = email
    this.save()
  }

  get snapshotCacheDir(): string {
    const dir = path.join(app.getPath('userData'), 'snapshot-cache')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }
}
