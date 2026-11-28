import { create } from 'zustand'
import { livePosition, useBuffering, usePos, useProgress } from './lib/pos'
import { prefetchAudio } from './lib/webcache'
import { useShallow } from 'zustand/react/shallow'
import { detectLang, loadLang, setCurrentLang, t, type Lang, fmtSize } from './i18n'
import { isHost } from './mode'
import { power as currentPower, watchPower, type Power } from './lib/power'
import * as journal from './lib/node/journal'
import * as pinCode from './lib/pin'
import { trackCover, type Covers } from './lib/covers'
import { fontStack, loadLook, loadRadius, saveColor, saveLook, saveRadius, type CustomTheme, type FontId } from './lib/themes'
import { artistsOf, hasArtist, setArtistSeparators } from './lib/artists'
import { api, ApiError, getApiBase, getToken, mediaUrl, probe, setApiBase, setDeviceId, setToken, setUnauthorizedHandler, setViewAs, uploadTrack, type Activity as ServerActivity, type AuthResult, type AuthStatus, type AuthUser, type ServerUser, type Changes, type Incoming, type Play, type Profile, type ServerPrefs, DEFAULT_SERVER_PREFS, type CompareResult, type IntegrationStatus, type ServerDevice, type ServerFolder, type ServerPlaylist, type ServerTrack, type Stats, type TokenInfo, mediaKeyFresh, setMediaKey, type DeviceInfo } from './lib/api'
import type { Account, AlbumsTab, Device, Filter, MusicFolder, Playlist, PlaylistEditor, Scope, Theme, Track, TrackStatus, View } from './types'

// какие сервисы сейчас забираются заново — чтобы не запускать второй раз поверх
const remoteSyncing = new Set<string>()

// Библиотека, плейлисты, лайки, картинки, устройства и настройки сервера — с сервера (docs/API.md).
// В браузере остаются только его собственные вещи: тема, язык, плеер, эквалайзер.

// checking — спрашиваем сервер; offline — не отвечает; setup — пароль ещё не задан; login — нужно войти
// connect — приложение ещё не знает адрес сервера; local — сервера нет, но библиотека с телефона открыта
// profile — первый запуск телефона: «Как вас зовут» (начать без сервера)
// claim — сервер обновился до нескольких пользователей: владелец придумывает себе логин (пароль прежний)
export type Conn = 'checking' | 'offline' | 'setup' | 'login' | 'claim' | 'online' | 'connect' | 'local' | 'profile'

// Форма входа: войти, зарегистрироваться, создать владельца (первый запуск), придумать логин владельцу после обновления
export type AuthMode = 'login' | 'register' | 'setup' | 'claim'
export interface AuthForm {
  mode: AuthMode
  login: string
  password: string
  name?: string // имя для показа — при регистрации и создании владельца
  code?: string // код из приложения-аутентификатора, если включён двухэтапный вход
}
// Что по адресу: новый сервер или настроенный, открыта ли регистрация, ждёт ли владелец логина
export interface ServerCheck {
  url: string
  setupDone: boolean
  registration: boolean
  ownerNeedsLogin: boolean
}
// Логин: латиница, цифры, точка, подчёркивание, дефис; 3–32 символа (как на сервере)
export const LOGIN_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{1,30})[a-zA-Z0-9]$/ // как на сервере (auth.ts)
export const MIN_PASSWORD = 8
/** Как показывать пользователя: имя, а без него — логин */
export const userLabel = (u: { name?: string; login?: string | null }) => u.name?.trim() || u.login || '—'
/** Владелец ли тот, кто вошёл. Сервер без пользователей (старый) роли не присылает — там вошедший и есть владелец */
export const selectIsOwner = (s: { me: AuthUser | null }) => s.me?.role !== 'user'

/** Лента «что приходило»: прислало устройство (device) или нашёлся сканом папки (device пустой) */
export interface Activity {
  id: string
  device?: string
  title: string
  artist: string
  at: number
}

// ok — синхронизация прошла (зелёный), error — что-то сломалось (красный), info — всё остальное
export type ToastKind = 'info' | 'ok' | 'error'
interface Toast { id: number; text: string; kind: ToastKind }

/** Что сейчас редактируем в диалоге картинки */
export interface CoverEdit {
  key: string          // track:<id> | album:<название> | artist:<имя>
  kind: 'track' | 'album' | 'artist'
  title: string
  fallback?: string    // что будет показано, если свою картинку сбросить
}

// Интерфейс — в этом браузере: масштаб, с какой страницы открываться, колонки в списках треков, анимации
export type TrackCol = 'album' | 'year' | 'size' | 'duration' | 'added'
/** Что можно поставить в нижнюю панель телефона */
export type NavId = 'home' | 'library' | 'albums' | 'playlists' | 'artists' | 'history' | 'sync' | 'settings'
// пункты левой панели (на широком экране): разделы и «Корзина» (у хоста)
export type SideId = 'home' | 'library' | 'albums' | 'artists' | 'history' | 'sync' | 'settings' | 'trash'

/** Что не показывать в общем списке «Треки»: альбомы, артисты (по имени) и плейлисты (по id) */
export interface HiddenScopes {
  album: string[]
  artist: string[]
  playlist: string[]
}

export interface UiPrefs {
  nav: NavId[] // нижняя панель на телефоне: что и в каком порядке
  side: SideId[] // левая панель на широком экране: что и в каком порядке («Настройки» — всегда)
  hidden: HiddenScopes
  font: FontId // шрифт всего интерфейса, кроме логотипа; auto — как в теме
  scale: number // % от обычного размера
  glass: number // прозрачность блоков, 0–100 %
  start: View
  cols: Record<TrackCol, boolean>
  motion: boolean
  saver: SaverMode // «Экономия заряда» (только на телефоне)
}
export type SaverMode = 'auto' | 'on' | 'off'
const UI_KEY = 'musich-ui'
const UI_DEFAULTS: UiPrefs = {
  // в приложении альбомы, артисты и история по умолчанию — плитками на Главной
  nav: isHost ? ['home', 'library', 'albums', 'artists', 'history', 'sync', 'settings'] : ['home', 'library', 'sync', 'settings'],
  side: ['home', 'library', 'albums', 'artists', 'history', 'sync', 'settings', ...(isHost ? (['trash'] as const) : [])],
  hidden: { album: [], artist: [], playlist: [] },
  font: 'auto', glass: 0, scale: 100, start: 'home', cols: { album: true, year: false, size: true, duration: true, added: false }, motion: true, saver: 'auto' }
const loadUi = (): UiPrefs => {
  try {
    const stored = localStorage.getItem(UI_KEY)
    if (!stored) return UI_DEFAULTS
    const p = JSON.parse(stored) as Partial<UiPrefs>
    return { ...UI_DEFAULTS, ...p, cols: { ...UI_DEFAULTS.cols, ...p.cols }, hidden: { ...UI_DEFAULTS.hidden, ...p.hidden } }
  } catch (e) {
    console.warn('[UI] Failed to load UI prefs:', e)
    return UI_DEFAULTS
  }
}
/**
 * Экономия заряда: «вкл» — всегда, «авто» — когда заряда меньше 20 % и телефон не на зарядке. Только на телефоне.
 * Что делает: блоки без размытия, без бесконечных анимаций, реже связь с сервером, громкость не замеряется,
 * фоновая синхронизация ждёт зарядки (кнопка «Синхронизировать» работает всегда)
 */
const savingOf = (u: Pick<UiPrefs, 'saver'>, p: Power) =>
  !isHost && (u.saver === 'on' || (u.saver === 'auto' && p.battery !== null && p.battery < 0.2 && !p.charging))
const applySaver = (on: boolean) => {
  if (typeof document !== 'undefined') document.documentElement.dataset.saver = on ? 'on' : 'off'
}

// размеры в интерфейсе в rem — масштаб это размер шрифта корня
const applyUi = (u: UiPrefs) => {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  // в пикселях от наших 16 px (index.css): проценты считались бы от шрифта браузера, и 110 % могло выйти мельче 100 %
  root.style.fontSize = u.scale === 100 ? '' : `${(16 * u.scale) / 100}px`
  root.dataset.motion = u.motion ? 'on' : 'off'
  // блоки полупрозрачные: фон темы просвечивает, под блоком размытие
  if (u.glass > 0) {
    root.style.setProperty('--widget-opacity', `${100 - u.glass}%`)
    root.style.setProperty('--widget-blur', `blur(${Math.round(8 + u.glass / 4)}px)`)
  } else {
    root.style.removeProperty('--widget-opacity')
    root.style.removeProperty('--widget-blur')
  }
  const font = fontStack(u.font)
  if (font) root.style.setProperty('--user-font', font)
  else root.style.removeProperty('--user-font')
}
const initialUi = loadUi()
applyUi(initialUi)

// выравнивание громкости: выкл; автоматически — ReplayGain, а без него громкость, которую MUSICH измерил сам; только по тегам ReplayGain
export type Normalize = 'off' | 'auto' | 'tags'
export type QueueEnd = 'stop' | 'repeat' | 'radio'

interface Settings {
  autoDownload: boolean
  wifiOnly: boolean
  storageLimitGb: number // телефон: сколько места можно занять музыкой; 0 — без лимита (предупреждаем и предлагаем почистить)
  askOnDelete: boolean
  quality: Quality
  qualityMobileOnly: boolean // сжимать только в мобильном интернете (по Wi-Fi — оригинал)
  eq: boolean
  eqGains: number[] // дБ по полосам EQ_BANDS
  // воспроизведение — в этом браузере
  crossfade: number // секунд, 0 — выкл
  normalize: Normalize // выравнивать громкость
  queueEnd: QueueEnd // что делать, когда очередь доиграла
  hotkeys: boolean
  resumeMin: number // треки длиннее стольких минут продолжают с места остановки; 0 — выкл
}

// Настройки воспроизведения помним в этом браузере
const PLAYBACK_KEY = 'musich-playback'
const PLAYBACK_FIELDS = ['crossfade', 'normalize', 'queueEnd', 'hotkeys', 'resumeMin', 'eq', 'eqGains', 'quality', 'qualityMobileOnly'] as const
type PlaybackSettings = Pick<Settings, (typeof PLAYBACK_FIELDS)[number]>
const PLAYBACK_DEFAULTS: PlaybackSettings = {
  crossfade: 0, normalize: 'off', queueEnd: 'repeat', hotkeys: true, resumeMin: 20, eq: false, eqGains: [0, 0, 0, 0, 0], quality: 'original', qualityMobileOnly: true,
}
const loadPlayback = (): PlaybackSettings => {
  try {
    const saved = JSON.parse(localStorage.getItem(PLAYBACK_KEY) ?? '{}') as Partial<PlaybackSettings> & { normalize?: string }
    const p = { ...PLAYBACK_DEFAULTS, ...saved } as PlaybackSettings
    // раньше было «по треку / по альбому» — это теперь «по тегам»
    if ((saved.normalize as string) === 'track' || (saved.normalize as string) === 'album') p.normalize = 'tags'
    if (!Array.isArray(p.eqGains) || p.eqGains.length !== PLAYBACK_DEFAULTS.eqGains.length) p.eqGains = [...PLAYBACK_DEFAULTS.eqGains]
    return p
  } catch {
    return PLAYBACK_DEFAULTS
  }
}
const savePlayback = (s: Settings) => {
  try {
    localStorage.setItem(PLAYBACK_KEY, JSON.stringify(Object.fromEntries(PLAYBACK_FIELDS.map((k) => [k, s[k]]))))
  } catch {
    /* не запомним — после перезагрузки будут значения по умолчанию */
  }
}

/** Множитель громкости по ReplayGain: тише — сколько скажут теги, громче — не выше пика и не больше 100 % у <audio> */
const rgFactor = (t: Track | undefined, mode: Normalize) => {
  if (!t || mode === 'off') return 1
  const g = mode === 'tags' ? t.gain : (t.gain ?? t.autoGain)
  if (g == null) return 1
  let k = 10 ** (g / 20)
  if (t.peak) k = Math.min(k, 1 / t.peak)
  return Math.min(k, 1)
}

export type Quality = 'original' | '320' | '128'

// Названия качества и пресетов — в словарях: `quality.<id>`, `quality.<id>.hint`, `eq.<id>`
export const QUALITY: Quality[] = ['original', '320', '128']

export const EQ_BANDS = [60, 230, 910, 3600, 14000]

export const EQ_PRESETS: { id: 'flat' | 'bass' | 'vocal' | 'treble' | 'night'; gains: number[] }[] = [
  { id: 'flat', gains: [0, 0, 0, 0, 0] },
  { id: 'bass', gains: [7, 4, 0, 0, 1] },
  { id: 'vocal', gains: [-2, 0, 4, 3, 0] },
  { id: 'treble', gains: [0, 0, 0, 4, 7] },
  { id: 'night', gains: [3, 1, 0, -2, -5] },
]

interface State {
  lang: Lang
  account: Account
  saveAccount: (patch: Partial<Account>) => void
  setLang: (l: Lang) => void
  tracks: Track[]
  playlists: Playlist[]
  view: View
  ui: UiPrefs
  setUi: (patch: Partial<UiPrefs>) => void
  filter: Filter
  scope: Scope
  query: string
  theme: Theme
  palette: string // тема оформления (lib/themes.ts)
  accent: string | null // свой акцентный цвет; null — как в теме
  customThemes: CustomTheme[] // темы, собранные в настройках
  sel: string | null // цвет выделения: null — как в теме, 'text', 'accent' или свой hex
  blocks: string | null // цвет блоков: null — как в теме, 'accent' (оттенок) или свой hex
  setSel: (v: string | null) => void
  setBlocks: (v: string | null) => void
  radius: number // множитель скругления углов: 0 — острые, 1 — как в Nothing
  settings: Settings
  albumsTab: AlbumsTab
  playlistId: string | null
  // плейлисты подключённых сервисов (Spotify, YouTube, Яндекс, VK) — уже сравнённые с библиотекой
  remote: { service: IntegrationStatus['service']; syncedAt: string; canSync: boolean; data: CompareResult }[]
  remoteList: { service: IntegrationStatus['service']; list: string } | null // открытый в «remote»; list '' — понравившиеся
  loadRemote: () => Promise<void>
  syncRemote: (service: IntegrationStatus['service']) => Promise<void> // забрать список из сервиса заново
  openRemoteList: (service: IntegrationStatus['service'], list: string) => void

  currentId: string | null
  queue: string[] | null // null — играем всю библиотеку по порядку
  queueName: string      // откуда играем: «Все треки», плейлист, альбом
  upNext: string[]       // «играть следующим» / «в конец очереди» — идут раньше основного порядка
  history: string[]      // что уже играло
  fullPlayer: boolean
  phoneQueue: boolean // телефон: открыто окно очереди поверх большого плеера
  lyricsOpen: boolean // открыт текст песни (components/Lyrics.tsx)
  probing: boolean // телефон показал библиотеку из кэша и ещё ищет сервер — значок «не в сети» рано
  searchOpen: boolean // телефон: открыто окно поиска
  trackInfoId: string | null
  playing: boolean
  position: number
  volume: number
  shuffle: boolean
  // «случайно»: порядок, перемешанный один раз (при включении или запуске другого списка) —
  // по нему идут «вперёд», «назад» и очередь; иначе следующий трек и показанный в очереди расходились бы
  shuffleOrder: string[] | null
  repeat: boolean
  sleepAt: number | null   // когда поставить на паузу (timestamp)
  sleepEndOfTrack: boolean // или после текущего трека

  likedOffline: boolean // «Держать на устройстве» для Избранного
  covers: Covers
  coverEdit: CoverEdit | null

  selected: string[]
  pickerIds: string[] | null // для каких треков открыт выбор плейлиста
  playlistEditor: PlaylistEditor
  playlistDeleteId: string | null
  deleteId: string | null
  uploadOpen: boolean
  toasts: Toast[]
  activity: Activity[] // что и откуда недавно появилось в библиотеке
  incoming: Incoming[] // загрузки на сервер, которые идут прямо сейчас
  devices: Device[]
  stats: Stats | null
  prefs: ServerPrefs // общие настройки сервера: история, корзина, скан, файлы и номера
  historyPaused: boolean // «не записывать историю» — только в этом браузере
  power: Power & { saving: boolean } // экран, батарея и включена ли сейчас экономия заряда
  storage: import('./lib/device-api').StoragePrefs & { moving: { done: number; total: number } | null } // телефон: где лежит музыка
  setStorage: (patch: { folder?: 'default' | 'custom'; keep?: boolean }) => Promise<void>
  setPrefs: (patch: Partial<ServerPrefs>) => Promise<void>
  saveTracksView: (v: import('./lib/api').TracksView) => void // порядок и фильтры «Треков» — в аккаунт, тихо
  setHistoryPaused: (v: boolean) => void
  rescanning: boolean
  musicFolders: MusicFolder[] // откуда сервер берёт музыку
  conn: Conn
  standalone: boolean // телефон без привязанного сервера: всё живёт на нём
  binding: boolean // идёт привязка сервера из автономного режима (на экранах входа есть «Назад»)
  mergePending: boolean // сервер привязан, ждём «Объединить» — до этого ничего на него не отправляем
  locked: boolean // телефон с PIN-кодом: экран ввода поверх всего
  hasPin: boolean
  unlock: (pin: string) => Promise<boolean>
  setPinCode: (pin: string | null) => Promise<void>
  openProfileSetup: () => void
  backToConnect: () => void
  startStandalone: (name: string) => Promise<void>
  checkServer: (raw: string) => Promise<ServerCheck | null>
  signInServer: (raw: string, form: AuthForm) => Promise<string | null>
  startBinding: () => void
  cancelBinding: () => Promise<void>
  unbindServer: () => Promise<void>
  confirmMerge: (useLocalName: boolean) => Promise<void>
  cancelMerge: () => Promise<void>
  tokens: TokenInfo[] // где выполнен вход: браузеры и устройства
  plays: Play[] | null // история прослушиваний; null — ещё не загружали
  renameId: string | null // для какого трека открыто переименование
  syncInfo: SyncInfo // телефон: что ждёт отправки и скачивания, когда последний раз всё сошлось
  artistRename: string[] | null // переименование артиста: из кого выбирать (у совместного трека их несколько)

  loadPlays: () => Promise<void>
  recordPlay: (trackId: string) => Promise<void>
  openRename: (id: string | null) => void
  renameTrack: (id: string, patch: { title?: string; artist?: string; album?: string; year?: number }) => Promise<void>
  resetTrackEdits: (id: string) => Promise<void> // убрать правки «только в MUSICH» — снова как в тегах файла
  embedAlbumCover: (album: string) => Promise<void> // своя обложка альбома — во все его файлы
  openArtistRename: (names: string[] | null) => void
  renameArtist: (from: string, to: string) => Promise<void>

  initConn: () => Promise<void>
  connectServer: (url: string) => Promise<string | null> // телефон: адрес сервера; текст ошибки или null
  changeServer: () => void
  authSubmit: (form: AuthForm) => Promise<string | null> // текст ошибки или null
  me: AuthUser | null // кто вошёл: id, логин, роль
  registration: boolean // регистрация на сервере открыта (из /auth/status, у владельца — и из настроек сервера)
  users: ServerUser[] // владелец: все пользователи сервера
  loadUsers: () => Promise<void>
  loadServerSettings: () => Promise<void>
  setRegistration: (v: boolean) => Promise<void>
  resetUserPassword: (id: string, password: string) => Promise<boolean>
  setUserRole: (id: string, role: 'admin' | 'user') => Promise<void> // только владелец
  transferOwner: (id: string, password: string) => Promise<boolean> // только владелец: сам он станет администратором
  deleteUser: (id: string) => Promise<boolean>
  viewAs: { id: string; name: string } | null // владелец смотрит чужую библиотеку — только чтение
  libLoading: boolean // библиотека грузится с сервера с нуля (открыли страницу) — вместо «пусто» показываем загрузку
  openUserLibrary: (u: { id: string; name: string }) => Promise<void>
  exitUserLibrary: () => Promise<void>
  setFolderOwner: (path: string, userId: string) => Promise<void>
  codeSubmit: (code: string) => Promise<string | null> // вход по коду подключения; текст ошибки или null
  pairServer: (raw: string, code: string) => Promise<string | null> // телефон: адрес сервера + код с другого устройства, всё сразу
  logout: () => Promise<void>
  changePassword: (current: string, next: string) => Promise<boolean>
  loadTokens: () => Promise<void>
  createToken: (name: string) => Promise<(TokenInfo & { token: string }) | null> // сам токен — показать один раз
  revokeToken: (id: string) => Promise<void>

  setView: (v: View) => void
  setFilter: (f: Filter) => void
  openScope: (s: Scope) => void
  setQuery: (q: string) => void
  setTheme: (t: Theme) => void
  setPalette: (id: string) => void
  setAccent: (hex: string | null) => void
  saveCustomTheme: (t: CustomTheme) => void // новая или изменённая — и сразу включается
  deleteCustomTheme: (id: string) => void
  setRadius: (v: number) => void
  setSetting: <K extends keyof Settings>(k: K, v: Settings[K]) => void
  setAlbumsTab: (t: AlbumsTab) => void
  openPlaylist: (id: string) => void

  play: (id: string, queue?: string[] | null, queueName?: string) => void
  startRadio: (seed: { trackId?: string; artist?: string }) => Promise<void> // радио по библиотеке (lib/radio.ts)
  toggle: () => void
  next: () => void
  prev: () => void
  prevTrack: () => void // предыдущий трек, без «в первые 3 секунды — в начало» (свайп обложки)
  playNext: (id: string) => void
  addToQueue: (id: string) => void
  removeFromQueue: (id: string) => void // убрать из того, что сыграет дальше
  moveInQueue: (from: number, to: number) => void // переставить в том, что сыграет дальше (номера — как в upcoming)
  setFullPlayer: (v: boolean) => void
  setPhoneQueue: (v: boolean) => void
  setLyricsOpen: (v: boolean) => void
  setSearchOpen: (v: boolean) => void
  showTrackInfo: (id: string | null) => void
  seek: (sec: number) => void
  setVolume: (v: number) => void
  toggleShuffle: () => void
  toggleRepeat: () => void
  toggleLike: (id: string) => void
  setSleep: (v: number | 'track' | null) => void // минуты, «до конца трека» или выкл
  setEq: (on: boolean) => void
  setEqGains: (gains: number[]) => void

  toggleSelect: (id: string) => void
  clearSelection: () => void

  openCoverEdit: (e: CoverEdit | null) => void
  setCover: (key: string, url: string | null) => Promise<void>

  openPicker: (ids: string[] | null) => void
  openPlaylistEditor: (e: PlaylistEditor) => void
  savePlaylist: (data: { name: string; description: string; coverUrl?: string }) => Promise<void>
  addToPlaylist: (pid: string, ids: string[]) => void
  removeFromPlaylist: (pid: string, tid: string) => void
  movePlaylistTrack: (pid: string, from: number, to: number) => void
  movePlaylist: (from: number, to: number) => void // порядок своих плейлистов (без «Избранного»)
  renumbering: boolean // идёт перенос номера трека — файлы переписываются, второй перенос ждёт
  moveTrackNumber: (id: string, to: number) => Promise<void>
  setKeepOffline: (pid: string, v: boolean) => void
  keepScopes: { album: string[]; artist: string[] } // телефон: альбомы и артисты, которые держим на устройстве
  setKeepScope: (type: 'album' | 'artist', value: string, v: boolean) => void
  askDeletePlaylist: (id: string | null) => void
  deletePlaylist: (id: string) => Promise<void>

  download: (id: string) => void
  downloadMany: (ids: string[]) => void
  askDelete: (id: string | null) => void
  deleteFromDevice: (id: string) => void
  freeUpSpace: (ids: string[]) => Promise<void> // убрать с телефона пачкой (на сервере остаётся, само больше не качается)
  deleteEverywhere: (id: string) => Promise<void>
  setUploadOpen: (v: boolean) => void
  uploadFiles: (files: File[]) => Promise<void>
  forgetDevice: (id: string) => Promise<void>
  syncNow: () => void
  pauseSync: () => void // телефон: «Остановить» — после текущих файлов ничего больше не качаем и не отправляем
  resumeSync: () => void // «Продолжить»
  checkSync: () => Promise<void> // «Проверить»: скачанное на месте и целое, пропавшее — заново
  pullChanges: () => Promise<void> // забрать изменения с сервера сразу, не дожидаясь опроса
  rescan: () => Promise<void>
  addMusicFolder: (path: string, userId?: string) => Promise<boolean> // false — не добавили (дубль, пересечение, ошибка); userId — чья (по умолчанию своя)
  removeMusicFolder: (path: string) => Promise<void>
  setUploadFolder: (path: string) => Promise<void>
  moveMusicFolder: (from: string, to: string) => Promise<boolean> // «папка переехала»: пути в базе переписываются

  toast:(text: string, kind?: ToastKind) => void
  trackEnded: () => void
  crossfadeTick: () => void // главный <audio> подошёл к концу — пора ли начинать следующий трек
  prefetchNext: () => void // веб: следующий трек в очереди — заранее в память браузера (lib/webcache.ts)
  tick: () => void
}

let toastId = 0

const today = () => new Date().toISOString().slice(0, 10)

// Пути на сервере: обычно linux (/mnt/das), в dev на Windows — C:\Music. Разделитель берём из самого пути
export const pathSep = (p: string) => (p.includes('\\') ? '\\' : '/')
const trimPath = (p: string) => {
  const s = pathSep(p)
  const cut = p.replace(/[\\/]+$/, '')
  return !cut ? s : /^[A-Za-z]:$/.test(cut) ? cut + s : cut
}
/** a лежит внутри b (или это она сама) */
const isInside = (a: string, b: string) => a === b || a.startsWith(b.endsWith(pathSep(b)) ? b : b + pathSep(b))

// Ошибка API — её текст от сервера; сеть — «сервер не отвечает»
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : t('auth.offline'))

// Вход и регистрация (docs/USERS.md): куда слать и что
const AUTH_PATH: Record<AuthMode, string> = { login: '/auth/login', register: '/auth/register', setup: '/auth/setup', claim: '/auth/claim' }
const authBody = (f: AuthForm) => {
  const login = f.login.trim()
  // при входе name — подпись входа в «Устройствах и входах», как раньше; при создании аккаунта — имя для показа
  if (f.mode === 'login') return { login, password: f.password, name: browserName(), ...(f.code?.trim() ? { code: f.code.trim() } : {}) }
  if (f.mode === 'claim') return { login, password: f.password }
  return { login, password: f.password, ...(f.name?.trim() ? { name: f.name.trim() } : {}) }
}
// Ошибка входа — понятным текстом на языке интерфейса
const authError = (e: unknown, mode: AuthMode) => {
  if (!(e instanceof ApiError)) return t('auth.offline')
  // двухэтапный вход: пароль верный, нужен код (экран входа по этому тексту показывает поле кода — TOTP_NEED)
  if (e.code === 'totp_required') return t('auth.totpNeed')
  if (e.code === 'totp_wrong') return t('auth.totpWrong')
  if (e.status === 401) return mode === 'claim' ? t('auth.wrong') : t('auth.wrongLogin')
  if (e.status === 403 && (e.code === 'registration_closed' || mode === 'register')) return t('auth.regClosed')
  // коды — как отвечает сервер (server/src/auth.ts): login_taken, bad_login, setup_required, conflict
  if (e.code === 'login_taken') return t('auth.loginTaken')
  if (e.code === 'bad_login') return t('auth.loginBad')
  // владельца ещё нет — сначала первый запуск
  if (e.code === 'setup_required') return t('auth.needSetup')
  // пока смотрели на «первый запуск» или «придумайте логин», это уже сделали из другого браузера
  if (e.status === 409) return t('auth.taken')
  return e.message
}

// Имя входа в списке «Устройства и входы»: браузер и система
function browserName() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : t('auth.browser')
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${browser} · ${os}` : browser
}

// Уборка при горячей перезагрузке (только в разработке). Иначе старая версия модуля оставляет живыми
// свой <audio> (два трека разом), опрос сервера и эквалайзер. На dispose от Vite полагаться нельзя:
// он зовётся только у модуля-границы обновления (компонентов), а store.ts перезапускается как зависимость.
// Поэтому новая версия модуля при загрузке сама убирает за прошлой
const cleanups: (() => void)[] = []
const onDispose = (fn: () => void) => cleanups.push(fn)
{
  const cleanup = () => cleanups.splice(0).forEach((fn) => fn())
  const g = globalThis as { musichCleanup?: () => void }
  g.musichCleanup?.()
  g.musichCleanup = cleanup
  import.meta.hot?.dispose(cleanup)
}

// Звук идёт файлом с сервера: GET /api/tracks/:id/file поддерживает Range, перемотка работает
// Два <audio>: при кроссфейде старый трек доигрывает и затихает в одном, следующий нарастает в другом.
// audio — тот, что сейчас главный (его позиция в стейте); после кроссфейда они меняются ролями
const players = typeof Audio !== 'undefined' ? [new Audio(), new Audio()] : []
let audio: HTMLAudioElement | null = players[0] ?? null
for (const p of players) {
  p.volume = 0.7
  // на телефоне сервер — другой адрес: без CORS эквалайзер (Web Audio) получил бы тишину
  if (!isHost) p.crossOrigin = 'anonymous'
}

// Длинные треки (миксы, подкасты) помнят, где остановились: id → секунда. Только в этом браузере
const RESUME_KEY = 'musich-resume'
const resumeMap: Record<string, number> = (() => {
  try {
    return JSON.parse(localStorage.getItem(RESUME_KEY) ?? '{}')
  } catch {
    return {}
  }
})()
const saveResume = () => {
  const keys = Object.keys(resumeMap)
  for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete resumeMap[k] // помним последние 100
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify(resumeMap))
  } catch {
    /* не запомним — начнётся сначала */
  }
}

// ---- телефон (режим device): файлы, офлайн-библиотека, системный плеер — lib/device.ts ----
// Модуль грузится только в приложении: в веб-морду сервера Capacitor не попадает
type DeviceModule = typeof import('./lib/device-api')
let dev: DeviceModule | null = null
let nativeHooked = false // кнопки шторки, «Назад», «Поделиться» уже подключены
let onCellular = false // телефон сейчас в мобильном интернете (не Wi-Fi) — для качества потока
const loadDevice = async () => (dev ??= await import('@device'))

// Сервер не отвечает по старому адресу — может, роутер выдал ПК другой. Ищем в сети сервер с тем же id
// и переезжаем на новый адрес; не чаще раза в 30 секунд, чтобы не гонять поиск на каждый повтор
let lastRediscover = 0
async function rediscover(d: DeviceModule): Promise<boolean> {
  const node = d.savedNode()
  if (!node || Date.now() - lastRediscover < 30_000) return false
  lastRediscover = Date.now()
  const { findServers } = await import('./lib/discovery')
  const found = (await findServers(d.savedServer())).find((s) => s.node === node)
  if (!found || found.url === d.savedServer()) return false
  // главный адрес — домен: домашний лишь маршрут на сейчас, сохранённый адрес не трогаем
  if (isDomainUrl(d.savedServer() ?? '')) {
    setApiBase(found.url)
    return true
  }
  d.saveServer(found.url)
  await d.moveMirror(found.url)
  setApiBase(found.url)
  return true
}

/** Запомнить id сервера, к которому подключены, и его адреса в домашней сети (из /api/health — без входа) */
async function rememberNode(d: DeviceModule) {
  const { hello } = await import('./lib/discovery')
  const h = await hello(getApiBase(), 4000)
  if (!h) return
  d.saveNode(h.node)
  try {
    if (h.lan?.length) localStorage.setItem(LAN_KEY, JSON.stringify({ node: h.node, urls: h.lan }))
  } catch {
    /* не запомним — будем ходить по домену */
  }
}

/**
 * Дома — напрямую, вне дома — по домену. Сервер указан доменом, телефон на Wi-Fi и знает домашние адреса этого
 * сервера → пробуем их (до 1,2 с); ответил тот же сервер (id совпал) — ходим по нему: быстрее и без интернета.
 * Иначе — по домену. Сохранённый адрес не меняется: он остаётся «главным», домашний — только маршрут
 */
const LAN_KEY = 'musich-lan'
const isDomainUrl = (u: string) => {
  try {
    const h = new URL(u).hostname
    return h.includes('.') && !/^(\d{1,3}\.){3}\d{1,3}$/.test(h) && !h.endsWith('.local')
  } catch {
    return false
  }
}
async function pickRoute(d: DeviceModule, server: string): Promise<string> {
  if (!isDomainUrl(server) || !(await d.onWifi())) return server
  let lan: { node: string; urls: string[] } | null = null
  try {
    lan = JSON.parse(localStorage.getItem(LAN_KEY) ?? 'null')
  } catch {
    lan = null
  }
  if (!lan || lan.node !== d.savedNode() || !lan.urls.length) return server
  const { hello } = await import('./lib/discovery')
  const found = await Promise.all(lan.urls.map((u) => hello(u, 1200)))
  return found.find((h) => h?.node === lan!.node)?.url ?? server
}

/**
 * Перепроверить маршрут, пока есть связь: пришёл домой — переходим на домашний адрес, не дожидаясь события «сеть
 * сменилась». Его шлёт Android при переходе Wi‑Fi ↔ мобильный, а ПК (ноутбук сменил Wi‑Fi) — почти никогда.
 * Ушёл из дома — опрос по домашнему адресу перестаёт отвечать, и initConn сам уходит на домен.
 * Не чаще раза в минуту; force — сразу (только что узнали домашние адреса сервера)
 */
let routeCheckedAt = 0
async function recheckRoute(onSwitch: () => void, force = false) {
  if (isHost || !dev || (!force && Date.now() - routeCheckedAt < 60_000)) return
  routeCheckedAt = Date.now()
  const server = dev.savedServer()
  if (!server) return
  const route = await pickRoute(dev, server)
  if (route === getApiBase()) return
  setApiBase(route)
  onSwitch()
}

// что сейчас качается на телефон: id → проценты
const downloading = new Map<string, number>()
// что сейчас уходит с телефона на сервер: id «up:…» → проценты
const uploadingNow = new Map<string, number>()
const isPendingId = (id: string) => id.startsWith('up:')
const statusOf = (id: string): TrackStatus =>
  isHost ? 'synced' : isPendingId(id) ? 'uploading' : downloading.has(id) ? 'downloading' : dev?.isLocal(id) ? 'synced' : 'cloud'

// Экран синхронизации на телефоне: что ждёт и когда последний раз всё сошлось (помним между запусками)
// paused — человек нажал «Остановить»: ничего не качаем и не отправляем, пока не «Продолжить»; checking — идёт «Проверить»
export type SyncInfo = { up: number; down: number; running: boolean; at: number | null; paused: boolean; checking: boolean }
const LAST_SYNC_KEY = 'musich-last-sync'
const loadLastSync = () => {
  try {
    return Number(localStorage.getItem(LAST_SYNC_KEY)) || null
  } catch {
    return null
  }
}

// Флажок «да/нет», который помним в этом браузере
const loadFlag = (key: string) => {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}
const saveFlag = (key: string, v: boolean) => {
  try {
    if (v) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch {
    /* не запомним — не страшно */
  }
}

// «держать на устройстве» у плейлистов и «Избранного», «скачивать всё», «только по Wi‑Fi» — помним на телефоне
const KEEP_KEY = 'musich-keep'
type Keep = { liked: boolean; playlists: string[]; albums: string[]; artists: string[]; autoDownload: boolean; wifiOnly: boolean; paused: boolean; limitGb?: number }
const loadKeep = (): Keep => {
  try {
    return { liked: true, playlists: [], albums: [], artists: [], autoDownload: false, wifiOnly: true, paused: false, ...JSON.parse(localStorage.getItem(KEEP_KEY) ?? '{}') }
  } catch {
    return { liked: true, playlists: [], albums: [], artists: [], autoDownload: false, wifiOnly: true, paused: false }
  }
}
const saveKeep = (patch: Partial<Keep>) => {
  try {
    localStorage.setItem(KEEP_KEY, JSON.stringify({ ...loadKeep(), ...patch }))
  } catch {
    /* без памяти — после перезапуска вернутся значения по умолчанию */
  }
}

// Что играло и где остановились — чтобы после перезагрузки страницы продолжить с того же места.
// Ссылки на треки, которых на сервере уже нет, выкидываем, когда библиотека загрузится (keepKnown)
const PLAYER_KEY = 'tunich-player'
const PLAYER_FIELDS = ['currentId', 'position', 'queue', 'queueName', 'upNext', 'history', 'volume', 'shuffle', 'shuffleOrder', 'repeat'] as const
type SavedPlayer = Partial<Pick<State, (typeof PLAYER_FIELDS)[number]>>

const savedPlayer = ((): SavedPlayer => {
  try {
    const p: SavedPlayer = JSON.parse(localStorage.getItem(PLAYER_KEY) ?? '{}')
    // раньше «Все треки» сохранялось строкой; теперь это пустое имя, а подпись — на языке интерфейса
    return { ...p, queueName: p.queueName === 'Все треки' ? '' : p.queueName }
  } catch {
    return {}
  }
})()
// на телефоне громкость — только кнопками телефона: своя громкость приложения всегда 100%
if (audio && savedPlayer.volume !== undefined) audio.volume = isHost ? savedPlayer.volume / 100 : 1

// ---- форматы сервера → интерфейса ----

const MB = 1024 * 1024

const toTrack = (s: ServerTrack): Track => ({
  id: s.id,
  title: s.title,
  artist: s.artist,
  album: s.album,
  year: s.year,
  trackNo: s.trackNo,
  duration: s.duration,
  gain: s.gain,
  albumGain: s.albumGain,
  peak: s.peak,
  sizeMb: s.size / MB,
  status: statusOf(s.id),
  progress: downloading.get(s.id),
  liked: s.liked,
  likedAt: s.likedAt ? Date.parse(s.likedAt) : undefined,
  addedAt: s.addedAt,
  from: s.source,
  file: s.fileName,
  edited: s.edited,
  hash: s.hash,
  autoGain: s.autoGain,
  fileChanged: s.fileChanged,
  fileChanges: s.fileChanges,
  // скачанный трек показывает свою обложку из файла — она есть и без сети
  cover: dev?.localCover(s.id) ?? (s.hasCover ? mediaUrl(`/tracks/${s.id}/cover`, s.seq) : undefined),
})

// Плейлисты — в порядке, который владелец задал перетаскиванием
const byPosition = (a: Playlist, b: Playlist) => (a.position ?? 0) - (b.position ?? 0)

const toPlaylist = (s: ServerPlaylist, keepOffline = false): Playlist => ({
  id: s.id,
  position: s.position,
  name: s.name,
  description: s.description,
  trackIds: s.trackIds,
  keepOffline,
  coverUrl: s.hasCover ? mediaUrl(`/playlists/${s.id}/cover`, s.seq) : undefined,
  updatedAt: s.updatedAt.slice(0, 10),
})

// «на связи» — отмечалось последние пару минут (клиент синхронизации стучится раз в 30 секунд)
const toDevice = (d: ServerDevice): Device => {
  const lastSeenAt = Date.parse(d.lastSeenAt)
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    lastSeenAt,
    online: Date.now() - lastSeenAt < 2 * 60_000,
    pendingUp: d.pendingUp ?? 0,
    pendingDown: d.pendingDown ?? 0,
    syncedAt: d.syncedAt ? Date.parse(d.syncedAt) : undefined,
  }
}

// Трек, добавленный на телефоне и ещё не отправленный: в библиотеке сразу, со статусом «отправляется»
const outboxTrack = (o: import('./lib/device-api').OutboxItem): Track => ({
  id: o.id,
  title: o.title,
  artist: o.artist || t('dev.unknownArtist'),
  album: o.album,
  duration: o.duration,
  sizeMb: o.size / (1024 * 1024),
  status: 'uploading',
  progress: uploadingNow.get(o.id),
  addedAt: o.addedAt,
  file: o.name,
  cover: dev?.localCover(o.id),
})

const coverKey = (kind: string, key: string) => `${kind}:${key}`
const coverPath = (kind: string, key: string) => `/covers/${kind}/${encodeURIComponent(key)}`
const newestFirst = (a: Track, b: Track) => b.addedAt.localeCompare(a.addedAt)

/** data:-url картинки → Blob для PUT */
// data:-адрес → файл без fetch: fetch(data:) упирается в CSP сервера (connect-src) и падал как «сервер не отвечает»
const dataUrlBlob = async (url: string) => {
  if (!url.startsWith('data:')) return (await fetch(url)).blob()
  const [head, body = ''] = url.split(',', 2)
  const type = /^data:([^;,]+)/.exec(head)?.[1] ?? 'application/octet-stream'
  if (!head.includes(';base64')) return new Blob([decodeURIComponent(body)], { type })
  const bin = atob(body)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

const EMPTY_ACCOUNT: Account = { name: '', email: '' }
const MERGE_KEY = 'musich-merge-pending'

const initialLang = detectLang()
setCurrentLang(initialLang)

const initialTheme = (): Theme => {
  try {
    return (localStorage.getItem('tunich-theme') as Theme) || 'light'
  } catch {
    return 'light'
  }
}

export const useStore = create<State>((set, get) => {
  // плейлист только что правили здесь: ответ опроса, запрошенный до правки, её не затирает (свежая версия придёт следом)
  const plEdited = new Map<string, number>()
  const patchPlaylist = (pid: string, fn: (p: Playlist) => Playlist) => {
    plEdited.set(pid, Date.now())
    set({ playlists: get().playlists.map((p) => (p.id === pid ? { ...fn(p), updatedAt: today() } : p)) })
  }

  // Эквалайзер: <audio> → 5 фильтров → колонки. Граф создаём один раз, при первом включении
  // (AudioContext можно завести только после действия пользователя)
  let eq: { ctx: AudioContext; nodes: BiquadFilterNode[] } | null = null
  const applyEq = () => {
    if (!eq) return
    const { eq: on, eqGains } = get().settings
    eq.nodes.forEach((n, i) => (n.gain.value = on ? eqGains[i] : 0))
  }
  const ensureEq = () => {
    if (!audio || eq) return
    const ctx = new AudioContext()
    const nodes = EQ_BANDS.map((f, i) => {
      const n = ctx.createBiquadFilter()
      n.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking'
      n.frequency.value = f
      n.Q.value = 1
      return n
    })
    nodes.forEach((n, i) => n.connect(nodes[i + 1] ?? ctx.destination))
    for (const p of players) ctx.createMediaElementSource(p).connect(nodes[0])
    eq = { ctx, nodes }
    onDispose(() => ctx.close())
  }

  // Громкость главного <audio>: ползунок × ReplayGain трека × затухание (таймер сна, нарастание после кроссфейда)
  let sleepFade = 1
  const fadeIn = { start: 0, ms: 0 }
  let fadeTimer: ReturnType<typeof setInterval> | null = null
  const applyVolume = () => {
    if (!audio) return
    const s = get()
    const k = fadeIn.ms ? Math.min(1, (performance.now() - fadeIn.start) / fadeIn.ms) : 1
    const cur = s.tracks.find((t) => t.id === s.currentId)
    // на телефоне своей громкости у приложения нет — привязка к громкости телефона; выравнивание, таймер сна
    // и плавный вход остаются (они только убавляют)
    const own = isHost ? s.volume / 100 : 1
    audio.volume = Math.max(0, Math.min(1, own * rgFactor(cur, s.settings.normalize) * sleepFade * k))
  }
  const startFadeIn = (ms: number) => {
    if (fadeTimer) clearInterval(fadeTimer)
    Object.assign(fadeIn, { start: performance.now(), ms })
    fadeTimer = setInterval(() => {
      if (performance.now() - fadeIn.start >= fadeIn.ms) {
        fadeIn.ms = 0
        clearInterval(fadeTimer!)
        fadeTimer = null
      }
      applyVolume()
    }, 50)
  }
  // старый трек доигрывает в соседнем <audio> и затихает к своему концу
  let tail: { el: HTMLAudioElement; timer: ReturnType<typeof setInterval> } | null = null
  const stopTail = () => {
    if (!tail) return
    clearInterval(tail.timer)
    tail.el.pause()
    tail.el.removeAttribute('src')
    delete tail.el.dataset.id
    tail = null
  }
  const startTail = (el: HTMLAudioElement, ms: number) => {
    stopTail()
    const from = el.volume
    const t0 = performance.now()
    tail = {
      el,
      timer: setInterval(() => {
        const k = 1 - (performance.now() - t0) / Math.max(ms, 1)
        if (k <= 0 || el.ended) return stopTail()
        el.volume = from * k
      }, 50),
    }
  }
  onDispose(() => {
    if (fadeTimer) clearInterval(fadeTimer)
    stopTail()
  })

  // «Выравнивать автоматически», а у трека нет ReplayGain: раскодируем файл, меряем громкость (средняя мощность
  // по кускам 0,4 с без тишины, как в замерах LUFS) и запоминаем на сервере — второй раз и на других устройствах не меряем
  const LOUD_TARGET = -17 // дБ: примерно как стриминги (−14 LUFS)
  const measuring = new Set<string>()
  const measureLoudness = async (t: Track) => {
    // в чужой библиотеке ничего не записываем — и замер громкости тоже
    if (measuring.has(t.id) || typeof OfflineAudioContext === 'undefined' || get().power.saving || get().viewAs) return
    if (t.duration > 15 * 60 || (!isHost && !dev?.localSrc(t.id))) return
    measuring.add(t.id)
    try {
      const src = dev?.localSrc(t.id) ?? mediaUrl(`/tracks/${t.id}/file`, t.hash)
      const data = await (await fetch(src)).arrayBuffer()
      const buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(data)
      const block = Math.round(buf.sampleRate * 0.4)
      const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c))
      const blocks: number[] = []
      for (let i = 0; i + block <= buf.length; i += block) {
        let sum = 0
        for (const ch of chans) for (let j = i; j < i + block; j += 2) sum += ch[j] * ch[j]
        blocks.push(sum / ((block / 2) * chans.length))
      }
      const loud = blocks.filter((b) => b > 1e-7) // тише −70 дБ — тишина
      const mean = loud.reduce((a, b) => a + b, 0) / Math.max(1, loud.length)
      const gated = loud.filter((b) => b > mean / 10) // тише на 10 дБ среднего — паузы и затухания
      const level = 10 * Math.log10(gated.reduce((a, b) => a + b, 0) / Math.max(1, gated.length) || 1e-10)
      const gain = Math.max(-20, Math.min(10, LOUD_TARGET - level))
      const st = await api<ServerTrack>(`/tracks/${t.id}/loudness`, { method: 'PUT', body: { gain } })
      set({ tracks: get().tracks.map((x) => (x.id === t.id ? { ...x, autoGain: st.autoGain } : x)) })
      applyVolume()
    } catch {
      /* не вышло (нет сети, формат не раскодировался) — играем как есть */
    } finally {
      measuring.delete(t.id)
    }
  }

  // Таймер сна: пауза и возврат громкости, которую приглушали перед остановкой
  const sleepNow = () => {
    set({ playing: false, sleepAt: null, sleepEndOfTrack: false })
    syncAudio()
    sleepFade = 1
    applyVolume()
    get().toast(t('toast.sleepNight'))
  }

  const findPlaylist = (pid: string) => withLiked(get().tracks, get().playlists, get().likedOffline, get().plays).find((p) => p.id === pid)

  // ---- журнал телефона (lib/node/journal.ts) ----
  // Действие идёт в журнал, если сервера нет, он не на связи, ждём «Объединить» или трек/плейлист ещё только на телефоне;
  // иначе — прямо на сервер, как раньше. Журнал уходит на сервер в runSync (pushJournal)
  const inJournal = (key: string) => journal.pending().some((e) => e.key === key)
  const viaJournal = (ids: string[] = [], pid?: string) =>
    !isHost && (get().standalone || get().mergePending || get().conn !== 'online' || ids.some(isPendingId) || (!!pid && inJournal(pid)))
  const record = (type: journal.JournalEvent['type'], key: string, field: string, value?: unknown) => {
    const e = journal.append(type, key, field, value)
    const f = journal.fold(get().tracks, get().playlists, [e])
    set({ tracks: f.tracks, playlists: f.playlists.sort(byPosition) })
    scheduleSync()
  }
  // то, что ещё не ушло на сервер, — поверх того, что пришло от него
  const refold = () => {
    if (isHost || !journal.pending().length) return
    const f = journal.fold(get().tracks, get().playlists)
    set({ tracks: f.tracks, playlists: f.playlists.sort(byPosition) })
  }
  // журнал — на сервер: по порядку, до первого события про ещё не отправленный файл
  const pushJournal = async (): Promise<void> => {
    if (foreignData()) return
    const waiting = new Set(dev?.outbox().map((o) => o.id))
    journal.prune((id) => isPendingId(id) && !waiting.has(id))
    const events = journal.sendable()
    if (!events.length || get().conn !== 'online') return
    try {
      const r = await api<{ stored: number; applied: number; rejected: number; vector: Record<string, number> }>('/sync/push', { method: 'POST', body: { events } })
      const have = r.vector[journal.nodeId()] ?? 0
      // сервер нас не помнит (новая база, другой сервер) — новый узел и номера с 1
      if (have < events[0].n - 1) {
        journal.renumber()
        return pushJournal()
      }
      journal.dropUpTo(have)
      if (r.stored) await get().pullChanges()
    } catch {
      /* нет связи — в следующий раз */
    }
  }

  // Лайк ставим/снимаем пачкой: сразу на экране, потом на сервере; не вышло — возвращаем как было
  const setLiked = (ids: string[], liked: boolean) => {
    if (readOnly()) return
    if (viaJournal(ids)) {
      for (const id of ids) record('like.set', id, 'like', liked)
      if (liked && get().likedOffline) scheduleSync()
      return
    }
    const now = Date.now()
    const before = get().tracks
    set({
      tracks: before.map((t) =>
        ids.includes(t.id) ? { ...t, liked, likedAt: liked ? now + ids.indexOf(t.id) : undefined } : t,
      ),
    })
    if (liked && get().likedOffline) scheduleSync()
    Promise.all(ids.map((id) => api<ServerTrack>(`/tracks/${id}/like`, { method: 'PUT', body: { liked } }))).catch((e) => {
      const back = new Map(before.map((t) => [t.id, t]))
      set({ tracks: get().tracks.map((t) => (ids.includes(t.id) && back.has(t.id) ? back.get(t.id)! : t)) })
      get().toast(errorText(e), 'error')
    })
  }

  // Плейлист поменялся на экране — отправляем его целиком (порядок треков важен)
  const pushPlaylist = (pid: string) => {
    const p = get().playlists.find((x) => x.id === pid)
    if (!p) return
    plEdited.set(pid, Date.now())
    api(`/playlists/${pid}`, { method: 'PATCH', body: { name: p.name, description: p.description, trackIds: p.trackIds } }).then(
      () => void plEdited.set(pid, Date.now()),
      (e) => {
        plEdited.delete(pid)
        get().toast(errorText(e), 'error')
        reload()
      },
    )
  }

  // Качество потока (сервер пережимает в MP3, server/src/transcode.ts): «оригинал» — как есть; иначе — 320/128,
  // а при «только в мобильном интернете» — лишь не на Wi-Fi. Скачанное на телефон играет из файла, без сжатия
  const streamQ = (): string | null => {
    const s = get().settings
    if (s.quality === 'original') return null
    const mobile = isHost ? (navigator as { connection?: { type?: string } }).connection?.type === 'cellular' : onCellular
    return !s.qualityMobileOnly || mobile ? s.quality : null
  }
  const streamUrl = (id: string, hash?: string) => {
    const u = mediaUrl(`/tracks/${id}/file`, hash)
    const q = streamQ()
    return q ? `${u}&q=${q}` : u
  }

  // Подгоняем <audio> под стейт: нужный файл, позиция, играть или стоять
  const syncAudio = () => {
    if (!audio) return
    const { currentId, tracks, playing, position } = get()
    const cur = tracks.find((t) => t.id === currentId)
    if (!cur?.file) {
      audio.pause()
      audio.removeAttribute('src')
      delete audio.dataset.id
      return
    }
    if (audio.dataset.id !== cur.id) {
      // на телефоне скачанный трек играет из файла, остальное — потоком с сервера (если он на связи)
      const file = dev?.localSrc(cur.id)
      if (!file && !isHost && get().conn !== 'online') {
        audio.pause()
        set({ playing: false })
        get().toast(t('dev.notDownloaded'))
        return
      }
      audio.src = file ?? streamUrl(cur.id, cur.hash)
      // следующий трек сервер пережмёт заранее — переход не будет ждать
      const nextId = upcoming(get(), 1)[0]
      const nextT = nextId ? get().tracks.find((x) => x.id === nextId) : undefined
      if (nextT && streamQ() && !dev?.localSrc(nextT.id)) void fetch(`${streamUrl(nextT.id, nextT.hash)}&warm=1`).catch(() => {})
      audio.dataset.id = cur.id
      audio.currentTime = position
      applyVolume() // у нового трека своё выравнивание
      if (get().settings.normalize === 'auto' && cur.gain == null && cur.autoGain == null) void measureLoudness(cur)
    }
    if (playing) {
      if (get().settings.eq && !eq) {
        ensureEq()
        applyEq()
      }
      if (eq?.ctx.state === 'suspended') eq.ctx.resume()
      audio.play().catch(() => set({ playing: false }))
    } else {
      audio.pause()
      stopTail()
    }
  }

  // без сети на телефоне по очереди идёт только скачанное
  const order = () => {
    const ids = playOrder(get())
    // добавленное на телефоне, но ещё не отправленное, тоже лежит здесь
    return !isHost && get().conn !== 'online' ? ids.filter((id) => dev?.isLocal(id) || isPendingId(id)) : ids
  }

  // Трек ещё не на сервере — лайк, плейлист, правка подождут, пока он отправится
  const notSentYet = (ids: string[]) => {
    if (!ids.some(isPendingId)) return false
    get().toast(t('dev.notSentYet'))
    return true
  }

  // После переименования у треков новые id (это хэш файла): меняем старые id везде, где они у нас лежат
  const applyRenamed = (list: { track: ServerTrack; previousId: string }[]) => {
    const map = new Map(list.map((r) => [r.previousId, toTrack(r.track)]))
    if (!isHost) {
      const ids = new Map(list.map((r) => [r.previousId, r.track.id]))
      journal.remap(ids)
      dev?.remapPlays(ids)
    }
    const swap = (x: string) => map.get(x)?.id ?? x
    const s = get()
    const seen = new Set<string>()
    set({
      // опрос сервера мог уже принести новые версии — после замены оставляем каждый id один раз
      tracks: s.tracks.map((x) => map.get(x.id) ?? x).filter((x) => !seen.has(x.id) && !!seen.add(x.id)),
      playlists: s.playlists.map((p) => (p.trackIds.some((x) => map.has(x)) ? { ...p, trackIds: p.trackIds.map(swap) } : p)),
      plays: s.plays?.map((p) => (map.has(p.trackId) ? { ...p, trackId: swap(p.trackId) } : p)) ?? null,
      currentId: s.currentId && swap(s.currentId),
      queue: s.queue?.map(swap) ?? null,
      shuffleOrder: s.shuffleOrder?.map(swap) ?? null,
      upNext: s.upNext.map(swap),
      history: s.history.map(swap),
      selected: s.selected.map(swap),
      trackInfoId: s.trackInfoId && swap(s.trackInfoId),
    })
    heard.id = swap(heard.id)
    // у играющего трека сменился адрес файла — переключаемся на новый с того же места
    if (s.currentId && map.has(s.currentId)) syncAudio()
  }

  // Сервер переписал теги (номер, название) — у трека новый id. Переставляем старые id в плеере,
  // очереди, истории и прослушиваниях, чтобы играющий трек не оборвался посреди перенумерации
  const remapIds = (map: Map<string, string>) => {
    if (!map.size) return
    if (!isHost) journal.remap(map)
    const swap = (x: string) => map.get(x) ?? x
    const s = get()
    set({
      plays: s.plays?.map((p) => (map.has(p.trackId) ? { ...p, trackId: swap(p.trackId) } : p)) ?? null,
      currentId: s.currentId && swap(s.currentId),
      queue: s.queue?.map(swap) ?? null,
      shuffleOrder: s.shuffleOrder?.map(swap) ?? null,
      upNext: s.upNext.map(swap),
      history: s.history.map(swap),
      trackInfoId: s.trackInfoId && swap(s.trackInfoId),
    })
    heard.id = swap(heard.id)
    if (s.currentId && map.has(s.currentId)) syncAudio()
  }

  // ---- сервер: папки с музыкой ----

  const online = () => get().conn === 'online'

  // Скан на сервере идёт в фоне: опрашиваем папки, пока какая-то сканируется,
  // и про каждую досканированную говорим, сколько в ней треков
  let scanTimer: ReturnType<typeof setTimeout> | null = null
  const applyFolders = (next: MusicFolder[]) => {
    // при полном пересканировании хватит одного «готово» в конце, без тоста на каждую папку
    for (const f of get().rescanning ? [] : next) {
      const was = get().musicFolders.find((p) => p.path === f.path)
      if (was?.scanning && !f.scanning) get().toast(t('toast.folderScanned', { path: f.path, n: f.tracks }), 'ok')
    }
    set({ musicFolders: next })
    const busy = next.some((f) => f.scanning)
    if (!busy) {
      // последние треки скана могли ещё не прийти — забираем их и выкладываем вместе с накопленным
      if (pending.size || get().rescanning) void poll().then(flushPending)
      if (get().rescanning) {
        set({ rescanning: false })
        get().toast(t('server.rescanDone'), 'ok')
      }
    }
    if (busy && !scanTimer) scanTimer = setTimeout(() => ((scanTimer = null), loadFolders()), 1500)
  }
  const loadFolders = async () => {
    try {
      applyFolders(await api<ServerFolder[]>('/folders'))
    } catch (e) {
      if (online()) get().toast(errorText(e), 'error')
    }
  }

  setUnauthorizedHandler((code) => {
    if (get().conn === 'online') signedOut(code === 'setup_required' ? 'setup' : 'login')
  })

  // ---- сервер: библиотека ----

  // Сохранённый плеер мог ссылаться на треки, которых уже нет
  const keepKnown = () => {
    const known = new Set(get().tracks.map((t) => t.id))
    const keep = (ids: string[]) => ids.filter((id) => known.has(id))
    const s = get()
    const gone = s.currentId && !known.has(s.currentId)
    set({
      queue: s.queue ? keep(s.queue) : null,
      upNext: keep(s.upNext),
      history: keep(s.history),
      // «случайно» включили ещё до того, как порядок стал храниться, — перемешиваем один раз сейчас
      shuffleOrder: s.shuffle ? (s.shuffleOrder ? keep(s.shuffleOrder) : shuffled(playOrder({ ...s, shuffle: false }), s.currentId)) : null,
      ...(gone ? { currentId: null, playing: false, position: 0 } : {}),
    })
    if (gone) syncAudio()
  }

  // Изменения с сервера: новые и изменённые записи заменяют старые, надгробия убирают.
  // Надгробия от сервера: id треков, которые он удалил (или заменил новым id). Файл на телефоне убираем ТОЛЬКО по ним —
  // а не потому, что трека «нет в зеркале»: туда не попадает только что отправленное, и зеркало пустое у нового сервера
  // (раньше так стирались свой добавленный трек и вся офлайн-музыка при подключении к другой базе)
  const TOMBS_KEY = 'musich-tombs'
  const tombs = new Set<string>(
    (() => {
      try {
        return JSON.parse(localStorage.getItem(TOMBS_KEY) ?? '[]') as string[]
      } catch {
        return []
      }
    })(),
  )
  const saveTombs = () => {
    try {
      localStorage.setItem(TOMBS_KEY, JSON.stringify([...tombs].slice(-5000)))
    } catch {
      /* не запомним — файл уберём при следующем надгробии */
    }
  }
  // Чей на телефоне зеркальный кэш и чьи неотправленные правки/файлы. Вошёл другой пользователь того же сервера:
  // зеркало сбрасываем (иначе видна чужая библиотека), а журнал и очередь файлов прошлого не отправляем в новый аккаунт —
  // они ждут, пока войдёт их хозяин
  const MIRROR_USER = 'musich-mirror-user'
  const DATA_OWNER = 'musich-data-owner'
  const ls = {
    get: (k: string) => {
      try {
        return localStorage.getItem(k)
      } catch {
        return null
      }
    },
    set: (k: string, v: string) => {
      try {
        localStorage.setItem(k, v)
      } catch {
        /* не запомним */
      }
    },
  }
  const foreignData = () => {
    const owner = ls.get(DATA_OWNER)
    const me = get().me?.id
    return !!owner && !!me && owner !== me
  }
  const checkAccount = async (d: DeviceModule) => {
    const me = get().me?.id
    if (!me) return
    const prev = ls.get(MIRROR_USER)
    if (prev && prev !== me) {
      await d.resetMirror(d.savedServer() || getApiBase())
      tombs.clear()
      saveTombs()
      set({ tracks: [], playlists: [], covers: {} })
    }
    ls.set(MIRROR_USER, me)
    const owner = ls.get(DATA_OWNER)
    const empty = !journal.pending().length && !d.outbox().length
    if (!owner || empty) ls.set(DATA_OWNER, me)
    else if (owner !== me) get().toast(t('acc.foreignPending'))
  }

  // отправку, которую сервер не принял (не 415), в этот запуск больше не пробуем, файл не трогаем
  const rejectedUp = new Set<string>()

  // Пока сканируется папка, новые треки копим и показываем разом в конце — без дёрганого списка
  let cursor = 0
  const pending = new Map<string, Track>()
  const scanningNow = () => get().musicFolders.some((f) => f.scanning)
  const applyChanges = (ch: Changes) => {
    // сервер сам сказал «трека больше нет» — только такие файлы потом убираем с телефона (см. runSync)
    for (const x of ch.tracks) if (x.status === 'deleted') tombs.add(x.id)
    if (ch.tracks.some((x) => x.status === 'deleted')) saveTombs()
    if (getApiBase()) dev?.mergeIntoMirror(dev.savedServer() || getApiBase(), ch)
    cursor = ch.cursor
    if (!ch.tracks.length && !ch.playlists.length && !ch.covers.length) return // ничего нового — не перерисовываем
    const tracks = new Map(get().tracks.map((t) => [t.id, t]))
    // во время скана новые треки копим и показываем разом — но только если библиотека уже на экране.
    // Первая загрузка (страница открыта, пока сервер сканирует) — показываем всё сразу, иначе библиотека была пустой до конца скана
    const hold = scanningNow() && get().tracks.length > 0
    for (const s of ch.tracks) {
      if (s.status === 'deleted') {
        tracks.delete(s.id)
        pending.delete(s.id)
      } else if (hold && !tracks.has(s.id)) pending.set(s.id, toTrack(s))
      else tracks.set(s.id, toTrack(s))
    }
    const playlists = new Map(get().playlists.map((p) => [p.id, p]))
    for (const s of ch.playlists) {
      if (!s.deleted && Date.now() - (plEdited.get(s.id) ?? 0) < 8000) continue
      if (s.deleted) playlists.delete(s.id)
      else playlists.set(s.id, toPlaylist(s, playlists.get(s.id)?.keepOffline ?? (!isHost && loadKeep().playlists.includes(s.id))))
    }
    const covers = { ...get().covers }
    for (const c of ch.covers) {
      if (c.deleted) delete covers[coverKey(c.kind, c.key)]
      else covers[coverKey(c.kind, c.key)] = dev?.localImage(`${coverKey(c.kind, c.key)}:${c.seq}`) ?? mediaUrl(coverPath(c.kind, c.key), c.seq)
    }
    const removed = ch.tracks.filter((s) => s.status === 'deleted').map((s) => s.id)
    const renamed = new Map(ch.tracks.filter((s) => s.status === 'deleted' && s.replacedBy).map((s) => [s.id, s.replacedBy!]))
    set({
      tracks: [...tracks.values()].sort(newestFirst),
      playlists: [...playlists.values()].sort(byPosition),
      covers,
      selected: get()
        .selected.map((id) => renamed.get(id) ?? id)
        .filter((id) => !removed.includes(id)),
    })
    remapIds(renamed)
    refold()
    scheduleSync()
  }

  // Скан закончился — выкладываем накопленное одним махом
  const flushPending = () => {
    if (!pending.size) return
    const tracks = new Map(get().tracks.map((t) => [t.id, t]))
    for (const [id, t] of pending) tracks.set(id, t)
    pending.clear()
    set({ tracks: [...tracks.values()].sort(newestFirst) })
  }

  // Треки из очереди отправки — в библиотеку: после открытия кэша и после полной перезагрузки списка
  const showOutbox = () => {
    if (!dev) return
    const have = new Set(get().tracks.map((x) => x.id))
    const add = dev.outbox().filter((o) => !have.has(o.id)).map(outboxTrack)
    if (add.length) set({ tracks: [...add, ...get().tracks].sort(newestFirst) })
    refold()
  }

  // Добавить на телефон («Добавить музыку», «Поделиться»): файл — в папку приложения, трек — сразу в библиотеку,
  // на сервер — при синхронизации (без сети — когда появится)
  const addToPhone = async (jobs: (() => Promise<import('./lib/device-api').OutboxItem>)[]) => {
    let added = 0
    for (const job of jobs) {
      try {
        const item = await job()
        set({ tracks: [outboxTrack(item), ...get().tracks] })
        added++
      } catch (e) {
        get().toast(t('dev.addFail', { msg: e instanceof Error ? e.message : String(e) }), 'error')
      }
    }
    if (!added) return
    void relocateNow() // своё добавленное — туда же, где вся музыка (по настройке «Где хранить»)
    get().toast(get().standalone ? t('dev.addedSolo', { n: added }) : get().conn === 'online' ? t('dev.addedSending', { n: added }) : t('dev.addedLater', { n: added }), 'ok')
    updateSyncInfo()
    scheduleSync()
  }

  // Опрос раз в 4 секунды: кладём в стор, только если что-то правда поменялось — иначе экран перерисовывается зря
  const setIfChanged = <K extends 'devices' | 'incoming' | 'activity' | 'stats'>(key: K, value: State[K]) => {
    if (JSON.stringify(get()[key]) !== JSON.stringify(value)) set({ [key]: value } as Pick<State, K>)
  }
  const loadDevices = async () => setIfChanged('devices', (await api<ServerDevice[]>('/devices')).map(toDevice))
  const loadActivity = async () => {
    const a = await api<ServerActivity>('/activity')
    setIfChanged('incoming', a.incoming)
    setIfChanged('activity', a.recent.map((r) => ({ id: r.id, device: r.source, title: r.title, artist: r.artist, at: Date.parse(r.addedAt) })))
  }
  const loadStats = async () => setIfChanged('stats', await api<Stats>('/stats'))
  const loadPrefs = async () => {
    const p = await api<ServerPrefs>('/prefs')
    set({ prefs: { ...DEFAULT_SERVER_PREFS, ...p } })
    setArtistSeparators(p.separators)
  }

  // Веб тоже виден в «Экосистеме»: браузер регистрируется устройством и раз в минуту отмечается (что играет, как ходит).
  // Номер браузера — свой у каждого адреса (домен и домашний — для браузера разные сайты)
  const WEB_DEV = 'musich-web-device'
  const WEB_HW = 'musich-web-hw'
  let webTimer: ReturnType<typeof setInterval> | null = null
  const webSeen = async () => {
    if (!isHost || get().viewAs || get().conn !== 'online' || !get().power.visible) return
    try {
      let id = ls.get(WEB_DEV)
      if (!id) {
        let hw = ls.get(WEB_HW)
        if (!hw) {
          hw = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
          ls.set(WEB_HW, hw)
        }
        id = (await api<ServerDevice>('/devices', { method: 'POST', body: { name: browserName(), kind: 'desktop', hwId: hw } })).id
        ls.set(WEB_DEV, id)
      }
      await api(`/devices/${id}/seen`, { method: 'POST', body: { info: await selfInfo() } }).catch((e) => {
        if (e instanceof ApiError && e.status === 404) ls.set(WEB_DEV, '') // «забыли» на странице сервера — зарегистрируемся снова
      })
    } catch {
      /* без отметки всё работает */
    }
  }

  // Всё сразу после входа
  const loadAll = async () => {
    if (!isHost && dev) await checkAccount(dev)
    // медиа-ключ для адресов аудио и обложек — параллельно с библиотекой (лишний круг по сети не ждём), но до того,
    // как адреса соберутся; старый сервер без него — по-старому
    const keyReady = mediaKeyFresh() ? Promise.resolve() : api<{ key: string; expiresAt: string }>('/auth/media-key').then(setMediaKey, () => {})
    // на телефоне библиотека уже открыта из кэша — забираем только то, что поменялось с того раза
    if (isHost || !get().tracks.length) {
      cursor = 0
      set({ tracks: [], playlists: [], covers: {}, libLoading: true })
      showOutbox()
    } else if (dev) {
      // библиотека из кэша открылась ещё до входа — адреса обложек собраны без ключа, и сервер отвечал 401 (серые квадраты).
      // После входа пересобираем их из того же кэша, дождавшись ключа
      await keyReady
      applyChanges(dev.mirrorChanges())
    }
    try {
      // в просмотре чужой библиотеки профиль — свой, прежний: чужой в «Аккаунт» не тянем
      const viewing = !!get().viewAs
      const [ch, profile] = await Promise.all([api<Changes>(`/changes?since=${cursor}`), viewing ? null : api<Profile>('/profile'), keyReady])
      applyChanges(ch)
      set({ libLoading: false }) // библиотека на экране — дальше подгружается остальное
      mirrorFresh = true
      if (profile) set({ account: { ...EMPTY_ACCOUNT, ...profile } })
      keepKnown()
      await Promise.all([loadFolders(), loadDevices(), loadActivity(), loadStats(), loadPrefs()])
      void get().loadRemote()
      if (isHost) {
        void webSeen()
        webTimer ??= setInterval(() => void webSeen(), 60_000)
      }
    } catch (e) {
      get().toast(errorText(e), 'error')
    }
    if (get().libLoading) set({ libLoading: false })
    startPolling()
  }

  // Пока приложение на экране — забираем новое: треки с устройств, загрузки, устройства. На ПК раз в 4 с; на телефоне
  // каждый запрос будит радио — раз в 20 с (на «Синхронизации» — 5 с, при экономии заряда — минута), в фоне не ходим.
  // Устройства, загрузки и сводку телефон показывает только на Главной и «Синхронизации» — там и забираем
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let pollGen = 0
  let failures = 0
  const pollDelay = () => (isHost ? 4000 : get().power.saving ? 60_000 : get().view === 'sync' ? 5000 : 20_000)
  const poll = async () => {
    if (get().conn !== 'online' || !get().power.visible) return
    try {
      applyChanges(await api<Changes>(`/changes?since=${cursor}`))
      if (isHost || get().view === 'home' || get().view === 'sync') await Promise.all([loadDevices(), loadActivity(), loadStats()])
      failures = 0
      // дома ли мы теперь — раз в минуту (ноутбук мог прийти домой, а событие «сеть сменилась» не пришло)
      void recheckRoute(() => dev && applyChanges(dev.mirrorChanges()))
    } catch (e) {
      // сервер пропал (выключили контейнер, нет сети) — после пары неудач показываем экран «не отвечает»
      if (!(e instanceof ApiError) && ++failures >= 2) {
        stopPolling()
        // телефон без сети — не беда: остаётся библиотека с телефона, а сервер ищем дальше
        set({ conn: !isHost && get().tracks.length ? 'local' : 'offline' })
        retryLater()
      }
    }
  }
  const startPolling = () => {
    stopPolling()
    failures = 0
    const gen = pollGen
    const step = () => {
      pollTimer = setTimeout(async () => {
        await poll()
        if (gen === pollGen) step() // остановили или запустили заново, пока ждали ответа, — этот круг закончен
      }, pollDelay())
    }
    step()
  }
  const stopPolling = () => {
    pollGen++
    if (pollTimer) clearTimeout(pollTimer)
    pollTimer = null
  }

  // ---- экран и батарея ----
  // ручная синхронизация работает и при экономии: человек сам попросил
  let forcedUntil = 0
  const held = () => !isHost && Date.now() > forcedUntil && get().power.saving && !get().power.charging
  let hiddenAt = 0
  const onPower = (p: Power) => {
    const was = get().power
    if (!isHost && was.visible && !p.visible) hiddenAt = Date.now()
    if (!isHost && !was.visible && p.visible && get().hasPin && hiddenAt && Date.now() - hiddenAt > 30_000) set({ locked: true })
    const saving = savingOf(get().ui, p)
    set({ power: { ...p, saving } })
    applySaver(saving)
    if (p.visible && !was.visible) {
      // вернулись на экран: позицию — сразу (в фоне обновляли редко), новое с сервера — не дожидаясь круга
      if (audio) set({ position: audio.currentTime })
      if (pollTimer) reload()
      else if (!isHost && (get().conn === 'local' || get().conn === 'offline')) void get().initConn()
    }
    if (!isHost && was.saving && !held()) scheduleSync()
    if (!isHost && !was.charging && p.charging) scheduleSync()
  }
  watchPower(onPower, !isHost)
  applySaver(savingOf(loadUi(), currentPower()))
  // после неудачной операции — просто перечитываем всё изменившееся
  const reload = () => void poll()

  // ---- где лежит музыка: переносим скачанное туда, куда велят настройки ----
  const relocateNow = async (announce = false) => {
    const d = dev
    if (isHost || !d || !d.misplaced()) return
    const moved = await d.relocate(
      // играющий и тот, что сейчас уходит на сервер, не трогаем — перенесутся в следующий раз
      (id) => get().currentId === id || uploadingNow.has(id),
      (done, total) => set({ storage: { ...get().storage, moving: done < total ? { done, total } : null } }),
    )
    set({ storage: { ...get().storage, moving: null } })
    if (announce && moved) get().toast(t('store.moved', { n: moved }), 'ok')
  }

  // настройки места — в стор; общая папка — один раз спросим разрешение читать музыку (подхватить после переустановки)
  const loadStorage = (d: DeviceModule) => {
    set({ storage: { ...d.storagePrefs(), moving: null } })
    if (d.storageTarget() === 'shared' && !loadFlag('musich-asked-read')) {
      saveFlag('musich-asked-read', true)
      void d.requestRead()
    }
    // музыку оставили при удалении приложения — возвращаем в библиотеку, потом переносим, что не на месте
    void d
      .importKept(!!d.savedServer())
      .then((n) => {
        if (!n) return
        showOutbox()
        get().toast(t('store.found', { n }), 'ok')
      })
      .catch(() => {})
      .then(() => relocateNow())
  }

  // другой сервер — другая библиотека и другой вход; тот же сервер (тот же id) на новом адресе — переезд
  const switchServer = async (d: DeviceModule, url: string) => {
    const { hello } = await import('./lib/discovery')
    const same = !!d.savedNode() && (await hello(url, 4000))?.node === d.savedNode()
    if (same) await d.moveMirror(url)
    else if (url !== d.savedServer()) {
      setToken(null)
      d.saveDeviceId(null)
      setDeviceId(null)
      cursor = 0
      mirrorFresh = false
      set({ tracks: [], playlists: [], covers: {} })
    }
  }

  // Картинки — на телефон: свои обложки (альбомы, артисты, треки) и обложки скачанных треков, у которых её не было.
  // Их немного и они маленькие; без сети альбомы и треки остаются с картинками. Потом — пересобрать адреса из кэша
  const cacheImages = async (d: DeviceModule) => {
    let got = 0
    for (const c of d.mirrorChanges().covers) {
      if (c.deleted || paused() || held() || get().conn !== 'online') continue
      const key = `${coverKey(c.kind, c.key)}:${c.seq}`
      if (d.hasImage(key)) continue
      await d.cacheImage(key, mediaUrl(coverPath(c.kind, c.key), c.seq)).then(() => got++, () => {})
    }
    for (const id of Object.keys(d.localFiles())) {
      if (paused() || held() || get().conn !== 'online') break
      const st = d.mirrorTrack(id)
      if (st?.hasCover && !d.localFiles()[id]?.cover && (await d.fetchTrackCover(id, mediaUrl(`/tracks/${id}/cover`, st.seq)))) got++
    }
    if (got) applyChanges(d.mirrorChanges())
  }

  // ---- «Назад» на телефоне: откуда пришли ----
  // Ушли вглубь (альбом, артист, плейлист) — запоминаем, где были, вместе с тем, был ли открыт большой плеер:
  // «Назад» возвращает туда же (из альбома, открытого в плеере, — снова в плеер), а не на Главную.
  // Переход по нижнему меню — начало заново
  type NavPlace = { view: View; scope: Scope; playlistId: string | null; albumsTab: AlbumsTab; player: boolean }
  let navStack: NavPlace[] = []
  let playerClosedAt = 0
  const pushNav = () => {
    const s = get()
    const place: NavPlace = { view: s.view, scope: s.scope, playlistId: s.playlistId, albumsTab: s.albumsTab, player: s.fullPlayer || Date.now() - playerClosedAt < 800 }
    navStack = [...navStack.slice(-29), place]
  }

  // ---- телефон без сервера ----
  // Библиотека — свои файлы (Outbox) и скачанное раньше; лайки и плейлисты — из журнала. Сервер не ищем
  const enterStandalone = async (d: DeviceModule) => {
    stopPolling()
    const prof = d.loadProfile()
    set({ standalone: true, binding: false, account: { ...EMPTY_ACCOUNT, name: prof?.name ?? '', email: prof?.email ?? '', avatar: prof?.avatar } })
    if (!get().tracks.length) {
      const cached = await d.loadAnyMirror()
      await d.warmUp()
      loadStorage(d)
      // с прежнего сервера — только то, что лежит на телефоне: остальное без сервера не сыграть
      if (cached) applyChanges({ ...cached, tracks: cached.tracks.filter((x) => d.isLocal(x.id)) })
      showOutbox()
      keepKnown()
      updateSyncInfo()
    }
    refold()
    set({ conn: 'local' })
  }
  // сервер привязан и вход выполнен: если на телефоне было своё — спрашиваем «Объединить»
  const finishBinding = () => {
    if (isHost || !get().standalone) return
    const own = !!(dev?.outbox().length || journal.pending().length || dev?.loadProfile())
    saveFlag(MERGE_KEY, own)
    set({ standalone: false, binding: false, mergePending: own })
  }
  // забыть сервер: вход, устройство, адрес. Всё своё (файлы, журнал, скачанное) остаётся на телефоне
  const forgetServer = (d: DeviceModule) => {
    stopPolling()
    setToken(null)
    d.saveServer(null)
    d.saveDeviceId(null)
    setDeviceId(null)
    setApiBase('')
    cursor = 0
    mirrorFresh = false
    saveFlag(MERGE_KEY, false)
    set({ mergePending: false, tracks: [], playlists: [], covers: {}, devices: [], activity: [], incoming: [], stats: null })
  }

  // ---- телефон: связь с сервером и синхронизация файлов ----

  // нет сервера — пробуем снова раз в 15 секунд (и сразу, когда появится сеть)
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const retryLater = () => {
    if (isHost || retryTimer || get().standalone) return
    // в фоне сервер не ищем (поиск по сети будит радио) — проверим, когда вернутся на экран; при экономии — раз в минуту
    retryTimer = setTimeout(() => {
      retryTimer = null
      const c = get().conn
      if (c !== 'local' && c !== 'offline') return
      if (!get().power.visible) return retryLater()
      void get().initConn()
    }, get().power.saving ? 60_000 : 15_000)
  }

  // телефон — устройство на сервере: так видно, кто прислал трек и кто слушал
  const registerDevice = async () => {
    const d = await loadDevice()
    try {
      // постоянный номер и id с прошлого раза: сервер узнаёт телефон и не заводит копию (переустановка, новый вход)
      const known = d.savedDeviceId()
      const hwId = await d.hardwareId()
      const created = await api<ServerDevice>('/devices', {
        method: 'POST',
        body: { name: await d.deviceName(), kind: import.meta.env.VITE_PLATFORM === 'desktop' ? 'laptop' : 'phone', ...(hwId ? { hwId } : {}), ...(known ? { id: known } : {}) },
      })
      d.saveDeviceId(created.id)
      setDeviceId(created.id)
    } catch {
      /* без регистрации всё работает, просто устройство не подписано */
    }
  }
  // Что ждёт синхронизации — на экран телефона и (при отметке) на страницу сервера
  const updateSyncInfo = (done = false) => {
    if (!dev) return { up: 0, down: 0 }
    const up = dev.outbox().length
    const down = wantedIds().length
    const at = done && !up && !down ? Date.now() : get().syncInfo.at
    if (at && at !== get().syncInfo.at) {
      try {
        localStorage.setItem(LAST_SYNC_KEY, String(at))
      } catch {
        /* не запомним время — не страшно */
      }
    }
    set({ syncInfo: { ...get().syncInfo, up, down, at } })
    return { up, down }
  }
  // что устройство сообщает о себе — для «Экосистемы» на странице сервера: сколько треков, места, как ходит, что играет
  const selfInfo = async (): Promise<DeviceInfo> => {
    const s = get()
    const cur = s.currentId ? s.tracks.find((x) => x.id === s.currentId) : undefined
    const playing = s.playing && cur ? `${cur.artist} — ${cur.title}`.slice(0, 300) : undefined
    const base = { version: __APP_VERSION__, ...(playing ? { playing } : {}) }
    if (isHost || !dev) {
      let tracks: number | undefined
      try {
        tracks = (await (await caches.open('musich-audio-v1')).keys()).length // треки в памяти браузера (public/sw.js)
      } catch {
        /* без кэша (http, старый браузер) */
      }
      const home = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost$|127\.)|\.local$/.test(location.hostname)
      return { ...base, client: 'web', route: home ? 'home' : 'domain', ...(tracks !== undefined ? { tracks } : {}) }
    }
    const local = s.tracks.filter((x) => x.status === 'synced')
    const st = await dev.storageInfo().catch(() => null)
    const server = dev.savedServer() ?? ''
    return {
      ...base,
      client: 'app',
      tracks: local.length,
      bytes: Math.round(local.reduce((a, x) => a + x.sizeMb, 0) * 1048576),
      ...(st?.free && st.total ? { free: st.free, total: st.total } : {}),
      route: getApiBase() !== server ? 'home' : isDomainUrl(server) ? 'domain' : 'direct',
    }
  }
  const markSeen = async (done = false) => {
    const id = dev?.savedDeviceId()
    if (!id) return registerDevice()
    const { up, down } = updateSyncInfo(done)
    const info = await selfInfo()
    // устройство «забыли» на странице сервера — регистрируемся заново
    await api(`/devices/${id}/seen`, { method: 'POST', body: { pendingUp: up, pendingDown: down, synced: done && !up && !down, info } }).catch(async (e) => {
      if (e instanceof ApiError && e.status === 404) await registerDevice()
    })
  }

  // прогресс загрузки приходит десятки раз в секунду — список трогаем не чаще ~3 раз в секунду на трек
  const progressAt = new Map<string, number>()
  const refreshProgress = (id: string) => {
    const now = Date.now()
    if (now - (progressAt.get(id) ?? 0) < 330) return
    progressAt.set(id, now)
    useProgress.setState({ [id]: downloading.get(id) ?? uploadingNow.get(id) })
  }
  const refreshTrack = (id: string) => {
    useProgress.setState({ [id]: downloading.get(id) ?? uploadingNow.get(id) })
    set({
      tracks: get().tracks.map((t) =>
        t.id === id ? { ...t, status: statusOf(id), progress: downloading.get(id) ?? uploadingNow.get(id), cover: dev?.localCover(id) ?? t.cover } : t,
      ),
    })
  }

  // что держать на телефоне: всё (если включено) или избранное, плейлисты «держать на устройстве» и скачанное руками;
  // удалённое «только здесь» само не возвращаем
  const wantedIds = () => {
    const d = dev!
    const s = get()
    const want = new Set<string>()
    if (s.settings.autoDownload) for (const t of s.tracks) want.add(t.id)
    else {
      if (s.likedOffline) for (const t of s.tracks) if (t.liked) want.add(t.id)
      for (const p of s.playlists) if (p.keepOffline) for (const id of p.trackIds) want.add(id)
      // альбомы и артисты, отмеченные «Кэшировать»
      if (s.keepScopes.album.length || s.keepScopes.artist.length) {
        const albums = new Set(s.keepScopes.album)
        for (const t of s.tracks) if (albums.has(t.album) || s.keepScopes.artist.some((a) => hasArtist(t, a))) want.add(t.id)
      }
      for (const id of d.pinned()) want.add(id)
    }
    const ex = d.excluded()
    // скачанный трек, который на сервере прошили (другой отпечаток), качаем заново — id у него прежний
    const stale = (id: string) => d.isLocal(id) && d.localHash(id) !== (d.mirrorTrack(id)?.hash ?? id)
    return [...want].filter((id) => !ex.has(id) && (!d.isLocal(id) || stale(id)) && !!d.mirrorTrack(id))
  }

  let syncTimer: ReturnType<typeof setTimeout> | null = null
  let syncing = false
  let syncAgain = false
  // зеркало сверено с сервером в этом запуске — только тогда можно убирать с телефона треки, которых на сервере нет
  let mirrorFresh = false
  const paused = () => get().syncInfo.paused
  const scheduleSync = () => {
    if (isHost || syncTimer || paused()) return
    syncTimer = setTimeout(() => {
      syncTimer = null
      void runSync()
    }, 800)
  }
  onDispose(() => syncTimer && clearTimeout(syncTimer))

  const runSync = async () => {
    const d = dev
    if (!d || get().conn !== 'online' || paused() || get().standalone || get().mergePending) return
    if (syncing) {
      syncAgain = true
      return
    }
    syncing = true
    set({ syncInfo: { ...get().syncInfo, running: true } })
    let failed = 0
    let failedUp = 0
    try {
      // добавленное на телефоне — на сервер (при «только по Wi‑Fi» — только по Wi‑Fi)
      let sentUp = 0
      for (const item of foreignData() ? [] : d.outbox()) {
        if (rejectedUp.has(item.id)) continue
        if (paused() || held() || get().conn !== 'online' || !(await d.canDownload(get().settings.wifiOnly))) break
        uploadingNow.set(item.id, 0)
        refreshTrack(item.id)
        try {
          const st = await uploadTrack(await d.outboxFile(item), (p) => {
            uploadingNow.set(item.id, p)
            refreshProgress(item.id)
          })
          await d.settleOutbox(item, st)
          uploadingNow.delete(item.id)
          // у трека теперь серверный id: меняем его везде — в списке, очереди, «сейчас играет»
          applyRenamed([{ track: st, previousId: item.id }])
          sentUp++
        } catch (e) {
          uploadingNow.delete(item.id)
          if (e instanceof ApiError && e.status === 415) {
            // не аудио — такой файл сервер не примет никогда: снимаем с очереди и говорим почему
            await d.dropOutbox(item.id)
            set({ tracks: get().tracks.filter((x) => x.id !== item.id) })
            get().toast(t('toast.uploadFail', { name: item.name, msg: e.message }), 'error')
          } else if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401) {
            // не приняли сейчас (409, 413 от прокси, 429…) — файл остаётся на телефоне и играет, попробуем в следующий запуск.
            // Удалять нельзя: часто это единственная копия
            rejectedUp.add(item.id)
            refreshTrack(item.id)
            get().toast(t('toast.uploadFail', { name: item.name, msg: e.message }), 'error')
          } else {
            // связь оборвалась — остальное отправим в следующий раз
            failedUp++
            refreshTrack(item.id)
            break
          }
        }
      }
      if (sentUp) get().toast(t('dev.sentUp', { n: sentUp }), 'ok')
      const limit = get().settings.storageLimitGb
      if (limit) {
        const used = get().tracks.reduce((a, x) => a + (x.status === 'synced' ? x.sizeMb : 0), 0)
        const day = new Date().toISOString().slice(0, 10)
        if (used > limit * 1024 && localStorage.getItem('musich-space-warned') !== day) {
          localStorage.setItem('musich-space-warned', day)
          get().toast(t('space.over', { used: fmtSize(used), limit: fmtSize(limit * 1024) }))
        }
      }

      // прослушивания, накопленные без сети — после файлов: у отправленных треков id уже серверные.
      // Трек ещё не отправлен — ждём; сервер сказал «нет такого трека» (400/404) — пропускаем; сбой сервера — в следующий раз
      const plays = d.queuedPlays()
      let sent = 0
      for (const p of plays) {
        if (isPendingId(p.trackId)) break
        const ok = await api('/plays', { method: 'POST', body: { trackId: p.trackId, at: p.at } }).then(
          () => true,
          (e) => e instanceof ApiError && (e.status === 400 || e.status === 404),
        )
        if (!ok) break
        sent++
      }
      if (sent) d.clearPlays(sent)
      // лайки и плейлисты, сделанные без сервера, — следом за файлами (их id уже серверные)
      await pushJournal()

      // трека больше нет на сервере (удалили или переписали теги — у него новый id) — и на телефоне не держим
      if (mirrorFresh) {
        for (const id of Object.keys(d.localFiles())) {
          if (!tombs.has(id) || d.mirrorTrack(id)) continue
          await d.removeLocal(id, false)
          if (get().currentId === id && audio) delete audio.dataset.id
        }
      }

      // качаем по три трека сразу: по одному большая часть времени уходила на паузы между запросами.
      // Пропала сеть (или не Wi‑Fi при «только по Wi‑Fi») — все три потока останавливаются, остальное — в следующий раз
      const want = [...wantedIds()]
      let nextIdx = 0
      let stop = false
      const worker = async () => {
        while (!stop && nextIdx < want.length) {
          const id = want[nextIdx++]
          const st = d.mirrorTrack(id)
          if (!st) continue
          if (paused() || held() || get().conn !== 'online' || !(await d.canDownload(get().settings.wifiOnly))) {
            stop = true
            break
          }
          downloading.set(id, 0)
          refreshTrack(id)
          try {
            await d.downloadTrack(st, mediaUrl(`/tracks/${id}/file`), st.hasCover ? mediaUrl(`/tracks/${id}/cover`, st.seq) : undefined, (p) => {
              downloading.set(id, p)
              refreshProgress(id)
            })
          } catch {
            failed++
          } finally {
            downloading.delete(id)
            refreshTrack(id)
          }
        }
      }
      await Promise.all([worker(), worker(), worker()])
      await cacheImages(d)
      void relocateNow()
      if (failed) get().toast(t('dev.dlFailed', { n: failed }), 'error')
      if (failedUp) get().toast(t('dev.upLater'), 'error')
      await markSeen(!failed && !failedUp)
    } finally {
      syncing = false
      set({ syncInfo: { ...get().syncInfo, running: false } })
      if (syncAgain) {
        syncAgain = false
        scheduleSync()
      }
    }
  }

  const signedOut = (conn: Conn) => {
    stopPolling()
    setToken(null)
    set({
      conn,
      view: get().ui.start,
      tokens: [],
      tracks: [],
      playlists: [],
      covers: {},
      devices: [],
      activity: [],
      incoming: [],
      stats: null,
      prefs: DEFAULT_SERVER_PREFS,
      account: EMPTY_ACCOUNT,
      currentId: null,
      playing: false,
      me: null,
      users: [],
      viewAs: null,
      libLoading: false,
    })
    setViewAs(null)
    syncAudio()
  }
  onDispose(stopPolling)

  // ---- пользователи (docs/USERS.md) ----

  // кто вошёл и открыта ли регистрация — из /auth/status
  const applyStatus = (st: AuthStatus) => set({ me: st.authenticated ? (st.user ?? null) : null, registration: !!st.registration })
  // какой экран показать по ответу /auth/status. Владельцу без логина — «Придумайте логин», даже если он уже вошёл:
  // иначе после выхода ему будет нечем войти
  const connOf = (st: AuthStatus): Conn => {
    if (!st.setupDone) return 'setup'
    if (st.ownerNeedsLogin && (!st.authenticated || st.user?.role === 'owner')) return 'claim'
    return st.authenticated ? 'online' : 'login'
  }
  // вход удался: токен, кто мы, устройство (телефон), библиотека
  const finishAuth = async (r: AuthResult) => {
    setToken(r.token)
    if (r.user) set({ me: r.user })
    else {
      const st = await probe()
      if (st) applyStatus(st)
    }
    if (!isHost) await registerDevice()
    set({ conn: 'online' })
    await loadAll()
    finishBinding()
  }

  // Просмотр чужой библиотеки — только чтение: правка останавливается тостом (сервер на не-GET с X-Musich-As и так ответит 403)
  const readOnly = () => {
    if (!get().viewAs) return false
    get().toast(t('viewAs.readOnly'))
    return true
  }
  // свой плеер (что играло, очередь) — на время просмотра откладываем и потом возвращаем
  let ownPlayer: SavedPlayer | null = null
  const switchLibrary = async (who: { id: string; name: string } | null) => {
    stopPolling()
    if (who && !get().viewAs) ownPlayer = Object.fromEntries(PLAYER_FIELDS.map((k) => [k, get()[k]])) as SavedPlayer
    setViewAs(who?.id ?? null)
    set({
      viewAs: who,
      playing: false,
      currentId: null,
      position: 0,
      queue: null,
      upNext: [],
      history: [],
      shuffleOrder: null,
      plays: null,
      selected: [],
      scope: null,
      remote: [],
      remoteList: null,
      view: 'home',
    })
    syncAudio()
    pending.clear()
    cursor = 0
    await loadAll()
    if (!who && ownPlayer) {
      set({ ...ownPlayer, playing: false })
      ownPlayer = null
      keepKnown()
    }
  }

  // Переключение трека: прошлый уходит в историю «Играло»
  // длинный трек, который не дослушали, — с того места, где остановились
  const resumeFrom = (id: string) => {
    const min = get().settings.resumeMin
    const t = get().tracks.find((x) => x.id === id)
    return min && t && t.duration >= min * 60 ? (resumeMap[id] ?? 0) : 0
  }

  const goto = (id: string) => {
    const { currentId, history } = get()
    set({
      currentId: id,
      position: resumeFrom(id),
      history: currentId && currentId !== id ? [...history.slice(-19), currentId] : history,
    })
    syncAudio()
  }

  // Радио: очередь кончилась — дальше похожее из библиотеки (чаще тот же артист), без недавно игравшего
  let radio = false
  const radioPick = (): string | null => {
    const s = get()
    const cur = s.tracks.find((t) => t.id === s.currentId)
    const recent = new Set([...s.history, s.currentId])
    const offline = !isHost && s.conn !== 'online'
    const pool = s.tracks.filter((t) => !recent.has(t.id) && (!offline || dev?.isLocal(t.id)))
    if (!pool.length) return null
    const names = new Set(cur ? artistsOf(cur.artist).map((a) => a.toLowerCase()) : [])
    const same = pool.filter((t) => artistsOf(t.artist).some((a) => names.has(a.toLowerCase())))
    const from = same.length && Math.random() < 0.6 ? same : pool
    return from[Math.floor(Math.random() * from.length)].id
  }

  // Что играть дальше: сначала ручная очередь, потом основной порядок.
  // auto — трек доиграл сам: в конце очереди — как в настройках (остановиться, сначала, радио); null — стоп
  const pickNext = (auto: boolean): string | null => {
    const [first, ...rest] = get().upNext.filter((id) => id !== get().currentId)
    if (first) {
      set({ upNext: rest })
      return first
    }
    const ids = order()
    if (!ids.length) return null
    const i = ids.indexOf(get().currentId ?? '')
    if (auto && (i === ids.length - 1 || (i === -1 && radio))) {
      const mode = get().settings.queueEnd
      if (mode === 'stop') return null
      if (mode === 'radio') {
        const r = radioPick()
        if (r) {
          radio = true
          return r
        }
      }
    }
    return ids[(i + 1) % ids.length]
  }

  // Кроссфейд: за N секунд до конца следующий трек стартует в соседнем <audio>, а этот доигрывает и затихает
  let crossTried = ''
  const crossfade = () => {
    const s = get()
    const cf = s.settings.crossfade
    if (!audio || !cf || !s.playing || s.repeat || s.sleepEndOfTrack || s.sleepAt || crossTried === s.currentId) return
    crossTried = s.currentId ?? ''
    const id = pickNext(true)
    if (!id || id === s.currentId) return
    const old = audio
    audio = players.find((p) => p !== old) ?? old
    startTail(old, (old.duration - old.currentTime) * 1000)
    startFadeIn(cf * 1000)
    goto(id)
  }

  return {
    lang: initialLang,
    account: EMPTY_ACCOUNT,
    // профиль владельца живёт на сервере; avatar: undefined — убрать фото
    saveAccount: (patch) => {
      if (readOnly()) return
      const before = get().account
      set({ account: { ...before, ...patch } })
      // без сервера профиль — свой, на телефоне
      if (!isHost && get().standalone) {
        const a = get().account
        dev?.saveProfile({ name: a.name, email: a.email, avatar: a.avatar })
        return
      }
      const body = 'avatar' in patch ? { ...patch, avatar: patch.avatar ?? null } : patch
      api<Profile>('/profile', { method: 'PUT', body })
        .then((p) => set({ account: { ...EMPTY_ACCOUNT, ...p } }))
        .catch((e) => {
          set({ account: before })
          get().toast(errorText(e), 'error')
        })
    },
    setLang: (lang) => {
      try { localStorage.setItem('tunich-lang', lang) } catch { /* не запомним — не страшно */ }
      // словарь языка грузится по требованию; потом модульный язык (им пользуются t() и форматирование), потом перерисовка
      void loadLang(lang).then(() => {
        setCurrentLang(lang)
        set({ lang })
      })
    },
    tracks: [],
    playlists: [],
    view: initialUi.start,
    ui: initialUi,
    setUi: (patch) => {
      const ui = {
        ...get().ui,
        ...patch,
        cols: { ...get().ui.cols, ...patch.cols },
        hidden: { ...get().ui.hidden, ...patch.hidden }
      }
      set({ ui })
      applyUi(ui)
      if (patch.saver) {
        const saving = savingOf(ui, get().power)
        set({ power: { ...get().power, saving } })
        applySaver(saving)
      }
      try {
        localStorage.setItem(UI_KEY, JSON.stringify(ui))
      } catch (e) {
        console.warn('[UI] Failed to save UI prefs:', e)
      }
    },
    filter: 'all',
    scope: null,
    query: '',
    theme: initialTheme(),
    ...loadLook(),
    radius: loadRadius(),
    settings: {
      autoDownload: !isHost && loadKeep().autoDownload,
      storageLimitGb: loadKeep().limitGb ?? 0,
      wifiOnly: isHost || loadKeep().wifiOnly,
      askOnDelete: !loadFlag('musich-no-ask-delete'),
      // воспроизведение (в т.ч. эквалайзер и качество) — как в прошлый раз в этом браузере
      ...loadPlayback(),
    },
    albumsTab: 'albums',
    playlistId: null,
    remote: [],
    remoteList: null,
    loadRemote: async () => {
      try {
        const load = async () => {
          const st = await api<IntegrationStatus[]>('/integrations')
          const live = st.filter((x) => x.connected && x.syncedAt)
          const remote = await Promise.all(
            live.map(async (x) => ({ service: x.service, syncedAt: x.syncedAt!, canSync: !!x.canSync, data: await api<CompareResult>(`/integrations/${x.service}/compare`) })),
          )
          set({ remote })
          return live
        }
        const live = await load()
        // лайкнул в сервисе что-то новое — список старше получаса забираем заново сами (присланный вручную VK — не трогаем)
        const stale = live.filter((x) => x.canSync && !remoteSyncing.has(x.service) && Date.now() - Date.parse(x.syncedAt!) > 30 * 60_000)
        if (!stale.length) return
        stale.forEach((x) => remoteSyncing.add(x.service))
        await Promise.allSettled(stale.map((x) => api(`/integrations/${x.service}/sync`, { method: 'POST' }))).finally(() =>
          stale.forEach((x) => remoteSyncing.delete(x.service)),
        )
        await load()
      } catch {
        /* интеграции — не главное: без них просто нет раздела в сайдбаре */
      }
    },
    syncRemote: async (service) => {
      remoteSyncing.add(service)
      try {
        await api(`/integrations/${service}/sync`, { method: 'POST' })
      } finally {
        remoteSyncing.delete(service)
      }
      await get().loadRemote()
    },
    openRemoteList: (service, list) => set({ view: 'remote', remoteList: { service, list }, scope: null, selected: [] }),

    currentId: null,
    queue: null,
    queueName: '', // пусто = «Все треки» на языке интерфейса
    upNext: [],
    history: [],
    fullPlayer: false,
    phoneQueue: false,
    lyricsOpen: false,
    probing: false,
    searchOpen: false,
    trackInfoId: null,
    playing: false, // после перезагрузки сами не играем — браузер всё равно не даст без клика
    position: 0,
    volume: 70,
    shuffle: false,
    shuffleOrder: null,
    repeat: false,
    ...savedPlayer,
    sleepAt: null,
    sleepEndOfTrack: false,

    likedOffline: isHost || loadKeep().liked,
    keepScopes: { album: loadKeep().albums, artist: loadKeep().artists },
    setKeepScope: (type, value, v) => {
      const cur = get().keepScopes[type].filter((x) => x !== value)
      const next = { ...get().keepScopes, [type]: v ? [...cur, value] : cur }
      set({ keepScopes: next })
      saveKeep({ albums: next.album, artists: next.artist })
      if (v) scheduleSync()
    },
    covers: {},
    coverEdit: null,

    selected: [],
    pickerIds: null,
    playlistEditor: null,
    playlistDeleteId: null,
    deleteId: null,
    plays: null,
    renameId: null,
    syncInfo: { up: 0, down: 0, running: false, at: loadLastSync(), paused: !isHost && loadKeep().paused, checking: false },
    artistRename: null,
    uploadOpen: false,
    toasts: [],
    activity: [],
    incoming: [],
    devices: [],
    stats: null,
    prefs: DEFAULT_SERVER_PREFS,
    historyPaused: loadFlag('musich-history-paused'),
    storage: { folder: 'default', keep: true, moving: null },
    setStorage: async (patch) => {
      const d = await loadDevice()
      const prev = d.storagePrefs()
      const next = { ...prev, ...patch }
      // своя папка — сначала выбрать её в системном окне; передумали — всё как было
      if (patch.folder === 'custom') {
        const picked = await d.pickFolder().catch(() => ({}) as { uri?: string; name?: string })
        if (!picked.uri) return
        next.tree = { uri: picked.uri, name: picked.name ?? picked.uri }
      }
      d.saveStoragePrefs(next)
      set({ storage: { ...next, moving: get().storage.moving } })
      // общая папка: попросим читать музыку — без этого после переустановки оставленные файлы не подхватятся
      if (d.storageTarget(next) === 'shared') void d.requestRead()
      void relocateNow(true)
    },
    power: { ...currentPower(), saving: savingOf(loadUi(), currentPower()) },
    rescanning: false,
    musicFolders: [],
    conn: 'checking',
    standalone: false,
    binding: false,
    mergePending: !isHost && loadFlag(MERGE_KEY),
    locked: !isHost && pinCode.hasPin(),
    hasPin: !isHost && pinCode.hasPin(),
    unlock: async (pin) => {
      const ok = await pinCode.checkPin(pin)
      if (ok) set({ locked: false })
      return ok
    },
    setPinCode: async (pin) => {
      if (pin) await pinCode.setPin(pin)
      else pinCode.clearPin()
      set({ hasPin: !!pin, locked: false })
    },
    tokens: [],
    me: null,
    registration: false,
    users: [],
    viewAs: null,
    // открыли страницу со входом — библиотека сейчас придёт с сервера (на телефоне она открывается из кэша)
    libLoading: isHost && !!getToken(),

    initConn: async () => {
      // библиотека с телефона уже на экране — проверяем сервер, не пряча её
      if (isHost ? get().conn !== 'offline' : get().conn !== 'local' && get().conn !== 'offline') set({ conn: 'checking' })
      if (!isHost) {
        const d = await loadDevice()
        // кнопки шторки и наушников, «Назад», «Поделиться», сеть — один раз и ДО проверки сервера: раньше это стояло
        // после «сервер ещё не выбран» и на свежей установке так и не включалось (в шторке не было кнопок)
        if (!nativeHooked) {
          nativeHooked = true
          // кнопки шторки, экрана блокировки и наушников
          void d.onMediaButtons({
            play: () => !get().playing && get().toggle(),
            pause: () => get().playing && get().toggle(),
            next: () => get().next(),
            prev: () => get().prev(),
            seek: (sec) => get().seek(sec),
          })
          // «Назад»: окна → большой плеер → альбом/артист → главная; на главной приложение сворачивается
          d.onBackButton(() => {
            const s = get()
            const dialogs = ['deleteId', 'renameId', 'artistRename', 'trackInfoId', 'pickerIds', 'playlistEditor', 'playlistDeleteId', 'coverEdit'] as const
            const open = dialogs.find((k) => s[k] !== null)
            if (open) set({ [open]: null } as Partial<State>)
            else if (s.selected.length) set({ selected: [] })
            else if (s.lyricsOpen) set({ lyricsOpen: false })
            else if (s.phoneQueue) set({ phoneQueue: false })
            else if (s.searchOpen) set({ searchOpen: false })
            else if (s.uploadOpen) set({ uploadOpen: false })
            else if (s.fullPlayer) set({ fullPlayer: false })
            else if (navStack.length) {
              const p = navStack.pop()!
              set({ view: p.view, scope: p.scope, playlistId: p.playlistId, albumsTab: p.albumsTab, selected: [], fullPlayer: p.player })
            } else if (s.scope) set({ scope: null, view: s.scope.type === 'album' ? 'albums' : 'artists' })
            else if (s.view !== 'home') set({ view: 'home' })
            else return false
            return true
          })
          // «Поделиться → MUSICH» из Telegram, браузера, файлового менеджера
          void d.onShare((files) => void addToPhone(files.map((f) => () => d.addSharedToOutbox(f.uri, f.name))))
          void d.onWifi().then((w) => (onCellular = !w))
          d.onNetworkChange((connected) => {
            void d.onWifi().then((w) => (onCellular = connected && !w))
            const c = get().conn
            if (connected && (c === 'local' || c === 'offline')) return void get().initConn()
            const server = d.savedServer()
            if (connected && c === 'online' && server)
              void pickRoute(d, server).then((route) => {
                if (route === getApiBase()) return
                setApiBase(route)
                applyChanges(d.mirrorChanges())
              })
          })
        }
        const server = d.savedServer()
        // сервера нет: есть свой профиль — работаем без него, нет — первый запуск
        if (!server) return d.loadProfile() ? enterStandalone(d) : set({ conn: 'connect' })
        setApiBase(server)
        // дома — напрямую по домашней сети, вне дома — по домену
        const route = await pickRoute(d, server)
        if (route !== server) setApiBase(route)
        setDeviceId(d.savedDeviceId())
        // библиотека и скачанное — сразу, ещё до ответа сервера
        if (!get().tracks.length) {
          const cached = await d.loadMirror(server)
          await d.warmUp()
          loadStorage(d)
          if (cached) {
            applyChanges(cached)
            keepKnown()
          }
          showOutbox()
          updateSyncInfo()
        }
        // библиотека из кэша уже есть — показываем её сразу, а сервер ищем в фоне (раньше до 12 с пустого экрана вне дома).
        // Значок «не в сети» пока не показываем: проверка ещё идёт (probing)
        if (get().tracks.length && get().conn === 'checking') set({ conn: 'local', probing: true })
      }
      let st = await probe()
      // телефон: по старому адресу тишина — ищем свой сервер в сети (роутер мог выдать ПК другой адрес)
      if (!st && !isHost && (await rediscover(await loadDevice()))) st = await probe()
      if (!st) {
        retryLater()
        return set({ conn: !isHost && get().tracks.length ? 'local' : 'offline', probing: false })
      }
      // домашние адреса сервера узнаём только сейчас — и сразу пробуем ходить по ним
      if (!isHost) void loadDevice().then(rememberNode).then(() => recheckRoute(() => dev && applyChanges(dev.mirrorChanges()), true))
      applyStatus(st)
      const next = connOf(st)
      if (next !== 'online') {
        if (!st.authenticated) setToken(null)
        return set({ conn: next, probing: false })
      }
      set({ conn: 'online', probing: false })
      await loadAll()
      finishBinding()
    },
    codeSubmit: async (code) => {
      try {
        // токен — того пользователя, кто создал код; кто это, скажет /auth/status
        const { key } = await api<{ key: string }>('/sync/pair', { method: 'POST', body: { code, name: browserName() } })
        await finishAuth({ token: key })
        return null
      } catch (e) {
        if (!(e instanceof ApiError)) return t('auth.offline')
        if (e.status === 401) return t('auth.codeWrong')
        return e.message
      }
    },
    authSubmit: async (form) => {
      let r: AuthResult
      try {
        r = await api<AuthResult>(AUTH_PATH[form.mode], { method: 'POST', body: authBody(form) })
      } catch (e) {
        // пока мы смотрели на «первый запуск», владельца создали из другого браузера — теперь только вход
        if (form.mode === 'setup' && e instanceof ApiError && e.status === 409) set({ conn: 'login' })
        // регистрацию успели закрыть — ссылку «Регистрация» убираем
        if (e instanceof ApiError && e.code === 'registration_closed') set({ registration: false })
        return authError(e, form.mode)
      }
      await finishAuth(r)
      // имя — в профиль, если сервер взял его только подписью входа
      const nm = form.name?.trim()
      if (nm && get().conn === 'online' && get().account.name !== nm) get().saveAccount({ name: nm })
      return null
    },
    connectServer: async (raw) => {
      const d = await loadDevice()
      const url = d.normalizeServer(raw)
      if (!url) return t('dev.badAddress')
      const before = getApiBase()
      setApiBase(url)
      if (!(await probe())) {
        setApiBase(before)
        return t('dev.noAnswer')
      }
      await switchServer(d, url)
      d.saveServer(url)
      await get().initConn()
      return null
    },
    // Адрес из формы: с http(s) — как есть; домен без него — сначала https (сервер за доменом обычно с сертификатом),
    // IP и localhost — http. Отвечает — что это за сервер: новый (пароля ещё нет) или уже настроенный
    checkServer: async (raw) => {
      const d = await loadDevice()
      const plain = raw.trim().replace(/\/+$/, '').replace(/\/api$/, '')
      if (!plain) return null
      const host = plain.replace(/^https?:\/\//i, '').split(/[/:]/)[0]
      const ipOrLocal = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host === 'localhost' || !host.includes('.')
      const tries = /^https?:\/\//i.test(plain) ? [plain] : ipOrLocal ? [d.normalizeServer(plain)] : [`https://${plain}`, `http://${plain}`]
      const before = getApiBase()
      try {
        for (const url of tries) {
          setApiBase(url)
          const st = await probe()
          if (st) return { url, setupDone: st.setupDone, registration: !!st.registration, ownerNeedsLogin: !!st.ownerNeedsLogin }
        }
        return null
      } finally {
        setApiBase(before)
      }
    },
    // Всё сразу: адрес, логин и пароль (новый сервер — создаём владельца), имя в профиль. Ошибка — текстом для формы
    // Телефон: сервер и код подключения в одном окне — без второго экрана входа
    pairServer: async (raw, code) => {
      const d = await loadDevice()
      const found = await get().checkServer(raw)
      if (!found) return t('dev.noAnswer')
      const before = getApiBase()
      setApiBase(found.url)
      let key: string
      try {
        ;({ key } = await api<{ key: string }>('/sync/pair', { method: 'POST', body: { code, name: browserName() } }))
      } catch (e) {
        setApiBase(before)
        if (!(e instanceof ApiError)) return t('auth.offline')
        if (e.status === 401) return t('auth.codeWrong')
        return e.message
      }
      await switchServer(d, found.url)
      setToken(key)
      d.saveServer(found.url)
      await get().initConn()
      return null
    },
    signInServer: async (raw, form) => {
      const d = await loadDevice()
      const found = await get().checkServer(raw)
      if (!found) return t('dev.noAnswer')
      // сервер успели настроить или сбросить, пока заполняли форму: новый — только создание владельца
      const mode: AuthMode = !found.setupDone ? 'setup' : form.mode === 'setup' ? 'login' : form.mode
      const before = getApiBase()
      setApiBase(found.url)
      let r: AuthResult
      try {
        r = await api<AuthResult>(AUTH_PATH[mode], { method: 'POST', body: authBody({ ...form, mode }) })
      } catch (e) {
        setApiBase(before)
        return authError(e, mode)
      }
      await switchServer(d, found.url)
      setToken(r.token)
      if (r.user) set({ me: r.user })
      d.saveServer(found.url)
      await get().initConn()
      // имя — в профиль: при создании аккаунта всегда, при входе — если там его ещё нет (при объединении спросит окно)
      const nm = form.name?.trim()
      if (nm && get().conn === 'online' && !get().mergePending && get().account.name !== nm && (mode === 'setup' || mode === 'register' || !get().account.name))
        get().saveAccount({ name: nm })
      return null
    },
    openProfileSetup: () => set({ conn: 'profile' }),
    backToConnect: () => set({ conn: 'connect' }),
    startStandalone: async (name) => {
      const d = await loadDevice()
      // пришли сюда из «Изменить» (сервер был привязан) — отвязываем: иначе после перезапуска он подключился бы снова
      if (d.savedServer()) forgetServer(d)
      d.saveProfile({ name: name.trim() })
      await enterStandalone(d)
    },
    // из автономного режима — к экрану подключения; там и на входе есть «Назад»
    startBinding: () => {
      stopPolling()
      set({ binding: true, conn: 'connect' })
    },
    cancelBinding: async () => {
      const d = await loadDevice()
      forgetServer(d)
      await enterStandalone(d)
    },
    // «Отвязать»: телефон снова сам по себе; имя и фото — с сервера в свой профиль
    unbindServer: async () => {
      const d = await loadDevice()
      const a = get().account
      if (!d.loadProfile()) d.saveProfile({ name: a.name || t('dev.me'), email: a.email, avatar: a.avatar })
      forgetServer(d)
      await enterStandalone(d)
    },
    // «Объединить»: имя (если выбрали с телефона), плейлисты с тем же именем — в один, дальше обычная синхронизация
    confirmMerge: async (useLocalName) => {
      const d = await loadDevice()
      const prof = d.loadProfile()
      if (useLocalName && prof) get().saveAccount({ name: prof.name, ...(prof.avatar ? { avatar: prof.avatar } : {}) })
      const norm = (x: string) => x.trim().toLocaleLowerCase()
      const created = new Set(journal.pending().filter((e) => e.type === 'playlist.create').map((e) => e.key))
      const onServer = new Map(get().playlists.filter((p) => !created.has(p.id)).map((p) => [norm(p.name), p.id]))
      const merged = new Set<string>()
      for (const e of journal.pending()) {
        if (e.type !== 'playlist.create') continue
        const sid = onServer.get(norm(String((e.value as { name?: string } | undefined)?.name ?? '')))
        if (!sid) continue
        journal.mergePlaylist(e.key, sid)
        merged.add(e.key)
      }
      d.clearProfile()
      saveFlag(MERGE_KEY, false)
      set({ mergePending: false, playlists: get().playlists.filter((p) => !merged.has(p.id)) })
      refold()
      scheduleSync()
      get().toast(t('merge.done'), 'ok')
    },
    cancelMerge: async () => {
      const d = await loadDevice()
      forgetServer(d)
      await enterStandalone(d)
    },
    changeServer: () => {
      stopPolling()
      set({ conn: 'connect' })
    },
    logout: async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => {})
      signedOut('login')
    },
    changePassword: async (current, password) => {
      try {
        await api('/auth/password', { method: 'PUT', body: { current, password } })
        get().toast(t('acc.passDone'), 'ok')
        return true
      } catch (e) {
        get().toast(e instanceof ApiError && e.status === 403 ? t('acc.passWrong') : errorText(e), 'error')
        return false
      }
    },
    loadTokens: async () => {
      try {
        set({ tokens: await api<TokenInfo[]>('/tokens') })
      } catch (e) {
        get().toast(errorText(e), 'error')
      }
    },
    createToken: async (name) => {
      if (readOnly()) return null
      try {
        const created = await api<TokenInfo & { token: string }>('/tokens', { method: 'POST', body: { name } })
        await get().loadTokens()
        return created
      } catch (e) {
        get().toast(errorText(e), 'error')
        return null
      }
    },
    revokeToken: async (id) => {
      if (readOnly()) return
      try {
        await api(`/tokens/${id}`, { method: 'DELETE' })
        get().toast(t('acc.revoked'))
        await get().loadTokens()
      } catch (e) {
        get().toast(errorText(e), 'error')
      }
    },

    setView: (view) => {
      navStack = []
      set({ view, scope: null, selected: [] })
      if (!isHost && (view === 'home' || view === 'sync')) reload()
    },
    setFilter: (filter) => set({ filter }),
    openScope: (scope) => {
      pushNav()
      set({ scope, view: 'library', filter: 'all', selected: [] })
    },
    setQuery: (query) => set({ query }),
    setTheme: (theme) => {
      try { localStorage.setItem('tunich-theme', theme) } catch { /* без памяти — не страшно */ }
      set({ theme })
    },
    setPalette: (palette) => {
      saveLook(palette, get().accent)
      set({ palette })
    },
    setAccent: (accent) => {
      saveLook(get().palette, accent)
      set({ accent })
    },
    setSel: (sel) => {
      saveColor('sel', sel)
      set({ sel })
    },
    setBlocks: (blocks) => {
      saveColor('blocks', blocks)
      set({ blocks })
    },
    saveCustomTheme: (theme) => {
      const list = get().customThemes
      const customThemes = list.some((x) => x.id === theme.id) ? list.map((x) => (x.id === theme.id ? theme : x)) : [...list, theme]
      // своя тема приходит со своим акцентом — общий акцент сбрасываем на «как в теме»
      saveLook(theme.id, null, customThemes)
      set({ customThemes, palette: theme.id, accent: null })
    },
    setRadius: (radius) => {
      saveRadius(radius)
      set({ radius })
    },
    deleteCustomTheme: (id) => {
      const customThemes = get().customThemes.filter((x) => x.id !== id)
      const palette = get().palette === id ? 'nothing' : get().palette
      saveLook(palette, get().accent, customThemes)
      set({ customThemes, palette })
    },
    setSetting: (k, v) => {
      set({ settings: { ...get().settings, [k]: v } })
      if (k === 'askOnDelete') saveFlag('musich-no-ask-delete', !v)
      if ((PLAYBACK_FIELDS as readonly string[]).includes(k)) savePlayback(get().settings)
      if (k === 'normalize') applyVolume()
      if (!isHost && k === 'storageLimitGb') saveKeep({ limitGb: v as number })
      if (!isHost && (k === 'autoDownload' || k === 'wifiOnly')) {
        saveKeep({ [k]: v })
        scheduleSync()
      }
    },
    setAlbumsTab: (albumsTab) => set({ albumsTab }),
    openPlaylist: (playlistId) => {
      pushNav()
      set({ view: 'playlist', playlistId, scope: null, selected: [] })
    },

    startRadio: async (seed) => {
      if (get().plays === null) await get().loadPlays().catch(() => {})
      const { radioQueue } = await import('./lib/radio')
      const ids = radioQueue(get().tracks, get().plays ?? [], seed)
      if (!ids.length) return
      const name = seed.artist ?? get().tracks.find((x) => x.id === seed.trackId)?.title ?? ''
      get().play(ids[0], ids, t('radio.name', { name }))
    },
    play: (id, queue = null, queueName = '') => {
      radio = false
      const s = get()
      // тот же список (клик в очереди) — порядок не трогаем; другой при «случайно» — перемешиваем заново
      const sameList = JSON.stringify(queue) === JSON.stringify(s.queue)
      set({
        queue,
        queueName,
        ...(s.shuffle && !sameList ? { shuffleOrder: shuffled(playOrder({ ...s, queue, shuffle: false }), id) } : {}),
      })
      if (get().currentId === id) {
        set({ playing: !get().playing })
        return syncAudio()
      }
      set({ playing: true, upNext: get().upNext.filter((x) => x !== id) })
      goto(id)
    },
    toggle: () => {
      if (!get().currentId) return
      set({ playing: !get().playing })
      syncAudio()
    },
    next: () => {
      const id = pickNext(false)
      if (id) goto(id)
    },
    prev: () => {
      if (livePosition() > 3) return get().seek(0)
      get().prevTrack()
    },
    prevTrack: () => {
      const ids = order()
      const i = ids.indexOf(get().currentId ?? '')
      const before = get().history[get().history.length - 1]
      if (i <= 0 && before) return goto(before)
      goto(ids[(i - 1 + ids.length) % ids.length])
    },
    playNext: (id) => {
      set({ upNext: [id, ...get().upNext.filter((x) => x !== id)] })
      get().toast(t('toast.playNext'))
    },
    addToQueue: (id) => {
      set({ upNext: [...get().upNext.filter((x) => x !== id), id] })
      get().toast(t('toast.queueEnd'))
    },
    removeFromQueue: (id) => {
      const s = get()
      // из ручной очереди — просто убрать; из основного порядка — закрепляем порядок уже без этого трека
      if (s.upNext.includes(id)) return set({ upNext: s.upNext.filter((x) => x !== id) })
      set({
        queue: playOrder({ ...s, shuffle: false }).filter((x) => x !== id),
        shuffleOrder: s.shuffleOrder?.filter((x) => x !== id) ?? null,
      })
    },
    moveInQueue: (from, to) => {
      const s = get()
      const list = upcoming(s, Infinity)
      if (from === to || !list[from] || to < 0 || to >= list.length) return
      const [id] = list.splice(from, 1)
      list.splice(to, 0, id)
      // переставленный список — теперь и есть порядок: сначала играющий, за ним всё в новом порядке
      const order = s.currentId ? [s.currentId, ...list] : list
      set({ queue: order, upNext: [], ...(s.shuffle ? { shuffleOrder: order } : {}) })
    },
    setFullPlayer: (fullPlayer) => {
      if (!fullPlayer && get().fullPlayer) playerClosedAt = Date.now() // сразу за этим часто идут «к альбому/артисту»
      set(fullPlayer ? { fullPlayer } : { fullPlayer, phoneQueue: false })
    },
    setPhoneQueue: (phoneQueue) => set({ phoneQueue }),
    setLyricsOpen: (lyricsOpen) => set({ lyricsOpen }),
    setSearchOpen: (searchOpen) => set({ searchOpen }),
    showTrackInfo: (trackInfoId) => set({ trackInfoId }),
    seek: (position) => {
      set({ position })
      if (audio?.dataset.id && audio.dataset.id === get().currentId) audio.currentTime = position
    },
    setVolume: (volume) => {
      set({ volume })
      applyVolume()
    },
    // включили — перемешиваем один раз, играющий трек первым; выключили — дальше по обычному порядку
    toggleShuffle: () => {
      const s = get()
      set(s.shuffle ? { shuffle: false, shuffleOrder: null } : { shuffle: true, shuffleOrder: shuffled(playOrder(s), s.currentId) })
    },
    toggleRepeat: () => set({ repeat: !get().repeat }),
    setSleep: (v) => {
      sleepFade = 1
      applyVolume()
      if (v === null) {
        set({ sleepAt: null, sleepEndOfTrack: false })
        return get().toast(t('toast.sleepOff'))
      }
      if (v === 'track') {
        set({ sleepAt: null, sleepEndOfTrack: true })
        return get().toast(t('toast.sleepAfterTrack'))
      }
      set({ sleepAt: Date.now() + v * 60_000, sleepEndOfTrack: false })
      get().toast(t('toast.sleepIn', { n: v }))
    },
    setEq: (on) => {
      set({ settings: { ...get().settings, eq: on } })
      savePlayback(get().settings)
      if (on) ensureEq()
      applyEq()
    },
    setEqGains: (gains) => {
      set({ settings: { ...get().settings, eqGains: gains } })
      savePlayback(get().settings)
      applyEq()
    },
    toggleLike: (id) => {
      const t = get().tracks.find((x) => x.id === id)
      if (!t) return
      setLiked([id], !t.liked)
    },

    toggleSelect: (id) => {
      const sel = get().selected
      set({ selected: sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id] })
    },
    clearSelection: () => set({ selected: [] }),

    openCoverEdit: (coverEdit) => {
      if (coverEdit && readOnly()) return
      set({ coverEdit })
    },
    // Своя картинка трека, альбома или артиста — на сервер; url — data:-url из редактора или null (сбросить)
    setCover: async (key, url) => {
      if (readOnly()) return set({ coverEdit: null })
      if (key.startsWith('track:') && notSentYet([key.slice(6)])) return set({ coverEdit: null })
      const i = key.indexOf(':')
      const kind = key.slice(0, i)
      const name = key.slice(i + 1)
      set({ coverEdit: null })
      try {
        if (url) await api(coverPath(kind, name), { method: 'PUT', blob: await dataUrlBlob(url) })
        else await api(coverPath(kind, name), { method: 'DELETE' })
        const covers = { ...get().covers }
        if (url) covers[key] = mediaUrl(coverPath(kind, name), Date.now())
        else delete covers[key]
        set({ covers })
        get().toast(url ? t('toast.coverUpdated') : t('toast.coverReset'))
        reload() // у треков сменится hasCover
        // картинки «вшивать в файлы»: новая обложка альбома сразу уходит во все его треки
        if (url && kind === 'album' && get().prefs.coverMode === 'file') await get().embedAlbumCover(name)
      } catch (e) {
        get().toast(errorText(e), 'error')
      }
    },

    openPicker: (pickerIds) => {
      if (pickerIds && readOnly()) return
      // на телефоне плейлисты принимают и ещё не отправленные треки — журнал переименует их после отправки
      if (pickerIds && isHost && notSentYet(pickerIds)) return
      set({ pickerIds })
    },
    openPlaylistEditor: (playlistEditor) => {
      if (playlistEditor && readOnly()) return
      set({ playlistEditor, pickerIds: null })
    },
    // coverUrl: data:-url — новая картинка, url сервера — оставить как есть, пусто — убрать
    savePlaylist: async ({ name, description, coverUrl }) => {
      const ed = get().playlistEditor
      if (!ed) return
      if (readOnly()) return set({ playlistEditor: null })
      const putCover = async (id: string, had: boolean) => {
        if (coverUrl?.startsWith('data:')) await api(`/playlists/${id}/cover`, { method: 'PUT', blob: await dataUrlBlob(coverUrl) })
        else if (!coverUrl && had) await api(`/playlists/${id}/cover`, { method: 'DELETE' })
      }
      // без сервера (или плейлист ещё только на телефоне) — в журнал; картинку плейлиста — только с сервером
      if (viaJournal(ed.mode === 'create' ? ed.addIds : [], ed.mode === 'edit' ? ed.id : undefined)) {
        if (coverUrl?.startsWith('data:')) get().toast(t('dev.coverNeedsServer'))
        if (ed.mode === 'edit') {
          const p = get().playlists.find((x) => x.id === ed.id)
          if (p && p.name !== name) record('playlist.set', ed.id, 'name', name)
          if (p && p.description !== description) record('playlist.set', ed.id, 'description', description)
          set({ playlistEditor: null })
          get().toast(t('toast.plSaved'))
        } else {
          const id = crypto.randomUUID()
          const trackIds = [...new Set(ed.addIds)]
          record('playlist.create', id, 'status', { name, description })
          let after: string | null = null
          for (const tid of trackIds) {
            record('playlist.add', id, 'tracks', { track: tid, after })
            after = tid
          }
          set({ playlistEditor: null, selected: [] })
          get().toast(trackIds.length ? t('toast.plCreatedN', { name, n: trackIds.length }) : t('toast.plCreated', { name }))
        }
        return
      }
      try {
        if (ed.mode === 'edit') {
          const had = !!get().playlists.find((p) => p.id === ed.id)?.coverUrl
          await api(`/playlists/${ed.id}`, { method: 'PATCH', body: { name, description } })
          await putCover(ed.id, had)
          set({ playlistEditor: null })
          get().toast(t('toast.plSaved'))
        } else {
          const trackIds = [...new Set(ed.addIds)]
          const p = await api<ServerPlaylist>('/playlists', { method: 'POST', body: { name, description, trackIds } })
          await putCover(p.id, false)
          set({ playlists: [toPlaylist(p), ...get().playlists], playlistEditor: null, selected: [] })
          get().toast(trackIds.length ? t('toast.plCreatedN', { name, n: trackIds.length }) : t('toast.plCreated', { name }))
        }
      } catch (e) {
        get().toast(errorText(e), 'error')
      }
      reload()
    },
    addToPlaylist: (pid, ids) => {
      const p = findPlaylist(pid)
      if (!p) return
      if (readOnly()) return set({ pickerIds: null })
      const fresh = ids.filter((id) => !p.trackIds.includes(id))
      set({ pickerIds: null, selected: [] })
      if (!fresh.length) return get().toast(t('toast.plAlready', { name: p.name }))
      // в «Избранное» добавить = лайкнуть
      if (pid === LIKED_ID) setLiked(fresh, true)
      else if (viaJournal(fresh, pid)) {
        let after = p.trackIds[p.trackIds.length - 1] ?? null
        for (const id of fresh) {
          record('playlist.add', pid, 'tracks', { track: id, after })
          after = id
        }
      } else {
        patchPlaylist(pid, (x) => ({ ...x, trackIds: [...x.trackIds, ...fresh] }))
        pushPlaylist(pid)
        if (p.keepOffline) get().downloadMany(fresh)
      }
      get().toast(t('toast.plAdded', { name: p.name, n: fresh.length }))
    },
    removeFromPlaylist: (pid, tid) => {
      if (readOnly()) return
      if (pid === LIKED_ID) return setLiked([tid], false)
      if (viaJournal([tid], pid)) return record('playlist.remove', pid, 'tracks', { track: tid })
      patchPlaylist(pid, (p) => ({ ...p, trackIds: p.trackIds.filter((x) => x !== tid) }))
      pushPlaylist(pid)
    },
    movePlaylist: (from, to) => {
      if (readOnly()) return
      const list = [...get().playlists]
      const [moved] = list.splice(from, 1)
      list.splice(to, 0, moved)
      // сразу на экране, потом на сервер (без сервера — в журнал: у кого сменилось место)
      if (viaJournal()) {
        list.forEach((p, i) => p.position !== i && record('playlist.set', p.id, 'position', i))
        return
      }
      set({ playlists: list.map((p, i) => ({ ...p, position: i })) })
      api<ServerPlaylist[]>('/playlists/order', { method: 'PUT', body: { ids: list.map((p) => p.id) } }).catch((e) => {
        get().toast(errorText(e), 'error')
        // не сохранилось — возвращаем порядок с сервера
        api<ServerPlaylist[]>('/playlists')
          .then((list) => set({ playlists: list.map((p) => toPlaylist(p, get().playlists.find((x) => x.id === p.id)?.keepOffline)) }))
          .catch(() => {})
      })
    },
    renumbering: false,
    // Номер пишется в теги: треки между старым и новым местом сдвигаются, их файлы переписываются (новые id)
    moveTrackNumber: async (id, to) => {
      const s = get()
      const track = s.tracks.find((x) => x.id === id)
      if (!track || s.renumbering || track.trackNo === to || readOnly()) return
      const from = track.trackNo
      const shifted = (n: number | undefined) => {
        if (n === undefined) return n
        if (from === undefined) return n >= to ? n + 1 : n
        if (to < from) return n >= to && n < from ? n + 1 : n
        return n > from && n <= to ? n - 1 : n
      }
      // сразу показываем новый порядок; файлы на сервере переписываются дольше
      const before = new Map(s.tracks.map((x) => [x.id, x.trackNo]))
      set({ renumbering: true, tracks: s.tracks.map((x) => (x.id === id ? { ...x, trackNo: to } : { ...x, trackNo: shifted(x.trackNo) })) })
      try {
        const res = await api<{ renamed: { track: ServerTrack; previousId: string }[]; failed: number }>(`/tracks/${id}/number`, { method: 'POST', body: { number: to }, timeout: 60 * 60_000 })
        applyRenamed(res.renamed)
        if (res.failed) get().toast(t('toast.artistRenameFailed', { n: res.failed }), 'error')
      } catch (e) {
        get().toast(errorText(e), 'error')
        // не вышло — возвращаем номера, как были (у тех треков, что остались со старыми id)
        set({ tracks: get().tracks.map((x) => (before.has(x.id) ? { ...x, trackNo: before.get(x.id) } : x)) })
      } finally {
        set({ renumbering: false })
      }
    },
    movePlaylistTrack: (pid, from, to) => {
      if (readOnly()) return
      const cur = get().playlists.find((x) => x.id === pid)
      if (cur && viaJournal(cur.trackIds, pid)) {
        const ids = [...cur.trackIds]
        const [moved] = ids.splice(from, 1)
        ids.splice(to, 0, moved)
        return record('playlist.move', pid, 'tracks', { track: moved, after: ids[to - 1] ?? null })
      }
      patchPlaylist(pid, (p) => {
        const ids = [...p.trackIds]
        const [moved] = ids.splice(from, 1)
        ids.splice(to, 0, moved)
        return { ...p, trackIds: ids }
      })
      pushPlaylist(pid)
    },
    setKeepOffline: (pid, v) => {
      const p = findPlaylist(pid)
      if (!p) return
      if (pid === LIKED_ID) set({ likedOffline: v })
      else patchPlaylist(pid, (x) => ({ ...x, keepOffline: v }))
      if (!isHost) {
        const kept = new Set(loadKeep().playlists)
        if (pid !== LIKED_ID) v ? kept.add(pid) : kept.delete(pid)
        saveKeep(pid === LIKED_ID ? { liked: v } : { playlists: [...kept] })
      }
      if (v) {
        const missing = get().tracks.filter((t) => p.trackIds.includes(t.id) && t.status === 'cloud')
        scheduleSync()
        get().toast(missing.length ? t('toast.dlStarted', { n: missing.length }) : t('toast.allOnDevice'))
      } else {
        get().toast(t('toast.keptOnDevice'))
      }
    },
    askDeletePlaylist: (playlistDeleteId) => {
      if (playlistDeleteId && readOnly()) return
      set({ playlistDeleteId })
    },
    deletePlaylist: async (id) => {
      if (readOnly()) return set({ playlistDeleteId: null })
      const p = get().playlists.find((x) => x.id === id)
      if (viaJournal([], id)) {
        record('playlist.delete', id, 'status')
        set({
          playlistDeleteId: null,
          ...(get().playlistId === id ? { view: 'albums' as const, albumsTab: 'mine' as const, playlistId: null } : {}),
        })
        if (p) get().toast(t('toast.plDeleted', { name: p.name }))
        return
      }
      try {
        await api(`/playlists/${id}`, { method: 'DELETE' })
      } catch (e) {
        set({ playlistDeleteId: null })
        return get().toast(errorText(e), 'error')
      }
      set({
        playlists: get().playlists.filter((x) => x.id !== id),
        playlistDeleteId: null,
        ...(get().playlistId === id ? { view: 'albums' as const, albumsTab: 'mine' as const, playlistId: null } : {}),
      })
      if (p) get().toast(t('toast.plDeleted', { name: p.name }))
    },

    download: (id) => get().downloadMany([id]),
    // на хосте качать некуда — музыка уже здесь. На телефоне: «скачано руками» держим, а качает синхронизация
    downloadMany: (ids) => {
      if (isHost || !dev || !ids.length) return
      dev.pin(ids)
      get().toast(get().conn === 'online' ? t('toast.dlStarted', { n: ids.length }) : t('dev.dlLater'))
      scheduleSync()
    },
    askDelete: (deleteId) => {
      if (deleteId && readOnly()) return
      if (deleteId && isHost && !get().settings.askOnDelete) return void get().deleteEverywhere(deleteId)
      set({ deleteId })
    },
    freeUpSpace: async (ids) => {
      const d = dev
      if (!d) return
      const mb = get().tracks.filter((x) => ids.includes(x.id)).reduce((a, x) => a + x.sizeMb, 0)
      for (const id of ids) {
        if (get().currentId === id) continue // играющий не трогаем
        await d.removeLocal(id, true)
      }
      set({ tracks: get().tracks.map((x) => (ids.includes(x.id) && x.id !== get().currentId ? { ...x, status: statusOf(x.id) } : x)) })
      get().toast(t('space.freed', { size: fmtSize(mb) }), 'ok')
    },
    deleteFromDevice: (id) => {
      const tr = get().tracks.find((x) => x.id === id)
      set({ deleteId: null })
      void dev?.removeLocal(id, true).then(() => {
        refreshTrack(id)
        // играл из этого файла — дальше потоком с сервера (или стоп, если сети нет)
        if (get().currentId === id && audio) {
          delete audio.dataset.id
          syncAudio()
        }
      })
      if (tr) get().toast(t('toast.delDevice', { title: tr.title }))
    },
    deleteEverywhere: async (id) => {
      if (readOnly()) return set({ deleteId: null })
      const tr = get().tracks.find((x) => x.id === id)
      // ещё не отправлен — просто отменяем отправку и убираем файл с телефона
      if (isPendingId(id)) {
        await dev?.dropOutbox(id)
        set({ deleteId: null, tracks: get().tracks.filter((x) => x.id !== id), selected: get().selected.filter((x) => x !== id) })
        if (get().currentId === id) {
          set({ currentId: null, playing: false, position: 0 })
          syncAudio()
        }
        updateSyncInfo()
        if (tr) get().toast(t('toast.uploadCancelled', { title: tr.title }))
        return
      }
      const wasCurrent = get().currentId === id
      try {
        await api(`/tracks/${id}`, { method: 'DELETE' })
      } catch (e) {
        set({ deleteId: null })
        return get().toast(errorText(e), 'error')
      }
      set({
        deleteId: null,
        tracks: get().tracks.filter((x) => x.id !== id),
        playlists: get().playlists.map((p) => ({ ...p, trackIds: p.trackIds.filter((x) => x !== id) })),
        selected: get().selected.filter((x) => x !== id),
      })
      if (wasCurrent) {
        set({ currentId: null, playing: false, position: 0 })
        syncAudio()
      }
      if (tr) get().toast(t('toast.delEverywhere', { title: tr.title }))
    },
    loadPlays: async () => {
      // телефон: своя история видна сразу и без сервера; сервер ответил — сливаем с его историей
      if (!isHost) {
        const d = await loadDevice()
        if (get().plays === null) set({ plays: d.localPlays() })
        if (get().conn !== 'online') return
        try {
          set({ plays: d.mergePlays(await api<Play[]>('/plays')) })
        } catch {
          /* нет связи — остаётся своя */
        }
        return
      }
      try {
        set({ plays: await api<Play[]>('/plays') })
      } catch (e) {
        if (online()) get().toast(errorText(e), 'error')
      }
    },
    // Порядок и фильтры «Треков» — в настройки аккаунта, чтобы на ПК и телефоне было одинаково. Без сервера или
    // в чужой библиотеке — только здесь; ошибку не показываем: это вид, а не данные
    saveTracksView: (v) => {
      set({ prefs: { ...get().prefs, tracksView: v } })
      if (get().viewAs || get().conn !== 'online' || (!isHost && get().standalone)) return
      api('/prefs', { method: 'PATCH', body: { tracksView: v } }).catch(() => {})
    },
    setPrefs: async (patch) => {
      if (readOnly()) return
      const before = get().prefs
      // сразу на экране, потом на сервер; не вышло — откатываем
      const next = { ...before, ...patch, separators: { ...before.separators, ...patch.separators } }
      set({ prefs: next })
      if (patch.separators) setArtistSeparators(next.separators)
      try {
        const p = await api<ServerPrefs>('/prefs', { method: 'PATCH', body: patch })
        set({ prefs: { ...DEFAULT_SERVER_PREFS, ...p } })
      } catch (e) {
        set({ prefs: before })
        if (patch.separators) setArtistSeparators(before.separators)
        get().toast(errorText(e), 'error')
      }
    },
    setHistoryPaused: (historyPaused) => {
      saveFlag('musich-history-paused', historyPaused)
      set({ historyPaused })
    },
    recordPlay: async (trackId) => {
      // в чужой библиотеке слушаем, но в историю не пишем: это только просмотр
      if (get().historyPaused || get().viewAs) return
      if (!isHost) {
        // телефон сначала пишет к себе, потом отправляет со своим временем — так сервер не запишет его дважды
        const d = await loadDevice()
        const p: Play = { trackId, playedAt: new Date().toISOString() }
        d.addLocalPlay(p)
        const plays = get().plays
        if (plays) set({ plays: [p, ...plays] })
        // без связи или трек ещё не на сервере (up:-id) — в очередь, уйдёт при синхронизации
        if (get().conn !== 'online' || isPendingId(trackId)) return d.queuePlay(trackId, p.playedAt)
        // выбрасываем, только если сервер сказал «нет такого трека»; сбой сервера (5xx) или сети — в очередь
        await api('/plays', { method: 'POST', body: { trackId, at: p.playedAt } }).catch(
          (e) => !(e instanceof ApiError && (e.status === 400 || e.status === 404)) && d.queuePlay(trackId, p.playedAt),
        )
        return
      }
      try {
        const p = await api<Play>('/plays', { method: 'POST', body: { trackId } })
        const plays = get().plays
        if (plays) set({ plays: [p, ...plays] })
      } catch {
        /* не записалось в историю — не повод мешать слушать */
      }
    },
    openRename: (renameId) => {
      if (renameId && readOnly()) return
      if (renameId && notSentYet([renameId])) return
      set({ renameId })
    },
    // Новые теги пишутся в файл, поэтому у трека меняется id: заменяем старый id везде, где он у нас лежит
    embedAlbumCover: async (album) => {
      if (readOnly()) return
      get().toast(t('cover.embedding'))
      try {
        const r = await api<{ done: number; failed: number }>('/albums/embed-cover', { method: 'POST', body: { album }, timeout: 60 * 60_000 })
        get().toast(t('cover.embedded', { n: r.done }) + (r.failed ? ` · ${t('cover.embedFailed', { n: r.failed })}` : ''), r.failed ? 'error' : 'ok')
        reload()
      } catch (e) {
        get().toast(errorText(e), 'error')
      }
    },
    resetTrackEdits: async (id) => {
      if (readOnly()) return
      try {
        const st = await api<ServerTrack>(`/tracks/${id}/overrides`, { method: 'DELETE' })
        set({ tracks: get().tracks.map((x) => (x.id === id ? toTrack(st) : x)) })
        get().toast(t('rename.resetDone'))
      } catch (e) {
        get().toast(errorText(e), 'error')
      }
    },
    renameTrack: async (id, patch) => {
      if (readOnly()) return set({ renameId: null })
      let res: { track: ServerTrack; previousId: string }
      try {
        res = await api(`/tracks/${id}`, { method: 'PATCH', body: patch })
      } catch (e) {
        return get().toast(errorText(e), 'error')
      }
      set({ renameId: null })
      applyRenamed([res])
      get().toast(t('toast.renamed', { title: res.track.title }), 'ok')
    },
    openArtistRename: (artistRename) => {
      if (artistRename && readOnly()) return
      set({ artistRename })
    },
    // Сервер переписывает теги во всех треках артиста — может занять время, если треков много
    renameArtist: async (from, to) => {
      if (readOnly()) return set({ artistRename: null })
      let res: { renamed: { track: ServerTrack; previousId: string }[]; failed: number }
      try {
        res = await api('/artists/rename', { method: 'POST', body: { from, to }, timeout: 60 * 60_000 })
      } catch (e) {
        return get().toast(errorText(e), 'error')
      }
      set({ artistRename: null })
      applyRenamed(res.renamed)
      // стояли на странице старого имени — переходим на новое
      const scope = get().scope
      if (scope?.type === 'artist' && scope.value.toLowerCase() === from.toLowerCase()) set({ scope: { type: 'artist', value: to } })
      get().toast(t('toast.artistRenamed', { name: to, n: res.renamed.length }), 'ok')
      if (res.failed) get().toast(t('toast.artistRenameFailed', { n: res.failed }), 'error')
    },
    setUploadOpen: (uploadOpen) => {
      if (uploadOpen && readOnly()) return
      set({ uploadOpen })
    },
    // Файлы уходят на сервер по одному; пока идут — видны в «Приходит сейчас» на странице «Сервер»
    uploadFiles: async (files) => {
      set({ uploadOpen: false })
      if (readOnly()) return
      // на телефоне трек сначала попадает в приложение (сразу играет), а на сервер уходит при синхронизации
      if (!isHost) {
        const d = await loadDevice()
        return addToPhone(files.map((f) => () => d.addFileToOutbox(f)))
      }
      get().toast(t('toast.uploadStart', { n: files.length }))
      for (const f of files) {
        try {
          const tr = await uploadTrack(f, () => {})
          applyChanges({ cursor, tracks: [tr], playlists: [], covers: [] })
          get().toast(t('toast.uploaded', { title: tr.title }), 'ok')
        } catch (e) {
          get().toast(t('toast.uploadFail', { name: f.name, msg: errorText(e) }), 'error')
        }
      }
      reload()
    },
    forgetDevice: async (id) => {
      if (readOnly()) return
      try {
        await api(`/devices/${id}`, { method: 'DELETE' })
        set({ devices: get().devices.filter((d) => d.id !== id) })
        get().toast(t('toast.deviceForgotten'))
      } catch (e) {
        get().toast(errorText(e), 'error')
      }
    },
    pullChanges: async () => {
      applyChanges(await api<Changes>(`/changes?since=${cursor}`))
    },
    // забрать с сервера всё новое прямо сейчас, не дожидаясь очередного опроса
    pauseSync: () => {
      saveKeep({ paused: true })
      set({ syncInfo: { ...get().syncInfo, paused: true } })
      get().toast(t('sync.pausedToast'))
    },
    resumeSync: () => {
      saveKeep({ paused: false })
      set({ syncInfo: { ...get().syncInfo, paused: false } })
      get().syncNow()
    },
    checkSync: async () => {
      if (!dev || get().syncInfo.checking) return
      set({ syncInfo: { ...get().syncInfo, checking: true } })
      try {
        const { checked, broken } = await dev.verifyLocal()
        // статусы треков (скачан / нет) — заново по списку скачанного
        set({ tracks: get().tracks.map((x) => ({ ...x, status: statusOf(x.id) })) })
        updateSyncInfo()
        get().toast(broken ? t('sync.checkBroken', { n: broken }) : t('sync.checkOk', { n: checked }), broken ? 'error' : 'ok')
        if (broken) scheduleSync()
      } finally {
        set({ syncInfo: { ...get().syncInfo, checking: false } })
      }
    },
    syncNow: () => {
      if (!isHost && get().standalone) return get().startBinding()
      forcedUntil = Date.now() + 10 * 60_000
      if (!isHost && paused()) return get().resumeSync()
      if (!isHost && get().conn !== 'online') {
        void get().initConn()
        return get().toast(t('dev.searching'))
      }
      reload()
      scheduleSync()
      get().toast(t('toast.syncStarted'))
    },
    rescan: async () => {
      if (get().rescanning || readOnly()) return
      set({ rescanning: true })
      get().toast(t('server.rescanning'))
      try {
        applyFolders(await api<ServerFolder[]>('/scan', { method: 'POST' }))
      } catch (e) {
        set({ rescanning: false })
        get().toast(errorText(e), 'error')
      }
    },

    // Папки с музыкой: проверяем дубли и вложенность сразу (понятной ошибкой на языке интерфейса), остальное — сервер
    addMusicFolder: async (raw, userId) => {
      if (readOnly()) return false
      const path = trimPath(raw.trim())
      const folders = get().musicFolders
      if (folders.some((f) => f.path === path)) {
        get().toast(t('toast.folderExists'), 'error')
        return false
      }
      // вложенные друг в друга папки просканировались бы дважды
      const clash = folders.find((f) => isInside(path, f.path) || isInside(f.path, path))
      if (clash) {
        get().toast(t('toast.folderNested', { path: clash.path }), 'error')
        return false
      }
      try {
        const added = await api<ServerFolder>('/folders', { method: 'POST', body: { path, ...(userId ? { userId } : {}) } })
        get().toast(t('toast.folderAdded', { path: added.path }))
        applyFolders([...get().musicFolders, added])
        return true
      } catch (e) {
        get().toast(errorText(e), 'error')
        return false
      }
    },
    removeMusicFolder: async (path) => {
      if (readOnly()) return
      if (get().musicFolders.length <= 1) return get().toast(t('toast.folderLast'), 'error')
      try {
        await api(`/folders?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
        get().toast(t('toast.folderRemoved'))
        await loadFolders()
        reload() // треки из этой папки ушли из библиотеки
      } catch (e) {
        get().toast(errorText(e), 'error')
      }
    },
    moveMusicFolder: async (from, to) => {
      if (readOnly()) return false
      try {
        const r = await api<{ path: string; tracks: number; folders: ServerFolder[] }>('/folders/move', { method: 'POST', body: { from, to } })
        applyFolders(r.folders)
        get().toast(t('folders.movedDone', { n: r.tracks }), 'ok')
        void get().pullChanges()
        return true
      } catch (e) {
        get().toast(errorText(e), 'error')
        return false
      }
    },
    setUploadFolder: async (path) => {
      if (readOnly()) return
      try {
        applyFolders(await api<ServerFolder[]>('/folders/uploads', { method: 'PUT', body: { path } }))
        get().toast(t('toast.uploadsHere', { path }), 'ok')
      } catch (e) {
        get().toast(errorText(e), 'error')
      }
    },
    // Владелец передаёт папку другому: её треки переезжают в его библиотеку
    setFolderOwner: async (path, userId) => {
      if (readOnly()) return
      try {
        await api('/folders/owner', { method: 'PUT', body: { path, userId } })
        const u = get().users.find((x) => x.id === userId)
        get().toast(t('folders.ownerChanged', { name: u ? userLabel(u) : '—' }), 'ok')
        await loadFolders()
        reload() // треки этой папки ушли из своей библиотеки (или пришли в неё)
        void get().loadUsers() // у пользователей поменялось, сколько треков и места
      } catch (e) {
        get().toast(errorText(e), 'error')
      }
    },

    // ---- пользователи сервера: только владелец ----
    loadUsers: async () => {
      try {
        set({ users: await api<ServerUser[]>('/users') })
      } catch (e) {
        get().toast(errorText(e), 'error')
      }
    },
    loadServerSettings: async () => {
      try {
        const s = await api<{ registration: boolean }>('/server/settings')
        set({ registration: !!s.registration })
      } catch (e) {
        get().toast(errorText(e), 'error')
      }
    },
    setRegistration: async (v) => {
      const before = get().registration
      set({ registration: v }) // сразу на экране; не вышло — назад
      try {
        const s = await api<{ registration: boolean }>('/server/settings', { method: 'PATCH', body: { registration: v } })
        set({ registration: !!s.registration })
        get().toast(v ? t('users.regOnToast') : t('users.regOffToast'), 'ok')
      } catch (e) {
        set({ registration: before })
        get().toast(errorText(e), 'error')
      }
    },
    setUserRole: async (id, role) => {
      try {
        await api(`/users/${id}/role`, { method: 'PUT', body: { role } })
        await get().loadUsers()
        get().toast(t(role === 'admin' ? 'users.madeAdmin' : 'users.unmadeAdmin'), 'ok')
      } catch (e) {
        get().toast(errorText(e), 'error')
      }
    },
    transferOwner: async (id, password) => {
      try {
        const users = await api<ServerUser[]>(`/users/${id}/owner`, { method: 'POST', body: { password } })
        const me = get().me
        set({ users, ...(me ? { me: { ...me, role: 'admin' as const } } : {}) })
        get().toast(t('users.ownerMoved'), 'ok')
        return true
      } catch (e) {
        get().toast(e instanceof ApiError && e.status === 401 ? t('acc.passWrong') : errorText(e), 'error')
        return false
      }
    },
    resetUserPassword: async (id, password) => {
      try {
        await api(`/users/${id}/password`, { method: 'PUT', body: { password } })
        get().toast(t('users.passResetDone'), 'ok')
        return true
      } catch (e) {
        get().toast(errorText(e), 'error')
        return false
      }
    },
    deleteUser: async (id) => {
      const u = get().users.find((x) => x.id === id)
      try {
        await api(`/users/${id}`, { method: 'DELETE' })
      } catch (e) {
        get().toast(errorText(e), 'error')
        return false
      }
      // смотрели как раз его библиотеку — возвращаемся к своей
      if (get().viewAs?.id === id) await get().exitUserLibrary()
      set({ users: get().users.filter((x) => x.id !== id) })
      get().toast(t('users.deleted', { name: u ? userLabel(u) : '—' }))
      void loadFolders() // его папки остались без хозяина
      return true
    },
    openUserLibrary: async (u) => {
      if (u.id === get().me?.id) return get().exitUserLibrary()
      if (get().viewAs?.id === u.id) return set({ view: 'home' })
      await switchLibrary(u)
    },
    exitUserLibrary: async () => {
      if (!get().viewAs) return
      await switchLibrary(null)
    },

    toast: (text, kind = 'info') => {
      if (!isHost && text === t('auth.offline')) return
      const id = ++toastId
      set({ toasts: [...get().toasts, { id, text, kind }] })
      // ошибку показываем подольше, чтобы успеть прочитать
      setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 5000 : 3200)
    },

    // Трек доиграл: таймер «до конца трека», повтор или следующий
    trackEnded: () => {
      if (get().sleepEndOfTrack) {
        get().seek(0)
        return sleepNow()
      }
      if (get().repeat) {
        get().seek(0)
        return syncAudio()
      }
      const id = pickNext(true)
      if (id) return goto(id)
      // очередь доиграла, а в настройках «остановиться» — стоим в начале последнего трека
      set({ playing: false })
      get().seek(0)
      syncAudio()
    },
    crossfadeTick: crossfade,
    prefetchNext: () => {
      if (!isHost) return
      const nextId = upcoming(get(), 1)[0]
      const nextT = nextId ? get().tracks.find((x) => x.id === nextId) : undefined
      if (nextT) prefetchAudio(streamUrl(nextT.id, nextT.hash))
    },

    // Раз в полсекунды: таймер сна — последние 10 секунд плавно убавляем звук, потом пауза
    tick: () => {
      const s = get()
      if (!s.sleepAt) return
      const left = s.sleepAt - Date.now()
      if (left <= 0) return sleepNow()
      if (left < 10_000) {
        sleepFade = left / 10_000
        applyVolume()
      }
    },
  }
})

// Прослушивание засчитываем, когда реально прослушано столько секунд, сколько в настройках сервера
// (0 — половину трека; трек короче порога — целиком), перемотка не в счёт. Повтор с начала — новое прослушивание
const heardNeeded = (duration: number) => {
  const sec = useStore.getState().prefs.playThreshold
  const full = (duration || Infinity) - 0.5
  return Math.min(sec > 0 ? sec : full / 2, full)
}
const heard = { id: '', sec: 0, last: 0, sent: false }

let resumeSaved = 0
let bufferTimer: ReturnType<typeof setTimeout> | undefined
let prefetchedFor = '' // для какого трека следующий уже скачан заранее
  for (const el of players) {
  // пауза — точная позиция в главный стор сразу (оттуда «продолжить с места»), а не через 5 с
  el.addEventListener('pause', () => el === audio && el.dataset.id === useStore.getState().currentId && useStore.setState({ position: el.currentTime }))
  el.addEventListener('timeupdate', () => {
    // события доигрывающего после кроссфейда <audio> не считаем: главный — другой
    if (el !== audio) return
    const st = useStore.getState()
    if (el.dataset.id === st.currentId) {
      // на экране — живая позиция (lib/pos.ts, её слушают только полоска, время, текст); в главный стор — раз в 5 с
      if (st.power.visible) usePos.setState({ position: el.currentTime })
      if (Math.abs(el.currentTime - st.position) >= 5) useStore.setState({ position: el.currentTime })
    }
    const id = el.dataset.id
    if (!id) return
    const at = el.currentTime
    if (heard.id !== id || (heard.sent && at < 1 && heard.last > at)) Object.assign(heard, { id, sec: 0, last: at, sent: false })
    const step = at - heard.last
    if (step > 0 && step < 2) heard.sec += step // большой скачок — это перемотка
    heard.last = at
    // −0.5 c: timeupdate приходит раз в ~0.25 с, и у трека короче 10 секунд счёт может не добежать до самого конца
    if (!heard.sent && heard.sec >= heardNeeded(el.duration)) {
      heard.sent = true
      void st.recordPlay(id)
    }
    // длинный трек: раз в 5 секунд запоминаем место; почти дослушал — забываем
    const min = st.settings.resumeMin
    if (min && el.duration >= min * 60 && Date.now() - resumeSaved > 5000) {
      resumeSaved = Date.now()
      if (at > 30 && el.duration - at > 30) resumeMap[id] = Math.floor(at)
      else delete resumeMap[id]
      saveResume()
    }
    // текущий играет уже 10 с (его начало скачано) — следующий качаем целиком заранее: переход будет мгновенным
    if (at > 10 && prefetchedFor !== id) {
      prefetchedFor = id
      st.prefetchNext()
    }
    const cf = st.settings.crossfade
    if (cf && el.duration > cf * 3 && el.duration - at <= cf) st.crossfadeTick()
  })
  // трек грузится: нажали «играть», а звука ещё нет — кольцо на кнопке (с задержкой 300 мс, чтобы не мигало на быстрой сети)
  const loading = () => {
    if (el !== audio || !useStore.getState().playing) return
    clearTimeout(bufferTimer)
    bufferTimer = setTimeout(() => el === audio && el.paused === false && el.readyState < 3 && useBuffering.setState({ buffering: true }), 300)
  }
  const loaded = () => {
    if (el !== audio) return
    clearTimeout(bufferTimer)
    if (useBuffering.getState().buffering) useBuffering.setState({ buffering: false })
  }
  for (const ev of ['loadstart', 'waiting', 'stalled']) el.addEventListener(ev, loading)
  for (const ev of ['playing', 'pause', 'canplay', 'error', 'emptied', 'ended']) el.addEventListener(ev, loaded)
  el.addEventListener('ended', () => {
    if (el !== audio) return
    if (el.dataset.id && resumeMap[el.dataset.id] !== undefined) {
      delete resumeMap[el.dataset.id]
      saveResume()
    }
    useStore.getState().trackEnded()
  })
  el.addEventListener('error', () => {
    if (el !== audio || !el.dataset.id) return
    useStore.setState({ playing: false })
    useStore.getState().toast(t('toast.fileError'), 'error')
  })
  // при горячей перезагрузке модуля старый плеер иначе продолжит играть
  onDispose(() => {
    el.pause()
    el.removeAttribute('src')
  })
}

// Сохраняем состояние плеера: сразу при смене трека/очереди, позицию — не чаще раза в 2 секунды
{
  let lastSave = 0
  const save = () => {
    const s = useStore.getState()
    // в чужой библиотеке свой сохранённый плеер не трогаем — после выхода он вернётся как был
    if (s.viewAs) return
    const data = Object.fromEntries(PLAYER_FIELDS.map((k) => [k, s[k]]))
    try {
      localStorage.setItem(PLAYER_KEY, JSON.stringify(data))
    } catch {
      /* нет места или хранилище выключено — просто не запомним */
    }
    lastSave = Date.now()
  }
  const unsub = useStore.subscribe((s, prev) => {
    const changed = PLAYER_FIELDS.some((k) => k !== 'position' && s[k] !== prev[k])
    if (changed || (s.position !== prev.position && Date.now() - lastSave > 2000)) save()
  })
  window.addEventListener('pagehide', save)
  onDispose(() => {
    unsub()
    window.removeEventListener('pagehide', save)
  })
}

// Наушники отключили (провод, Bluetooth) — пауза, а не музыка на весь автобус. Событие шлёт MainActivity.java
if (!isHost && typeof window !== 'undefined') {
  const noisy = () => {
    const st = useStore.getState()
    if (st.playing) st.toggle()
  }
  window.addEventListener('musich-noisy', noisy)
  onDispose(() => window.removeEventListener('musich-noisy', noisy))
}

// Телефон: что играет — в шторку и на экран блокировки. Обновляем, когда меняется трек, пауза, обложка или тема,
// и по событиям самого <audio> (заиграло, пауза, перемотка, узнали длину) — так полоска в шторке стоит там же, где звук
if (!isHost) {
  let shown = ''
  let trackOf = ''
  const push = () => {
    const s = useStore.getState()
    const cur = s.tracks.find((x) => x.id === s.currentId)
    if (!cur) return void dev?.setNowPlaying(null)
    // <audio> ещё может держать прошлый трек: тогда позиция — с начала
    const sameFile = audio?.dataset.id === cur.id
    const position = sameFile && audio ? audio.currentTime : 0
    const duration = sameFile && audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : cur.duration
    void dev?.setNowPlaying({ title: cur.title, artist: cur.artist, album: cur.album, cover: trackCover(cur, s.covers), playing: s.playing, duration, position })
  }
  useStore.subscribe((s) => {
    const cur = s.tracks.find((x) => x.id === s.currentId)
    const key = `${s.currentId}|${s.playing}|${cur ? trackCover(cur, s.covers) ?? '' : ''}|${cur?.title ?? ''}|${cur?.artist ?? ''}|${s.theme}|${s.palette}|${s.accent ?? ''}`
    if (key === shown) return
    shown = key
    push()
  })
  for (const el of players)
    for (const ev of ['playing', 'pause', 'seeked', 'durationchange'] as const)
      el.addEventListener(ev, () => {
        if (el !== audio) return
        // durationchange бывает и у того же трека — шлём, только если что-то правда поменялось
        if (ev === 'durationchange' && trackOf === `${el.dataset.id}|${el.duration}`) return
        trackOf = `${el.dataset.id}|${el.duration}`
        push()
      })
}

// Порядок воспроизведения: очередь источника (если задана) или вся библиотека; при «случайно» — перемешанный
// Порядок нужен плееру, мини-плееру и очереди при каждом обновлении стора (позиция — 4 раза в секунду):
// пока очередь, треки и перемешивание те же — отдаём прошлый результат, а не считаем заново по всей библиотеке
let orderCache: { q: State['queue']; t: State['tracks']; sh: boolean; so: State['shuffleOrder']; ids: string[] } | null = null
export const playOrder = (s: Pick<State, 'queue' | 'tracks' | 'shuffle' | 'shuffleOrder'>) => {
  const c = orderCache
  if (c && c.q === s.queue && c.t === s.tracks && c.sh === s.shuffle && c.so === s.shuffleOrder) return c.ids
  const ids = computeOrder(s)
  orderCache = { q: s.queue, t: s.tracks, sh: s.shuffle, so: s.shuffleOrder, ids }
  return ids
}
const computeOrder = (s: Pick<State, 'queue' | 'tracks' | 'shuffle' | 'shuffleOrder'>) => {
  const known = new Set(s.tracks.map((t) => t.id))
  const queued = s.queue?.filter((id) => known.has(id))
  const base = queued?.length ? queued : s.tracks.map((t) => t.id)
  if (!s.shuffle || !s.shuffleOrder) return base
  // треки, появившиеся после перемешивания (новые в библиотеке), — в конце
  const inBase = new Set(base)
  const mixed = s.shuffleOrder.filter((id) => inBase.has(id))
  const seen = new Set(mixed)
  return [...mixed, ...base.filter((id) => !seen.has(id))]
}

/** Перемешать (Фишер — Йетс); first — играющий трек, он остаётся первым */
const shuffled = (ids: string[], first?: string | null): string[] => {
  const rest = ids.filter((id) => id !== first)
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j], rest[i]]
  }
  return first && ids.includes(first) ? [first, ...rest] : rest
}

/** Какой трек «назад»: предыдущий в порядке; в самом начале (или трек включили не из этого порядка) — что играло перед ним */
export const previousId = (s: State): string | null => {
  const ids = playOrder(s)
  const i = ids.indexOf(s.currentId ?? '')
  const before = s.history[s.history.length - 1]
  if (i <= 0 && before) return before
  return ids.length ? ids[(i - 1 + ids.length) % ids.length] : null
}

/** Что сыграет дальше: ручная очередь, потом основной порядок после текущего */
export const upcoming = (s: State, n = 8) => {
  const ids = playOrder(s)
  const i = ids.indexOf(s.currentId ?? '')
  const rest = [...ids.slice(i + 1), ...ids.slice(0, Math.max(0, i))]
  return [...s.upNext, ...rest.filter((id) => !s.upNext.includes(id) && id !== s.currentId)].slice(0, n)
}

export const selectCurrent = (s: State) => s.tracks.find((t) => t.id === s.currentId) ?? null

/**
 * Подписка только на нужные поля. useStore() без селектора перерисовывает компонент на любое
 * изменение — например, позиции трека 4 раза в секунду. Для списков (сотни строк) это тормоза
 */
export const usePick = <K extends keyof State>(...keys: K[]): Pick<State, K> =>
  useStore(useShallow((s) => Object.fromEntries(keys.map((k) => [k, s[k]])) as Pick<State, K>))

// Спрашиваем сервер сразу при загрузке стора — в том числе когда vite пересоздаёт его при правке кода
useStore.getState().initConn()

// Системный плейлист «Избранное» не хранится — собирается из лайков, свежие сверху
export const LIKED_ID = 'liked'

/**
 * Умные плейлисты — собираются сами, ничего не хранят: «Добавлено за месяц», «Любимое за <год>», «Давно не слушал»
 * (слушал раньше, но не последние 60 дней — чаще слушанные сверху). Без истории (ещё не загружена) последний пуст
 */
export const SMART_PREFIX = 'smart:'
const DAY = 86_400_000
export const smartLists = (tracks: Track[], plays: Play[] | null): Playlist[] => {
  const now = Date.now()
  const year = new Date().getFullYear()
  const base = { description: '', keepOffline: false, updatedAt: today(), system: true, smart: true }
  const fresh = tracks
    .filter((x) => now - Date.parse(x.addedAt) < 30 * DAY)
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
  const loved = tracks
    .filter((x) => x.liked && x.likedAt && new Date(x.likedAt).getFullYear() === year)
    .sort((a, b) => (b.likedAt ?? 0) - (a.likedAt ?? 0))
  const last = new Map<string, number>()
  const count = new Map<string, number>()
  for (const p of plays ?? []) {
    const at = Date.parse(p.playedAt)
    if (at > (last.get(p.trackId) ?? 0)) last.set(p.trackId, at)
    count.set(p.trackId, (count.get(p.trackId) ?? 0) + 1)
  }
  const known = new Set(tracks.map((x) => x.id))
  const forgotten = [...last]
    .filter(([id, at]) => known.has(id) && now - at > 60 * DAY)
    .sort((a, b) => (count.get(b[0]) ?? 0) - (count.get(a[0]) ?? 0))
    .map(([id]) => id)
  return [
    { ...base, id: `${SMART_PREFIX}recent`, name: t('smart.recent'), description: t('smart.recentDesc'), trackIds: fresh.map((x) => x.id) },
    { ...base, id: `${SMART_PREFIX}year`, name: t('smart.year', { year }), description: t('smart.yearDesc'), trackIds: loved.map((x) => x.id) },
    { ...base, id: `${SMART_PREFIX}forgotten`, name: t('smart.forgotten'), description: t('smart.forgottenDesc'), trackIds: forgotten },
  ]
}

// plays передан (даже null) — после «Избранного» идут умные плейлисты; не передан (выбор «добавить в плейлист») — без них
export const withLiked = (tracks: Track[], playlists: Playlist[], likedOffline: boolean, plays?: Play[] | null): Playlist[] => [
  {
    id: LIKED_ID,
    name: t('liked.name'),
    description: t('liked.desc'),
    trackIds: tracks
      .filter((t) => t.liked)
      .sort((a, b) => (b.likedAt ?? 0) - (a.likedAt ?? 0))
      .map((t) => t.id),
    keepOffline: likedOffline,
    updatedAt: today(),
    system: true,
  },
  ...(plays === undefined ? [] : smartLists(tracks, plays)),
  ...playlists,
]

// Перетаскивание треков: тип данных в dataTransfer
export const DRAG_TRACKS = 'application/x-musich-tracks'

// позиция в главном сторе поменялась (смена трека, перемотка, «продолжить с места») — живая следом
useStore.subscribe((s, p) => {
  if (s.position !== p.position) usePos.setState({ position: s.position })
})
