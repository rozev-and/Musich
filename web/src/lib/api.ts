// Клиент API сервера (контракт — docs/API.md). Веб-морда раздаётся тем же сервером,
// поэтому адрес относительный; в dev vite проксирует /api на локальный сервер.

export interface AuthStatus {
  setupDone: boolean
  authenticated: boolean
  registration?: boolean // владелец разрешил регистрацию
  ownerNeedsLogin?: boolean // после обновления: владелец есть, а логина у него ещё нет
  user?: AuthUser // кто вошёл (если вошли)
}

/** Кто вошёл: из ответов входа и из /auth/status. login — null у владельца, пока он его не придумал */
export interface AuthUser {
  id: string
  login: string | null
  name: string
  role: 'owner' | 'admin' | 'user'
}

/** Ответ входа, регистрации, первого запуска и /auth/claim */
export interface AuthResult {
  token: string
  user?: AuthUser
}

/** Пользователь сервера — для владельца (GET /users) */
export interface ServerUser {
  id: string
  login: string | null
  name: string
  role: 'owner' | 'admin' | 'user'
  createdAt: string
  lastSeenAt: string | null
  tracks: number
  bytes: number
}

export interface ServerFolder {
  path: string
  uploads: boolean
  tracks: number
  scanning: boolean
  scanDone?: number
  scanTotal?: number
  userId?: string // чья папка (у владельца приходят все папки)
}

export interface DirListing {
  path: string
  parent: string | null
  dirs: string[]
}

export interface TokenInfo {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string
  current: boolean
}

// ---- форматы библиотеки (docs/API.md) ----

export interface ServerTrack {
  id: string
  title: string
  artist: string
  album: string
  year?: number
  trackNo?: number
  duration: number
  gain?: number // ReplayGain трека из тегов, дБ
  albumGain?: number
  peak?: number // пик трека, доля от 1
  size: number
  format: string
  fileName: string
  hasCover: boolean
  liked: boolean
  likedAt?: string
  addedAt: string
  status: 'available' | 'deleted'
  seq: number
  source?: string
  replacedBy?: string // у надгробия: новый id того же трека после переписывания тегов на сервере
  edited?: boolean // исправлен только в MUSICH, файл прежний
  hash?: string // нынешний отпечаток файла: меняется при прошивке тегов, id — нет
  autoGain?: number // громкость, измеренная клиентом (дБ), — для «выравнивать автоматически»
  fileChanged?: boolean // файл прошит — уже не тот, с которым трек пришёл
  fileChanges?: ('tags' | 'number' | 'cover')[] // что именно поменяли в файле
}

/** Одно прослушивание: трек дослушали до половины (или 4 минут) */
export interface Play {
  trackId: string
  playedAt: string
  source?: string // с какого устройства или входа слушали
}

export interface ServerPlaylist {
  id: string
  name: string
  description: string
  trackIds: string[]
  hasCover: boolean
  position: number
  updatedAt: string
  deleted: boolean
  seq: number
}

export interface Changes {
  cursor: number
  tracks: ServerTrack[]
  playlists: ServerPlaylist[]
  covers: { kind: 'track' | 'album' | 'artist'; key: string; seq: number; deleted: boolean }[]
}

/** Что устройство сообщает о себе при отметке (server/src/library.ts DeviceInfo) — для «Экосистемы» */
export interface DeviceInfo {
  client?: 'app' | 'web'
  version?: string
  tracks?: number
  bytes?: number
  free?: number
  total?: number
  route?: 'home' | 'domain' | 'direct'
  playing?: string
}

/** «Экосистема» на странице «Сервер»: сервер и устройства (владелец видит всех пользователей) */
export interface Ecosystem {
  server: { version: string; name: string; disk: { free: number; total: number } | null }
  users: { id: string; login: string | null; name: string; role: string; me: boolean; tracks: number; bytes: number; devices: (ServerDevice & { info?: DeviceInfo })[] }[]
}

export interface ServerDevice {
  id: string
  name: string
  kind: 'desktop' | 'laptop' | 'phone'
  lastSeenAt: string
  pendingUp?: number // ждёт отправки на сервер (сообщает само устройство)
  pendingDown?: number // ждёт скачивания на устройство
  syncedAt?: string // когда синхронизация последний раз прошла до конца
}

/** Общие настройки сервера (server/src/prefs.ts) */
export interface ServerPrefs {
  playThreshold: number // секунд; 0 — половину трека
  trashDays: number
  rescanMinutes: number
  watch: boolean
  editMode: 'file' | 'overlay' // правка трека: в самом файле или только в MUSICH поверх тегов
  coverMode: 'file' | 'overlay' // картинки: вшивать в файлы (трека — в его файл, альбома — во все его треки) или только в MUSICH
  fileNames: 'artist-title' | 'number-artist-title' | 'keep'
  autoNumber: boolean
  shiftOnDelete: boolean
  separators: { comma: boolean; feat: boolean; x: boolean; amp: boolean }
  tracksView?: TracksView // порядок и фильтры «Треков» — одни на всех устройствах аккаунта
}

/** Порядок и фильтры страницы «Треки» (сервер только хранит) */
export interface TracksView {
  sort: 'number' | 'added' | 'title' | 'artist' | 'album' | 'duration' | 'size'
  desc: boolean
  filter: 'all' | 'liked' | 'device' | 'cloud' | 'syncing'
  year: number | 'none' | null
  file: 'all' | 'changed' | 'edited' | 'untouched'
}

export const DEFAULT_SERVER_PREFS: ServerPrefs = {
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

/** Трек в корзине сервера: файл ещё на диске, до expiresAt его можно вернуть */
export interface TrashItem {
  id: string
  title: string
  artist: string
  album: string
  trackNo?: number
  duration: number
  size: number
  format: string
  fileName: string
  deletedAt: string
  expiresAt: string
}

/** Интеграция с музыкальным сервисом (server/src/integrations.ts) */
export interface IntegrationStatus {
  service: 'spotify' | 'youtube' | 'yandex' | 'vk'
  configured: boolean // ключ приложения вписан
  connected: boolean // вход выполнен
  canSync?: boolean // список можно забрать заново (VK — только после входа через аккаунт)
  account?: string
  syncedAt?: string
  total?: number // треков в сервисе
  missing?: number // из них нет в библиотеке
  error?: string
}

/** Сравнение списка из сервиса с библиотекой: localId — нашёлся у нас */
export interface CompareResult {
  total: number
  matched: number
  lists: string[]
  tracks: { id: string; title: string; artists: string[]; album?: string; liked: boolean; lists: string[]; localId?: string; cover?: string; duration?: number }[]
}

export interface Stats {
  tracks: number
  albums: number
  artists: number
  musicBytes: number
  disk: { total: number; free: number } | null
  version: string
}

export interface Incoming {
  id: string
  fileName: string
  received: number
  total: number
  source?: string
  startedAt: string
}

export interface Activity {
  incoming: Incoming[]
  recent: { id: string; title: string; artist: string; source?: string; addedAt: string }[]
}

export interface Profile {
  login?: string // только читается
  name: string
  email: string
  avatar?: string
}

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const TOKEN_KEY = 'musich-token'

// Где сервер. Веб-морду отдаёт сам сервер — адрес пустой, запросы идут туда же, откуда страница.
// Приложение на телефоне открыто со своего адреса и ходит к серверу по сети: адрес задаёт человек при первом запуске
let base = ''
export const setApiBase = (url: string) => {
  base = url.trim().replace(/\/+$/, '')
}
export const getApiBase = () => base

// Приложение — это устройство на сервере: по этому id сервер подписывает, кто прислал трек и кто слушал
let deviceId: string | null = null
export const setDeviceId = (id: string | null) => {
  deviceId = id
}
// Владелец смотрит чужую библиотеку: запросы идут с X-Musich-As — сервер отвечает от имени того пользователя
// (только чтение: любой не-GET с ним — 403)
let viewAs: string | null = null
export const setViewAs = (userId: string | null) => {
  viewAs = userId
}
export const getViewAs = () => viewAs
// вход, пароль и управление пользователями — всегда от себя: это не библиотека
const ownPath = (path: string) => /^\/(auth\/|users|server\/)/.test(path)

const authHeaders = (as = true): Record<string, string> => {
  const token = getToken()
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(deviceId ? { 'X-Musich-Device': deviceId } : {}),
    ...(as && viewAs ? { 'X-Musich-As': viewAs } : {}),
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* без памяти — войти придётся после каждой перезагрузки */
  }
  if (!token) setMediaKey(null)
}

/**
 * Медиа-ключ для адресов аудио и картинок (сервер: security.ts): только чтение файлов, живёт 14 дней.
 * Полный ключ входа в адресе оседал бы в журналах прокси, поэтому сервер принимает его только в заголовке
 */
const MK_KEY = 'musich-mk'
type MediaKey = { key: string; expiresAt: string; at: number }
let mk: MediaKey | null = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(MK_KEY) ?? 'null') as MediaKey | null
    return v && Date.parse(v.expiresAt) > Date.now() + 3600_000 ? v : null
  } catch {
    return null
  }
})()
export function setMediaKey(v: { key: string; expiresAt: string } | null) {
  mk = v ? { ...v, at: Date.now() } : null
  try {
    if (mk) localStorage.setItem(MK_KEY, JSON.stringify(mk))
    else localStorage.removeItem(MK_KEY)
  } catch {
    /* не запомним — попросим новый при следующем входе */
  }
}
/** Медиа-ключ свежий (моложе суток) — новый не нужен */
export const mediaKeyFresh = () => !!mk && Date.now() - mk.at < 24 * 3600_000

// Токен отозвали или он устарел: стор по этому сигналу показывает экран входа
let onUnauthorized: (code: string) => void = () => {}
export const setUnauthorizedHandler = (fn: (code: string) => void) => {
  onUnauthorized = fn
}

/** Адрес файла или картинки для <audio>/<img>: они не умеют слать заголовок — в адресе медиа-ключ ?mk=.
 *  v — версия (seq), чтобы браузер не показывал старую картинку из кэша. В просмотре чужой библиотеки — и ?as= */
export function mediaUrl(path: string, v?: number | string) {
  const q = new URLSearchParams()
  if (mk) q.set('mk', mk.key)
  if (viewAs) q.set('as', viewAs)
  if (v !== undefined) q.set('v', String(v))
  return `${base}/api${path}?${q}`
}

// timeout — для долгих операций, где сервер переписывает много файлов (перенумерация, вшить обложку, переименовать артиста)
export async function api<T = void>(path: string, opts: { method?: string; body?: unknown; blob?: Blob; timeout?: number } = {}): Promise<T> {
  const res = await fetch(`${base}/api${path}`, {
    signal: AbortSignal.timeout(opts.timeout ?? (opts.blob ? 120_000 : 90_000)),
    method: opts.method ?? 'GET',
    headers: {
      ...authHeaders(!ownPath(path)),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.blob ? { 'Content-Type': opts.blob.type } : {}),
    },
    body: opts.blob ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText)
    // на входе 401 — это просто неверный пароль, а не повод выкидывать на экран входа
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized(err.code)
    throw err
  }
  return data as T
}

/** Адрес для скачивания файлом: ссылка в браузере не шлёт заголовок — в адресе медиа-ключ ?mk= */
export function downloadUrl(path: string, params: Record<string, string> = {}) {
  const q = new URLSearchParams(params)
  if (mk) q.set('mk', mk.key)
  if (viewAs && !ownPath(path)) q.set('as', viewAs)
  return `${base}/api${path}?${q}`
}

/** Скачать по адресу, не уходя со страницы */
export function startDownload(url: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  document.body.append(a)
  a.click()
  a.remove()
}

/** Отправить файл бэкапа — сервер проверит его и перезапустится уже с ним */
/** Бэкап: POST (пароль — в теле, не в адресе); с паролем файл зашифрован (.musich) */
export async function downloadBackup(password?: string) {
  const res = await fetch(`${base}/api/backup`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(password ? { password } : {}),
  })
  if (!res.ok) throw new ApiError(res.status, 'backup', `Не вышло: ${res.status}`)
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'musich-backup.db'
  const a = document.createElement('a')
  a.href = URL.createObjectURL(await res.blob())
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000)
}

export async function uploadBackup(file: File, password?: string): Promise<void> {
  const form = new FormData()
  // пароль — до файла: сервер читает поля, пока не дошёл до файла
  if (password) form.append('password', password)
  form.append('file', file, file.name)
  const res = await fetch(`${base}/api/backup/restore`, { method: 'POST', headers: authHeaders(), body: form })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText)
  }
}

/** Загрузка файла трека с прогрессом (fetch прогресс отправки не умеет) */
export function uploadTrack(file: File, onProgress: (p: number) => void): Promise<ServerTrack> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${base}/api/tracks`)
    xhr.timeout = 15 * 60_000 // большой файл по медленной сети — долго, но не вечно
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress((e.loaded / e.total) * 100)
    xhr.onload = () => {
      let data: { error?: string; message?: string } | null = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        /* не JSON — ниже будет общая ошибка */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data as unknown as ServerTrack)
      if (xhr.status === 401) onUnauthorized(data?.error ?? 'unauthorized')
      reject(new ApiError(xhr.status, data?.error ?? 'error', data?.message ?? xhr.statusText))
    }
    xhr.onerror = () => reject(new Error('network'))
    const form = new FormData()
    form.append('file', file, file.name)
    xhr.send(form)
  })
}

/** Отвечает ли сервер и вошли ли мы. null — сервера нет (выключен, нет сети) */
export async function probe(): Promise<AuthStatus | null> {
  try {
    const res = await fetch(`${base}/api/auth/status`, { headers: authHeaders(false), signal: AbortSignal.timeout(6000) })
    if (!res.ok) return null
    const data = await res.json()
    return typeof data?.setupDone === 'boolean' ? (data as AuthStatus) : null
  } catch {
    return null
  }
}
