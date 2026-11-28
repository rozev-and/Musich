import { getUserSetting, setUserSetting, type Db } from './db.ts'

/**
 * Общие настройки сервера — меняются в веб-морде (страница «Настройки»), лежат в базе.
 * То, что касается только одного браузера (воспроизведение, интерфейс), живёт в самом браузере, не здесь.
 */
export interface Prefs {
  playThreshold: number // сколько секунд прослушать, чтобы трек попал в историю; 0 — половину трека
  trashDays: number // сколько дней удалённое лежит в корзине, потом стирается насовсем
  rescanMinutes: number // полный скан папок раз в N минут; 0 — не сканировать по расписанию
  watch: boolean // следить за папками: новый файл появляется в библиотеке через пару секунд
  editMode: 'file' | 'overlay' // правка трека: теги в самом файле или только в MUSICH, поверх тегов (файл и id не меняются)
  coverMode: 'file' | 'overlay' // картинки: вшивать в файлы (трека — в его файл, альбома — во все его треки) или держать только в MUSICH
  fileNames: 'artist-title' | 'number-artist-title' | 'keep' // как называть файл после правки тегов
  autoNumber: boolean // новому треку без номера — следующий номер (пишется в файл)
  shiftOnDelete: boolean // удалили трек — номера после него сдвигаются на −1
  separators: { comma: boolean; feat: boolean; x: boolean; amp: boolean } // что делит артистов в одном теге
  tracksView?: TracksView // порядок и фильтры «Треков» — одни на всех устройствах пользователя (нет — как решит клиент)
}

/** Порядок и фильтры страницы «Треки»: сервер их только хранит, смысл знает клиент */
export interface TracksView {
  sort: 'number' | 'added' | 'title' | 'artist' | 'album' | 'duration' | 'size'
  desc: boolean
  filter: 'all' | 'liked' | 'device' | 'cloud' | 'syncing'
  year: number | 'none' | null
  file: 'all' | 'changed' | 'edited' | 'untouched'
}

export const DEFAULT_PREFS: Prefs = {
  playThreshold: 10,
  trashDays: 30,
  rescanMinutes: 60,
  watch: true,
  editMode: 'file',
  coverMode: 'file',
  fileNames: 'artist-title',
  autoNumber: true,
  shiftOnDelete: true,
  separators: { comma: true, feat: true, x: true, amp: false },
}

// Схема для PATCH /api/prefs: любые поля из Prefs, каждое в своих границах
export const PREFS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    playThreshold: { type: 'integer', minimum: 0, maximum: 600 },
    trashDays: { type: 'integer', minimum: 1, maximum: 365 },
    rescanMinutes: { type: 'integer', minimum: 0, maximum: 10080 },
    watch: { type: 'boolean' },
    editMode: { type: 'string', enum: ['file', 'overlay'] },
    coverMode: { type: 'string', enum: ['file', 'overlay'] },
    fileNames: { type: 'string', enum: ['artist-title', 'number-artist-title', 'keep'] },
    autoNumber: { type: 'boolean' },
    shiftOnDelete: { type: 'boolean' },
    separators: {
      type: 'object',
      additionalProperties: false,
      properties: { comma: { type: 'boolean' }, feat: { type: 'boolean' }, x: { type: 'boolean' }, amp: { type: 'boolean' } },
    },
    tracksView: {
      type: 'object',
      additionalProperties: false,
      required: ['sort', 'desc', 'filter', 'year', 'file'],
      properties: {
        sort: { type: 'string', enum: ['number', 'added', 'title', 'artist', 'album', 'duration', 'size'] },
        desc: { type: 'boolean' },
        filter: { type: 'string', enum: ['all', 'liked', 'device', 'cloud', 'syncing'] },
        // null — первым: проверка запросов приводит типы, и с «integer» первым null («все годы») превращался в 0 —
        // фильтр «0-й год» прятал всю музыку
        year: { anyOf: [{ type: 'null' }, { type: 'string', enum: ['none'] }, { type: 'integer', minimum: 1, maximum: 9999 }] },
        file: { type: 'string', enum: ['all', 'changed', 'edited', 'untouched'] },
      },
    },
  },
} as const

/** Что из настроек — про сам сервер, а не про библиотеку: меняет только владелец, у остальных — как у него */
export const SERVER_PREFS = ['rescanMinutes', 'watch'] as const

// настройки свои у каждого пользователя; userId нет (владельца ещё не создали) — по умолчанию
export function loadPrefs(db: Db, userId: string | undefined): Prefs {
  try {
    const raw = userId ? getUserSetting(db, userId, 'prefs') : undefined
    const { historyDays: _old, ...saved } = JSON.parse(raw ?? '{}') as Partial<Prefs> & { historyDays?: number } // срок истории убран: она хранится всегда
    // картинки раньше шли за правкой тегов: своей настройки ещё нет — как у тегов
    const coverMode = saved.coverMode ?? saved.editMode ?? DEFAULT_PREFS.coverMode
    // год 0 — след той ошибки (null превращался в 0): это «все годы»
    const tracksView = saved.tracksView && saved.tracksView.year === 0 ? { ...saved.tracksView, year: null } : saved.tracksView
    return { ...DEFAULT_PREFS, ...saved, coverMode, separators: { ...DEFAULT_PREFS.separators, ...saved.separators }, ...(tracksView ? { tracksView } : {}) }
  } catch {
    return DEFAULT_PREFS
  }
}

export function savePrefs(db: Db, userId: string, patch: Partial<Prefs>): Prefs {
  const cur = loadPrefs(db, userId)
  const next: Prefs = { ...cur, ...patch, separators: { ...cur.separators, ...patch.separators } }
  setUserSetting(db, userId, 'prefs', JSON.stringify(next))
  return next
}
