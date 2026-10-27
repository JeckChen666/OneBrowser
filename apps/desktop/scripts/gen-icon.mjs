// 从 build/icon.svg 生成 electron-builder 所需的 build/icon.png（512，自动转 ico/icns）
// 用法：node scripts/gen-icon.mjs
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))
const svgPath = path.join(root, '../build/icon.svg')
const outPath = path.join(root, '../build/icon.png')

const svg = fs.readFileSync(svgPath)
await sharp(svg, { density: 384 }).resize(512, 512).png().toFile(outPath)
console.log(`icon.png written: ${outPath}`)
