// 快照引擎：结构化数据 → 加密信封（manifest + blob）。
// 格式规范见 docs/project-plan.md §5，向前兼容 M6 的文件级快照（kind: 'files'）。
import * as os from 'node:os'
import { encryptJson, decryptJson, sha256Hex, toB64, fromB64, randomId, type KdfParamsJson } from './e2e'
import type { StructuredData } from './dataPlane'

export interface SnapshotManifest {
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

export async function open(dek: Uint8Array, sealed: SealedSnapshot): Promise<SnapshotPayload> {
  const envelopeJson = Buffer.from(sealed.blobB64, 'base64').toString('utf8')
  return decryptJson<SnapshotPayload>(dek, `snapshot:${sealed.manifest.snapshotId}`, envelopeJson)
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
