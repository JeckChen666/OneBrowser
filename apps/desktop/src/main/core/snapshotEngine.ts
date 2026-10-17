// 快照引擎：结构化数据 → 加密信封（manifest + blob）。
// 格式规范见 docs/project-plan.md §5；L2 文件级快照（kind: 'files'）见 docs/v0.3.0-plan.md。
import * as os from 'node:os'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { encryptJson, decryptJson, sha256Hex, toB64, fromB64, randomId, subkey, type KdfParamsJson } from './e2e'
import type { StructuredData } from './dataPlane'

export interface StructuredManifest {
  schema: 'onebrowser.snapshot/v1'
  kind: 'structured'
  envId: string
  snapshotId: string
  basedOn: string | null
  createdAt: string
  deviceId: string
  platform: string
  cipher: { alg: 'AES-256-GCM'; kdf: 'argon2id'; kdfParams: KdfParamsJson; subkey: 'HKDF-SHA256(dek,purpose)' }
  payload: { format: 'json'; encSha256: string; encSize: number }
}

/** L2 文件级快照：整个浏览器 profile 的 tar.gz 密文（docs/v0.3.0-plan.md） */
export interface FilesManifest {
  schema: 'onebrowser.snapshot/v1'
  kind: 'files'
  envId: string
  snapshotId: string
  basedOn: string | null
  createdAt: string
  deviceId: string
  platform: string
  cipher: { alg: 'AES-256-GCM'; kdf: 'argon2id'; kdfParams: KdfParamsJson; subkey: 'HKDF-SHA256(dek,purpose)' }
  payload: { format: 'tar+gzip'; encSha256: string; encSize: number; rawSize: number }
  /** 内核版本绑定：恢复时校验，不一致提示风险（profile 含 os_crypt 数据，跨构建不保证可解） */
  kernel: { version: string; seed: string }
}

export type SnapshotManifest = StructuredManifest | FilesManifest

/** 内部载荷（blob 解密后）：登录态 + 环境配置副本 */
export interface SnapshotPayload extends StructuredData {
  env: { homepage: string }
}

export interface SealedSnapshot {
  manifest: SnapshotManifest
  /** base64(JSON({iv,ct})) —— AES-256-GCM 密文信封 */
  blobB64: string
}

export interface SealInput {
  dek: Uint8Array
  kdf: KdfParamsJson
  envId: string
  snapshotId?: string
  basedOn: string | null
  deviceId: string
  payload: SnapshotPayload
}

export async function seal(input: SealInput): Promise<SealedSnapshot> {
  const snapshotId = input.snapshotId || randomId()
  const enc = await encryptJson(input.dek, `snapshot:${snapshotId}`, input.payload)
  const blobBytes = new TextEncoder().encode(enc)
  const manifest: SnapshotManifest = {
    schema: 'onebrowser.snapshot/v1',
    kind: 'structured',
    envId: input.envId,
    snapshotId,
    basedOn: input.basedOn,
    createdAt: new Date().toISOString(),
    deviceId: input.deviceId,
    platform: `${process.platform}/${os.arch()}`,
    cipher: { alg: 'AES-256-GCM', kdf: 'argon2id', kdfParams: input.kdf, subkey: 'HKDF-SHA256(dek,purpose)' },
    payload: { format: 'json', encSha256: sha256Hex(blobBytes), encSize: blobBytes.length }
  }
  return { manifest, blobB64: toB64(blobBytes) }
}

export async function open(dek: Uint8Array, sealed: { manifest: SnapshotManifest; blobB64: string }): Promise<SnapshotPayload> {
  const envelopeJson = Buffer.from(sealed.blobB64, 'base64').toString('utf8')
  return decryptJson<SnapshotPayload>(dek, `snapshot:${sealed.manifest.snapshotId}`, envelopeJson)
}

// ---------- L2 文件级快照（blob = 原始二进制密文） ----------

export interface SealedFilesSnapshot {
  manifest: FilesManifest
  /** [12B nonce][AES-256-GCM ct||tag]（无 base64/JSON 包装，体积友好） */
  blob: Uint8Array
}

export interface SealFilesInput {
  dek: Uint8Array
  kdf: KdfParamsJson
  envId: string
  snapshotId?: string
  basedOn: string | null
  deviceId: string
  /** tar.gz 字节流（profile 打包产物） */
  tarBytes: Uint8Array
  kernel: { version: string; seed: string }
}

export async function sealFiles(input: SealFilesInput): Promise<SealedFilesSnapshot> {
  const snapshotId = input.snapshotId || randomId()
  const key = subkey(input.dek, `snapshot-files:${snapshotId}`)
  const iv = new Uint8Array(randomBytes(12))
  const cipher = createCipheriv('aes-256-gcm', key as unknown as Buffer, iv as unknown as Buffer)
  const ct = Buffer.concat([cipher.update(input.tarBytes as unknown as Buffer), cipher.final()])
  const blob = Buffer.concat([Buffer.from(iv), ct, cipher.getAuthTag()])
  const manifest: FilesManifest = {
    schema: 'onebrowser.snapshot/v1',
    kind: 'files',
    envId: input.envId,
    snapshotId,
    basedOn: input.basedOn,
    createdAt: new Date().toISOString(),
    deviceId: input.deviceId,
    platform: `${process.platform}/${os.arch()}`,
    cipher: { alg: 'AES-256-GCM', kdf: 'argon2id', kdfParams: input.kdf, subkey: 'HKDF-SHA256(dek,purpose)' },
    payload: {
      format: 'tar+gzip',
      encSha256: sha256Hex(blob),
      encSize: blob.length,
      rawSize: input.tarBytes.length
    },
    kernel: input.kernel
  }
  return { manifest, blob }
}

export function openFiles(dek: Uint8Array, sealed: { manifest: FilesManifest; blob: Uint8Array }): Uint8Array {
  const buf = Buffer.from(sealed.blob)
  const iv = buf.subarray(0, 12)
  const ct = buf.subarray(12)
  const key = subkey(dek, `snapshot-files:${sealed.manifest.snapshotId}`)
  const decipher = createDecipheriv('aes-256-gcm', key as unknown as Buffer, iv)
  decipher.setAuthTag(ct.subarray(ct.length - 16))
  const pt = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()])
  return new Uint8Array(pt)
}

export function manifestJson(manifest: SnapshotManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(manifest, null, 2))
}

export function blobBytes(sealed: SealedSnapshot): Uint8Array {
  return fromB64(sealed.blobB64)
}

/** 单环境配置的 E2E 密文（服务端 config_enc 列） */
export async function sealConfig(dek: Uint8Array, envId: string, cfg: unknown): Promise<string> {
  return encryptJson(dek, `env-config:${envId}`, cfg)
}

export async function openConfig<T>(dek: Uint8Array, envId: string, enc: string): Promise<T> {
  return decryptJson<T>(dek, `env-config:${envId}`, enc)
}
