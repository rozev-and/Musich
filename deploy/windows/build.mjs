// Сборка установщика MUSICH для Windows: node deploy/windows/build.mjs
// Нужны: Windows x64, Node (его node.exe кладётся в установщик) и Inno Setup 6 (winget install JRSoftware.InnoSetup).
// Готовый установщик — deploy/windows/out/MUSICH-Setup-<версия>.exe
// --stage-only — только папка программы (deploy/windows/out/stage), без .exe: проверить сервер из сборки
import { execFileSync, execSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const out = join(here, 'out')
const stage = join(out, 'stage')
const app = join(stage, 'app')
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' })
const version = JSON.parse(readFileSync(join(root, 'server', 'package.json'), 'utf8')).version

if (process.platform !== 'win32') throw new Error('Установщик собирается на Windows: внутрь кладётся node.exe и sharp под Windows')

console.log(`MUSICH ${version}: собираю веб и сервер`)
rmSync(stage, { recursive: true, force: true })
mkdirSync(app, { recursive: true })
run('npx vite build', join(root, 'web'))
run('npm run build', join(root, 'server'))

// сервер: скомпилированный JS без карт кода и только боевые зависимости (sharp — сборка под Windows)
cpSync(join(root, 'server', 'dist'), join(app, 'dist'), { recursive: true, filter: (p) => !p.endsWith('.map') })
for (const f of ['package.json', 'package-lock.json']) copyFileSync(join(root, 'server', f), join(app, f))
run('npm ci --omit=dev --no-audit --no-fund', app)
cpSync(join(root, 'web', 'dist'), join(app, 'public'), { recursive: true })
cpSync(join(root, 'extension', 'vk'), join(stage, 'extension', 'vk'), { recursive: true })

// свой Node внутри — ставить отдельно ничего не нужно
copyFileSync(process.execPath, join(stage, 'node.exe'))
for (const f of ['launcher.mjs', 'service.ps1']) copyFileSync(join(here, f), join(stage, f))

// иконка: PNG разных размеров в одном .ico (Windows Vista+ понимает PNG внутри ICO)
const sharp = createRequire(join(root, 'server', 'package.json'))('sharp')
const src = join(root, 'web', 'public', 'icons', 'icon-512.png')
const pngs = await Promise.all([16, 24, 32, 48, 64, 128, 256].map(async (s) => ({ s, buf: await sharp(src).resize(s, s).png().toBuffer() })))
const head = Buffer.alloc(6 + 16 * pngs.length)
head.writeUInt16LE(0, 0)
head.writeUInt16LE(1, 2)
head.writeUInt16LE(pngs.length, 4)
let offset = head.length
pngs.forEach(({ s, buf }, i) => {
  const e = 6 + i * 16
  head.writeUInt8(s >= 256 ? 0 : s, e)
  head.writeUInt8(s >= 256 ? 0 : s, e + 1)
  head.writeUInt16LE(1, e + 4)
  head.writeUInt16LE(32, e + 6)
  head.writeUInt32LE(buf.length, e + 8)
  head.writeUInt32LE(offset, e + 12)
  offset += buf.length
})
writeFileSync(join(stage, 'musich.ico'), Buffer.concat([head, ...pngs.map((p) => p.buf)]))

// чужие лицензии рядом с программой: Node и зависимости сервера
const notice = [
  'MUSICH для Windows включает:',
  `- Node.js ${process.version} (MIT) — https://nodejs.org/en/about/previous-releases, лицензия: https://github.com/nodejs/node/blob/main/LICENSE`,
  '- зависимости сервера из app\\node_modules — у каждой своя лицензия в её папке',
  '- sharp и libvips (Apache-2.0 / LGPL-3.0) — https://sharp.pixelplumbing.com',
  '',
].join('\r\n')
writeFileSync(join(stage, 'THIRD_PARTY.txt'), `\ufeff${notice}`)

if (process.argv.includes('--stage-only')) {
  console.log(`Папка программы готова: ${stage}`)
  process.exit(0)
}

const iscc = [
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
  'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
].find((p) => existsSync(p))
if (!iscc) throw new Error('Нет Inno Setup 6: winget install JRSoftware.InnoSetup')
execFileSync(iscc, [`/DAppVersion=${version}`, `/DStage=${stage}`, join(here, 'musich.iss')], { stdio: 'inherit' })
// ещё и под постоянным именем: кнопка «Скачать» в README ведёт на releases/latest/download/MUSICH-Setup.exe
copyFileSync(join(out, `MUSICH-Setup-${version}.exe`), join(out, 'MUSICH-Setup.exe'))
console.log(`Готово: ${join(out, `MUSICH-Setup-${version}.exe`)} (и MUSICH-Setup.exe — его выкладывать в релиз)`)
