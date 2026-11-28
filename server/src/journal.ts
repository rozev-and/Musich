import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSetting, nextSeq, setSetting, tx, type Db } from './db.ts'

/**
 * Журнал событий узла (docs/SYNC.md, этап 1). Каждое изменение библиотеки — событие с гибридной меткой времени
 * и ссылкой на последнее событие о том же, которое узел видел (base). Сырые изменения складывают триггеры базы
 * (миграция 17) в journal_pending — так в журнал попадает всё: правки из веб-морды, скан, слежка за папками,
 * фоновые задачи. flush() превращает их в события. Первый запуск строит начальный журнал из нынешней базы.
 * Журнал у каждого пользователя свой (docs/USERS.md): события, векторы и номера узлов — внутри его журнала
 */

export interface SyncEvent {
  id: string // <узел>:<n>
  node: string
  n: number
  hlc: string
  type: string
  key: string
  field: string
  value?: unknown
  base: string | null
}

/** Настройки библиотеки — общие для всех устройств. Остальные (скан по расписанию, слежка за папками) — свои у узла */
const SHARED_PREFS = ['playThreshold', 'trashDays', 'editMode', 'coverMode', 'fileNames', 'autoNumber', 'shiftOnDelete', 'separators'] as const
const OV_FIELDS = ['title', 'artist', 'album', 'year'] as const

// снимок строки трека, который кладут триггеры
interface TrackJ {
  title: string
  artist: string
  album: string
  year: number | null
  trackNo: number | null
  duration: number
  size: number
  format: string
  fileName: string
  hash: string | null
  origHash: string | null
  status: 'available' | 'deleted'
  unlinked: number
  ov: string | null
  autoGain: number | null
  source: string | null
  addedAt: string
  tagsV: number
  hasFile: number
}
interface PlaylistJ {
  name: string
  description: string
  trackIds: string
  deleted: number
  position: number
}
interface CoverJ {
  kind: string
  key: string
  mime: string | null
  file: string | null
  deleted: number
}
interface Pending {
  id: number
  user_id: string | null
  entity: 'track' | 'like' | 'playlist' | 'cover' | 'play' | 'trash' | 'setting'
  key: string
  op: 'insert' | 'update' | 'delete'
  old: string | null
  new: string | null
  at: string
}

const parse = <T>(s: string | null): T | null => {
  if (s === null) return null
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}
const ovOf = (raw: string | null) => parse<Record<string, unknown>>(raw) ?? {}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const time = (iso: string | null | undefined, fallback: number) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : fallback
}

// ---------- гибридные часы ----------
// Метка — «время/счётчик»: 2026-11-04T15:07:12.345Z/000003. Строки с ней сравниваются как обычные строки
const fmtHlc = (ms: number, c: number) => `${new Date(ms).toISOString()}/${String(c).padStart(6, '0')}`
// метка строго в нашем виде «ISO/000000»: иначе строка вроде «Thu, 01 Jan…» при сравнении строк всегда «позже» и выигрывала бы навсегда
const HLC_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\/\d{6,}$/
const STR_FIELDS = new Set(['title', 'artist', 'album', 'name', 'description'])
/** Значение события подходит полю? Кривое — храним (номера узла не рвутся), но к данным не применяем */
const valueOk = (e: SyncEvent) => {
  const v = e.value
  if (v !== undefined && v !== null && JSON.stringify(v).length > 20_000) return false
  if (e.type === 'track.set' && STR_FIELDS.has(e.field)) return typeof v === 'string' && v.trim().length > 0 && v.length <= 1000
  if (e.type === 'track.set' && e.field === 'year') return v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 9999)
  if (e.type === 'track.set' && e.field === 'autoGain') return v === null || (typeof v === 'number' && Number.isFinite(v))
  if (e.type === 'playlist.set' && STR_FIELDS.has(e.field)) return typeof v === 'string' && v.length <= 1000
  return true
}
const parseHlc = (s: string) => {
  const [iso, c] = s.split('/')
  return { ms: Date.parse(iso), c: Number(c) || 0 }
}

export class Journal {
  readonly node: string
  // последний свой номер события — в журнале каждого пользователя
  private readonly n = new Map<string, number>()
  private clock: { ms: number; c: number }
  // отпечатки своих картинок (по имени файла) — чтобы отдавать их по отпечатку
  private coverHashes = new Map<string, string>()
  private readonly db: Db
  private readonly coverDir: string

  constructor(db: Db, dataDir: string) {
    this.db = db
    this.coverDir = join(dataDir, 'covers', 'custom')
    let node = getSetting(db, 'node')
    if (!node) {
      node = randomBytes(9).toString('base64url')
      setSetting(db, 'node', node)
    }
    this.node = node
    const top = (db.prepare('SELECT MAX(hlc) AS h FROM events').get() as { h: string | null }).h
    this.clock = top ? parseHlc(top) : { ms: 0, c: 0 }
  }

  /** Метка для нового события: не раньше всех известных, даже если часы устройства отстают */
  private tick(physical: number): string {
    const ms = Math.max(physical, this.clock.ms)
    let c = ms === this.clock.ms ? this.clock.c + 1 : 0
    let at = ms
    if (c > 999_999) {
      at = ms + 1
      c = 0
    }
    this.clock = { ms: at, c }
    return fmtHlc(at, c)
  }

  private nextN(uid: string): number {
    const cur =
      this.n.get(uid) ?? (this.db.prepare('SELECT MAX(n) AS n FROM events WHERE user_id = ? AND node = ?').get(uid, this.node) as { n: number | null }).n ?? 0
    this.n.set(uid, cur + 1)
    return cur + 1
  }

  private emit(uid: string, type: string, key: string, field: string, value: unknown, physical: number, withBase = true) {
    const base = withBase
      ? ((this.db.prepare('SELECT id FROM events WHERE user_id = ? AND key = ? AND field = ? ORDER BY hlc DESC LIMIT 1').get(uid, key, field) as
          | { id: string }
          | undefined)?.id ?? null)
      : null
    const n = this.nextN(uid)
    this.db
      .prepare('INSERT INTO events (user_id, id, node, n, hlc, type, key, field, value, base) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uid, `${this.node}:${n}`, this.node, n, this.tick(physical), type, key, field, value === undefined ? null : JSON.stringify(value), base)
  }

  private coverHash(file: string): string | null {
    const known = this.coverHashes.get(file)
    if (known) return known
    const path = join(this.coverDir, file)
    if (!existsSync(path)) return null
    const h = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
    this.coverHashes.set(file, h)
    return h
  }

  // ---------- начальный журнал ----------

  /** Первый запуск: журнал из того, что уже есть в базе. Потом — только flush */
  bootstrap() {
    if (getSetting(this.db, 'journal')) return
    const users = (this.db.prepare('SELECT id FROM users').all() as { id: string }[]).map((u) => u.id)
    const items: { uid: string; ms: number; type: string; key: string; field: string; value?: unknown }[] = []
    for (const uid of users) this.bootstrapUser(uid, items)
    items.sort((a, b) => a.ms - b.ms)
    tx(this.db, () => {
      for (const it of items) this.emit(it.uid, it.type, it.key, it.field, it.value, it.ms, !['play', 'copy', 'tracks'].includes(it.field))
      // всё, что триггеры успели сложить до начального журнала, в нём уже учтено
      this.db.exec('DELETE FROM journal_pending')
      setSetting(this.db, 'journal', 'v1')
    })
  }

  private bootstrapUser(uid: string, items: { uid: string; ms: number; type: string; key: string; field: string; value?: unknown }[]) {
    const add = (ms: number, type: string, key: string, field: string, value?: unknown) => items.push({ uid, ms, type, key, field, value })
    const start = Date.now()

    type Row = {
      id: string; title: string; artist: string; album: string; year: number | null; track_no: number | null; duration: number; size: number
      format: string; file_name: string; hash: string | null; orig_hash: string | null; status: string; unlinked: number; ov: string | null
      auto_gain: number | null; source: string | null; added_at: string; path: string | null; orig_title: string | null; orig_artist: string | null
      orig_album: string | null; orig_year: number | null; orig_track_no: number | null
    }
    // треки из папок, убранных из библиотеки (unlinked), сейчас не в библиотеке — вернут папку, придут как новые
    const tracks = this.db.prepare('SELECT * FROM tracks WHERE user_id = ? AND replaced_by IS NULL AND NOT (status = ? AND unlinked = 1)').all(uid, 'deleted') as Row[]
    const hashesOf = this.db.prepare('SELECT hash, seen_at FROM hashes WHERE track_id = ? ORDER BY seen_at, hash')
    const trashOf = this.db.prepare('SELECT deleted_at FROM trash WHERE track_id = ?')
    for (const t of tracks) {
      const addedAt = time(t.added_at, start)
      const cur = t.hash ?? t.id
      const orig = t.orig_hash ?? cur
      const ov = ovOf(t.ov)
      // теги файла: правки «только в MUSICH» уже лежат в title/artist/…, поэтому подменённые поля из файла не берём
      const fileTags = (src: 'cur' | 'orig') =>
        src === 'orig' && t.orig_title !== null
          ? { title: t.orig_title, artist: t.orig_artist, album: t.orig_album, year: t.orig_year, trackNo: t.orig_track_no }
          : Object.fromEntries(
              (['title', 'artist', 'album', 'year'] as const).filter((k) => !(k in ov)).map((k) => [k, t[k]]).concat([['trackNo', t.track_no]]),
            )
      add(addedAt, 'track.add', t.id, '', {
        hash: orig,
        ...(orig === cur ? { size: t.size, format: t.format, duration: t.duration } : {}),
        fileName: t.file_name,
        ...fileTags('orig'),
        ...(t.source ? { source: t.source } : {}),
        addedAt: t.added_at,
      })
      // версии файла после первой (MUSICH писал теги в файл): промежуточные — только отпечаток, нынешняя — целиком
      let last = addedAt
      for (const h of hashesOf.all(t.id) as { hash: string; seen_at: string }[]) {
        if (h.hash === orig) continue
        last = Math.max(last, time(h.seen_at, last))
        if (h.hash !== cur) add(last, 'track.file', t.id, 'file', { hash: h.hash })
      }
      if (cur !== orig) add(last, 'track.file', t.id, 'file', { hash: cur, size: t.size, format: t.format, duration: t.duration, fileName: t.file_name, ...fileTags('cur') })
      for (const k of OV_FIELDS) if (k in ov) add(last, 'track.set', t.id, k, ov[k])
      if (t.auto_gain !== null) add(last, 'track.set', t.id, 'autoGain', t.auto_gain)
      if (t.status === 'deleted' && !t.unlinked) {
        const tr = trashOf.get(t.id) as { deleted_at: string } | undefined
        add(time(tr?.deleted_at, last), 'track.delete', t.id, 'status')
        if (!tr) add(last, 'track.purge', t.id, 'status')
      }
      // копия файла у этого узла: живой трек с файлом или лежащий в корзине
      if (t.path && (t.status === 'available' || (!t.unlinked && trashOf.get(t.id)))) add(last, 'copy.have', cur, 'copy')
    }

    for (const l of this.db.prepare('SELECT track_id, liked_at FROM likes WHERE user_id = ?').all(uid) as { track_id: string; liked_at: string }[])
      add(time(l.liked_at, start), 'like.set', l.track_id, 'like', true)

    type PRow = { id: string; name: string; description: string; track_ids: string; created_at: string; updated_at: string; position: number }
    for (const p of this.db.prepare('SELECT * FROM playlists WHERE user_id = ? AND deleted = 0').all(uid) as PRow[]) {
      const at = time(p.created_at, start)
      add(at, 'playlist.create', p.id, 'status', { name: p.name, description: p.description })
      add(at, 'playlist.set', p.id, 'position', p.position)
      let after: string | null = null
      for (const id of parse<string[]>(p.track_ids) ?? []) {
        add(at, 'playlist.add', p.id, 'tracks', { track: id, after })
        after = id
      }
    }

    type CRow = { kind: string; key: string; mime: string; file: string; updated_at: string }
    for (const c of this.db.prepare('SELECT kind, key, mime, file, updated_at FROM covers WHERE user_id = ? AND deleted = 0 AND file IS NOT NULL').all(uid) as CRow[]) {
      const hash = this.coverHash(c.file)
      if (!hash) continue
      add(time(c.updated_at, start), 'cover.set', `${c.kind}:${c.key}`, '', { mime: c.mime, hash })
      add(time(c.updated_at, start), 'copy.have', hash, 'copy')
    }

    for (const p of this.db.prepare('SELECT track_id, played_at, source FROM plays WHERE user_id = ?').all(uid) as { track_id: string; played_at: string; source: string | null }[])
      add(time(p.played_at, start), 'play', p.track_id, 'play', { at: p.played_at, ...(p.source ? { source: p.source } : {}) })

    for (const [key, value] of this.sharedSettings(uid)) this.settingEvents(key, null, value, start, add)
  }

  private sharedSettings(uid: string): [string, string][] {
    return (
      this.db
        .prepare("SELECT key, value FROM user_settings WHERE user_id = ? AND (key IN ('prefs', 'dupIgnored') OR key GLOB 'integration:*:tracks')")
        .all(uid) as { key: string; value: string }[]
    ).map((r) => [r.key, r.value])
  }

  /** Общие настройки: prefs — по одной на ключ, dupIgnored — целиком, снимок интеграции — integration.snapshot */
  private settingEvents(key: string, oldRaw: string | null, newRaw: string | null, at: number, add: (ms: number, type: string, key: string, field: string, value?: unknown) => void) {
    if (key === 'prefs') {
      const o = parse<Record<string, unknown>>(oldRaw) ?? {}
      const n = parse<Record<string, unknown>>(newRaw) ?? {}
      for (const k of SHARED_PREFS) if (n[k] !== undefined && !same(o[k], n[k])) add(at, 'settings.set', k, '', n[k])
      return
    }
    if (key === 'dupIgnored') return add(at, 'settings.set', key, '', parse(newRaw) ?? [])
    const service = key.split(':')[1]
    add(at, 'integration.snapshot', service, '', parse(newRaw) ?? [])
  }

  // ---------- текущие изменения ----------

  /** Сырые изменения из триггеров → события. Зовётся после каждого запроса и раз в пару секунд */
  flush(): number {
    const rows = this.db.prepare('SELECT * FROM journal_pending ORDER BY id').all() as unknown as Pending[]
    if (!rows.length) return 0
    tx(this.db, () => {
      // без пользователя изменение ничьё (такого быть не должно) — в журнал не пишем
      for (const r of rows) if (r.user_id) this.apply(r, r.user_id)
      this.db.prepare('DELETE FROM journal_pending WHERE id <= ?').run(rows[rows.length - 1].id)
    })
    return rows.length
  }

  private apply(r: Pending, uid: string) {
    const at = time(r.at, Date.now())
    const ev = (type: string, key: string, field: string, value?: unknown) =>
      this.emit(uid, type, key, field, value, at, !['play', 'copy', 'tracks'].includes(field))
    switch (r.entity) {
      case 'track':
        return this.applyTrack(r, uid, ev)
      case 'like':
        return ev('like.set', r.key, 'like', r.op === 'insert')
      case 'playlist':
        return this.applyPlaylist(r, ev)
      case 'cover':
        return this.applyCover(r, ev)
      case 'play': {
        const p = parse<{ at: string; source: string | null }>(r.new)
        if (p) this.emit(uid, 'play', r.key, 'play', { at: p.at, ...(p.source ? { source: p.source } : {}) }, time(p.at, at), false)
        return
      }
      case 'trash': {
        // корзина очистилась: трек, который всё ещё удалён, стёрт насовсем
        const t = this.db.prepare('SELECT status, unlinked, hash, id FROM tracks WHERE id = ?').get(r.key) as
          | { status: string; unlinked: number; hash: string | null; id: string }
          | undefined
        if (t?.status === 'deleted' && !t.unlinked) {
          ev('track.purge', r.key, 'status')
          ev('copy.drop', t.hash ?? t.id, 'copy')
        }
        return
      }
      case 'setting':
        return this.settingEvents(r.key, r.old, r.new, at, (_ms, type, key, field, value) => ev(type, key, field, value))
    }
  }

  private applyTrack(r: Pending, uid: string, ev: (type: string, key: string, field: string, value?: unknown) => void) {
    const o = parse<TrackJ>(r.old)
    const n = parse<TrackJ>(r.new)
    const fileValue = (t: TrackJ) => {
      const ov = ovOf(t.ov)
      return {
        hash: t.hash ?? r.key,
        size: t.size,
        format: t.format,
        duration: t.duration,
        fileName: t.fileName,
        trackNo: t.trackNo,
        ...Object.fromEntries(OV_FIELDS.filter((k) => !(k in ov)).map((k) => [k, t[k]])),
      }
    }
    if (r.op === 'delete') {
      if (o?.status === 'available') ev('track.purge', r.key, 'status')
      if (o?.hasFile) ev('copy.drop', o.hash ?? r.key, 'copy')
      return
    }
    if (!n) return
    if (r.op === 'insert') {
      ev('track.add', r.key, '', { ...fileValue(n), ...(n.source ? { source: n.source } : {}), addedAt: n.addedAt })
      for (const [k, v] of Object.entries(ovOf(n.ov))) ev('track.set', r.key, k, v)
      if (n.autoGain !== null) ev('track.set', r.key, 'autoGain', n.autoGain)
      if (n.status === 'deleted' && !n.unlinked) ev('track.delete', r.key, 'status')
      if (n.hasFile && n.status === 'available') ev('copy.have', n.hash ?? r.key, 'copy')
      return
    }
    if (!o) return
    const oh = o.hash ?? r.key
    const nh = n.hash ?? r.key
    // новая версия файла: MUSICH вписал теги, скан заметил правку, теги дочитаны
    if (oh !== nh || o.fileName !== n.fileName || o.trackNo !== n.trackNo || o.tagsV !== n.tagsV) ev('track.file', r.key, 'file', fileValue(n))
    // правки «только в MUSICH» — по полям
    const oo = ovOf(o.ov)
    const no = ovOf(n.ov)
    for (const k of new Set([...Object.keys(oo), ...Object.keys(no)])) {
      if (!(k in no)) ev('track.reset', r.key, k)
      else if (!same(oo[k], no[k])) ev('track.set', r.key, k, no[k])
    }
    if (o.autoGain !== n.autoGain) n.autoGain === null ? ev('track.reset', r.key, 'autoGain') : ev('track.set', r.key, 'autoGain', n.autoGain)
    // удаление: папку убрали из библиотеки (unlinked) — у узла просто нет файла, это не «удалить из библиотеки»
    if (o.status !== n.status) {
      if (n.status === 'deleted') n.unlinked ? ev('copy.drop', oh, 'copy') : ev('track.delete', r.key, 'status')
      else if (o.unlinked) {
        // папку вернули: трек, которого журнал ещё не знал (папку убрали до журнала), приходит как новый
        const known = this.db.prepare("SELECT 1 FROM events WHERE user_id = ? AND key = ? AND type = 'track.add' LIMIT 1").get(uid, r.key)
        if (!known) ev('track.add', r.key, '', { ...fileValue(n), ...(n.source ? { source: n.source } : {}), addedAt: n.addedAt })
        ev('copy.have', nh, 'copy')
      } else ev('track.restore', r.key, 'status')
    } else if (oh !== nh && n.hasFile) {
      // файл заменён новой версией: старой копии больше нет
      ev('copy.drop', oh, 'copy')
      ev('copy.have', nh, 'copy')
    } else if (!!o.hasFile !== !!n.hasFile) ev(n.hasFile ? 'copy.have' : 'copy.drop', nh, 'copy')
  }

  private applyPlaylist(r: Pending, ev: (type: string, key: string, field: string, value?: unknown) => void) {
    const o = parse<PlaylistJ>(r.old)
    const n = parse<PlaylistJ>(r.new)
    if (r.op === 'delete' || (o && n && !o.deleted && n.deleted)) return ev('playlist.delete', r.key, 'status')
    if (!n || n.deleted) return
    const created = r.op === 'insert' || !!o?.deleted
    if (created) ev('playlist.create', r.key, 'status', { name: n.name, description: n.description })
    else {
      if (o!.name !== n.name) ev('playlist.set', r.key, 'name', n.name)
      if (o!.description !== n.description) ev('playlist.set', r.key, 'description', n.description)
    }
    if (created || o!.position !== n.position) ev('playlist.set', r.key, 'position', n.position)
    // состав — действиями «добавить / убрать / переставить», чтобы правки с разных устройств складывались
    const before = created ? [] : (parse<string[]>(o!.trackIds) ?? [])
    const after = parse<string[]>(n.trackIds) ?? []
    const keep = new Set(after)
    const cur = before.filter((id) => {
      if (keep.has(id)) return true
      ev('playlist.remove', r.key, 'tracks', { track: id })
      return false
    })
    after.forEach((id, i) => {
      const prev = i ? after[i - 1] : null
      const at = cur.indexOf(id)
      if (at === i && (i === 0 || cur[i - 1] === prev)) return
      ev(at < 0 ? 'playlist.add' : 'playlist.move', r.key, 'tracks', { track: id, after: prev })
      if (at >= 0) cur.splice(at, 1)
      cur.splice(i, 0, id)
    })
  }

  private applyCover(r: Pending, ev: (type: string, key: string, field: string, value?: unknown) => void) {
    const o = parse<CoverJ>(r.old)
    const n = parse<CoverJ>(r.new)
    const had = o && !o.deleted && o.file ? this.coverHash(o.file) : null
    const has = n && !n.deleted && n.file ? this.coverHash(n.file) : null
    if (has && has !== had) {
      ev('cover.set', r.key, '', { mime: n!.mime, hash: has })
      ev('copy.have', has, 'copy')
    } else if (!has && had) ev('cover.clear', r.key, '')
    if (had && had !== has) ev('copy.drop', had, 'copy')
  }

  // ---------- обмен ----------

  /** Вектор журнала пользователя: для каждого узла — последний номер события, который здесь есть */
  vector(uid: string): Record<string, number> {
    const rows = this.db.prepare('SELECT node, MAX(n) AS n FROM events WHERE user_id = ? GROUP BY node').all(uid) as { node: string; n: number }[]
    return Object.fromEntries(rows.map((r) => [r.node, r.n]))
  }

  /** События журнала пользователя, которых нет у того, чей это вектор, — порцией не больше limit */
  pull(uid: string, vector: Record<string, number>, limit: number): { events: SyncEvent[]; more: boolean } {
    const out: SyncEvent[] = []
    let more = false
    const q = this.db.prepare('SELECT id, node, n, hlc, type, key, field, value, base FROM events WHERE user_id = ? AND node = ? AND n > ? ORDER BY n LIMIT ?')
    for (const [node, top] of Object.entries(this.vector(uid))) {
      const from = vector[node] ?? 0
      if (top <= from) continue
      if (out.length >= limit) {
        more = true
        break
      }
      const rows = q.all(uid, node, from, limit - out.length) as unknown as (Omit<SyncEvent, 'value'> & { value: string | null })[]
      for (const e of rows) out.push({ ...e, value: e.value === null ? undefined : JSON.parse(e.value) })
      if (from + rows.length < top) more = true
    }
    return { events: out, more }
  }

  // ---------- приём чужих событий (этап 2a) ----------

  /** Чужие часы подтягивают свои: следующее своё событие будет позже всего, что узел уже видел */
  private observe(hlc: string) {
    const h = parseHlc(hlc)
    if (h.ms > this.clock.ms || (h.ms === this.clock.ms && h.c > this.clock.c)) this.clock = h
  }

  /**
   * Принять события других узлов. Номера каждого узла идут без пропусков: пропуск — дальше событий этого
   * узла не берём (он пришлёт их снова, начиная с нашего вектора). Каждое событие хранится как есть;
   * к базе применяется, если оно самое позднее по своему полю (последняя метка побеждает). Изменения базы при
   * применении триггеры складывают в journal_pending — их убираем, иначе чужое событие стало бы ещё и своим.
   * Метки из будущего (часы устройства убежали больше чем на час) не принимаем: они сдвинули бы часы всем
   */
  push(uid: string, events: SyncEvent[]): { stored: number; applied: number; rejected: number } {
    this.flush() // свои изменения — событиями до чужих
    const top = new Map(Object.entries(this.vector(uid)))
    const known = this.db.prepare('SELECT 1 FROM events WHERE user_id = ? AND id = ?')
    const insert = this.db.prepare('INSERT INTO events (user_id, id, node, n, hlc, type, key, field, value, base) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const future = Date.now() + 3_600_000
    const stuck = new Set<string>()
    let stored = 0
    let applied = 0
    let rejected = 0
    // по каждому узлу — по возрастанию номера
    const sorted = [...events].sort((a, b) => (a.node === b.node ? a.n - b.n : a.node < b.node ? -1 : 1))
    tx(this.db, () => {
      const mark = (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM journal_pending').get() as { m: number }).m
      for (const e of sorted) {
        if (e.node === this.node || stuck.has(e.node)) {
          rejected++
          continue
        }
        if (known.get(uid, e.id)) continue // уже есть — пришло второй раз
        const h = parseHlc(e.hlc)
        if (e.id !== `${e.node}:${e.n}` || e.n !== (top.get(e.node) ?? 0) + 1 || typeof e.hlc !== 'string' || !HLC_RE.test(e.hlc) || !Number.isFinite(h.ms) || h.ms > future) {
          stuck.add(e.node)
          rejected++
          continue
        }
        const latest = this.isLatest(uid, e)
        insert.run(uid, e.id, e.node, e.n, e.hlc, e.type, e.key, e.field, e.value === undefined ? null : JSON.stringify(e.value), e.base ?? null)
        top.set(e.node, e.n)
        stored++
        this.observe(e.hlc)
        if (!valueOk(e)) {
          rejected++
          continue
        }
        // одно событие не применилось (ошибка базы) — откатываем только его, остальной пакет идёт дальше
        if (latest) {
          this.db.exec('SAVEPOINT ev')
          try {
            if (this.applyForeign(uid, e, new Date(h.ms).toISOString())) applied++
            this.db.exec('RELEASE ev')
          } catch {
            this.db.exec('ROLLBACK TO ev')
            this.db.exec('RELEASE ev')
            rejected++
          }
        }
      }
      this.db.prepare('DELETE FROM journal_pending WHERE id > ?').run(mark)
    })
    return { stored, applied, rejected }
  }

  /** Событие по полю — позже всех известных о том же? Добавления в плейлист, прослушивания и т.п. применяются всегда */
  private isLatest(uid: string, e: SyncEvent): boolean {
    if (['play', 'copy', 'tracks', ''].includes(e.field)) return true
    const last = this.db
      .prepare('SELECT hlc, node FROM events WHERE user_id = ? AND key = ? AND field = ? ORDER BY hlc DESC, node DESC LIMIT 1')
      .get(uid, e.key, e.field) as
      | { hlc: string; node: string }
      | undefined
    return !last || e.hlc > last.hlc || (e.hlc === last.hlc && e.node > last.node)
  }

  /**
   * Применить чужое событие к данным пользователя uid. false — не к чему применять (трека нет или он чужой)
   * или этот тип пока только хранится
   */
  private applyForeign(uid: string, e: SyncEvent, at: string): boolean {
    const v = e.value as Record<string, unknown> | string | number | boolean | null | undefined
    const seq = () => nextSeq(this.db)
    const track = this.db.prepare("SELECT ov FROM tracks WHERE id = ? AND user_id = ? AND status = 'available' AND replaced_by IS NULL").get(e.key, uid) as
      | { ov: string | null }
      | undefined
    // плейлист с таким id у другого пользователя — не трогаем
    const playlist = this.db.prepare('SELECT deleted, user_id FROM playlists WHERE id = ?').get(e.key) as { deleted: number; user_id: string | null } | undefined
    if (e.type.startsWith('playlist.') && playlist && playlist.user_id !== uid) return false
    switch (e.type) {
      case 'like.set':
        if (!track) return false
        if (v === true) this.db.prepare('INSERT OR IGNORE INTO likes (track_id, liked_at, user_id) VALUES (?, ?, ?)').run(e.key, at, uid)
        else this.db.prepare('DELETE FROM likes WHERE track_id = ?').run(e.key)
        this.db.prepare('UPDATE tracks SET seq = ? WHERE id = ?').run(seq(), e.key)
        return true
      case 'play': {
        if (!track) return false
        const p = (v ?? {}) as { at?: string; source?: string }
        this.db.prepare('INSERT INTO plays (track_id, played_at, source, user_id) VALUES (?, ?, ?, ?)').run(e.key, p.at ?? at, p.source ?? null, uid)
        return true
      }
      case 'track.set': {
        if (!track) return false
        if (e.field === 'autoGain') {
          if (typeof v !== 'number') return false
          this.db.prepare('UPDATE tracks SET auto_gain = ?, seq = ? WHERE id = ?').run(Math.round(v * 10) / 10, seq(), e.key)
          return true
        }
        const col = ({ title: 'title', artist: 'artist', album: 'album', year: 'year' } as Record<string, string | undefined>)[e.field]
        if (!col) return false
        const ov = { ...ovOf(track.ov), [e.field]: v }
        // год 0 в правке — «года нет»
        const shown = col === 'year' ? (v === 0 || v === null ? null : v) : v
        this.db.prepare(`UPDATE tracks SET ov = ?, ${col} = ?, seq = ? WHERE id = ?`).run(JSON.stringify(ov), shown as string | number | null, seq(), e.key)
        return true
      }
      case 'playlist.create': {
        const p = (v ?? {}) as { name?: string; description?: string }
        const row = playlist
        if (row && !row.deleted) return false
        if (row) this.db.prepare('UPDATE playlists SET deleted = 0, name = ?, description = ?, track_ids = ?, updated_at = ?, seq = ? WHERE id = ?').run(p.name ?? '', p.description ?? '', '[]', at, seq(), e.key)
        else
          this.db
            .prepare(
              `INSERT INTO playlists (id, name, description, track_ids, created_at, updated_at, deleted, position, seq, user_id)
               VALUES (?, ?, ?, '[]', ?, ?, 0, (SELECT COALESCE(MAX(position), -1) + 1 FROM playlists WHERE user_id = ?), ?, ?)`,
            )
            .run(e.key, p.name ?? '', p.description ?? '', at, at, uid, seq(), uid)
        return true
      }
      case 'playlist.delete':
        return this.db.prepare('UPDATE playlists SET deleted = 1, updated_at = ?, seq = ? WHERE id = ? AND deleted = 0').run(at, seq(), e.key).changes > 0
      case 'playlist.set': {
        const col = ({ name: 'name', description: 'description', position: 'position' } as Record<string, string | undefined>)[e.field]
        if (!col) return false
        return this.db.prepare(`UPDATE playlists SET ${col} = ?, updated_at = ?, seq = ? WHERE id = ? AND deleted = 0`).run(v as string | number, at, seq(), e.key).changes > 0
      }
      case 'playlist.add':
      case 'playlist.remove':
      case 'playlist.move': {
        const row = this.db.prepare('SELECT track_ids FROM playlists WHERE id = ? AND deleted = 0').get(e.key) as { track_ids: string } | undefined
        const op = (v ?? {}) as { track?: string; after?: string | null }
        if (!row || !op.track) return false
        const ids = (parse<string[]>(row.track_ids) ?? []).filter((x) => x !== op.track)
        if (e.type !== 'playlist.remove') {
          // после after; null — в начало; after не нашёлся (убрали на другом устройстве) — в конец
          const i = op.after == null ? 0 : ids.indexOf(op.after) + 1 || ids.length
          ids.splice(i, 0, op.track)
        }
        this.db.prepare('UPDATE playlists SET track_ids = ?, updated_at = ?, seq = ? WHERE id = ?').run(JSON.stringify(ids), at, seq(), e.key)
        return true
      }
      default:
        // удаление, картинки, новые треки, копии, настройки — этап 2b: пока только храним
        return false
    }
  }

  /** Своя картинка пользователя по отпечатку — для /sync/file */
  coverFile(uid: string, hash: string): { path: string; mime: string } | undefined {
    const rows = this.db.prepare('SELECT mime, file FROM covers WHERE user_id = ? AND deleted = 0 AND file IS NOT NULL').all(uid) as { mime: string; file: string }[]
    const r = rows.find((x) => this.coverHash(x.file) === hash)
    return r ? { path: join(this.coverDir, r.file), mime: r.mime } : undefined
  }
}
