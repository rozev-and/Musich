import { createHash, randomUUID } from 'node:crypto'
import { constants, existsSync, readdirSync } from 'node:fs'
import { copyFile, link, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import type { Config } from './config.ts'
import { currentSeq, getSetting, getUserSetting, nextSeq, setSetting, setUserSetting, tx, type Db } from './db.ts'
import { badRequest, HttpError, notFound } from './errors.ts'
import { loadPrefs, savePrefs, SERVER_PREFS, type Prefs } from './prefs.ts'
import { audioFormat, hasArtist, hashFile, IMAGE_EXT, readFileTags, replaceArtist, safeFileName, writeFileTags, type ParsedFile, type TagPatch, type TrackTags } from './media.ts'

// ---- форматы API (docs/API.md) ----

export type TrackStatus = 'available' | 'deleted'

export interface Track {
  id: string
  title: string
  artist: string
  album: string
  year?: number
  trackNo?: number    // номер трека из тегов («№» в проводнике)
  duration: number
  gain?: number       // ReplayGain трека из тегов, дБ
  albumGain?: number  // ReplayGain альбома, дБ
  peak?: number       // пик трека (доля от 1): прибавлять громкость выше него нельзя
  size: number
  format: string
  fileName: string
  hasCover: boolean
  liked: boolean
  likedAt?: string
  addedAt: string
  status: TrackStatus
  seq: number
  source?: string     // кто прислал: имя устройства или входа; нет — нашёлся в папке
  replacedBy?: string // у надгробия: новый id того же трека после переписывания тегов
  hash: string        // нынешний отпечаток файла (меняется, когда файл прошивают; id — нет)
  autoGain?: number   // громкость, которую клиент измерил сам (дБ) — для «выравнивать автоматически»
  edited?: boolean    // название/исполнитель/альбом/год исправлены только в MUSICH, файл прежний
  fileChanged?: boolean // файл прошит: отпечаток уже не тот, с которым трек пришёл
  fileChanges?: FileChange[] // что именно в нём поменяли: теги, номер, обложку (пусто — меняли что-то другое, например на диске)
}

export interface Play {
  trackId: string
  playedAt: string
  source?: string     // с какого устройства или входа слушали
}

/** Что ждёт решения владельца (вкладка «Сервер» → «Конфликты») */
export interface Conflicts {
  returned: { id: string; trackId: string; title: string; artist: string; fileName: string; source?: string; createdAt: string }[]
  duplicates: { key: string; tracks: Track[] }[]
}

/** Трек в корзине: файл ещё на диске, до expiresAt его можно вернуть */
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

export interface Playlist {
  id: string
  name: string
  description: string
  trackIds: string[]
  hasCover: boolean
  updatedAt: string
  deleted: boolean
  position: number    // порядок в списке плейлистов, с нуля
  seq: number
}

export type DeviceKind = 'desktop' | 'laptop' | 'phone'

/** Что устройство сообщает о себе при отметке — для «Экосистемы» на странице сервера */
export interface DeviceInfo {
  client?: 'app' | 'web' // приложение на телефоне или веб в браузере
  version?: string // версия приложения
  tracks?: number // треков на устройстве (у веба — в памяти браузера)
  bytes?: number // сколько они занимают
  free?: number // свободно на устройстве
  total?: number // всего места
  route?: 'home' | 'domain' | 'direct' // как ходит к серверу: дома напрямую, через домен, по прямому адресу
  playing?: string // что играет сейчас («Исполнитель — Название»)
}

export interface Device {
  id: string
  name: string
  kind: DeviceKind
  lastSeenAt: string
  info?: DeviceInfo
  pendingUp: number   // сколько треков ждёт отправки на сервер (сообщает само устройство)
  pendingDown: number // сколько ждёт скачивания на устройство
  syncedAt?: string   // когда синхронизация последний раз прошла до конца
}

export type CoverKind = 'track' | 'album' | 'artist'

export interface CoverChange {
  kind: CoverKind
  key: string
  seq: number
  deleted: boolean
}

export interface Changes {
  cursor: number
  tracks: Track[]
  playlists: Playlist[]
  covers: CoverChange[]
}

export interface Folder {
  path: string
  userId: string | null // чья папка: её треки — этого пользователя
  uploads: boolean
  tracks: number
  scanning: boolean
  scanDone?: number  // пока идёт скан: сколько файлов пройдено
  scanTotal?: number // и сколько всего аудиофайлов нашлось в папке (0 — ещё считаем)
}

export interface Profile {
  login: string | null   // только читается; null — владелец ещё не придумал логин
  name: string
  email: string
  avatar?: string | null // data:image/...; null в PUT — убрать
}

export interface DirListing {
  path: string
  parent: string | null
  dirs: string[]
}

// ---- строки базы ----

interface TrackRow {
  id: string
  title: string
  artist: string
  album: string
  year: number | null
  track_no: number | null
  duration: number
  size: number
  format: string
  file_name: string
  path: string | null
  tag_cover_mime: string | null
  added_at: string
  status: TrackStatus
  seq: number
  unlinked: number
  replaced_by: string | null
  mtime: number | null
  rg_track: number | null
  rg_album: number | null
  rg_peak: number | null
  auto_gain: number | null // громкость, измеренная клиентом
  ov: string | null // правки «только в MUSICH» поверх тегов (JSON)
  hash: string | null // нынешний отпечаток файла
  orig_hash: string | null // отпечаток файла, каким он пришёл
  orig_title: string | null // исходные теги — каким файл пришёл
  orig_artist: string | null
  orig_album: string | null
  orig_year: number | null
  orig_track_no: number | null
  cover_embedded: number // вшивали ли в файл обложку
  source: string | null
  liked_at: string | null
  has_cover: number
  user_id: string
}

interface PlaylistRow {
  id: string
  name: string
  description: string
  track_ids: string
  updated_at: string
  deleted: number
  position: number
  seq: number
  has_cover: number
  user_id: string
}

interface CoverRow {
  kind: string
  key: string
  mime: string | null
  file: string | null
  deleted: number
  seq: number
}

interface DeviceRow {
  id: string
  name: string
  kind: DeviceKind
  last_seen_at: string
  pending_up: number
  pending_down: number
  synced_at: string | null
  info: string | null
  user_id?: string
}

const TRACK_SELECT = `
  SELECT t.*, l.liked_at AS liked_at,
    (t.tag_cover_mime IS NOT NULL OR EXISTS (
      SELECT 1 FROM covers c WHERE c.user_id = t.user_id AND c.deleted = 0
        AND ((c.kind = 'track' AND c.key = t.id) OR (c.kind = 'album' AND c.key = t.album))
    )) AS has_cover
  FROM tracks t LEFT JOIN likes l ON l.track_id = t.id`

const PLAYLIST_SELECT = `
  SELECT p.*, EXISTS (
    SELECT 1 FROM covers c WHERE c.user_id = p.user_id AND c.kind = 'playlist' AND c.key = p.id AND c.deleted = 0
  ) AS has_cover
  FROM playlists p`

function toTrack(r: TrackRow): Track {
  return {
    id: r.id,
    title: r.title,
    artist: r.artist,
    album: r.album,
    ...(r.year != null ? { year: r.year } : {}),
    ...(r.track_no != null ? { trackNo: r.track_no } : {}),
    duration: r.duration,
    ...(r.rg_track != null ? { gain: r.rg_track } : {}),
    ...(r.auto_gain != null ? { autoGain: r.auto_gain } : {}),
    ...(r.rg_album != null ? { albumGain: r.rg_album } : {}),
    ...(r.rg_peak != null ? { peak: r.rg_peak } : {}),
    size: r.size,
    format: r.format,
    fileName: r.file_name,
    hasCover: r.status === 'available' && !!r.has_cover,
    liked: r.liked_at != null,
    ...(r.liked_at != null ? { likedAt: r.liked_at } : {}),
    addedAt: r.added_at,
    status: r.status,
    seq: r.seq,
    ...(r.source ? { source: r.source } : {}),
    ...(r.status === 'deleted' && r.replaced_by ? { replacedBy: r.replaced_by } : {}),
    hash: r.hash ?? r.id,
    ...(r.ov ? { edited: true } : {}),
    // файл уже не тот, каким пришёл: его прошил MUSICH (теги, номер) или поправили на диске
    ...(r.status === 'available' && r.orig_hash && r.hash && r.orig_hash !== r.hash ? { fileChanged: true, fileChanges: fileChanges(r) } : {}),
  }
}

export type FileChange = 'tags' | 'number' | 'cover'

/**
 * Что поменяли в файле по сравнению с тем, каким он пришёл: теги (название, исполнитель, альбом, год), номер, обложку.
 * Поле с правкой «только в MUSICH» не считаем — в файле оно прежнее
 */
function fileChanges(r: TrackRow): FileChange[] {
  if (r.orig_title == null) return []
  const ov = parseOv(r.ov)
  const out: FileChange[] = []
  const tags =
    (ov.title === undefined && r.title !== r.orig_title) ||
    (ov.artist === undefined && r.artist !== r.orig_artist) ||
    (ov.album === undefined && r.album !== r.orig_album) ||
    (ov.year === undefined && (r.year ?? null) !== (r.orig_year ?? null))
  if (tags) out.push('tags')
  if ((r.track_no ?? null) !== (r.orig_track_no ?? null)) out.push('number')
  if (r.cover_embedded) out.push('cover')
  return out
}

/** Правки «только в MUSICH»: что из тегов подменено (year 0 — года нет) */
interface Overrides {
  title?: string
  artist?: string
  album?: string
  year?: number
}
const parseOv = (raw: string | null): Overrides => {
  try {
    return raw ? (JSON.parse(raw) as Overrides) : {}
  } catch {
    return {}
  }
}

function toPlaylist(r: PlaylistRow): Playlist {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    trackIds: JSON.parse(r.track_ids) as string[],
    hasCover: !!r.has_cover && !r.deleted,
    updatedAt: r.updated_at,
    deleted: !!r.deleted,
    position: r.position,
    seq: r.seq,
  }
}

const toDevice = (r: DeviceRow): Device => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  lastSeenAt: r.last_seen_at,
  pendingUp: r.pending_up,
  pendingDown: r.pending_down,
  ...(r.synced_at ? { syncedAt: r.synced_at } : {}),
  ...(r.info ? { info: parseInfo(r.info) } : {}),
})
const parseInfo = (s: string): DeviceInfo | undefined => {
  try {
    return JSON.parse(s) as DeviceInfo
  } catch {
    return undefined
  }
}

const now = () => new Date().toISOString()
export const TMP_DIR_NAME = '.musich-tmp'
export const TRASH_DIR_NAME = '.musich-trash'
export const CONFLICT_DIR_NAME = '.musich-conflicts'

/** Исполнитель или название для поиска дублей: без регистра, знаков и пробелов, ё = е */
const normName = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '')

/** Перенести файл; между дисками rename не умеет — тогда копия и удаление */
async function moveFile(src: string, dst: string) {
  try {
    await rename(src, dst)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await copyFile(src, dst, constants.COPYFILE_EXCL)
    await rm(src, { force: true })
  }
}
// Версия разбора тегов: 1 — появился номер трека, 2 — ReplayGain. Строки с меньшей версией дочитывает backfillTags
const TAGS_V = 2


// Один ли это файл: на Windows регистр в пути не важен
const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

export const TRACK_ID_RE = /^[0-9a-f]{16}$/

/** a лежит внутри b (или это она сама) */
/**
 * Путь внутри старой папки → тот же путь внутри новой; чужие пути — как есть. Разделители — под новую папку:
 * старый путь мог быть виндовым (C:\…) на Linux-сервере, поэтому сравниваем без привязки к ОС
 */
export function movedPath(p: string, from: string, to: string) {
  const base = from.replace(/[\\/]+$/, '')
  if (p !== base && !p.startsWith(base + '\\') && !p.startsWith(base + '/')) return p
  const posix = !/^[a-zA-Z]:[\\/]/.test(to) && to.startsWith('/')
  let rest = p.slice(base.length).replace(/^[\\/]+/, '')
  rest = posix ? rest.replace(/\\/g, '/') : rest.replace(/\//g, '\\')
  return rest ? `${to.replace(/[\\/]+$/, '')}${posix ? '/' : '\\'}${rest}` : to
}

export function isInside(a: string, b: string) {
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

export class Library {
  readonly cfg: Config
  readonly db: Db
  readonly log: FastifyBaseLogger
  private readonly tagCoverDir: string
  private readonly customCoverDir: string
  // Операции над одним id идут строго по очереди (две одинаковые загрузки, загрузка во время скана)
  private readonly locks = new Map<string, Promise<unknown>>()
  /** Папки, которые сейчас сканируются, и сколько файлов из скольких уже пройдено (заполняет scanner.ts) */
  readonly scanning = new Map<string, { done: number; total: number }>()

  constructor(cfg: Config, db: Db, log: FastifyBaseLogger) {
    this.cfg = cfg
    this.db = db
    this.log = log
    this.tagCoverDir = join(cfg.dataDir, 'covers', 'tag')
    this.customCoverDir = join(cfg.dataDir, 'covers', 'custom')
  }

  // ---------- пользователи ----------

  private ownerCache?: string

  /** id владельца; undefined — сервер ещё не настроен. Меняется только передачей владения — тогда forgetOwner() */
  ownerId(): string | undefined {
    this.ownerCache ??= (this.db.prepare("SELECT id FROM users WHERE role = 'owner'").get() as { id: string } | undefined)?.id
    return this.ownerCache
  }

  forgetOwner() {
    this.ownerCache = undefined
  }

  /** Владелец или администратор — видит все папки, управляет сервером */
  isAdmin(userId: string) {
    const r = (this.db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined)?.role
    return r === 'owner' || r === 'admin'
  }

  /** У кого id треков = отпечаток файла: первый владелец (запомнен в миграции 20 или при передаче владения) */
  private plainIdUser(): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key = 'plainIdUser'").get() as { value: string } | undefined)?.value ?? this.ownerId()
  }

  isOwner(userId: string) {
    return userId === this.ownerId()
  }

  /**
   * id нового трека. У владельца — отпечаток файла, как было до пользователей (на эти id ссылаются телефоны и журнал),
   * у остальных — от пары «пользователь + отпечаток»: один и тот же файл у двоих — два разных трека
   */
  trackIdFor(userId: string, hash: string): string {
    return userId === this.plainIdUser() ? hash : createHash('sha256').update(`${userId}:${hash}`).digest('hex').slice(0, 16)
  }

  private userLogin(userId: string): string | null {
    return (this.db.prepare('SELECT login FROM users WHERE id = ?').get(userId) as { login: string | null } | undefined)?.login ?? null
  }

  /** Куда ложатся загрузки пользователя: <папка загрузок>/<логин>/ (у владельца без логина — прямо в неё) */
  userUploadDir(userId: string): string {
    const login = this.userLogin(userId)
    return login ? join(this.uploadFolder(), login) : this.uploadFolder()
  }

  /** Логин можно отдать новому пользователю: в папке загрузок нет папки с таким именем (там чужая музыка) */
  // без учёта регистра: на Windows «Rock» и «rock» — одна папка, на Linux — две; логины тоже без регистра
  uploadDirFree(login: string): boolean {
    const l = login.toLowerCase()
    try {
      return !readdirSync(this.uploadFolder()).some((name) => name.toLowerCase() === l)
    } catch {
      return !existsSync(join(this.uploadFolder(), login))
    }
  }

  /** Сколько треков и места у пользователя — для списка пользователей */
  usage(userId: string): { tracks: number; bytes: number } {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM tracks WHERE user_id = ? AND status = 'available'")
      .get(userId) as { n: number; bytes: number }
    return { tracks: r.n, bytes: r.bytes }
  }

  /** Владельца только что создали: всё, что появилось до него (первая папка), — ему */
  adoptOrphans(ownerId: string) {
    this.ownerCache = ownerId
    this.db.prepare('UPDATE folders SET user_id = ? WHERE user_id IS NULL').run(ownerId)
  }

  // ---------- настройки ----------

  /** Настройки пользователя (меняются в веб-морде). Без userId — владельца: скан по расписанию и слежка за папками — его */
  prefs(userId?: string): Prefs {
    const own = loadPrefs(this.db, userId ?? this.ownerId())
    if (!userId || this.isOwner(userId)) return own
    const server = loadPrefs(this.db, this.ownerId())
    return { ...own, ...Object.fromEntries(SERVER_PREFS.map((k) => [k, server[k]])) }
  }

  /** Кто-то следит за настройками владельца (расписание скана, слежка за папками) — его зовут после сохранения */
  onPrefsChange?: (p: Prefs) => void

  setPrefs(userId: string, patch: Partial<Prefs>): Prefs {
    const before = this.prefs(userId)
    // расписание скана и слежку за папками задаёт только владелец
    const own = this.isOwner(userId) ? patch : Object.fromEntries(Object.entries(patch).filter(([k]) => !(SERVER_PREFS as readonly string[]).includes(k)))
    savePrefs(this.db, userId, own)
    const p = this.prefs(userId)
    if (this.isOwner(userId)) this.onPrefsChange?.(p)
    else if (p.trashDays < before.trashDays) void this.cleanTrash().catch(() => {})
    return p
  }

  async init() {
    for (const d of [this.tagCoverDir, this.customCoverDir]) await mkdir(d, { recursive: true })
    this.migrateRelativePaths()
    // первый запуск: одна папка — MUSIC_DIR (по умолчанию /music), дальше всё меняется в веб-морде
    if (!this.folderRows().length) {
      await mkdir(this.cfg.musicDir, { recursive: true })
      this.db.prepare('INSERT INTO folders (path, uploads, added_at, user_id) VALUES (?, 1, ?, ?)').run(this.cfg.musicDir, now(), this.ownerId() ?? null)
    }
    for (const f of this.folderRows()) await rm(join(f.path, TMP_DIR_NAME), { recursive: true, force: true })
    // и временные папки загрузок пользователей
    for (const u of this.db.prepare('SELECT login FROM users WHERE login IS NOT NULL').all() as { login: string }[])
      await rm(join(this.uploadFolder(), u.login, TMP_DIR_NAME), { recursive: true, force: true })
    void this.backfillTags()
      .then(() => this.numberMissing())
      .then(() => this.restoreTagCovers())
      .catch((e: Error) => this.log.warn({ err: e.message }, 'фоновое дочитывание упало'))
  }

  /**
   * Обложки из тегов лежат кэшем в <data>/covers/tag и в бэкап не входят (их можно достать из файла снова).
   * После восстановления бэкапа или переезда кэша нет — дочитываем недостающие из файлов в фоне, по одному
   */
  private restoring = false
  async restoreTagCovers() {
    if (this.restoring) return
    this.restoring = true
    try {
      const rows = this.db
        .prepare("SELECT id, path, file_name FROM tracks WHERE status = 'available' AND path IS NOT NULL AND tag_cover_mime IS NOT NULL")
        .all() as { id: string; path: string; file_name: string }[]
      const missing = rows.filter((r) => !existsSync(join(this.tagCoverDir, r.id)))
      if (!missing.length) return
      this.log.info({ tracks: missing.length }, 'достаю обложки из тегов заново (после бэкапа или переезда)')
      let got = 0
      for (const r of missing) {
        if (!existsSync(r.path)) continue
        try {
          const { picture } = await readFileTags(r.path, r.file_name)
          if (picture) {
            await this.saveTagCover(r.id, picture)
            got++
          }
        } catch {
          /* файл не читается — останется узор вместо обложки */
        }
      }
      this.log.info({ got, of: missing.length }, 'обложки из тегов восстановлены')
    } finally {
      this.restoring = false
    }
  }

  /**
   * Треки, теги которых читались старой версией разбора (без номера трека), дочитываем в фоне.
   * Скан уже известные файлы не перечитывает, поэтому без этого номер у них так и не появился бы.
   */
  private async backfillTags() {
    const rows = this.db
      .prepare(`SELECT id, path, file_name FROM tracks WHERE status = 'available' AND path IS NOT NULL AND tags_v < ?`)
      .all(TAGS_V) as { id: string; path: string; file_name: string }[]
    if (!rows.length) return
    this.log.info({ tracks: rows.length }, 'дочитываю теги (номер, ReplayGain)')
    let updated = 0
    for (const r of rows) {
      await this.withLock(r.id, async () => {
        const cur = this.trackRow(r.id)
        if (!cur || cur.status !== 'available') return
        let tags: TrackTags | null = null
        try {
          tags = (await readFileTags(r.path, r.file_name)).tags
        } catch {
          /* файл пропал или не читается — запомним, что пробовали */
        }
        const trackNo = tags?.trackNo ?? cur.track_no
        const changed = !!tags && (trackNo !== cur.track_no || tags.gain != null || tags.albumGain != null)
        tx(this.db, () => {
          // seq двигаем, только если что-то нашлось: клиентам незачем перекачивать трек без изменений
          if (changed) {
            this.db
              .prepare('UPDATE tracks SET track_no = ?, rg_track = ?, rg_album = ?, rg_peak = ?, tags_v = ?, seq = ? WHERE id = ?')
              .run(trackNo, tags!.gain ?? null, tags!.albumGain ?? null, tags!.peak ?? null, TAGS_V, nextSeq(this.db), r.id)
            updated++
          } else this.db.prepare('UPDATE tracks SET tags_v = ? WHERE id = ?').run(TAGS_V, r.id)
        })
      })
    }
    this.log.info({ tracks: rows.length, changed: updated }, 'теги дочитаны')
  }

  // До папок в базе tracks.path был относительным от MUSIC_DIR
  private migrateRelativePaths() {
    if (getSetting(this.db, 'paths') === 'absolute') return
    tx(this.db, () => {
      const rows = this.db.prepare('SELECT id, path FROM tracks WHERE path IS NOT NULL').all() as { id: string; path: string }[]
      const upd = this.db.prepare('UPDATE tracks SET path = ? WHERE id = ?')
      for (const r of rows) if (!isAbsolute(r.path)) upd.run(join(this.cfg.musicDir, ...r.path.split('/')), r.id)
      setSetting(this.db, 'paths', 'absolute')
    })
  }

  /** Сервер сейчас что-то переписывает (загрузка, теги, номера) */
  get busy() {
    return this.locks.size > 0
  }

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => {})
    this.locks.set(id, tail)
    try {
      return await run
    } finally {
      if (this.locks.get(id) === tail) this.locks.delete(id)
    }
  }

  // ---------- треки ----------

  private trackRow(id: string): TrackRow | undefined {
    return this.db.prepare(`${TRACK_SELECT} WHERE t.id = ?`).get(id) as TrackRow | undefined
  }

  /** Трек любого пользователя — для внутренних дел и тестов; запросы API идут через track(userId, id) */
  getTrack(id: string): Track | undefined {
    const r = this.trackRow(id)
    return r && toTrack(r)
  }

  /** Трек этого пользователя (чужой — как будто его нет) */
  track(userId: string, id: string): Track | undefined {
    const r = this.trackRow(id)
    return r && r.user_id === userId ? toTrack(r) : undefined
  }

  /** Трек пользователя, который есть в хранилище (не надгробие), иначе 404 */
  availableTrack(userId: string, id: string): Track {
    const t = this.track(userId, id)
    if (!t || t.status !== 'available') throw notFound('Трек не найден')
    return t
  }

  listTracks(userId: string): Track[] {
    const rows = this.db.prepare(`${TRACK_SELECT} WHERE t.user_id = ? AND t.status = 'available' ORDER BY t.added_at DESC, t.id`).all(userId) as unknown as TrackRow[]
    return rows.map(toTrack)
  }

  /** Чей это файл у этого пользователя: трек, у которого такой отпечаток был когда-либо (каким пришёл, после прошивки…) */
  trackByHash(userId: string, hash: string): TrackRow | undefined {
    const h = this.db.prepare('SELECT track_id FROM hashes WHERE user_id = ? AND hash = ?').get(userId, hash) as { track_id: string } | undefined
    const r = this.trackRow(h?.track_id ?? this.trackIdFor(userId, hash))
    return r?.user_id === userId ? r : undefined
  }

  /** Запомнить отпечаток файла за треком (зовётся внутри транзакции записи) */
  private rememberHash(userId: string, hash: string, trackId: string) {
    this.db
      .prepare('INSERT INTO hashes (user_id, hash, track_id, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, hash) DO UPDATE SET track_id = excluded.track_id')
      .run(userId, hash, trackId, now())
  }

  /**
   * Трек по отпечатку файла (для GET /tracks/by-hash) — по любому отпечатку из его истории: старая копия файла
   * (до прошивки тегов) на устройстве — это тот же трек, заливать её снова не нужно
   */
  getTrackByHash(userId: string, hash: string): Track | undefined {
    const r = this.trackByHash(userId, hash)
    return r && toTrack(r)
  }

  /** Абсолютный путь к файлу трека пользователя, если он на месте */
  trackFile(userId: string, id: string): { path: string; size: number; format: string } | undefined {
    const r = this.trackRow(id)
    if (!r || r.user_id !== userId || r.status !== 'available' || !r.path) return undefined
    return existsSync(r.path) ? { path: r.path, size: r.size, format: r.format } : undefined
  }

  /** Временная папка для загрузок — внутри папки загрузок пользователя, чтобы перенос файла был атомарным */
  async uploadTmpDir(userId: string): Promise<string> {
    const dir = join(this.userUploadDir(userId), TMP_DIR_NAME)
    await mkdir(dir, { recursive: true })
    return dir
  }

  /**
   * Загрузка через API: файл уже лежит во временной папке, хэш посчитан.
   * created = false, если такой трек уже был в хранилище (файл-дубликат удаляется).
   */
  async ingestUpload(userId: string, tmpFile: string, hash: string, originalName: string, source?: string): Promise<{ track: Track; created: boolean }> {
    const res = await this.withLock(`hash:${userId}:${hash}`, async () => {
      const existing = this.trackByHash(userId, hash)
      if (existing?.status === 'available' && existing.path && existsSync(existing.path)) {
        await rm(tmpFile, { force: true })
        return { track: toTrack(existing), created: false }
      }
      // трек удалили в MUSICH, а устройство прислало его снова — молча не возвращаем: решение на странице «Конфликты»
      if (existing?.status === 'deleted' && !existing.unlinked) {
        await this.holdConflict(userId, existing.id, tmpFile, originalName, source)
        throw new HttpError(409, 'deleted', 'Этот трек удалён в хранилище — вернуть его можно в «Сервер → Конфликты»')
      }
      // новый трек получает id от отпечатка файла; вернувшийся (файл пропал или папку убирали) — свой прежний id
      const id = existing?.id ?? this.trackIdFor(userId, hash)
      const format = audioFormat(originalName)
      if (!format) throw new HttpError(415, 'unsupported_media_type', `Неизвестный формат файла «${originalName}»`)
      let parsed: ParsedFile
      try {
        parsed = await readFileTags(tmpFile, originalName)
      } catch (e) {
        throw new HttpError(415, 'unsupported_media_type', `Не удалось прочитать аудио: ${(e as Error).message}`)
      }
      const { size } = await stat(tmpFile)
      let name = safeFileName(originalName)
      if (!audioFormat(name)) name = `${id}.${format}`
      const path = await this.placeFile(tmpFile, this.userUploadDir(userId), name, hash)
      await this.saveTagCover(id, parsed.picture)
      this.writeTrack(userId, id, hash, path, size, format, originalName, parsed, existing, source)
      // повторная заливка трека, чей файл пропал с диска, — это не новый трек
      return { track: this.getTrack(id)!, created: existing?.status !== 'available' }
    })
    if (!res.created) return res
    const numbered = await this.ensureNumber(res.track.id)
    return numbered ? { track: numbered.track, created: true } : res
  }

  /**
   * У каждого трека должен быть номер («№»): если в тегах его нет — следующий после самого большого,
   * записывается в файл (id трека прежний). Номера раздаются строго по одному, чтобы две загрузки не получили один
   */
  private ensureNumber(id: string): Promise<{ track: Track; previousId: string } | null> {
    // нумерация своя у каждого пользователя
    return this.withLock(`#numbering:${this.trackRow(id)?.user_id}`, async () => {
      const r = this.trackRow(id)
      if (!r || r.status !== 'available' || r.track_no != null || !this.prefs(r.user_id).autoNumber) return null
      const { mx } = this.db.prepare("SELECT MAX(track_no) AS mx FROM tracks WHERE user_id = ? AND status = 'available'").get(r.user_id) as { mx: number | null }
      try {
        return await this.renameTrack(id, { trackNo: (mx ?? 0) + 1 })
      } catch (e) {
        this.log.warn({ id, err: (e as Error).message }, 'не удалось записать номер трека')
        return null
      }
    })
  }

  /** Треки без номера (старые файлы без тега) получают номера по порядку добавления */
  private async numberMissing() {
    const rows = this.db.prepare("SELECT id FROM tracks WHERE status = 'available' AND track_no IS NULL ORDER BY added_at, id").all() as { id: string }[]
    if (!rows.length) return
    this.log.info({ tracks: rows.length }, 'присваиваю номера трекам без номера')
    for (const r of rows) await this.ensureNumber(r.id)
  }

  /** Файл нашёлся в одной из папок с музыкой при сканировании */
  ingestScanned(abs: string): Promise<'added' | 'moved' | 'skipped'> {
    let addedId = ''
    // чей файл — по папке (и подпапке загрузок пользователя); хозяина нет (сервер не настроен) — отдавать некому
    const userId = this.userForPath(abs)
    if (!userId) return Promise.resolve('skipped')
    return hashFile(abs).then((hash) =>
      this.withLock(`hash:${userId}:${hash}`, async () => {
        const existing = this.trackByHash(userId, hash)
        if (existing?.status === 'available') {
          if (existing.path === abs) return 'skipped'
          // старая версия файла (до прошивки) или копия — трек уже есть
          if ((existing.path && existsSync(existing.path)) || existing.hash !== hash) {
            this.log.debug({ file: abs, id: existing.id, original: existing.path }, 'скан: дубликат или старая версия, пропускаю')
            return 'skipped'
          }
          // файл переложили/переименовали — запомним новое место
          this.db.prepare('UPDATE tracks SET path = ? WHERE id = ?').run(abs, existing.id)
          return 'moved'
        }
        if (existing?.status === 'deleted' && !existing.unlinked) {
          // надгробие не воскрешаем сканом: вернуть трек можно только явной загрузкой
          this.log.info({ file: abs, id: existing.id }, 'скан: трек был удалён из хранилища, пропускаю')
          return 'skipped'
        }
        // нового трека нет в базе, или он пропал вместе с убранной папкой и теперь вернулся
        const id = existing?.id ?? this.trackIdFor(userId, hash)
        const fileName = basename(abs)
        const format = audioFormat(fileName)!
        let parsed: ParsedFile
        try {
          parsed = await readFileTags(abs, fileName)
        } catch (e) {
          this.log.warn({ file: abs, err: (e as Error).message }, 'скан: не удалось прочитать теги, пропускаю')
          return 'skipped'
        }
        const { size, mtimeMs } = await stat(abs)
        await this.saveTagCover(id, parsed.picture)
        this.writeTrack(userId, id, hash, abs, size, format, fileName, parsed, existing)
        this.db.prepare('UPDATE tracks SET mtime = ? WHERE id = ?').run(mtimeMs, id)
        addedId = id
        return 'added' as const
      }).then(async (res) => {
        // номер — уже вне блокировки: ensureNumber сам переписывает файл через renameTrack
        if (res === 'added') await this.ensureNumber(addedId)
        return res
      }),
    )
  }

  private writeTrack(
    userId: string, id: string, hash: string, path: string, size: number, format: string, fileName: string, parsed: ParsedFile, existing: TrackRow | undefined, source?: string,
  ) {
    const t = parsed.tags
    const coverMime = parsed.picture?.mime ?? null
    tx(this.db, () => {
      const seq = nextSeq(this.db)
      if (existing) {
        // вернувшийся трек — «пришёл» заново: новое время и новый источник
        const back = existing.status === 'deleted'
        this.db
          .prepare(
            `UPDATE tracks SET title = ?, artist = ?, album = ?, year = ?, track_no = ?, duration = ?, size = ?, format = ?, file_name = ?,
               path = ?, tag_cover_mime = ?, added_at = ?, status = 'available', unlinked = 0, source = ?, tags_v = ?, hash = ?, seq = ? WHERE id = ?`,
          )
          .run(t.title, t.artist, t.album, t.year ?? null, t.trackNo ?? null, t.duration, size, format, fileName, path, coverMime,
            back ? now() : existing.added_at, back ? (source ?? null) : existing.source, TAGS_V, hash, seq, id)
      } else {
        this.db
          .prepare(
            `INSERT INTO tracks (id, title, artist, album, year, track_no, duration, size, format, file_name, path, tag_cover_mime, added_at, status, source, tags_v, hash, orig_hash,
               orig_title, orig_artist, orig_album, orig_year, orig_track_no, seq, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, t.title, t.artist, t.album, t.year ?? null, t.trackNo ?? null, t.duration, size, format, fileName, path, coverMime, now(),
            source ?? null, TAGS_V, hash, hash, t.title, t.artist, t.album, t.year ?? null, t.trackNo ?? null, seq, userId)
      }
      this.rememberHash(userId, hash, id)
      this.setGain(id, t)
      this.applyOv(id)
    })
  }

  /** Правки «только в MUSICH» — поверх только что прочитанных тегов (зовётся внутри транзакции записи) */
  private applyOv(id: string) {
    const row = this.db.prepare('SELECT ov FROM tracks WHERE id = ?').get(id) as { ov: string | null } | undefined
    const ov = parseOv(row?.ov ?? null)
    if (!Object.keys(ov).length) return
    this.db
      .prepare(
        `UPDATE tracks SET title = COALESCE(?, title), artist = COALESCE(?, artist), album = COALESCE(?, album),
           year = CASE WHEN ? IS NULL THEN year WHEN ? = 0 THEN NULL ELSE ? END WHERE id = ?`,
      )
      .run(ov.title ?? null, ov.artist ?? null, ov.album ?? null, ov.year ?? null, ov.year ?? null, ov.year ?? null, id)
  }

  /** Клиент измерил громкость трека (у него нет ReplayGain) — запоминаем для всех устройств */
  setAutoGain(userId: string, id: string, gain: number): Track {
    const r = this.trackRow(id)
    if (!r || r.user_id !== userId || r.status !== 'available') throw notFound('Трек не найден')
    tx(this.db, () => {
      this.db.prepare('UPDATE tracks SET auto_gain = ?, seq = ? WHERE id = ?').run(Math.round(gain * 10) / 10, nextSeq(this.db), id)
    })
    return this.getTrack(id)!
  }

  /** Записать в сам файл трека (через копию), имя файла прежнее; id тот же, отпечаток новый */
  private async writeIntoFile(old: TrackRow, tags: TagPatch) {
    const path = old.path!
    const tmpDir = join(dirname(path), TMP_DIR_NAME)
    await mkdir(tmpDir, { recursive: true })
    const tmp = join(tmpDir, `${randomUUID()}${extname(path)}`)
    try {
      await copyFile(path, tmp)
      try {
        writeFileTags(tmp, tags)
      } catch (e) {
        throw new HttpError(422, 'unprocessable', `Не удалось записать в файл: ${(e as Error).message}`)
      }
      const hash = await hashFile(tmp)
      const clash = this.trackByHash(old.user_id, hash)
      if (clash && clash.id !== old.id && clash.status === 'available') throw new HttpError(409, 'conflict', 'Ровно такой файл уже есть в хранилище')
      const parsed = await readFileTags(tmp, basename(path))
      await rename(tmp, path)
      const { size, mtimeMs } = await stat(path)
      await this.updateFromFile(old, hash, path, size, mtimeMs, parsed)
    } finally {
      await rm(tmp, { force: true })
    }
  }

  /** Вшить обложку в файл трека (режим правки «файл») */
  private embedCover(id: string, mime: string, data: Uint8Array): Promise<void> {
    return this.withLock(id, async () => {
      const old = this.trackRow(id)
      if (!old || old.status !== 'available' || !old.path || !existsSync(old.path)) throw notFound('Трек не найден')
      await this.writeIntoFile(old, { picture: { mime, data } })
      this.db.prepare('UPDATE tracks SET cover_embedded = 1 WHERE id = ?').run(id)
    })
  }

  /** Своя обложка альбома — во все файлы альбома. Трек, который не удалось переписать, не мешает остальным */
  async embedAlbumCover(userId: string, album: string): Promise<{ done: number; failed: number }> {
    const own = this.customCover(userId, 'album', album)
    if (!own) throw notFound('У альбома нет своей обложки')
    const data = await readFile(own.path)
    const rows = this.db.prepare("SELECT id FROM tracks WHERE user_id = ? AND status = 'available' AND album = ?").all(userId, album) as { id: string }[]
    let done = 0
    let failed = 0
    for (const r of rows) {
      try {
        await this.embedCover(r.id, own.mime, data)
        done++
      } catch (e) {
        failed++
        this.log.warn({ id: r.id, err: (e as Error).message }, 'обложка альбома: трек пропущен')
      }
    }
    return { done, failed }
  }

  // ---------- конфликты ----------

  /** Присланный файл удалённого трека — в .musich-conflicts папки для загрузок, ждать решения */
  private async holdConflict(userId: string, trackId: string, tmpFile: string, fileName: string, source?: string) {
    const known = this.db.prepare("SELECT file FROM conflicts WHERE kind = 'returned' AND track_id = ?").get(trackId) as { file: string } | undefined
    if (known && existsSync(known.file)) {
      await rm(tmpFile, { force: true }) // уже ждёт решения — второй раз то же самое не держим
      return
    }
    const dir = join(this.uploadFolder(), CONFLICT_DIR_NAME)
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${randomUUID()}${extname(fileName) || '.audio'}`)
    await moveFile(tmpFile, file)
    tx(this.db, () => {
      this.db.prepare("DELETE FROM conflicts WHERE kind = 'returned' AND track_id = ?").run(trackId)
      this.db
        .prepare("INSERT INTO conflicts (id, kind, track_id, file, file_name, source, created_at, user_id) VALUES (?, 'returned', ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), trackId, file, fileName, source ?? null, now(), userId)
    })
    this.log.info({ trackId, source }, 'конфликт: удалённый трек прислали снова')
  }

  /** Что ждёт решения: вернувшиеся удалённые треки и возможные дубли (одинаковые исполнитель и название) */
  listConflicts(userId: string): Conflicts {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.track_id, c.file_name, c.source, c.created_at, t.title, t.artist
         FROM conflicts c JOIN tracks t ON t.id = c.track_id WHERE c.user_id = ? ORDER BY c.created_at DESC`,
      )
      .all(userId) as { id: string; track_id: string; file_name: string; source: string | null; created_at: string; title: string; artist: string }[]
    const ignored = new Set(JSON.parse(getUserSetting(this.db, userId, 'dupIgnored') ?? '[]') as string[])
    const groups = new Map<string, Track[]>()
    for (const t of this.listTracks(userId)) {
      const key = `${normName(t.artist)}—${normName(t.title)}`
      if (!ignored.has(key)) groups.set(key, [...(groups.get(key) ?? []), t])
    }
    return {
      returned: rows.map((r) => ({
        id: r.id, trackId: r.track_id, title: r.title, artist: r.artist, fileName: r.file_name, createdAt: r.created_at,
        ...(r.source ? { source: r.source } : {}),
      })),
      duplicates: [...groups].filter(([, l]) => l.length > 1).map(([key, tracks]) => ({ key, tracks })),
    }
  }

  /** «Вернуть» — трек снова в библиотеке (из корзины или из присланного файла); «не нужен» — присланный файл стираем */
  async resolveConflict(userId: string, id: string, action: 'restore' | 'discard'): Promise<Track | undefined> {
    const c = this.db.prepare('SELECT * FROM conflicts WHERE id = ? AND user_id = ?').get(id, userId) as
      | { track_id: string; file: string; file_name: string; source: string | null }
      | undefined
    if (!c) throw notFound('Такого конфликта нет')
    const drop = async () => {
      await rm(c.file, { force: true })
      this.db.prepare('DELETE FROM conflicts WHERE id = ?').run(id)
    }
    if (action === 'discard') return void (await drop())
    const r = this.trackRow(c.track_id)
    if (r?.status === 'available') {
      await drop()
      return toTrack(r)
    }
    // ещё в корзине — возвращаем оттуда (с прежним местом), присланная копия не нужна
    if (this.db.prepare('SELECT 1 FROM trash WHERE track_id = ?').get(c.track_id)) {
      const t = await this.restoreTrash(userId, c.track_id)
      await drop()
      return t
    }
    if (!existsSync(c.file)) {
      await drop()
      throw notFound('Присланный файл пропал с диска')
    }
    const hash = await hashFile(c.file)
    const res = await this.withLock(c.track_id, async () => {
      const parsed = await readFileTags(c.file, c.file_name)
      const format = audioFormat(c.file_name) ?? r?.format ?? 'mp3'
      const { size } = await stat(c.file)
      const path = await this.placeFile(c.file, this.userUploadDir(userId), safeFileName(c.file_name) || `${c.track_id}.${format}`, hash)
      await this.saveTagCover(c.track_id, parsed.picture)
      this.writeTrack(userId, c.track_id, hash, path, size, format, c.file_name, parsed, r, c.source ?? undefined)
      this.db.prepare('DELETE FROM conflicts WHERE id = ?').run(id)
      return this.getTrack(c.track_id)!
    })
    const numbered = await this.numberRestored(c.track_id)
    return numbered?.track ?? res
  }

  /** «Это разные треки» — группу возможных дублей больше не показываем */
  ignoreDuplicate(userId: string, key: string) {
    const list = new Set(JSON.parse(getUserSetting(this.db, userId, 'dupIgnored') ?? '[]') as string[])
    list.add(key)
    setUserSetting(this.db, userId, 'dupIgnored', JSON.stringify([...list]))
  }

  /** Убрать правки «только в MUSICH»: снова как в тегах файла */
  resetOverrides(userId: string, id: string): Promise<Track> {
    return this.withLock(id, async () => {
      const r = this.trackRow(id)
      if (!r || r.user_id !== userId || r.status !== 'available' || !r.path) throw notFound('Трек не найден')
      if (!r.ov) return toTrack(r)
      const t = (await readFileTags(r.path, basename(r.path))).tags
      tx(this.db, () => {
        this.db
          .prepare('UPDATE tracks SET title = ?, artist = ?, album = ?, year = ?, ov = NULL, seq = ? WHERE id = ?')
          .run(t.title, t.artist, t.album, t.year ?? null, nextSeq(this.db), id)
      })
      return this.getTrack(id)!
    })
  }

  /** ReplayGain из тегов — в строку трека (зовётся внутри транзакции записи) */
  private setGain(id: string, t: TrackTags) {
    this.db.prepare('UPDATE tracks SET rg_track = ?, rg_album = ?, rg_peak = ? WHERE id = ?').run(t.gain ?? null, t.albumGain ?? null, t.peak ?? null, id)
  }

  /**
   * Кладёт файл в папку загрузок пользователя dir, никогда не перезаписывая чужие файлы.
   * Если там уже лежит ровно этот же файл — используем его. Возвращает абсолютный путь.
   */
  private async placeFile(src: string, dir: string, name: string, hash: string): Promise<string> {
    const ext = extname(name)
    const base = name.slice(0, name.length - ext.length)
    const candidates = [name, `${base} (${hash.slice(0, 8)})${ext}`, `${hash}${ext}`]
    await mkdir(dir, { recursive: true })
    for (const cand of candidates) {
      const dst = join(dir, cand)
      if (existsSync(dst)) {
        if (await hashFile(dst).catch(() => '') === hash) {
          await rm(src, { force: true })
          return dst
        }
        continue
      }
      try {
        // link + unlink: атомарно и без перезаписи (EEXIST, если файл успел появиться)
        await link(src, dst)
        await unlink(src)
        return dst
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'EEXIST') continue
        try {
          await copyFile(src, dst, constants.COPYFILE_EXCL)
        } catch (e2) {
          if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') continue
          throw e2
        }
        await rm(src, { force: true })
        return dst
      }
    }
    throw new HttpError(409, 'conflict', `Не удалось подобрать имя файла для «${name}»`)
  }

  private async saveTagCover(id: string, picture: ParsedFile['picture']) {
    await rm(join(this.tagCoverDir, id), { force: true })
    if (picture) await writeFile(join(this.tagCoverDir, id), picture.data)
  }

  /** Удаление из хранилища: надгробие, а файл — в корзину (не вышло перенести — удаляем, как раньше) */
  deleteTrack(userId: string, id: string): Promise<void> {
    return this.withLock(id, async () => {
      const r = this.trackRow(id)
      if (!r || r.user_id !== userId) throw notFound('Трек не найден')
      if (r.status === 'deleted') return
      let trashed: string | null = null
      if (r.path && existsSync(r.path)) {
        trashed = await this.moveToTrash(r.path, id).catch((e: Error) => {
          this.log.warn({ file: r.path, err: e.message }, 'не удалось убрать файл в корзину — удаляю')
          return null
        })
      }
      tx(this.db, () => {
        const seq = nextSeq(this.db)
        this.db.prepare("UPDATE tracks SET status = 'deleted', path = NULL, tag_cover_mime = NULL, seq = ? WHERE id = ?").run(seq, id)
        if (trashed) {
          this.db
            .prepare('INSERT OR REPLACE INTO trash (track_id, file, orig_path, deleted_at, user_id) VALUES (?, ?, ?, ?, ?)')
            .run(id, trashed, r.path, now(), userId)
        }
      })
      if (r.path && !trashed) {
        await rm(r.path, { force: true }).catch((e: Error) =>
          this.log.warn({ file: r.path, err: e.message }, 'не удалось удалить файл трека'),
        )
      }
      await rm(join(this.tagCoverDir, id), { force: true })
      // номер у трека был свой (не делил его с другим) — закрываем дыру: всё, что после, на единицу назад
      if (this.prefs(userId).shiftOnDelete && r.track_no != null && !this.db.prepare("SELECT 1 FROM tracks WHERE user_id = ? AND status = 'available' AND track_no = ?").get(userId, r.track_no)) {
        void this.shiftAfter(userId, r.track_no)
      }
    })
  }

  // ---------- корзина ----------

  /**
   * Файл — в .musich-trash той папки с музыкой, где он лежал: тот же диск, перенос мгновенный.
   * Скан папки с точкой не обходит, так что из корзины трек сам не «воскреснет»
   */
  private async moveToTrash(path: string, id: string): Promise<string> {
    const root = this.folderPaths().find((f) => isInside(path, f)) ?? dirname(path)
    const dir = join(root, TRASH_DIR_NAME)
    await mkdir(dir, { recursive: true })
    const dst = join(dir, `${id}${extname(path)}`)
    await moveFile(path, dst)
    return dst
  }

  listTrash(userId: string): TrashItem[] {
    const days = this.prefs(userId).trashDays
    const rows = this.db
      .prepare(
        `SELECT t.*, tr.deleted_at AS deleted_at FROM trash tr JOIN tracks t ON t.id = tr.track_id
         WHERE tr.user_id = ? AND t.status = 'deleted' ORDER BY tr.deleted_at DESC`,
      )
      .all(userId) as unknown as (TrackRow & { deleted_at: string })[]
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      artist: r.artist,
      album: r.album,
      ...(r.track_no != null ? { trackNo: r.track_no } : {}),
      duration: r.duration,
      size: r.size,
      format: r.format,
      fileName: r.file_name,
      deletedAt: r.deleted_at,
      expiresAt: new Date(Date.parse(r.deleted_at) + days * 86_400_000).toISOString(),
    }))
  }

  /**
   * Вернуть трек из корзины на прежнее место. Его номер за это время мог занять другой (сдвиг после удаления) —
   * тогда трек встаёт в конец, чтобы не раздвигать середину
   */
  async restoreTrash(userId: string, id: string): Promise<Track> {
    await this.withLock(id, async () => {
      const e = this.db.prepare('SELECT file, orig_path FROM trash WHERE track_id = ? AND user_id = ?').get(id, userId) as { file: string; orig_path: string } | undefined
      const r = this.trackRow(id)
      if (!e || !r || r.user_id !== userId || r.status !== 'deleted') throw notFound('В корзине такого трека нет')
      if (!existsSync(e.file)) {
        this.db.prepare('DELETE FROM trash WHERE track_id = ?').run(id)
        throw notFound('Файл в корзине пропал с диска')
      }
      let target = e.orig_path
      if (existsSync(target)) {
        const ext = extname(target)
        target = `${target.slice(0, target.length - ext.length)} (${id.slice(0, 8)})${ext}`
      }
      await mkdir(dirname(target), { recursive: true })
      await moveFile(e.file, target)
      const parsed = await readFileTags(target, basename(target))
      const { size, mtimeMs } = await stat(target)
      await this.saveTagCover(id, parsed.picture)
      this.writeTrack(userId, id, r.hash ?? id, target, size, r.format, r.file_name, parsed, r, r.source ?? undefined)
      // это не новый трек: прежняя дата добавления, корзина больше не держит файл
      tx(this.db, () => {
        this.db.prepare('UPDATE tracks SET added_at = ?, mtime = ? WHERE id = ?').run(r.added_at, mtimeMs, id)
        this.db.prepare('DELETE FROM trash WHERE track_id = ?').run(id)
      })
    })
    const moved = await this.numberRestored(id)
    return moved?.track ?? this.getTrack(id)!
  }

  private numberRestored(id: string): Promise<{ track: Track; previousId: string } | null> {
    return this.withLock(`#numbering:${this.trackRow(id)?.user_id}`, async () => {
      const r = this.trackRow(id)
      if (!r || r.status !== 'available') return null
      const u = r.user_id
      if (r.track_no == null ? !this.prefs(u).autoNumber : !this.db.prepare("SELECT 1 FROM tracks WHERE user_id = ? AND status = 'available' AND track_no = ? AND id <> ?").get(u, r.track_no, id)) return null
      const { mx } = this.db.prepare("SELECT MAX(track_no) AS mx FROM tracks WHERE user_id = ? AND status = 'available' AND id <> ?").get(u, id) as { mx: number | null }
      try {
        return await this.renameTrack(id, { trackNo: (mx ?? 0) + 1 })
      } catch (e) {
        this.log.warn({ id, err: (e as Error).message }, 'возврат из корзины: не удалось записать номер')
        return null
      }
    })
  }

  /** Стереть из корзины насовсем: один трек или всё */
  async purgeTrash(userId: string, id?: string) {
    const rows = (id
      ? this.db.prepare('SELECT track_id, file FROM trash WHERE track_id = ? AND user_id = ?').all(id, userId)
      : this.db.prepare('SELECT track_id, file FROM trash WHERE user_id = ?').all(userId)) as { track_id: string; file: string }[]
    if (id && !rows.length) throw notFound('В корзине такого трека нет')
    for (const r of rows) await this.dropTrash(r)
  }

  /** Истёк срок — стираем сами; заодно то, что вернулось другим путём (тот же файл залили заново) */
  async cleanTrash() {
    // срок корзины у каждого пользователя свой
    const rows: { track_id: string; file: string }[] = []
    for (const { user_id } of this.db.prepare('SELECT DISTINCT user_id FROM trash').all() as { user_id: string | null }[]) {
      const before = new Date(Date.now() - this.prefs(user_id ?? undefined).trashDays * 86_400_000).toISOString()
      rows.push(
        ...(this.db
          .prepare(
            `SELECT tr.track_id, tr.file FROM trash tr LEFT JOIN tracks t ON t.id = tr.track_id
             WHERE tr.user_id IS ? AND (tr.deleted_at < ? OR t.status IS NOT 'deleted')`,
          )
          .all(user_id, before) as { track_id: string; file: string }[]),
      )
    }
    for (const r of rows) await this.dropTrash(r)
    if (rows.length) this.log.info({ tracks: rows.length }, 'корзина: старые треки стёрты')
  }

  private async dropTrash(r: { track_id: string; file: string }) {
    await rm(r.file, { force: true }).catch((e: Error) => this.log.warn({ file: r.file, err: e.message }, 'корзина: не удалось стереть файл'))
    this.db.prepare('DELETE FROM trash WHERE track_id = ?').run(r.track_id)
  }

  /**
   * Нумерация сплошная: удалили №6 — №7, 8, 9… становятся №6, 7, 8…
   * Номер — тег в файле, поэтому каждый сдвинутый трек переписывается (как renameTrack, с новым id)
   */
  private shiftAfter(userId: string, no: number): Promise<void> {
    return this.withLock(`#numbering:${userId}`, async () => {
      const rows = this.db
        .prepare("SELECT id, track_no FROM tracks WHERE user_id = ? AND status = 'available' AND track_no > ? ORDER BY track_no, added_at, id")
        .all(userId, no) as { id: string; track_no: number }[]
      let failed = 0
      for (const r of rows) {
        try {
          await this.renameTrack(r.id, { trackNo: r.track_no - 1 })
        } catch (e) {
          failed++
          this.log.warn({ id: r.id, err: (e as Error).message }, 'сдвиг номеров: трек пропущен')
        }
      }
      if (rows.length) this.log.info({ after: no, shifted: rows.length - failed, failed }, 'номера после удалённого сдвинуты')
    })
  }

  /**
   * Пронумеровать всю библиотеку подряд 1…N в нынешнем порядке (по номеру, при равных — кто раньше добавлен).
   * Закрывает дыры и разводит одинаковые номера; переписывает только те треки, чей номер меняется.
   * Идёт в фоне; возвращает, сколько треков поменяют номер
   */
  renumberAll(userId: string): { changes: number } {
    const rows = this.db
      .prepare("SELECT id, track_no FROM tracks WHERE user_id = ? AND status = 'available' ORDER BY track_no IS NULL, track_no, added_at, id")
      .all(userId) as { id: string; track_no: number | null }[]
    const plan = rows.map((r, i) => ({ id: r.id, from: r.track_no, to: i + 1 })).filter((p) => p.from !== p.to)
    void this.withLock(`#numbering:${userId}`, async () => {
      let failed = 0
      for (const [i, p] of plan.entries()) {
        if (i % 25 === 0) this.log.info({ done: i, total: plan.length }, 'перенумерация идёт')
        try {
          await this.renameTrack(p.id, { trackNo: p.to })
        } catch (e) {
          failed++
          this.log.warn({ id: p.id, err: (e as Error).message }, 'перенумерация: трек пропущен')
        }
      }
      this.log.info({ changed: plan.length - failed, failed }, 'библиотека пронумерована подряд')
    })
    return { changes: plan.length }
  }

  /** Файла трека больше нет в папке (удалили с диска мимо MUSICH) — убираем из библиотеки; вернётся файл — скан вернёт и трек */
  forgetMissing(path: string) {
    tx(this.db, () => {
      this.db.prepare("UPDATE tracks SET status = 'deleted', unlinked = 1, seq = ? WHERE path = ? AND status = 'available'").run(nextSeq(this.db), path)
    })
  }

  setLike(userId: string, id: string, liked: boolean): Track {
    const t = this.availableTrack(userId, id)
    if (t.liked !== liked) {
      tx(this.db, () => {
        const seq = nextSeq(this.db)
        if (liked) this.db.prepare('INSERT INTO likes (track_id, liked_at, user_id) VALUES (?, ?, ?)').run(id, now(), userId)
        else this.db.prepare('DELETE FROM likes WHERE track_id = ?').run(id)
        this.db.prepare('UPDATE tracks SET seq = ? WHERE id = ?').run(seq, id)
      })
    }
    return this.getTrack(id)!
  }

  /**
   * Правка тегов. В режиме «файл» новые теги пишутся в сам файл: id трека прежний, меняется только отпечаток
   * (устройства по нему видят, что файл надо скачать заново). В режиме «только в MUSICH» — правка поверх тегов.
   * Имя файла — по правилу из настроек
   */
  renameTrack(id: string, patch: TagPatch): Promise<{ track: Track; previousId: string }> {
    return this.withLock(id, async () => {
      const old = this.trackRow(id)
      if (!old || old.status !== 'available' || !old.path || !existsSync(old.path)) throw notFound('Трек не найден')
      const ov = parseOv(old.ov)
      const fileMode = this.prefs(old.user_id).editMode === 'file'
      // «только в MUSICH»: запоминаем правку поверх тегов — файл и id прежние. Номер всегда пишется в файл
      if (!fileMode && patch.trackNo === undefined) {
        const nextOv: Overrides = { ...ov }
        if (patch.title?.trim()) nextOv.title = patch.title.trim()
        if (patch.artist?.trim()) nextOv.artist = patch.artist.trim()
        if (patch.album?.trim()) nextOv.album = patch.album.trim()
        if (patch.year !== undefined) nextOv.year = patch.year
        tx(this.db, () => {
          this.db.prepare('UPDATE tracks SET ov = ?, seq = ? WHERE id = ?').run(JSON.stringify(nextOv), nextSeq(this.db), id)
          this.applyOv(id)
        })
        return { track: this.getTrack(id)!, previousId: id }
      }
      const next = { title: patch.title?.trim() || old.title, artist: patch.artist?.trim() || old.artist, album: patch.album?.trim() || old.album }
      // в файл пишем только то, что поменялось: альбом «как название» у сингла не должен стать настоящим тегом
      const tags: TagPatch = {}
      if (next.title !== old.title) tags.title = next.title
      if (next.artist !== old.artist) tags.artist = next.artist
      if (next.album !== old.album) tags.album = next.album
      if (patch.year !== undefined && patch.year !== (old.year ?? 0)) tags.year = patch.year
      if (patch.trackNo !== undefined && patch.trackNo !== old.track_no) tags.trackNo = patch.trackNo
      // режим «файл», а у трека остались правки «только в MUSICH» — заодно переносим их в теги, чтобы файл и MUSICH совпали
      const materialize = fileMode && !!old.ov
      if (materialize) {
        if (ov.title !== undefined) tags.title = next.title
        if (ov.artist !== undefined) tags.artist = next.artist
        if (ov.album !== undefined) tags.album = next.album
        if (ov.year !== undefined && patch.year === undefined) tags.year = ov.year
      }
      if (!Object.keys(tags).length) return { track: toTrack(old), previousId: id }

      const dir = dirname(old.path)
      const ext = extname(old.path)
      const tmpDir = join(dir, TMP_DIR_NAME)
      await mkdir(tmpDir, { recursive: true })
      const tmp = join(tmpDir, `${randomUUID()}${ext}`)
      try {
        // правим копию: если что-то пойдёт не так, исходный файл останется целым
        await copyFile(old.path, tmp)
        try {
          writeFileTags(tmp, tags)
        } catch (e) {
          throw new HttpError(422, 'unprocessable', `Не удалось записать теги: ${(e as Error).message}`)
        }
        const newHash = await hashFile(tmp)
        const clash = this.trackByHash(old.user_id, newHash)
        if (clash && clash.id !== id && clash.status === 'available') throw new HttpError(409, 'conflict', 'Ровно такой файл уже есть в хранилище')
        const parsed = await readFileTags(tmp, basename(old.path))

        // имя файла — по правилу из настроек: «Артист - Название», «0042 Артист - Название» или не трогать
        const rule = this.prefs(old.user_id).fileNames
        // имя трогаем, только если поменялось то, из чего оно состоит (смена одного номера — не повод при «Артист - Название»)
        const nameChanged = tags.title !== undefined || tags.artist !== undefined || (rule === 'number-artist-title' && tags.trackNo !== undefined)
        let target = old.path
        if (rule !== 'keep' && nameChanged) {
          const no = parsed.tags.trackNo
          const name = `${next.artist} - ${next.title}`
          const base = safeFileName(rule === 'number-artist-title' && no ? `${String(no).padStart(4, '0')} ${name}` : name)
          target = join(dir, `${base}${ext}`)
          if (!samePath(target, old.path) && existsSync(target)) target = join(dir, `${base} (${id.slice(0, 8)})${ext}`)
        }
        if (samePath(target, old.path)) {
          await rename(tmp, old.path)
          // на Windows «Abc» и «abc» — один файл: меняем только регистр в имени
          if (target !== old.path) await rename(old.path, target)
        } else {
          await rename(tmp, target)
          await rm(old.path, { force: true })
        }

        const { size, mtimeMs } = await stat(target)
        await this.updateFromFile(old, newHash, target, size, mtimeMs, parsed, materialize ? null : old.ov)
        this.log.info({ id, hash: newHash, file: target }, 'теги записаны в файл')
        return { track: this.getTrack(id)!, previousId: id }
      } finally {
        await rm(tmp, { force: true })
      }
    })
  }

  /**
   * Файл трека теперь другой (теги переписали в MUSICH или прямо на диске): тот же трек и id, новые теги и отпечаток.
   * Старый отпечаток остаётся в истории — старую копию файла сервер узнает
   */
  private async updateFromFile(old: TrackRow, hash: string, target: string, size: number, mtime: number, parsed: ParsedFile, ov: string | null = old.ov) {
    const id = old.id
    await this.saveTagCover(id, parsed.picture)
    const t = parsed.tags
    tx(this.db, () => {
      this.db
        .prepare(
          `UPDATE tracks SET title = ?, artist = ?, album = ?, year = ?, track_no = ?, file_name = ?, path = ?, size = ?, mtime = ?,
             tag_cover_mime = ?, hash = ?, ov = ?, seq = ? WHERE id = ?`,
        )
        .run(t.title, t.artist, t.album, t.year ?? null, t.trackNo ?? null, basename(target), target, size, mtime,
          parsed.picture?.mime ?? null, hash, ov, nextSeq(this.db), id)
      this.rememberHash(old.user_id, hash, id)
      this.setGain(id, t)
      this.applyOv(id)
    })
  }

  /**
   * Скан: файл на старом месте, но изменился на диске (размер или время) — теги могли переписать мимо MUSICH.
   * Содержимое то же — просто запоминаем время; другое — перечитываем теги (id прежний, новый отпечаток)
   */
  refreshChanged(abs: string, id: string): Promise<'updated' | 'skipped'> {
    return this.withLock(id, async () => {
      const old = this.trackRow(id)
      if (!old || old.status !== 'available' || old.path !== abs) return 'skipped'
      const { size, mtimeMs } = await stat(abs)
      const hash = await hashFile(abs)
      if (hash === (old.hash ?? id)) {
        this.db.prepare('UPDATE tracks SET mtime = ? WHERE id = ?').run(mtimeMs, id)
        return 'skipped'
      }
      const clash = this.trackByHash(old.user_id, hash)
      if (clash && clash.id !== id && clash.status === 'available') {
        // ровно такой файл уже есть в библиотеке в другом месте — этот считаем его копией
        this.log.warn({ file: abs, same: clash.path }, 'скан: файл изменили, и он совпал с другим треком — пропускаю')
        return 'skipped'
      }
      let parsed: ParsedFile
      try {
        parsed = await readFileTags(abs, basename(abs))
      } catch (e) {
        this.log.warn({ file: abs, err: (e as Error).message }, 'скан: файл изменили, но теги не читаются — пропускаю')
        return 'skipped'
      }
      await this.updateFromFile(old, hash, abs, size, mtimeMs, parsed)
      this.log.info({ id, hash, file: abs }, 'скан: файл изменили на диске — теги перечитаны')
      return 'updated'
    })
  }

  /**
   * Переименование артиста: у каждого его трека новое имя пишется в файл (как renameTrack; id прежний),
   * в совместных треках меняется только он: «Kordhell, Ravens Rock» → «KORDHELL, Ravens Rock».
   * Своя картинка артиста переезжает на новое имя. Трек, который не удалось переписать, не мешает остальным.
   */
  async renameArtist(userId: string, from: string, to: string): Promise<{ renamed: { track: Track; previousId: string }[]; failed: number }> {
    const name = to.trim()
    if (!name) throw badRequest('Пустое имя')
    const rows = this.db.prepare("SELECT id, artist FROM tracks WHERE user_id = ? AND status = 'available'").all(userId) as { id: string; artist: string }[]
    const seps = this.prefs(userId).separators
    const targets = rows.filter((r) => hasArtist(r.artist, from, seps))
    if (!targets.length) throw notFound('Таких треков нет')
    const renamed: { track: Track; previousId: string }[] = []
    let failed = 0
    for (const r of targets) {
      try {
        renamed.push(await this.renameTrack(r.id, { artist: replaceArtist(r.artist, from, name, seps) }))
      } catch (e) {
        failed++
        this.log.warn({ id: r.id, err: (e as Error).message }, 'переименование артиста: трек пропущен')
      }
    }
    await this.moveArtistCover(userId, from, name)
    return { renamed, failed }
  }

  /**
   * Перенос трека на номер to (номер — тег в файле, «№» в проводнике): треки между старым и новым местом
   * сдвигаются на единицу, остальные не трогаются. Каждый изменённый трек переписывается как в renameTrack
   * (новый id). Треки с тем же номером, что был у переносимого (дубли из другой папки), остаются на месте.
   */
  // под той же блокировкой, что сдвиг после удаления, автономер и перенумерация: иначе план строится по устаревшим номерам
  moveTrackNumber(userId: string, id: string, to: number): Promise<{ renamed: { track: Track; previousId: string }[]; failed: number }> {
    return this.withLock(`#numbering:${userId}`, () => this.moveTrackNumberNow(userId, id, to))
  }

  private async moveTrackNumberNow(userId: string, id: string, to: number): Promise<{ renamed: { track: Track; previousId: string }[]; failed: number }> {
    const t = this.availableTrack(userId, id)
    const from = t.trackNo
    if (from === to) return { renamed: [], failed: 0 }
    // без номера — как будто стоял после всех: сдвигаем всех, у кого номер >= to
    const shift = (
      from === undefined
        ? this.db.prepare("SELECT id, track_no FROM tracks WHERE user_id = ? AND status = 'available' AND track_no >= ?").all(userId, to)
        : to < from
          ? this.db.prepare("SELECT id, track_no FROM tracks WHERE user_id = ? AND status = 'available' AND track_no >= ? AND track_no < ?").all(userId, to, from)
          : this.db.prepare("SELECT id, track_no FROM tracks WHERE user_id = ? AND status = 'available' AND track_no > ? AND track_no <= ?").all(userId, from, to)
    ) as { id: string; track_no: number }[]
    const step = from === undefined || to < from ? 1 : -1
    const renamed: { track: Track; previousId: string }[] = []
    let failed = 0
    for (const [tid, no] of [...shift.filter((r) => r.id !== id).map((r) => [r.id, r.track_no + step] as const), [id, to] as const]) {
      try {
        renamed.push(await this.renameTrack(tid, { trackNo: no }))
      } catch (e) {
        failed++
        this.log.warn({ id: tid, err: (e as Error).message }, 'перенумерация: трек пропущен')
      }
    }
    this.log.info({ id, from, to, changed: renamed.length, failed }, 'трек перенесён на другой номер')
    return { renamed, failed }
  }

  /** Своя картинка артиста — на новое имя, если у нового имени своей ещё нет */
  private async moveArtistCover(userId: string, from: string, to: string) {
    if (from === to) return
    const src = this.customCoverRow(userId, 'artist', from)
    if (!src?.file || this.customCoverRow(userId, 'artist', to)) return
    const data = await readFile(join(this.customCoverDir, src.file))
    await this.setCover(userId, 'artist', to, src.mime!, data)
    await this.deleteCover(userId, 'artist', from)
  }

  // ---------- история прослушиваний ----------

  recordPlay(userId: string, trackId: string, source?: string, at?: string): Play {
    this.availableTrack(userId, trackId)
    // время из будущего (сбитые часы) — считаем «сейчас»
    const t = at ? Date.parse(at) : NaN
    const playedAt = Number.isFinite(t) && t <= Date.now() ? new Date(t).toISOString() : now()
    // телефон хранит историю у себя и может прислать одно прослушивание дважды (связь оборвалась после записи) —
    // то же трек и та же миллисекунда — это оно и есть
    const dup = at && this.db.prepare('SELECT source FROM plays WHERE track_id = ? AND played_at = ?').get(trackId, playedAt)
    if (dup) return { trackId, playedAt, ...((dup as { source: string | null }).source ? { source: (dup as { source: string }).source } : {}) }
    this.db.prepare('INSERT INTO plays (track_id, played_at, source, user_id) VALUES (?, ?, ?, ?)').run(trackId, playedAt, source ?? null, userId)
    return { trackId, playedAt, ...(source ? { source } : {}) }
  }

  /** История (хранится всегда), свежие сверху */
  listPlays(userId: string): Play[] {
    const rows = this.db
      .prepare('SELECT track_id, played_at, source FROM plays WHERE user_id = ? ORDER BY played_at DESC, id DESC LIMIT 20000')
      .all(userId) as { track_id: string; played_at: string; source: string | null }[]
    return rows.map((r) => ({ trackId: r.track_id, playedAt: r.played_at, ...(r.source ? { source: r.source } : {}) }))
  }

  /** Абсолютные пути, которые уже в базе (чтобы скан не хэшировал их заново) */
  knownPaths(): Map<string, { id: string; size: number; mtime: number | null }> {
    const rows = this.db.prepare("SELECT id, path, size, mtime FROM tracks WHERE status = 'available' AND path IS NOT NULL").all() as {
      id: string
      path: string
      size: number
      mtime: number | null
    }[]
    return new Map(rows.map((r) => [r.path, { id: r.id, size: r.size, mtime: r.mtime }]))
  }

  // ---------- папки с музыкой ----------

  private folderRows(): { path: string; uploads: number; user_id: string | null }[] {
    return this.db.prepare('SELECT path, uploads, user_id FROM folders ORDER BY added_at, path').all() as { path: string; uploads: number; user_id: string | null }[]
  }

  folderPaths(): string[] {
    return this.folderRows().map((f) => f.path)
  }

  uploadFolder(): string {
    const rows = this.folderRows()
    return (rows.find((f) => f.uploads) ?? rows[0]).path
  }

  /**
   * Чей файл с диска: хозяина папки, а в папке загрузок подпапка <логин> — того пользователя.
   * undefined — файл вне папок или хозяина ещё нет (сервер не настроен)
   */
  userForPath(abs: string): string | undefined {
    const rows = this.folderRows()
    const f = rows.find((r) => isInside(abs, r.path))
    if (!f) return undefined
    if (f.path === this.uploadFolder()) {
      const parts = relative(f.path, abs).split(/[\\/]/)
      if (parts.length > 1) {
        const u = this.db.prepare('SELECT id FROM users WHERE login = ?').get(parts[0]) as { id: string } | undefined
        if (u) return u.id
      }
    }
    return f.user_id ?? this.ownerId()
  }

  /** Папки с музыкой: все (userId нет — у владельца) или только папки этого пользователя */
  listFolders(userId?: string): Folder[] {
    const owner = this.ownerId() ?? null
    const rows = this.folderRows().filter((f) => !userId || (f.user_id ?? owner) === userId)
    const counts = new Map(rows.map((f) => [f.path, 0]))
    // в папке считаем только треки её хозяина: загрузки других пользователей в папке загрузок — их
    const tracks = this.db.prepare("SELECT path, user_id FROM tracks WHERE status = 'available' AND path IS NOT NULL").all() as { path: string; user_id: string | null }[]
    for (const t of tracks) {
      const f = rows.find((r) => isInside(t.path, r.path))
      if (f && (f.user_id ?? owner) === t.user_id) counts.set(f.path, counts.get(f.path)! + 1)
    }
    return rows.map((f) => {
      const p = this.scanning.get(f.path)
      return {
        path: f.path,
        userId: f.user_id ?? owner,
        uploads: !!f.uploads,
        tracks: counts.get(f.path)!,
        scanning: !!p,
        ...(p ? { scanDone: p.done, scanTotal: p.total } : {}),
      }
    })
  }

  private async checkDir(raw: string): Promise<string> {
    if (!raw || !isAbsolute(raw)) throw badRequest('Нужен абсолютный путь к папке')
    const path = resolve(raw)
    const st = await stat(path).catch(() => null)
    if (!st?.isDirectory()) throw notFound(`Папки ${path} нет`)
    return path
  }

  /** Добавить папку; сканировать её вызывающий запускает сам (scanFolders) */
  async addFolder(raw: string, userId: string): Promise<Folder> {
    const path = await this.checkDir(raw)
    for (const f of this.folderPaths()) {
      if (f === path) throw new HttpError(409, 'conflict', 'Эта папка уже в библиотеке')
      // вложенные папки просканировались бы дважды
      if (isInside(path, f) || isInside(f, path)) throw new HttpError(409, 'conflict', `Папка пересекается с ${f}, она уже в библиотеке`)
    }
    if (isInside(this.cfg.dataDir, path) || isInside(path, this.cfg.dataDir)) throw badRequest('Это папка с данными самого сервера')
    this.db.prepare('INSERT INTO folders (path, uploads, added_at, user_id) VALUES (?, 0, ?, ?)').run(path, now(), userId)
    return this.listFolders().find((f) => f.path === path)!
  }

  /**
   * Отдать папку другому пользователю. Треки прежнего хозяина из неё становятся надгробиями «папку убрали»
   * (его устройства уберут их у себя; вернут папку — скан их воскресит), а скан, который запускает вызывающий,
   * заводит их у нового хозяина. Загрузки других пользователей в своих подпапках не трогаем
   */
  setFolderOwner(path: string, userId: string): boolean {
    const row = this.folderRows().find((f) => f.path === path)
    if (!row) throw notFound('Такой папки в библиотеке нет')
    const prev = row.user_id ?? this.ownerId()
    if (prev === userId) return false
    const gone = (this.db.prepare("SELECT id, path FROM tracks WHERE user_id IS ? AND status = 'available' AND path IS NOT NULL").all(prev ?? null) as { id: string; path: string }[])
      .filter((t) => isInside(t.path, path) && this.userForPath(t.path) === prev)
    tx(this.db, () => {
      const upd = this.db.prepare("UPDATE tracks SET status = 'deleted', unlinked = 1, seq = ? WHERE id = ?")
      for (const t of gone) upd.run(nextSeq(this.db), t.id)
      this.db.prepare('UPDATE folders SET user_id = ? WHERE path = ?').run(userId, path)
    })
    this.log.info({ folder: path, from: prev, to: userId, tracks: gone.length }, 'папка передана другому пользователю')
    return true
  }

  /**
   * Убрать папку из библиотеки. Файлы на диске не трогаем, а её треки становятся надгробиями
   * с пометкой unlinked: устройства уберут их у себя, а если папку вернут — скан их воскресит.
   */
  removeFolder(path: string) {
    const rows = this.folderRows()
    const row = rows.find((f) => f.path === path)
    if (!row) throw notFound('Такой папки в библиотеке нет')
    if (rows.length === 1) throw new HttpError(409, 'conflict', 'Нужна хотя бы одна папка с музыкой')
    const gone = [...this.knownPaths().keys()].filter((p) => isInside(p, path))
    tx(this.db, () => {
      const upd = this.db.prepare("UPDATE tracks SET status = 'deleted', unlinked = 1, seq = ? WHERE path = ? AND status = 'available'")
      for (const p of gone) upd.run(nextSeq(this.db), p)
      this.db.prepare('DELETE FROM folders WHERE path = ?').run(path)
      // убрали папку для новых — новые поедут в первую оставшуюся
      if (row.uploads) this.db.prepare('UPDATE folders SET uploads = 1 WHERE path = (SELECT path FROM folders ORDER BY added_at, path LIMIT 1)').run()
    })
    this.log.info({ folder: path, tracks: gone.length }, 'папка убрана из библиотеки')
  }

  /**
   * Папка переехала (сервер переехал с Windows на Linux, диск примонтирован в другое место): старый путь папки
   * меняется на новый во всей базе — у папки, треков, корзины и «Конфликтов». Файлы не трогаются, id треков,
   * лайки, плейлисты и история остаются. Разделители путей переводятся под новый путь (\\ → /).
   * Новая папка должна существовать на диске сервера
   */
  async moveFolder(from: string, rawTo: string): Promise<{ path: string; tracks: number }> {
    const row = this.folderRows().find((f) => f.path === from)
    if (!row) throw notFound('Такой папки в библиотеке нет')
    const to = await this.checkDir(rawTo)
    if (to === from) return { path: to, tracks: 0 }
    if (this.folderPaths().some((p) => p === to || isInside(p, to) || isInside(to, p))) {
      throw new HttpError(409, 'conflict', 'Эта папка уже в библиотеке (или внутри другой папки)')
    }
    const conv = (p: string) => movedPath(p, from, to)
    let tracks = 0
    tx(this.db, () => {
      this.db.prepare('UPDATE folders SET path = ? WHERE path = ?').run(to, from)
      const upd = (table: string, col: string, key: string) => {
        const rows = this.db.prepare(`SELECT ${key} AS k, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`).all() as { k: string; v: string }[]
        const set = this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${key} = ?`)
        let n = 0
        for (const r of rows) {
          const v = conv(r.v)
          if (v !== r.v) {
            set.run(v, r.k)
            n++
          }
        }
        return n
      }
      tracks = upd('tracks', 'path', 'id')
      upd('trash', 'file', 'track_id')
      upd('trash', 'orig_path', 'track_id')
      upd('conflicts', 'file', 'id')
    })
    this.log.info({ from, to, tracks }, 'папка переехала: пути в базе переписаны')
    void this.restoreTagCovers().catch(() => {})
    return { path: to, tracks }
  }

  setUploadFolder(path: string) {
    if (!this.folderPaths().includes(path)) throw notFound('Такой папки в библиотеке нет')
    tx(this.db, () => {
      this.db.prepare('UPDATE folders SET uploads = (path = ?)').run(path)
    })
  }

  /** Что лежит в папке на диске сервера — для выбора папки в веб-морде. Только папки, без скрытых */
  async browse(raw: string): Promise<DirListing> {
    const path = await this.checkDir(raw || sep)
    const dirs = (await listDirSafe(path))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
    const parent = dirname(path)
    return { path, parent: parent === path ? null : parent, dirs }
  }

  // ---------- плейлисты ----------

  // плейлист этого пользователя; чужой — как будто его нет
  private playlistRow(userId: string, id: string): PlaylistRow | undefined {
    return this.db.prepare(`${PLAYLIST_SELECT} WHERE p.id = ? AND p.user_id = ?`).get(id, userId) as PlaylistRow | undefined
  }

  activePlaylist(userId: string, id: string): Playlist {
    const r = this.playlistRow(userId, id)
    if (!r || r.deleted) throw notFound('Плейлист не найден')
    return toPlaylist(r)
  }

  listPlaylists(userId: string): Playlist[] {
    const rows = this.db.prepare(`${PLAYLIST_SELECT} WHERE p.user_id = ? AND p.deleted = 0 ORDER BY p.position, p.created_at, p.id`).all(userId) as unknown as PlaylistRow[]
    return rows.map(toPlaylist)
  }

  createPlaylist(userId: string, input: { name: string; description?: string; trackIds?: string[] }): Playlist {
    const id = randomUUID()
    const ts = now()
    tx(this.db, () => {
      const seq = nextSeq(this.db)
      this.db
        // новый плейлист — в конец списка
        .prepare(
          `INSERT INTO playlists (id, name, description, track_ids, created_at, updated_at, deleted, position, seq, user_id)
           VALUES (?, ?, ?, ?, ?, ?, 0, (SELECT COALESCE(MAX(position), -1) + 1 FROM playlists WHERE user_id = ?), ?, ?)`,
        )
        .run(id, input.name, input.description ?? '', JSON.stringify(uniq(input.trackIds ?? [])), ts, ts, userId, seq, userId)
    })
    return this.activePlaylist(userId, id)
  }

  /** Новый порядок плейлистов: ids — все живые плейлисты в нужном порядке (кого нет в списке — в конец, как были) */
  reorderPlaylists(userId: string, ids: string[]): Playlist[] {
    const live = this.listPlaylists(userId)
    const known = new Set(live.map((p) => p.id))
    const order = [...uniq(ids).filter((id) => known.has(id)), ...live.map((p) => p.id).filter((id) => !ids.includes(id))]
    tx(this.db, () => {
      const upd = this.db.prepare('UPDATE playlists SET position = ?, seq = ? WHERE id = ?')
      order.forEach((id, i) => {
        if (live.find((p) => p.id === id)!.position !== i) upd.run(i, nextSeq(this.db), id)
      })
    })
    return this.listPlaylists(userId)
  }

  updatePlaylist(userId: string, id: string, patch: { name?: string; description?: string; trackIds?: string[] }): Playlist {
    const cur = this.activePlaylist(userId, id)
    tx(this.db, () => {
      const seq = nextSeq(this.db)
      this.db
        .prepare('UPDATE playlists SET name = ?, description = ?, track_ids = ?, updated_at = ?, seq = ? WHERE id = ?')
        .run(patch.name ?? cur.name, patch.description ?? cur.description, JSON.stringify(uniq(patch.trackIds ?? cur.trackIds)), now(), seq, id)
    })
    return this.activePlaylist(userId, id)
  }

  async deletePlaylist(userId: string, id: string): Promise<void> {
    const r = this.playlistRow(userId, id)
    if (!r) throw notFound('Плейлист не найден')
    if (r.deleted) return
    const cover = this.customCoverRow(userId, 'playlist', id)
    tx(this.db, () => {
      const seq = nextSeq(this.db)
      this.db.prepare('UPDATE playlists SET deleted = 1, updated_at = ?, seq = ? WHERE id = ?').run(now(), seq, id)
      this.db
        .prepare("UPDATE covers SET deleted = 1, file = NULL, mime = NULL, seq = ?, updated_at = ? WHERE user_id = ? AND kind = 'playlist' AND key = ?")
        .run(seq, now(), userId, id)
    })
    if (cover?.file) await rm(join(this.customCoverDir, cover.file), { force: true })
  }

  // ---------- картинки ----------

  private customCoverRow(userId: string, kind: string, key: string): CoverRow | undefined {
    const r = this.db.prepare('SELECT * FROM covers WHERE user_id = ? AND kind = ? AND key = ?').get(userId, kind, key) as CoverRow | undefined
    return r && !r.deleted && r.file ? r : undefined
  }

  private customCover(userId: string, kind: string, key: string): { path: string; mime: string } | undefined {
    const r = this.customCoverRow(userId, kind, key)
    if (!r) return undefined
    const path = join(this.customCoverDir, r.file!)
    return existsSync(path) ? { path, mime: r.mime! } : undefined
  }

  private tagCover(id: string): { path: string; mime: string } | undefined {
    const r = this.db.prepare("SELECT tag_cover_mime FROM tracks WHERE id = ? AND status = 'available'").get(id) as { tag_cover_mime: string | null } | undefined
    if (!r?.tag_cover_mime) return undefined
    const path = join(this.tagCoverDir, id)
    return existsSync(path) ? { path, mime: r.tag_cover_mime } : undefined
  }

  /** Картинка трека пользователя: своя → своя у альбома → из тегов */
  trackCover(userId: string, id: string) {
    const t = this.availableTrack(userId, id)
    return this.customCover(userId, 'track', id) ?? this.customCover(userId, 'album', t.album) ?? this.tagCover(id)
  }

  /** GET /covers/:kind/:key — своя картинка, а если её нет, то из тегов */
  cover(userId: string, kind: CoverKind | 'playlist', key: string) {
    const own = this.customCover(userId, kind, key)
    if (own || kind === 'artist' || kind === 'playlist') return own
    if (kind === 'track') return this.track(userId, key)?.status === 'available' ? this.trackCover(userId, key) : undefined
    const r = this.db
      .prepare("SELECT id FROM tracks WHERE user_id = ? AND album = ? AND status = 'available' AND tag_cover_mime IS NOT NULL ORDER BY added_at, id LIMIT 1")
      .get(userId, key) as { id: string } | undefined
    return r && this.tagCover(r.id)
  }

  private checkCoverTarget(userId: string, kind: CoverKind | 'playlist', key: string) {
    if (kind === 'track') this.availableTrack(userId, key)
    if (kind === 'playlist') this.activePlaylist(userId, key)
  }

  // Картинка влияет на hasCover у треков/плейлиста — двигаем их seq, чтобы клиенты увидели изменение
  private bumpCoverDependents(userId: string, kind: CoverKind | 'playlist', key: string, seq: number) {
    if (kind === 'track') this.db.prepare("UPDATE tracks SET seq = ? WHERE id = ? AND user_id = ? AND status = 'available'").run(seq, key, userId)
    if (kind === 'album') this.db.prepare("UPDATE tracks SET seq = ? WHERE album = ? AND user_id = ? AND status = 'available'").run(seq, key, userId)
    if (kind === 'playlist') this.db.prepare('UPDATE playlists SET seq = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(seq, now(), key, userId)
  }

  async setCover(userId: string, kind: CoverKind | 'playlist', key: string, mime: string, data: Buffer): Promise<void> {
    this.checkCoverTarget(userId, kind, key)
    // картинки «вшивать в файлы»: обложка трека вшивается в сам файл, своя картинка в MUSICH больше не нужна
    if (kind === 'track' && this.prefs(userId).coverMode === 'file') {
      await this.embedCover(key, mime, data)
      await this.deleteCover(userId, 'track', key)
      return
    }
    const ext = IMAGE_EXT[mime]
    // в имени файла — и пользователь: обложки альбомов с одним названием у двоих разные
    // и отпечаток содержимого: новая картинка — новое имя, иначе журнал (триггер по file) не видел замену,
    // а по старому отпечатку отдавалась новая картинка
    const file = `${createHash('sha256').update(`${userId}\0${kind}\0${key}`).digest('hex').slice(0, 16)}-${createHash('sha256').update(data).digest('hex').slice(0, 12)}.${ext}`
    const tmp = join(this.customCoverDir, `${file}.${randomUUID()}.tmp`)
    await writeFile(tmp, data)
    await rename(tmp, join(this.customCoverDir, file))
    const prev = this.db.prepare('SELECT file FROM covers WHERE user_id = ? AND kind = ? AND key = ?').get(userId, kind, key) as { file: string | null } | undefined
    tx(this.db, () => {
      const seq = nextSeq(this.db)
      this.db
        .prepare(
          `INSERT INTO covers (user_id, kind, key, mime, file, updated_at, deleted, seq) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT (user_id, kind, key) DO UPDATE SET mime = excluded.mime, file = excluded.file, updated_at = excluded.updated_at, deleted = 0, seq = excluded.seq`,
        )
        .run(userId, kind, key, mime, file, now(), seq)
      this.bumpCoverDependents(userId, kind, key, seq)
    })
    if (prev?.file && prev.file !== file) await rm(join(this.customCoverDir, prev.file), { force: true })
  }

  async deleteCover(userId: string, kind: CoverKind | 'playlist', key: string): Promise<void> {
    if (kind === 'playlist') this.activePlaylist(userId, key)
    const r = this.customCoverRow(userId, kind, key)
    if (!r) return
    tx(this.db, () => {
      const seq = nextSeq(this.db)
      this.db
        .prepare('UPDATE covers SET deleted = 1, file = NULL, mime = NULL, updated_at = ?, seq = ? WHERE user_id = ? AND kind = ? AND key = ?')
        .run(now(), seq, userId, kind, key)
      this.bumpCoverDependents(userId, kind, key, seq)
    })
    await rm(join(this.customCoverDir, r.file!), { force: true })
  }

  // ---------- устройства ----------

  /**
   * Устройство представилось. Уже знакомое — та же запись (обновляем имя), новое — заводим.
   * Узнаём по hwId (постоянный номер устройства), иначе по id, который оно запомнило с прошлого раза.
   * Первый раз с hwId — забираем себе старые записи без номера с тем же именем и видом: это копии, которые
   * плодили переустановки; оставляем самую свежую, остальные удаляем (на устройство ссылаются по имени, не по id)
   */
  registerDevice(userId: string, name: string, kind: DeviceKind, hwId?: string, knownId?: string): Device {
    const ts = now()
    const db = this.db
    const touch = (id: string) => {
      db.prepare('UPDATE devices SET name = ?, kind = ?, hw_id = COALESCE(?, hw_id), last_seen_at = ? WHERE id = ?').run(name, kind, hwId ?? null, ts, id)
      return this.device(userId, id)!
    }
    return tx(db, () => {
      let found: string | undefined
      if (hwId) found = (db.prepare('SELECT id FROM devices WHERE user_id = ? AND hw_id = ?').get(userId, hwId) as { id: string } | undefined)?.id
      if (!found && knownId) {
        const r = db.prepare('SELECT id, hw_id FROM devices WHERE id = ? AND user_id = ?').get(knownId, userId) as { id: string; hw_id: string | null } | undefined
        // запись чужого устройства (номера есть у обоих и разные) не забираем
        if (r && (!r.hw_id || !hwId || r.hw_id === hwId)) found = r.id
      }
      if (hwId) {
        const copies = (
          db
            .prepare('SELECT id FROM devices WHERE user_id = ? AND hw_id IS NULL AND name = ? AND kind = ? ORDER BY last_seen_at DESC, created_at DESC, rowid DESC')
            .all(userId, name, kind) as { id: string }[]
        ).map((r) => r.id)
        if (!found) found = copies[0]
        for (const id of copies) if (id !== found) db.prepare('DELETE FROM devices WHERE id = ?').run(id)
      }
      let dev: Device
      if (found) dev = touch(found)
      else {
        const id = randomUUID()
        db.prepare('INSERT INTO devices (id, name, kind, hw_id, created_at, last_seen_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, name, kind, hwId ?? null, ts, ts, userId)
        dev = this.device(userId, id)!
      }
      return dev
    })
  }

  device(userId: string, id: string): Device | undefined {
    const r = this.db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(id, userId) as DeviceRow | undefined
    return r && toDevice(r)
  }

  listDevices(userId: string): Device[] {
    return (this.db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at, id').all(userId) as unknown as DeviceRow[]).map(toDevice)
  }

  /** Устройство на связи; status — что у него ждёт синхронизации (synced: всё сделано прямо сейчас) */
  deviceSeen(userId: string, id: string, status?: { pendingUp?: number; pendingDown?: number; synced?: boolean; info?: DeviceInfo }): Device {
    const ts = now()
    if (status?.info) this.db.prepare('UPDATE devices SET info = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(status.info), id, userId)
    const res = status
      ? this.db
          .prepare(
            'UPDATE devices SET last_seen_at = ?, pending_up = ?, pending_down = ?, synced_at = CASE WHEN ? THEN ? ELSE synced_at END WHERE id = ? AND user_id = ?',
          )
          .run(ts, status.pendingUp ?? 0, status.pendingDown ?? 0, status.synced ? 1 : 0, ts, id, userId)
      : this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ? AND user_id = ?').run(ts, id, userId)
    if (!res.changes) throw notFound('Устройство не найдено')
    return this.device(userId, id)!
  }

  /**
   * «Экосистема»: сколько треков у каждого пользователя на сервере и все их устройства.
   * userIds — чьи (владелец и админ видят всех, остальные — только себя)
   */
  ecosystem(userIds: string[]): { users: { id: string; tracks: number; bytes: number; devices: Device[] }[] } {
    const counts = new Map(
      (this.db.prepare("SELECT user_id, COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM tracks WHERE status = 'available' GROUP BY user_id").all() as { user_id: string; n: number; b: number }[]).map((r) => [r.user_id, r]),
    )
    const devs = this.db.prepare('SELECT * FROM devices ORDER BY last_seen_at DESC').all() as unknown as DeviceRow[]
    return {
      users: userIds.map((id) => ({
        id,
        tracks: counts.get(id)?.n ?? 0,
        bytes: counts.get(id)?.b ?? 0,
        devices: devs.filter((d) => d.user_id === id).map(toDevice),
      })),
    }
  }

  /** Забыть устройство. Его доступ (токен) отзывается отдельно — в списке входов */
  deleteDevice(userId: string, id: string) {
    const res = this.db.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?').run(id, userId)
    if (!res.changes) throw notFound('Устройство не найдено')
  }

  // ---------- сводка для главной и страницы «Сервер» ----------

  stats(userId: string): { tracks: number; albums: number; artists: number; musicBytes: number } {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS n, COUNT(DISTINCT album) AS al, COUNT(DISTINCT artist) AS ar, COALESCE(SUM(size), 0) AS bytes FROM tracks WHERE user_id = ? AND status = 'available'",
      )
      .get(userId) as { n: number; al: number; ar: number; bytes: number }
    return { tracks: r.n, albums: r.al, artists: r.ar, musicBytes: r.bytes }
  }

  /** Что недавно появилось в библиотеке и откуда */
  recent(userId: string, limit = 20): { id: string; title: string; artist: string; source?: string; addedAt: string }[] {
    const rows = this.db
      .prepare("SELECT id, title, artist, source, added_at FROM tracks WHERE user_id = ? AND status = 'available' ORDER BY added_at DESC, id LIMIT ?")
      .all(userId, limit) as { id: string; title: string; artist: string; source: string | null; added_at: string }[]
    return rows.map((r) => ({ id: r.id, title: r.title, artist: r.artist, ...(r.source ? { source: r.source } : {}), addedAt: r.added_at }))
  }

  // ---------- профиль ----------

  profile(userId: string): Profile {
    const u = this.db.prepare('SELECT login, name, email, avatar FROM users WHERE id = ?').get(userId) as
      | { login: string | null; name: string; email: string; avatar: string | null }
      | undefined
    if (!u) throw notFound('Пользователь не найден')
    return { login: u.login, name: u.name, email: u.email, ...(u.avatar ? { avatar: u.avatar } : {}) }
  }

  /** Имя сервера (так он объявляет себя в сети и телефонам) — имя владельца */
  serverName(): string {
    const id = this.ownerId()
    return (id && this.profile(id).name) || 'MUSICH'
  }

  // ---------- удаление пользователя ----------

  /**
   * Стереть всё, что есть у пользователя: записи и его файлы в папке загрузок (<загрузки>/<логин>/), картинки,
   * присланные на решение файлы. Файлы в назначенных ему папках не трогаем: папки убираются из библиотеки
   * (папка загрузок отходит владельцу), файлы из корзины возвращаются на место. Запись users стирает Auth
   */
  async deleteUserData(userId: string) {
    const owner = this.ownerId()
    if (userId === owner) throw new HttpError(403, 'forbidden', 'Владельца удалить нельзя')
    const login = this.userLogin(userId)
    const uploads = login ? join(this.uploadFolder(), login) : undefined
    const inUploads = (p: string) => !!uploads && isInside(p, uploads)
    for (const t of this.db.prepare('SELECT file, orig_path FROM trash WHERE user_id = ?').all(userId) as { file: string; orig_path: string }[]) {
      if (inUploads(t.orig_path) || !existsSync(t.file) || existsSync(t.orig_path)) await rm(t.file, { force: true })
      else await moveFile(t.file, t.orig_path).catch(() => rm(t.file, { force: true }))
    }
    for (const c of this.db.prepare('SELECT file FROM conflicts WHERE user_id = ?').all(userId) as { file: string }[]) await rm(c.file, { force: true })
    for (const c of this.db.prepare('SELECT file FROM covers WHERE user_id = ? AND file IS NOT NULL').all(userId) as { file: string }[])
      await rm(join(this.customCoverDir, c.file), { force: true })
    for (const t of this.db.prepare('SELECT id FROM tracks WHERE user_id = ?').all(userId) as { id: string }[]) await rm(join(this.tagCoverDir, t.id), { force: true })
    tx(this.db, () => {
      for (const table of ['likes', 'plays', 'playlists', 'covers', 'trash', 'conflicts', 'hashes', 'devices', 'events', 'user_settings', 'tracks', 'journal_pending'])
        this.db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId)
      this.db.prepare('UPDATE folders SET user_id = ? WHERE user_id = ? AND uploads = 1').run(owner ?? null, userId)
      this.db.prepare('DELETE FROM folders WHERE user_id = ?').run(userId)
    })
    // папка загрузок пользователя — его файлы целиком (саму папку загрузок не трогаем)
    if (uploads && uploads !== this.uploadFolder()) await rm(uploads, { recursive: true, force: true })
    this.log.info({ userId, login }, 'пользователь удалён вместе с музыкой')
  }

  // ---------- синхронизация ----------

  changes(userId: string, since: number): Changes {
    // курсор из будущего (база пересоздана) — отдаём всё, иначе клиент застрянет навсегда
    if (since > currentSeq(this.db)) since = 0
    const tracks = (this.db.prepare(`${TRACK_SELECT} WHERE t.user_id = ? AND t.seq > ? ORDER BY t.seq, t.id`).all(userId, since) as unknown as TrackRow[]).map(toTrack)
    const playlists = (this.db.prepare(`${PLAYLIST_SELECT} WHERE p.user_id = ? AND p.seq > ? ORDER BY p.seq, p.id`).all(userId, since) as unknown as PlaylistRow[]).map(
      toPlaylist,
    )
    const covers = (this.db
      .prepare("SELECT kind, key, seq, deleted FROM covers WHERE user_id = ? AND seq > ? AND kind IN ('track', 'album', 'artist') ORDER BY seq, kind, key")
      .all(userId, since) as unknown as CoverRow[]).map((r) => ({ kind: r.kind as CoverKind, key: r.key, seq: r.seq, deleted: !!r.deleted }))
    let cursor = since
    for (const x of [...tracks, ...playlists, ...covers]) if (x.seq > cursor) cursor = x.seq
    return { cursor, tracks, playlists, covers }
  }
}

function uniq(ids: string[]): string[] {
  return [...new Set(ids)]
}

export async function listDirSafe(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch(() => [])
}
