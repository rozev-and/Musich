// Исходник значка для `tauri icon`: знак MUSICH (web/public/icons/icon.svg) в 1024×1024.
// sharp берём у сервера (server/node_modules) — отдельно его не ставим
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const sharp = createRequire(`${root}server/package.json`)('sharp')
mkdirSync(`${root}desktop/src-tauri/icons`, { recursive: true })
await sharp(`${root}web/public/icons/icon.svg`, { density: 512 }).resize(1024, 1024).png().toFile(`${root}desktop/src-tauri/icons/source.png`)
console.log('desktop/src-tauri/icons/source.png')
