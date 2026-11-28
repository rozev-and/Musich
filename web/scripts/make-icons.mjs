// Иконки MUSICH в стиле Nothing: белый круг, чёрный проигрыватель винила, красная середина пластинки.
// Знак рисуется векторно (SVG ниже), PNG делает sharp из server/node_modules.
// Запуск: node scripts/make-icons.mjs  → public/favicon.svg, public/icons/*, android mipmap-*/ic_launcher*.png
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const sharp = createRequire(new URL('../../server/package.json', import.meta.url))('sharp')

const PAPER = '#f4f4f4'
const INK = '#111111'
const RED = '#d71921'

// Проигрыватель в координатах круга радиусом 70 с центром в 0,0: корпус, белый диск, красная наклейка, тонарм, кнопка
const GLYPH = `
  <rect x="-38" y="-36" width="76" height="72" rx="12" fill="${INK}"/>
  <circle cx="-6" cy="2" r="25" fill="${PAPER}"/>
  <circle cx="-6" cy="2" r="19" fill="none" stroke="#c9c9c9" stroke-width="1.4"/>
  <circle cx="-6" cy="2" r="8" fill="${RED}"/>
  <circle cx="-6" cy="2" r="1.8" fill="${INK}"/>
  <circle cx="27" cy="-25" r="4.5" fill="${PAPER}"/>
  <path d="M27 -25 L27 -4 L15 14" fill="none" stroke="${PAPER}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="-30" cy="28" r="2.5" fill="${PAPER}"/>`

/**
 * bg: 'circle' — белый круг на прозрачном (как значки Nothing), 'square' — белый квадрат во весь холст
 * (PWA и Apple сами обрежут), 'none' — только знак (слой адаптивной иконки Android).
 * scale — размер знака относительно круга-образца
 */
const svg = ({ bg = 'circle', scale = 1 } = {}) => {
  const back = bg === 'circle' ? `<circle r="70" fill="${PAPER}"/>` : bg === 'square' ? `<rect x="-70" y="-70" width="140" height="140" fill="${PAPER}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-70 -70 140 140">${back}<g transform="scale(${scale})">${GLYPH}</g></svg>`
}
const png = (s, size) => sharp(Buffer.from(s), { density: Math.max(72, (72 * size) / 140) * 2 }).resize(size, size).png().toBuffer()

const pub = new URL('../public/', import.meta.url)
mkdirSync(new URL('icons/', pub), { recursive: true })
writeFileSync(new URL('favicon.svg', pub), svg())
writeFileSync(new URL('icons/icon.svg', pub), svg({ bg: 'square', scale: 1.15 }))
for (const [name, opt, size] of [
  ['icon-512.png', { bg: 'square', scale: 1.15 }, 512],
  ['icon-192.png', { bg: 'square', scale: 1.15 }, 192],
  ['apple-touch-icon.png', { bg: 'square', scale: 1.15 }, 180],
  ['icon-48.png', {}, 48],
  ['icon-32.png', {}, 32],
]) {
  writeFileSync(new URL(`icons/${name}`, pub), await png(svg(opt), size))
  console.log(name)
}

// --- Android: обычная и круглая иконка (белый круг) + адаптивная: белая подложка и слой со знаком ---
const res = new URL('../android/app/src/main/res/', import.meta.url)
if (existsSync(res)) {
  const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 }
  for (const [d, size] of Object.entries(DENSITIES)) {
    const dir = new URL(`mipmap-${d}/`, res)
    mkdirSync(dir, { recursive: true })
    writeFileSync(new URL('ic_launcher.png', dir), await png(svg(), size))
    writeFileSync(new URL('ic_launcher_round.png', dir), await png(svg(), size))
    // слой адаптивной иконки: холст 108dp, система показывает середину ~66dp — знак как в круге того же размера
    writeFileSync(new URL('ic_launcher_foreground.png', dir), await png(svg({ bg: 'none', scale: 66 / 108 }), Math.round((size * 108) / 48)))
  }
  writeFileSync(
    new URL('values/ic_launcher_background.xml', res),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${PAPER}</color>\n</resources>\n`,
  )
  console.log('android: mipmap-*/ic_launcher*.png')
}
