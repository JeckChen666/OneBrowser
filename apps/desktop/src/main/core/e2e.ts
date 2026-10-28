// E2E 密钥体系（对应服务端 internal/auth 注释）：
//   authKey = Argon2id(主密码, saltAuth)   —— 登录等价凭据，发往服务端
//   KEK     = Argon2id(主密码, saltKek)    —— 仅内存，不离开本机
//   DEK     —— 随机数据密钥；wrappedDek(KEK 加密) 托管服务端
//   每快照子密钥 = HKDF-SHA256(DEK, salt=purpose)
import { argon2id } from '@noble/hashes/argon2.js'
import { hkdfSync, randomBytes, randomInt, createHash } from 'node:crypto'
import { x25519 } from '@noble/curves/ed25519.js'

export interface KdfParamsJson {
  alg: 'argon2id'
  m: number
  t: number
  p: number
  salt: string // b64
}

export const DEFAULT_KDF: Omit<KdfParamsJson, 'salt'> = { alg: 'argon2id', m: 19456, t: 2, p: 1 }

export function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

export function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'))
}

export function newSaltB64(): string {
  return toB64(randomBytes(16))
}

export function newKdfParams(): KdfParamsJson {
  return { ...DEFAULT_KDF, salt: newSaltB64() }
}

/** Argon2id 是同步重计算，先让出事件循环避免阻塞 IPC */
async function argon2Id(password: string, kdf: KdfParamsJson, dkLen: number): Promise<Uint8Array> {
  await new Promise((r) => setTimeout(r, 0))
  return argon2id(password, fromB64(kdf.salt), { t: kdf.t, m: kdf.m, p: kdf.p, dkLen })
}

export function deriveAuthKey(password: string, kdf: KdfParamsJson): Promise<string> {
  return argon2Id(password, kdf, 32).then(toB64)
}

export function deriveKEK(password: string, kdf: KdfParamsJson): Promise<Uint8Array> {
  return argon2Id(password, kdf, 32)
}

export function generateDEK(): Uint8Array {
  return new Uint8Array(randomBytes(32))
}

// --- AES-256-GCM（WebCrypto，密文=ct||tag） ---

async function gcmEncrypt(key: Uint8Array, plaintext: Uint8Array): Promise<{ iv: Uint8Array; ct: Uint8Array }> {
  const iv = new Uint8Array(randomBytes(12))
  const k = await crypto.subtle.importKey('raw', key as unknown as ArrayBuffer, 'AES-GCM', false, ['encrypt'])
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as ArrayBuffer }, k, plaintext as unknown as ArrayBuffer)
  return { iv, ct: new Uint8Array(ct) }
}

async function gcmDecrypt(key: Uint8Array, iv: Uint8Array, ct: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as unknown as ArrayBuffer, 'AES-GCM', false, ['decrypt'])
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
    k,
    ct as unknown as ArrayBuffer
  )
  return new Uint8Array(pt)
}

/** 从 DEK 派生用途子密钥（一快照一密钥 / 配置加密独立密钥） */
export function subkey(dek: Uint8Array, purpose: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', dek, Buffer.from(purpose), Buffer.from('onebrowser/v1'), 32))
}

// --- 信封 ---

export interface Envelope {
  v: 1
  iv: string
  ct: string
}

export async function encryptBytes(dek: Uint8Array, purpose: string, plaintext: Uint8Array): Promise<Envelope> {
  const { iv, ct } = await gcmEncrypt(subkey(dek, purpose), plaintext)
  return { v: 1, iv: toB64(iv), ct: toB64(ct) }
}

export async function decryptBytes(dek: Uint8Array, purpose: string, env: Envelope): Promise<Uint8Array> {
  return gcmDecrypt(subkey(dek, purpose), fromB64(env.iv), fromB64(env.ct))
}

export async function encryptJson(dek: Uint8Array, purpose: string, obj: unknown): Promise<string> {
  return JSON.stringify(await encryptBytes(dek, purpose, new TextEncoder().encode(JSON.stringify(obj))))
}

export async function decryptJson<T>(dek: Uint8Array, purpose: string, enc: string): Promise<T> {
  const env = JSON.parse(enc) as Envelope
  const bytes = await decryptBytes(dek, purpose, env)
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

/** DEK 托管信封（KEK 加密），存服务端 users.wrapped_dek */
export async function wrapDEK(kek: Uint8Array, dek: Uint8Array): Promise<string> {
  const { iv, ct } = await gcmEncrypt(kek, dek)
  return JSON.stringify({ v: 1, iv: toB64(iv), ct: toB64(ct) } satisfies Envelope)
}

export async function unwrapDEK(kek: Uint8Array, wrapped: string): Promise<Uint8Array> {
  const env = JSON.parse(wrapped) as Envelope
  return gcmDecrypt(kek, fromB64(env.iv), fromB64(env.ct))
}

// --- 身份密钥对与团队信封（V0.6 团队协作，附录 A.1）---
// X25519-ECDH → HKDF-SHA256(salt=ephPub, info='onebrowser/p2p/v1') → AES-256-GCM。
// wrapFor：发送方临时密钥对 × 接收方公钥；unwrapWith：接收方私钥 × 信封内临时公钥。

export interface P2pEnvelope {
  v: 1
  eph: string // 发送方临时公钥 b64（双方共同持有，兼作 HKDF salt）
  iv: string
  ct: string
}

export function generateIdentityKeypair(): { pub: Uint8Array; priv: Uint8Array } {
  const priv = x25519.utils.randomSecretKey()
  return { priv, pub: x25519.getPublicKey(priv) }
}

async function p2pKey(priv: Uint8Array, peerPub: Uint8Array, ephPub: Uint8Array): Promise<Uint8Array> {
  const shared = x25519.getSharedSecret(priv, peerPub)
  return new Uint8Array(hkdfSync('sha256', shared, ephPub, Buffer.from('onebrowser/p2p/v1'), 32))
}

/** 用接收方公钥包裹任意 32B 密钥（team DEK / 身份私钥托管均可复用） */
export async function wrapFor(recipientPubB64: string, key: Uint8Array): Promise<string> {
  const ephPriv = x25519.utils.randomSecretKey()
  const ephPub = x25519.getPublicKey(ephPriv)
  const wk = await p2pKey(ephPriv, fromB64(recipientPubB64), ephPub)
  const { iv, ct } = await gcmEncrypt(wk, key)
  return JSON.stringify({ v: 1, eph: toB64(ephPub), iv: toB64(iv), ct: toB64(ct) } satisfies P2pEnvelope)
}

export async function unwrapWith(myPriv: Uint8Array, wrapped: string): Promise<Uint8Array> {
  const env = JSON.parse(wrapped) as P2pEnvelope
  const ephPub = fromB64(env.eph)
  const wk = await p2pKey(myPriv, ephPub, ephPub)
  return gcmDecrypt(wk, fromB64(env.iv), fromB64(env.ct))
}

export function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

export function randomId(): string {
  return randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
}

/** 指纹种子：fingerprint-chromium 的 --fingerprint 仅接受 32 位整数（官方 README）。
 * 非整数 seed 会让内核解析失败，渲染进程首次读取 navigator.hardwareConcurrency
 * 即主线程死锁（KI-1，docs/v0.2.0-s3-notes.md）——生成与校验都必须守住这条约束。 */
export function randomSeed(): string {
  return String(randomInt(1, 2147483647))
}

export function isValidSeed(seed: string): boolean {
  return /^(0|[1-9]\d{0,9})$/.test(seed) && Number(seed) <= 2147483647
}
