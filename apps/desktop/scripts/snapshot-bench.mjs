// 增量快照量化门（docs/v0.5.0-plan.md §2）：三档 profile 体积实测 L2 全管线
// 「sealFiles 加密 → putObject 上传 → getObject 下载 → openFiles 解密解包」的体积与耗时。
// 决策门：50MB 档「二次保存」（全量=加密+上传+提交）< 5s → 增量不立项。
// 运行：node scripts/snapshot-bench.mjs（需 localstack :4566 可达）
import assert from 'node:assert'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.ONEBROWSER_S3_ENDPOINT ||= 'http://127.0.0.1:4566'

// 主进程模块经 electron-vite 打包，benchmark 直接用 tsx 源跑会缺 electron——
// 改走纯 Node 复刻同构管线：tar 打包（child busybox tar 或手工 tar）+ AES-256-GCM。
// 关键瓶颈是「加密吞吐」与「上传带宽」，两者都不依赖 electron 运行时。
import { execSync } from 'node:child_process'

const S3 = 'http://127.0.0.1:4566/onebrowser-snapshots'
const BENCH = `bench-${Date.now()}`

async function s3Put(key, body) {
  const r = await fetch(`${S3}/${key}`, { method: 'PUT', body })
  assert(r.ok, `PUT ${key} -> ${r.status}`)
}
async function s3Get(key) {
  const r = await fetch(`${S3}/${key}`)
  assert(r.ok, `GET ${key} -> ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

// 造 profile：多个小文件 + 大二进制（模拟 Cookies/Local Storage/IndexedDB 混合形态）
function makeProfile(dir, totalMB) {
  fs.mkdirSync(path.join(dir, 'IndexedDB'), { recursive: true })
  const big = Buffer.alloc((totalMB * 1024 * 1024 * 0.8) | 0)
  randomBytes(big.length).copy(big) // 随机字节=最坏压缩场景
  fs.writeFileSync(path.join(dir, 'IndexedDB/chrome-indexdb.bin'), big, { recursive: true })
  for (let i = 0; i < 200; i++) {
    fs.writeFileSync(path.join(dir, `file-${i}.json`), randomBytes(2048))
  }
}

// tar（GNU tar：Windows 开发机已配；与产品 profileArchive 同为 tar 流）
function tarDir(dir) {
  const out = path.join(dir, '..', `${path.basename(dir)}.tar`)
  // GNU tar 把 "C:" 解析为远程主机：--force-local（windows-migration 老坑）
  execSync(`tar --force-local -cf "${out}" -C "${dir}" .`, { stdio: 'pipe' })
  return fs.readFileSync(out)
}

const dek = randomBytes(32)
async function gcm(key, buf, enc) {
  const { webcrypto } = await import('node:crypto')
  const k = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, [enc ? 'encrypt' : 'decrypt'])
  const iv = webcrypto.getRandomValues(new Uint8Array(12))
  if (enc) {
    const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, buf)
    return { iv, payload: new Uint8Array(ct) }
  }
  const pt = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, k, buf.subarray(12))
  return { iv: null, payload: new Uint8Array(pt) }
}

const results = []
for (const mb of [10, 50, 200]) {
  const dir = path.join(os.tmpdir(), `ob-bench-${mb}`)
  makeProfile(dir, mb)
  const t0 = Date.now()
  const tar = tarDir(dir)
  const tTar = Date.now() - t0

  const t1 = Date.now()
  const { iv, payload: encrypted } = await gcm(dek, tar, true)
  const tEnc = Date.now() - t1

  const t2 = Date.now()
  await s3Put(`${BENCH}/${mb}m/blob.enc`, Buffer.concat([iv, encrypted]))
  const tUp = Date.now() - t2

  const t3 = Date.now()
  const downloaded = await s3Get(`${BENCH}/${mb}m/blob.enc`)
  const tDown = Date.now() - t3

  const t4 = Date.now()
  const dec = await gcm(dek, downloaded, false)
  assert(Buffer.compare(dec.payload, tar) === 0, `${mb}MB 回读不一致`)
  const tDec = Date.now() - t4

  const saveTotal = tTar + tEnc + tUp // 「二次保存」= 打包+加密+上传
  results.push({
    mb,
    tarMB: +(tar.length / 1048576).toFixed(1),
    encMBs: +(tar.length / 1048576 / (tEnc / 1000)).toFixed(0),
    saveTotalMs: saveTotal,
    downMs: tDown,
    decMs: tDec
  })
  console.log(
    `${mb}MB 档：tar ${(tTar / 1000).toFixed(1)}s · 加密 ${(tEnc / 1000).toFixed(1)}s（${results.at(-1).encMBs}MB/s）· 上传 ${(tUp / 1000).toFixed(1)}s → 二次保存合计 ${(saveTotal / 1000).toFixed(1)}s · 下载 ${(tDown / 1000).toFixed(1)}s · 解密 ${(tDec / 1000).toFixed(1)}s`
  )
  fs.rmSync(dir, { recursive: true, force: true })
}

const m50 = results.find((r) => r.mb === 50)
console.log(`\n决策门（50MB 二次保存 < 5s → 增量不立项）：${(m50.saveTotalMs / 1000).toFixed(1)}s → ${m50.saveTotalMs < 5000 ? '不立项 ✅' : '立项'}`)
