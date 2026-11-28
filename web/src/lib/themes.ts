import type { Theme } from '../types'

/**
 * Оформление = режим (светлый/тёмный) × тема (фон и виджеты) × акцентный цвет.
 * Тема задаёт CSS-переменные страницы; акцент — то, что в Nothing красное (переменная --red).
 * В тёмном режиме виджеты тёмные, как у Nothing; в светлом — светлые с тёмным текстом и лёгким оттенком темы.
 * Свою тему человек собирает сам (фон, виджеты, акцент) — она превращается в такую же палитру.
 */

interface Mode {
  page: string // фон страницы (под градиентом — его основа)
  dot: string // точки на фоне
  card: string // виджет
  card2: string // строка под курсором, вложенные блоки
  card3: string // поля ввода, кнопки внутри виджета
  line: string // разделители
  border: string // тонкая рамка виджета (в тёмном режиме — чтобы виджет не сливался с фоном)
  gradient?: string // градиент под точками
  bgPos?: string // своя тема с картинкой: где её важная часть («40% 30%») — по ней картинка подрезается на любом экране
  // у своих тем цвет текста подбирается под фон и виджеты; у встроенных берётся из index.css по режиму
  ink?: string
  inkMuted?: string
  fg?: string
  muted?: string
  dotOff?: string
}

export interface Palette {
  id: string
  accent: string // акцент темы по умолчанию
  lightAccent?: string // если в светлом режиме акцент другой (белый у «Монохрома» на светлом не виден)
  sel?: string // цвет выделения темы; нет — цвет текста (чёрный днём, белый ночью)
  lightSel?: string
  darkOnly?: boolean // светлого варианта нет: тема всегда тёмная, переключатель режима на неё не действует
  font?: string // свой шрифт темы (CSS font-family); шрифт из настроек главнее
  light: Mode
  dark: Mode
  name?: string // у своих тем — имя, которое дал человек
}

// ---------- цвета ----------

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', '').slice(0, 6).padEnd(6, '0'), 16)
  return [n >> 16, (n >> 8) & 255, n & 255]
}
const toHex = (c: number[]) => `#${c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('')}`

/** Смесь двух цветов: t = 0 — первый, 1 — второй */
export const mix = (a: string, b: string, t: number) => {
  const [x, y] = [rgb(a), rgb(b)]
  return toHex(x.map((v, i) => v + (y[i] - v) * t))
}

/** Относительная яркость 0..1 (как в WCAG) */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Текст поверх акцента: на светлом акценте (жёлтый, белый) — тёмный, иначе белый */
export const onAccent = (hex: string) => (/^#?[0-9a-f]{6}$/i.test(hex) && luminance(hex) > 0.45 ? '#0a0a0a' : '#ffffff')

// ---------- фоны ----------

const linear = (angle: number, colors: string[]) => `linear-gradient(${angle}deg, ${colors.join(', ')})`
// «пятна»: мягкие цветные облака по углам — на светлом основе или в темноте
const mesh = (colors: string[]) => {
  const spots = ['at 12% 8%', 'at 92% 18%', 'at 55% 105%', 'at 0% 85%']
  return colors.map((c, i) => `radial-gradient(${spots[i % spots.length]}, ${c} 0, transparent ${i === 2 ? 62 : 55}%)`).join(', ')
}

// ---------- встроенные темы ----------

// Светлые виджеты: почти белые с оттенком темы, текст тёмный, тонкая рамка — чтобы не растворялись в фоне
const LIGHT_TEXT = { fg: '#0a0a0a', muted: '#6b6b6b' }
const lightWidgets = (hue: number, sat: number) => ({
  card: `hsl(${hue} ${sat}% 98.5%)`,
  card2: `hsl(${hue} ${sat * 0.8}% 94.5%)`,
  card3: `hsl(${hue} ${sat * 0.7}% 91%)`,
  line: `hsl(${hue} ${sat * 0.5}% 88%)`,
  dotOff: `hsl(${hue} ${sat * 0.4}% 84%)`,
  border: 'rgb(0 0 0 / .06)',
  ...LIGHT_TEXT,
})

// Тонированная тема из оттенка: светлый фон и светлые виджеты днём, почти чёрный фон и тёмные виджеты ночью
const tinted = (id: string, hue: number, sat: number, accent: string): Palette => ({
  id,
  accent,
  light: {
    page: `hsl(${hue} ${sat}% 90%)`,
    dot: `hsl(${hue} ${sat * 0.7}% 80%)`,
    ...lightWidgets(hue, sat * 0.6),
  },
  dark: {
    page: `hsl(${hue} ${sat}% 3%)`,
    dot: `hsl(${hue} ${sat * 0.6}% 9%)`,
    card: `hsl(${hue} ${sat * 0.8}% 7%)`,
    card2: `hsl(${hue} ${sat * 0.6}% 11%)`,
    card3: `hsl(${hue} ${sat * 0.5}% 16%)`,
    line: `hsl(${hue} ${sat * 0.5}% 14%)`,
    border: `hsl(${hue} ${sat * 0.5}% 12%)`,
  },
})

/**
 * Градиентная тема: днём — светлый градиент, ночью — цветные пятна в темноте.
 * Виджеты — как у тонированной темы того же оттенка (с полупрозрачной рамкой, чтобы читались поверх цвета)
 */
const gradient = (id: string, hue: number, accent: string, light: string, darkSpots: string[], darkBase: string): Palette => {
  const p = tinted(id, hue, 30, accent)
  return {
    ...p,
    light: { ...p.light, ...lightWidgets(hue, 40), page: '#f2f0f4', dot: 'rgb(0 0 0 / .1)', gradient: light },
    dark: { ...p.dark, page: darkBase, dot: 'rgb(255 255 255 / .07)', border: 'rgb(255 255 255 / .06)', gradient: mesh(darkSpots) },
  }
}

export const PALETTES: Palette[] = [
  {
    id: 'nothing',
    accent: '#d71921',
    light: {
      page: '#e8e8e6', dot: '#cfcfcc', card: '#fafaf8', card2: '#efefec', card3: '#e5e5e1', line: '#dcdcd8', dotOff: '#d2d2ce',
      border: 'rgb(0 0 0 / .05)', ...LIGHT_TEXT,
    },
    dark: { page: '#000000', dot: '#161616', card: '#111111', card2: '#1b1b1b', card3: '#272727', line: '#252525', border: '#1f1f1f' },
  },
  tinted('blue', 218, 45, '#2f6bff'),
  tinted('orange', 24, 50, '#ff6a13'),
  tinted('violet', 265, 40, '#8b5cf6'),
  tinted('terminal', 140, 35, '#2fd15b'),
  tinted('sakura', 340, 45, '#ff3d7f'),
  tinted('sand', 38, 30, '#d9a441'),
  {
    id: 'mono',
    accent: '#f4f4f4',
    lightAccent: '#0a0a0a',
    light: {
      page: '#ececec', dot: '#d4d4d4', card: '#ffffff', card2: '#f2f2f2', card3: '#e8e8e8', line: '#e0e0e0', dotOff: '#d6d6d6',
      border: 'rgb(0 0 0 / .06)', ...LIGHT_TEXT,
    },
    dark: { page: '#000000', dot: '#121212', card: '#0a0a0a', card2: '#161616', card3: '#232323', line: '#1e1e1e', border: '#1a1a1a' },
  },
  gradient('sunset', 320, '#ff7a3d', linear(135, ['#ffd6b8', '#f6c6e2', '#d8c8ff']), ['#8a2e10', '#7a1658', '#33166e'], '#09050b'),
  gradient('aurora', 200, '#22d3ee', linear(160, ['#c8f2e4', '#c6dbff', '#e2d0ff']), ['#0b6650', '#0e3478', '#421670'], '#02070a'),
  gradient('neon', 290, '#ff2fb3', mesh(['#ff9ad5', '#8fe9ff', '#c9a6ff']), ['#b0188a', '#0a7896', '#5420b0'], '#050208'),
  gradient('lava', 15, '#ff4d1a', linear(160, ['#ffe0b0', '#ffb39a', '#ff9aa8']), ['#9a2006', '#a85000', '#650a24'], '#080302'),
  gradient('mint', 155, '#3ddc97', linear(135, ['#d2f7e8', '#e4fbd2', '#c9eef7']), ['#0d6644', '#46780f', '#0c5468'], '#020805'),
  gradient('midnight', 235, '#7c8cff', linear(180, ['#cfd6ff', '#e2d6ff']), ['#1e30a0', '#5420a0', '#0c1e58'], '#020210'),
  gradient('peach', 15, '#ff8a65', linear(120, ['#ffe5d6', '#ffd1dc', '#fff1c9']), ['#7a3220', '#7a2046', '#685612'], '#070404'),
  darkOnly({
    // нынешний клиент Steam: сине-серая ночь, голубой акцент, холодный серый текст
    id: 'steam2026',
    accent: '#1a9fff',
    mode: {
      page: '#0e141b', dot: 'rgb(255 255 255 / .05)', gradient: mesh(['#1b3a5c', '#2a475e', '#14304f']),
      card: '#171d25', card2: '#1f2a36', card3: '#2a3846', line: '#25303c', border: 'rgb(255 255 255 / .06)', dotOff: '#2e3c4b',
      ink: '#c7d5e0', inkMuted: '#8f98a0', fg: '#dcdedf', muted: '#8f98a0',
    },
  }),
  darkOnly({
    // старый зелёный Steam: оливковые панели, светло-зелёный текст, золотистое выделение
    id: 'steam1990',
    accent: '#c4b550',
    mode: {
      page: '#3e4637', dot: 'rgb(0 0 0 / .14)', gradient: linear(180, ['#4a5542', '#363d30']),
      card: '#4c5844', card2: '#5a6a50', card3: '#3e4637', line: '#5f6d55', border: '#292d23', dotOff: '#66735c',
      ink: '#dee5d7', inkMuted: '#a0aa95', fg: '#dee5d7', muted: '#a0aa95',
    },
  }),
  darkOnly({
    // консоль Linux (Ubuntu): тёмно-фиолетовый фон, светлый текст, зелёное приглашение «user@host:~$»
    id: 'linux',
    accent: '#8ae234',
    font: '"JetBrains Mono"',
    mode: {
      page: '#2b0a21', dot: 'rgb(255 255 255 / .06)',
      card: '#380d2b', card2: '#45123a', card3: '#541848', line: '#4a1440', border: 'rgb(255 255 255 / .06)', dotOff: '#5e2252',
      ink: '#eeeeec', inkMuted: '#a89aa3', fg: '#eeeeec', muted: '#a89aa3',
    },
  }),
  darkOnly({
    // «Матрица»: чёрный экран, зелёный текст, еле заметные вертикальные полосы «дождя» и зелёное свечение
    id: 'matrix',
    accent: '#00ff41',
    font: '"JetBrains Mono"',
    mode: {
      page: '#000000', dot: 'rgb(0 255 65 / .08)',
      gradient: 'repeating-linear-gradient(90deg, rgb(0 255 65 / .035) 0 1px, transparent 1px 22px), ' + mesh(['#003b12', '#00240b', '#002e10']),
      card: '#020a04', card2: '#06170b', card3: '#0a2412', line: '#0b2a14', border: 'rgb(0 255 65 / .12)', dotOff: '#0d3318',
      ink: '#5cff7a', inkMuted: '#1f9e3c', fg: '#5cff7a', muted: '#1f9e3c',
    },
  }),
  {
    // Google: белые карточки на светло-сером, днём — пастельные пятна четырёх фирменных цветов, синий акцент, Roboto
    id: 'google',
    accent: '#8ab4f8',
    lightAccent: '#1a73e8',
    font: '"Roboto Variable"',
    light: {
      page: '#f1f3f4', dot: 'rgb(0 0 0 / .07)', gradient: mesh(['#d2e3fc', '#fad2cf', '#ceead6', '#fef0c3']),
      card: '#ffffff', card2: '#f1f3f4', card3: '#e8eaed', line: '#dadce0', border: 'rgb(0 0 0 / .06)', dotOff: '#dadce0',
      ink: '#202124', inkMuted: '#5f6368', fg: '#202124', muted: '#5f6368',
    },
    dark: {
      page: '#1b1c1e', dot: 'rgb(255 255 255 / .05)', gradient: mesh(['#173564', '#561d19', '#123a20', '#4f410f']),
      card: '#28292c', card2: '#303134', card3: '#3c4043', line: '#3c4043', border: 'rgb(255 255 255 / .06)', dotOff: '#44474b',
      ink: '#e8eaed', inkMuted: '#9aa0a6', fg: '#e8eaed', muted: '#9aa0a6',
    },
  },
  {
    // Minecraft: днём — полоса травы над землёй и серые окна инвентаря с тёмной обводкой; ночью — пещера, камень, алмазный акцент
    id: 'minecraft',
    accent: '#4aedd9',
    lightAccent: '#3c8527',
    light: {
      page: '#866043', dot: 'rgb(0 0 0 / .12)', gradient: linear(180, ['#86c45a 0', '#6aa83c 18%', '#866043 18%', '#6e4e36 100%']),
      card: '#c6c6c6', card2: '#b4b4b4', card3: '#a0a0a0', line: '#9a9a9a', border: '#373737', dotOff: '#8b8b8b',
      ink: '#ffffff', inkMuted: '#e6dccd', fg: '#1f1f1f', muted: '#4a4a4a',
    },
    dark: {
      page: '#121110', dot: 'rgb(255 255 255 / .05)', gradient: mesh(['#22361a', '#3a2818', '#13303a']),
      card: '#2b2b2b', card2: '#363636', card3: '#454545', line: '#3d3d3d', border: '#0c0c0c', dotOff: '#4c4c4c',
      ink: '#e0e0e0', inkMuted: '#9a9a9a', fg: '#e0e0e0', muted: '#9a9a9a',
    },
  },
  {
    // Obsidian: графитовые панели, фиолетовый акцент, Inter — как в самих заметках
    id: 'obsidian',
    accent: '#8b6cef',
    lightAccent: '#705dcf',
    light: {
      page: '#ececec', dot: 'rgb(0 0 0 / .07)',
      card: '#ffffff', card2: '#f6f6f6', card3: '#ebebeb', line: '#e3e3e3', border: 'rgb(0 0 0 / .06)', dotOff: '#d9d9d9',
      ink: '#222222', inkMuted: '#5c5c5c', fg: '#222222', muted: '#5c5c5c',
    },
    dark: {
      page: '#161616', dot: 'rgb(255 255 255 / .05)', gradient: mesh(['#2a1f52', '#1e1e1e', '#1f1838']),
      card: '#1e1e1e', card2: '#262626', card3: '#303030', line: '#363636', border: '#2a2a2a', dotOff: '#3a3a3a',
      ink: '#dadada', inkMuted: '#999999', fg: '#dadada', muted: '#999999',
    },
  },
  {
    // Claude: тёплый кремовый фон и светлые карточки днём, тёплый графит ночью, терракотовый акцент — плоско, как в самом Claude
    id: 'claude',
    accent: '#d97757',
    lightAccent: '#c96442',
    light: {
      page: '#f0eee6', dot: 'rgb(31 30 29 / .07)',
      card: '#faf9f5', card2: '#f5f4ed', card3: '#ebe9df', line: '#e8e6dc', border: 'rgb(31 30 29 / .08)', dotOff: '#dedcd1',
      ink: '#141413', inkMuted: '#73726c', fg: '#141413', muted: '#73726c',
    },
    dark: {
      page: '#1f1e1d', dot: 'rgb(255 255 255 / .04)',
      card: '#262624', card2: '#30302e', card3: '#3a3a37', line: '#3e3e38', border: 'rgb(255 255 255 / .06)', dotOff: '#45443f',
      ink: '#faf9f5', inkMuted: '#a6a39a', fg: '#faf9f5', muted: '#a6a39a',
    },
  },
  {
    // Яндекс Музыка: чёрное и белое, жёлтый акцент; ночью тёплое свечение, как у «Моей волны»
    id: 'yandex',
    accent: '#ffdb4d',
    lightAccent: '#e6a800',
    light: {
      page: '#f2f2f2', dot: 'rgb(0 0 0 / .07)', gradient: mesh(['#fff1b3', '#ffe0cc', '#fff7d6']),
      card: '#ffffff', card2: '#f5f5f5', card3: '#ebebeb', line: '#e6e6e6', border: 'rgb(0 0 0 / .06)', dotOff: '#dddddd',
      ink: '#000000', inkMuted: '#7a7a7a', fg: '#000000', muted: '#7a7a7a',
    },
    dark: {
      page: '#0d0d0d', dot: 'rgb(255 255 255 / .05)', gradient: mesh(['#4a3500', '#4a1a05', '#2b2000']),
      card: '#181818', card2: '#222222', card3: '#2c2c2c', line: '#2a2a2a', border: 'rgb(255 255 255 / .06)', dotOff: '#333333',
      ink: '#ffffff', inkMuted: '#9a9a9a', fg: '#ffffff', muted: '#9a9a9a',
    },
  },
  {
    // VK Музыка: днём — классический серо-голубой фон ВКонтакте и белые блоки, ночью — графит; синий акцент
    id: 'vk',
    accent: '#71aaeb',
    lightAccent: '#0077ff',
    light: {
      page: '#edeef0', dot: 'rgb(0 0 0 / .06)',
      card: '#ffffff', card2: '#f5f6f8', card3: '#ebedf0', line: '#e7e8ec', border: '#dce1e6', dotOff: '#d3d9de',
      ink: '#000000', inkMuted: '#818c99', fg: '#000000', muted: '#818c99',
    },
    dark: {
      page: '#141414', dot: 'rgb(255 255 255 / .05)', gradient: mesh(['#0d2a52', '#141414', '#16204a']),
      card: '#222222', card2: '#2c2d2e', card3: '#363738', line: '#363738', border: 'rgb(255 255 255 / .06)', dotOff: '#424344',
      ink: '#e1e3e6', inkMuted: '#76787a', fg: '#e1e3e6', muted: '#76787a',
    },
  },
  darkOnly({
    // Spotify: чёрный фон с зеленоватым отсветом сверху, тёмно-серые панели, зелёный акцент
    id: 'spotify',
    accent: '#1ed760',
    mode: {
      page: '#000000', dot: 'rgb(255 255 255 / .04)', gradient: linear(180, ['#14331f', '#000000 40%']),
      card: '#121212', card2: '#1f1f1f', card3: '#2a2a2a', line: '#282828', border: 'rgb(255 255 255 / .05)', dotOff: '#333333',
      ink: '#ffffff', inkMuted: '#b3b3b3', fg: '#ffffff', muted: '#b3b3b3',
    },
  }),
]

// Цвет выделения у встроенных тем. Одноцветные и градиентные — приглушённый оттенок темы, а не чёрно-белый:
// ночью тёмный (на нём светлый текст), днём светлый (на нём тёмный текст) — не режет глаза.
// У сервисов — их фирменный цвет
const soft = (hue: number, sat: number) => ({
  sel: toHexColor(`hsl(${hue} ${Math.min(sat, 45)}% 30%)`),
  lightSel: toHexColor(`hsl(${hue} ${sat}% 82%)`),
})
const THEME_SEL: Record<string, { sel?: string; lightSel?: string }> = {
  nothing: { sel: '#3a3a3a', lightSel: '#d6d6d2' },
  mono: { sel: '#3a3a3a', lightSel: '#d6d6d6' },
  blue: soft(218, 45),
  orange: soft(24, 50),
  violet: soft(265, 40),
  terminal: soft(140, 35),
  sakura: soft(340, 45),
  sand: soft(38, 30),
  sunset: soft(320, 40),
  aurora: soft(200, 45),
  neon: soft(290, 45),
  lava: soft(15, 50),
  mint: soft(155, 40),
  midnight: soft(235, 45),
  peach: soft(15, 45),
  yandex: { sel: '#ffdb4d', lightSel: '#ffdb4d' },
  vk: { sel: '#71aaeb', lightSel: '#0077ff' },
  spotify: { sel: '#1ed760' },
  google: { sel: '#8ab4f8', lightSel: '#1a73e8' },
  minecraft: { sel: '#4aedd9', lightSel: '#3c8527' },
  obsidian: { sel: '#8b6cef', lightSel: '#705dcf' },
  claude: { sel: '#d97757', lightSel: '#c96442' },
  // как выделенная вкладка в клиенте Steam — спокойный сине-стальной, а не яркий голубой
  steam2026: { sel: '#2d5b80' },
  steam1990: { sel: '#c4b550' },
  linux: { sel: '#8ae234' },
  matrix: { sel: '#00ff41' },
}
for (const p of PALETTES) Object.assign(p, THEME_SEL[p.id])

/** Тема без светлого варианта: в любом режиме одна и та же */
function darkOnly(t: { id: string; accent: string; mode: Mode; font?: string }): Palette {
  return { id: t.id, accent: t.accent, darkOnly: true, font: t.font, light: t.mode, dark: t.mode }
}

/** Режим, в котором тема реально показывается: у тем только с тёмным — всегда тёмный */
export const effectiveTheme = (p: Palette, theme: Theme): Theme => (p.darkOnly ? 'dark' : theme)

/** Темы по группам в настройках; свои — отдельной группой в конце */
export const PALETTE_GROUPS = [
  { id: 'solid', ids: ['nothing', 'blue', 'orange', 'violet', 'terminal', 'sakura', 'sand', 'mono'] },
  { id: 'gradient', ids: ['sunset', 'aurora', 'neon', 'lava', 'mint', 'midnight', 'peach'] },
  { id: 'services', ids: ['yandex', 'vk', 'spotify', 'steam2026', 'steam1990', 'linux', 'matrix', 'google', 'minecraft', 'obsidian', 'claude'] },
] as const

// Готовые акцентные цвета; null в настройке — «как в теме»
export const ACCENTS = ['#d71921', '#ff6a13', '#ffc21a', '#2fbf5b', '#14b8a6', '#2f6bff', '#8b5cf6', '#ff3d7f', '#f4f4f4']

// ---------- свои темы ----------

export type BgKind = 'solid' | 'linear' | 'mesh' | 'image'

export interface CustomTheme {
  id: string // 'custom-…'
  name: string
  bg: BgKind // один цвет, плавный градиент или пятна
  colors: string[] // 1–3 цвета фона (для одного цвета берётся первый)
  angle: number // направление плавного градиента, градусы
  widget: string // цвет виджетов
  accent: string
  // фон-картинка (bg = 'image'): data-URL уменьшенной копии, точка фокуса в %, затемнение в %, средняя яркость 0–1
  image?: string
  focus?: [number, number]
  dim?: number
  lum?: number
}

export const newCustomTheme = (): CustomTheme => ({
  id: `custom-${Date.now().toString(36)}`,
  name: '',
  bg: 'linear',
  colors: ['#ff9a5a', '#c86bfa', '#4f7bff'],
  angle: 135,
  widget: '#111111',
  accent: '#ff7a3d',
})

/** Текст поверх фона страницы: средняя яркость цветов фона решает, тёмный он или светлый */
const inkFor = (bg: string[]) => {
  const light = bg.reduce((a, c) => a + luminance(c), 0) / bg.length > 0.35
  return light
    ? { ink: '#0a0a0a', inkMuted: '#555555', dot: 'rgb(0 0 0 / .12)' }
    : { ink: '#f4f4f4', inkMuted: '#a3a3a3', dot: 'rgb(255 255 255 / .08)' }
}

/** Виджеты из одного цвета: оттенки для вложенных блоков и текст — под его яркость */
const widgetMode = (card: string, dark: boolean) => {
  const light = luminance(card) > 0.4
  const toward = light ? '#000000' : '#ffffff'
  return {
    card,
    card2: mix(card, toward, 0.06),
    card3: mix(card, toward, 0.12),
    line: mix(card, toward, 0.1),
    dotOff: mix(card, toward, 0.17),
    fg: light ? '#0a0a0a' : '#f4f4f4',
    muted: light ? '#5c5c5c' : '#8a8a8a',
    border: dark ? mix(card, '#ffffff', 0.07) : 'transparent',
  }
}

/** Своя тема → палитра. Днём фон как выбрали; в тёмном режиме тот же фон приглушается */
export function customPalette(c: CustomTheme): Palette {
  if (c.bg === 'image' && c.image) return imagePalette(c, c.image)
  const colors = c.bg === 'solid' ? c.colors.slice(0, 1) : c.colors
  const build = (dark: boolean): Mode => {
    const bg = dark ? colors.map((x) => mix(x, '#000000', c.bg === 'mesh' ? 0.45 : 0.78)) : colors
    const base = c.bg === 'mesh' ? (dark ? '#050505' : mix(colors[0], '#ffffff', 0.55)) : bg[0]
    const text = inkFor(c.bg === 'mesh' ? [base, ...bg] : bg)
    return {
      page: base,
      dot: text.dot,
      gradient: c.bg === 'solid' ? undefined : c.bg === 'linear' ? linear(c.angle, bg) : mesh(bg),
      ink: text.ink,
      inkMuted: text.inkMuted,
      ...widgetMode(c.widget, dark),
    }
  }
  return { id: c.id, name: c.name, accent: c.accent, light: build(false), dark: build(true) }
}

/**
 * Фон-картинка: сверху полупрозрачное затемнение (в тёмном режиме сильнее), картинка — «cover» с точкой фокуса:
 * на узком телефоне, планшете и широком ПК подрезается по-разному, но важная часть остаётся в кадре.
 * Цвет текста — по средней яркости картинки с учётом затемнения
 */
function imagePalette(c: CustomTheme, image: string): Palette {
  const [fx, fy] = c.focus ?? [50, 50]
  const build = (dark: boolean): Mode => {
    const dim = Math.min(90, Math.max(dark ? 45 : 0, c.dim ?? 25)) / 100
    const lum = (c.lum ?? 0.3) * (1 - dim)
    const text = lum > 0.35 ? { ink: '#0a0a0a', inkMuted: '#3f3f3f', dot: 'rgb(0 0 0 / .1)' } : { ink: '#f4f4f4', inkMuted: '#c4c4c4', dot: 'rgb(255 255 255 / .06)' }
    return {
      page: '#000000',
      dot: text.dot,
      gradient: `linear-gradient(rgb(0 0 0 / ${dim}), rgb(0 0 0 / ${dim})), url("${image}")`,
      bgPos: `${fx}% ${fy}%`,
      ink: text.ink,
      inkMuted: text.inkMuted,
      ...widgetMode(c.widget, dark),
    }
  }
  return { id: c.id, name: c.name, accent: c.accent, light: build(false), dark: build(true) }
}

/** Цвет выделения темы в этом режиме; undefined — как текст */
export const themeSel = (p: Palette, theme: Theme) => (theme === 'light' ? (p.lightSel ?? p.sel) : p.sel)

/** Любой цвет темы (hex или hsl(h s% l%)) → hex, чтобы его можно было смешивать */
function toHexColor(c: string): string {
  const m = c.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/)
  if (!m) return c
  const [h, s, l] = [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100]
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))
  return toHex([f(0), f(8), f(4)])
}

/** Акцент темы в этом режиме */
export const themeAccent = (p: Palette, theme: Theme) => (theme === 'light' ? (p.lightAccent ?? p.accent) : p.accent)

export const paletteById = (id: string, custom: CustomTheme[] = []) => {
  const own = custom.find((c) => c.id === id)
  return own ? customPalette(own) : (PALETTES.find((p) => p.id === id) ?? PALETTES[0])
}

// ---------- применение ----------

/**
 * Размеры слоёв фона: точки — плиткой, каждый слой градиента — на весь экран. Список нужен на каждый слой:
 * иначе CSS повторяет его по кругу, и третье «пятно» получает размер точек — фон рябит сеткой
 */
const layers = (gradient: string | undefined, dot: string, attach: boolean, pos?: string) => {
  const kinds = [...(gradient ?? '').matchAll(/-gradient\(|url\(/g)].map((m) => (m[0] === 'url(' ? 'img' : 'grad'))
  return {
    size: [dot, ...kinds.map((k) => (k === 'img' ? 'cover' : '100% 100%'))].join(', '),
    attach: attach ? ['scroll', ...kinds.map(() => 'fixed')].join(', ') : undefined,
    pos: ['0 0', ...kinds.map((k) => (k === 'img' ? (pos ?? 'center') : '0 0'))].join(', '),
  }
}

/** Переменные темы — на <html>; у встроенных тем цвет текста остаётся в index.css через data-theme */
/**
 * sel — цвет выделения: null — как в теме, 'text' — как текст, 'accent' — как акцент, иначе свой hex.
 * blocks — цвет блоков: null — как в теме, 'accent' — оттенок акцента, иначе свой hex
 */
export function applyTheme(
  theme: Theme, paletteId: string, accent: string | null, custom: CustomTheme[] = [], sel: string | null = null, blocks: string | null = null,
) {
  const { vars, mode, id } = themeVars(theme, paletteId, accent, custom, sel, blocks)
  const root = document.documentElement
  root.dataset.theme = mode
  root.dataset.palette = id
  for (const [k, v] of Object.entries(vars)) {
    if (v) root.style.setProperty(k, v)
    else root.style.removeProperty(k)
  }
}

/** CSS-переменные темы — без применения: для всей страницы (applyTheme) или для примера в окне выбора */
export function themeVars(
  theme: Theme, paletteId: string, accent: string | null, custom: CustomTheme[] = [], sel: string | null = null, blocks: string | null = null,
): { vars: Record<string, string | undefined>; mode: Theme; id: string } {
  const p = paletteById(paletteId, custom)
  theme = effectiveTheme(p, theme)
  const base = p[theme]
  const a = accent ?? themeAccent(p, theme)
  // свои блоки: из одного цвета считаются вложенные оттенки, рамка и текст на них
  const dark = theme === 'dark'
  const blockColor = blocks === 'accent' ? mix(toHexColor(base.card), toHexColor(a), dark ? 0.14 : 0.1) : blocks
  const m: Mode = blockColor ? { ...base, ...widgetMode(blockColor, dark) } : base
  const selPick = sel ?? themeSel(p, theme)
  const selColor = selPick === 'accent' ? a : selPick && selPick !== 'text' ? selPick : undefined
  const vars: Record<string, string | undefined> = {
    '--page': m.page,
    '--page-dot': m.dot,
    '--card': m.card,
    '--card-2': m.card2,
    '--card-3': m.card3,
    '--line': m.line,
    '--widget-border': m.border,
    '--page-gradient': m.gradient ?? 'none',
    '--page-bg-size': layers(m.gradient, '18px 18px', true).size,
    '--page-bg-attach': layers(m.gradient, '18px 18px', true).attach,
    '--page-bg-pos': layers(m.gradient, '18px 18px', true, m.bgPos).pos,
    '--ink': m.ink,
    '--ink-muted': m.inkMuted,
    '--fg': m.fg,
    '--muted': m.muted,
    '--dot-off': m.dotOff,
    '--red': a,
    '--on-red': onAccent(a),
    '--sel': selColor,
    '--on-sel': selColor ? onAccent(selColor) : undefined,
    // у темы свой шрифт (моноширинный у «терминальных», Roboto у Google); шрифт из настроек главнее
    '--theme-font': p.font,
  }
  return { vars, mode: theme, id: p.id }
}

/** CSS фона для превью темы (точки + градиент), без применения ко всей странице */
export const previewBackground = (m: Mode) => ({
  backgroundColor: m.page,
  backgroundImage: `radial-gradient(${m.dot} 1px, transparent 1.2px)${m.gradient ? `, ${m.gradient}` : ''}`,
  backgroundSize: layers(m.gradient, '8px 8px', false).size,
  backgroundPosition: layers(m.gradient, '8px 8px', false, m.bgPos).pos,
})

// ---------- шрифт ----------

/** Шрифты на выбор: auto — как в теме (Inter, у «терминальных» тем — моноширинный) */
export const FONTS = [
  { id: 'auto', stack: '' },
  { id: 'inter', name: 'Inter', stack: '"Inter Variable"' },
  { id: 'golos', name: 'Golos', stack: '"Golos Text Variable"' },
  { id: 'manrope', name: 'Manrope', stack: '"Manrope Variable"' },
  { id: 'montserrat', name: 'Montserrat', stack: '"Montserrat Variable"' },
  { id: 'rubik', name: 'Rubik', stack: '"Rubik Variable"' },
  { id: 'roboto', name: 'Roboto', stack: '"Roboto Variable"' },
  { id: 'nunito', name: 'Nunito', stack: '"Nunito Variable"' },
  { id: 'comfortaa', name: 'Comfortaa', stack: '"Comfortaa Variable"' },
  { id: 'unbounded', name: 'Unbounded', stack: '"Unbounded Variable"' },
  { id: 'jetbrains', name: 'JetBrains Mono', stack: '"JetBrains Mono"' },
  { id: 'plex', name: 'IBM Plex Mono', stack: '"IBM Plex Mono"' },
  { id: 'pixel', name: 'Press Start 2P', stack: '"Press Start 2P"' },
  { id: 'system', stack: 'system-ui, "Segoe UI", sans-serif' },
] as const
export type FontId = (typeof FONTS)[number]['id']
export const fontStack = (id: string) => FONTS.find((f) => f.id === id)?.stack ?? ''

// ---------- скругление углов ----------

// Множитель всех скруглений (--rk): 0 — острые углы, 1 — как в Nothing, 2 — очень круглые
export const RADIUS_PRESETS = [
  { id: 'sharp', value: 0 },
  { id: 'soft', value: 0.5 },
  { id: 'nothing', value: 1 },
  { id: 'round', value: 1.6 },
] as const
const RADIUS_KEY = 'tunich-radius'

export function loadRadius(): number {
  try {
    const v = Number(localStorage.getItem(RADIUS_KEY) ?? 1)
    return Number.isFinite(v) ? Math.max(0, Math.min(2, v)) : 1
  } catch {
    return 1
  }
}

export function saveRadius(v: number) {
  try {
    localStorage.setItem(RADIUS_KEY, String(v))
  } catch {
    /* не запомним — после перезагрузки как в Nothing */
  }
}

// ---------- память браузера ----------

const PALETTE_KEY = 'tunich-palette'
const ACCENT_KEY = 'tunich-accent'
const CUSTOM_KEY = 'tunich-custom-themes'

const SEL_KEY = 'tunich-sel'
const BLOCKS_KEY = 'tunich-blocks'

export function loadLook(): { palette: string; accent: string | null; customThemes: CustomTheme[]; sel: string | null; blocks: string | null } {
  try {
    const custom = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]') as CustomTheme[]
    return {
      palette: localStorage.getItem(PALETTE_KEY) || 'nothing',
      accent: localStorage.getItem(ACCENT_KEY) || null,
      customThemes: Array.isArray(custom) ? custom : [],
      sel: localStorage.getItem(SEL_KEY) || null,
      blocks: localStorage.getItem(BLOCKS_KEY) || null,
    }
  } catch {
    return { palette: 'nothing', accent: null, customThemes: [], sel: null, blocks: null }
  }
}

/** Цвет выделения и блоков: null — как в теме */
export function saveColor(kind: 'sel' | 'blocks', v: string | null) {
  try {
    const key = kind === 'sel' ? SEL_KEY : BLOCKS_KEY
    if (v) localStorage.setItem(key, v)
    else localStorage.removeItem(key)
  } catch {
    /* не запомним — после перезагрузки будет как в теме */
  }
}

export function saveLook(palette: string, accent: string | null, customThemes?: CustomTheme[]) {
  try {
    localStorage.setItem(PALETTE_KEY, palette)
    if (accent) localStorage.setItem(ACCENT_KEY, accent)
    else localStorage.removeItem(ACCENT_KEY)
    if (customThemes) localStorage.setItem(CUSTOM_KEY, JSON.stringify(customThemes))
  } catch {
    /* без памяти — после перезагрузки вернётся Nothing */
  }
}
