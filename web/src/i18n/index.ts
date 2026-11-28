import { en } from './en'
import { ru } from './ru'

// Русский — эталон: в нём есть все ключи. Остальные языки могут чего-то не иметь —
// тогда берётся английский, потом русский.
export type Key = keyof typeof ru
// Сверх ключей эталона язык может иметь свои формы числительных (у арабского их шесть)
type PluralForm = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'
export type Dict = Partial<Record<Key, string>> & { [plural: `${string}_${PluralForm}`]: string }

export type Lang = 'ru' | 'en' | 'it' | 'de' | 'fr' | 'ar' | 'zh' | 'ja'

export const LANGS: { id: Lang; name: string; dir: 'ltr' | 'rtl' }[] = [
  { id: 'ru', name: 'Русский', dir: 'ltr' },
  { id: 'en', name: 'English', dir: 'ltr' },
  { id: 'it', name: 'Italiano', dir: 'ltr' },
  { id: 'de', name: 'Deutsch', dir: 'ltr' },
  { id: 'fr', name: 'Français', dir: 'ltr' },
  { id: 'ar', name: 'العربية', dir: 'rtl' },
  { id: 'zh', name: '中文', dir: 'ltr' },
  { id: 'ja', name: '日本語', dir: 'ltr' },
]

// Русский (эталон) и английский (запасной) — всегда с собой; остальные грузим, только когда язык выбран:
// восемь словарей — это сотни килобайт кода, который телефон разбирал бы на каждом запуске
const dicts: Partial<Record<Lang, Dict>> = { ru, en }
const loaders: Record<Exclude<Lang, 'ru' | 'en'>, () => Promise<Dict>> = {
  it: () => import('./it').then((m) => m.it),
  de: () => import('./de').then((m) => m.de),
  fr: () => import('./fr').then((m) => m.fr),
  ar: () => import('./ar').then((m) => m.ar),
  zh: () => import('./zh').then((m) => m.zh),
  ja: () => import('./ja').then((m) => m.ja),
}
const isLang = (l: string): l is Lang => LANGS.some((x) => x.id === l)

/** Подгрузить словарь языка (до первого показа и перед переключением). Не вышло — останется английский */
export async function loadLang(l: Lang) {
  if (dicts[l] || l === 'ru' || l === 'en') return
  try {
    dicts[l] = await loaders[l]()
  } catch {
    /* нет сети до куска со словарём — тексты будут на английском */
  }
}

// Текущий язык держим и здесь: им пользуются места вне React (тосты в сторе, форматирование).
// Меняется только через store.setLang — тот же вызов перерисовывает интерфейс.
let current: Lang = 'ru'
export const getLang = () => current
export const setCurrentLang = (l: Lang) => {
  current = l
}

export const detectLang = (): Lang => {
  try {
    const saved = localStorage.getItem('tunich-lang') as Lang | null
    if (saved && isLang(saved)) return saved
  } catch {
    /* хранилище недоступно — смотрим на браузер */
  }
  const nav = (typeof navigator !== 'undefined' ? navigator.language : 'ru').slice(0, 2) as Lang
  return isLang(nav) ? nav : 'ru'
}

type Params = Record<string, string | number>

const lookup = (lang: Lang, key: string) =>
  (dicts[lang] as Record<string, string> | undefined)?.[key] ??
  (dicts.en as Record<string, string>)[key] ??
  (ru as Record<string, string>)[key]

// Приложение для ПК — тот же код, что на телефоне: в строках про своё устройство «телефон» → «компьютер».
// Только эти разделы (про телефоны вообще — «Экосистема», входы — не трогаем) и только там, где слово меняется без
// перестройки фразы: русский (корень один во всех падежах) и английский
const DESKTOP = import.meta.env.VITE_PLATFORM === 'desktop'
const ownDevice = /^(space|sync|solo|dev|store|scope|merge)\.|^(share\.noFile|home\.onPhoneOf|set\.keepWhat|toast\.uploadCancelled|acc\.foreignPending)$/
const SWAP: Partial<Record<Lang, [RegExp, string][]>> = {
  ru: [[/телефон/g, 'компьютер'], [/Телефон/g, 'Компьютер']],
  en: [[/\bphone\b/g, 'computer'], [/\bPhone\b/g, 'Computer']],
}
const desk = (lang: Lang, key: string, s: string | undefined) =>
  s && DESKTOP && ownDevice.test(key) ? (SWAP[lang] ?? []).reduce((v, [re, to]) => v.replace(re, to), s) : s

const fill = (s: string, p?: Params) => (p ? s.replace(/\{(\w+)\}/g, (_, k) => String(p[k] ?? `{${k}}`)) : s)

/** Строка по ключу: t('nav.home'), t('toast.plAdded', { name, n }) */
export const t = (key: Key, p?: Params) => fill(desk(current, key, lookup(current, key)) ?? key, p)

const rules = new Map<Lang, Intl.PluralRules>()

/**
 * Число со словом по правилам языка: tn('n.tracks', 5) → «5 треков».
 * В словаре лежат формы base_one / base_few / base_many / base_other (какие нужны языку).
 */
export const tn = (base: string, n: number, p?: Params) => {
  if (!rules.has(current)) rules.set(current, new Intl.PluralRules(current))
  const cat = rules.get(current)!.select(n)
  const s = lookup(current, `${base}_${cat}`) ?? lookup(current, `${base}_other`) ?? base
  return fill(s, { n: n.toLocaleString(current), ...p })
}

/** «12 минут назад», «2 hours ago» — относительное время на языке интерфейса */
export const fmtAgo = (ts: number) => {
  const rtf = new Intl.RelativeTimeFormat(current, { numeric: 'auto' })
  const min = Math.round((ts - Date.now()) / 60_000)
  if (Math.abs(min) < 60) return rtf.format(min, 'minute')
  const h = Math.round(min / 60)
  if (Math.abs(h) < 24) return rtf.format(h, 'hour')
  return rtf.format(Math.round(h / 24), 'day')
}

/** Размер файла в локальных единицах: «8,6 МБ», «8.6 MB», «8.6 ميغابايت» */
export const fmtSize = (mb: number) => {
  const gb = mb >= 1024
  return new Intl.NumberFormat(current, {
    style: 'unit',
    unit: gb ? 'gigabyte' : 'megabyte',
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(gb ? mb / 1024 : mb)
}
