// Журнал своих действий телефона (docs/SYNC.md): каждое действие — событие с гибридной меткой времени.
// Пока сервера нет (или он не на связи), события копятся здесь и сразу видны на экране «свёрткой» (fold);
// когда сервер на связи — уходят через POST /api/sync/push, и отправленное убирается.
// Формат и правила те же, что у сервера (server/src/journal.ts): id «узел:номер», номера без пропусков,
// последняя метка побеждает; добавить в плейлист — после after (null — в начало, нет такого — в конец)

export interface JournalEvent {
  id: string
  node: string
  n: number
  hlc: string
  type: 'like.set' | 'playlist.create' | 'playlist.delete' | 'playlist.set' | 'playlist.add' | 'playlist.remove' | 'playlist.move'
  key: string
  field: string
  value?: unknown
  base: null
}

const NODE_KEY = 'musich-node-id'
const JOURNAL_KEY = 'musich-journal'
const NEXT_KEY = 'musich-journal-next' // следующий номер: события уходят, а номера не повторяются

const read = <T>(key: string, fallback: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback
  } catch {
    return fallback
  }
}
const write = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* хранилище выключено — журнал проживёт до перезапуска */
  }
}

/** Свой id узла: новый на каждую установку — иначе после переустановки номера пошли бы заново и сервер счёл бы их старыми */
export function nodeId(): string {
  let id = localStorage.getItem(NODE_KEY)
  if (!id) {
    id = `phone-${crypto.randomUUID()}`
    try {
      localStorage.setItem(NODE_KEY, id)
    } catch {
      /* не запомнили — в следующий раз будет другой узел, сервер это переживёт */
    }
  }
  return id
}

// ---------- гибридные часы: «ISO/счётчик» ----------

let clock = { ms: 0, c: 0 }
const fmt = (h: { ms: number; c: number }) => `${new Date(h.ms).toISOString()}/${String(h.c).padStart(6, '0')}`
const parse = (s: string) => {
  const [iso, c] = s.split('/')
  return { ms: Date.parse(iso), c: Number(c) || 0 }
}

function tick(): string {
  const now = Date.now()
  clock = now > clock.ms ? { ms: now, c: 0 } : { ms: clock.ms, c: clock.c + 1 }
  return fmt(clock)
}

/** Метка с сервера (или из своего журнала после перезапуска): следующая своя будет позже неё */
export function observe(hlc: string) {
  const h = parse(hlc)
  if (Number.isFinite(h.ms) && h.ms <= Date.now() + 3_600_000 && (h.ms > clock.ms || (h.ms === clock.ms && h.c > clock.c))) clock = h
}

// ---------- журнал ----------

export const pending = (): JournalEvent[] => read<JournalEvent[]>(JOURNAL_KEY, [])

export function append(type: JournalEvent['type'], key: string, field: string, value?: unknown): JournalEvent {
  const list = pending()
  for (const e of list.slice(-1)) observe(e.hlc)
  const node = nodeId()
  const n = Math.max(read<number>(NEXT_KEY, 1), (list[list.length - 1]?.n ?? 0) + 1)
  const e: JournalEvent = { id: `${node}:${n}`, node, n, hlc: tick(), type, key, field, value, base: null }
  write(JOURNAL_KEY, [...list, e])
  write(NEXT_KEY, n + 1)
  return e
}

/** Сервер принял события до n включительно — убираем их */
export function dropUpTo(n: number) {
  write(JOURNAL_KEY, pending().filter((e) => e.n > n))
}

/** У трека появился серверный id (файл с телефона отправлен): меняем его во всех событиях */
export function remap(map: Map<string, string>) {
  if (!map.size) return
  const swap = (x: unknown) => (typeof x === 'string' ? (map.get(x) ?? x) : x)
  let changed = false
  const list = pending().map((e) => {
    const key = swap(e.key) as string
    let value = e.value
    if (value && typeof value === 'object' && 'track' in value) {
      const v = value as { track?: string; after?: string | null }
      value = { ...v, track: swap(v.track), after: swap(v.after) }
    }
    if (key !== e.key || value !== e.value) changed = true
    return { ...e, key, value }
  })
  if (changed) write(JOURNAL_KEY, list)
}

/** Свой плейлист «слился» с серверным того же имени: события про него — на серверный id, создание не нужно */
export function mergePlaylist(localId: string, serverId: string) {
  const list = pending()
  if (list.some((e) => e.key === localId && e.type === 'playlist.delete')) {
    write(JOURNAL_KEY, list.filter((e) => e.key !== localId))
    return
  }
  write(
    JOURNAL_KEY,
    list.filter((e) => !(e.key === localId && e.type === 'playlist.create')).map((e) => (e.key === localId ? { ...e, key: serverId } : e)),
  )
}

/** Что можно отправлять: всё до первого события про трек, который ещё не на сервере (id «up:…») */
export function sendable(): JournalEvent[] {
  const out: JournalEvent[] = []
  for (const e of pending()) {
    const v = e.value as { track?: string; after?: string | null } | undefined
    if (e.key.startsWith('up:') || v?.track?.startsWith('up:') || (typeof v?.after === 'string' && v.after.startsWith('up:'))) break
    out.push(e)
  }
  return out
}

// ---------- свёртка: события поверх библиотеки ----------

type FoldTrack = { id: string; liked?: boolean; likedAt?: number }
type FoldPlaylist = { id: string; name: string; description: string; trackIds: string[]; position?: number; updatedAt: string; keepOffline: boolean }

/**
 * Накладывает события журнала на треки и плейлисты на экране. Порядок — как в журнале (свои события и так идут
 * по времени). Плейлисты, созданные на телефоне, появляются здесь же; удалённые — пропадают
 */
export function fold<T extends FoldTrack, P extends FoldPlaylist>(tracks: T[], playlists: P[], events = pending()): { tracks: T[]; playlists: P[] } {
  if (!events.length) return { tracks, playlists }
  const t = new Map(tracks.map((x) => [x.id, x]))
  const p = new Map<string, P | null>(playlists.map((x) => [x.id, x]))
  for (const e of events) {
    const ms = parse(e.hlc).ms
    const day = new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString().slice(0, 10)
    switch (e.type) {
      case 'like.set': {
        const x = t.get(e.key)
        if (x) t.set(e.key, { ...x, liked: e.value === true, likedAt: e.value === true ? ms : undefined })
        break
      }
      case 'playlist.create': {
        const v = (e.value ?? {}) as { name?: string; description?: string }
        if (!p.get(e.key)) {
          const top = Math.max(-1, ...[...p.values()].map((x) => x?.position ?? 0))
          p.set(e.key, { id: e.key, name: v.name ?? '', description: v.description ?? '', trackIds: [], position: top + 1, updatedAt: day, keepOffline: false } as unknown as P)
        }
        break
      }
      case 'playlist.delete':
        if (p.has(e.key)) p.set(e.key, null)
        break
      case 'playlist.set': {
        const x = p.get(e.key)
        if (x && (e.field === 'name' || e.field === 'description' || e.field === 'position')) p.set(e.key, { ...x, [e.field]: e.value, updatedAt: day })
        break
      }
      case 'playlist.add':
      case 'playlist.remove':
      case 'playlist.move': {
        const x = p.get(e.key)
        const op = (e.value ?? {}) as { track?: string; after?: string | null }
        if (!x || !op.track) break
        const ids = x.trackIds.filter((id) => id !== op.track)
        if (e.type !== 'playlist.remove') {
          const i = op.after == null ? 0 : ids.indexOf(op.after) + 1 || ids.length
          ids.splice(i, 0, op.track)
        }
        p.set(e.key, { ...x, trackIds: ids, updatedAt: day })
        break
      }
    }
  }
  return { tracks: [...t.values()], playlists: [...p.values()].filter((x): x is P => !!x) }
}

/** Сервер нас не помнит (новая база или другой сервер): новый узел и номера с 1 — иначе он ждал бы пропущенные */
export function renumber() {
  try {
    localStorage.removeItem(NODE_KEY)
  } catch {
    /* не убрали — nodeId вернёт старый, сервер снова откажет и мы придём сюда же */
  }
  const node = nodeId()
  const list = pending().map((e, i) => ({ ...e, node, n: i + 1, id: `${node}:${i + 1}` }))
  write(JOURNAL_KEY, list)
  write(NEXT_KEY, list.length + 1)
}

/** Убрать события про треки, которых больше нет (файл с телефона сервер не принял, трек удалили до отправки) —
 *  иначе sendable так и стоял бы перед ними */
export function prune(gone: (trackId: string) => boolean) {
  const list = pending()
  let changed = false
  const keep = list
    .filter((e) => {
      const v = e.value as { track?: string } | undefined
      return !(gone(e.key) || (v?.track && gone(v.track)))
    })
    .map((e) => {
      const v = e.value as { after?: string | null } | undefined
      if (v && typeof v === 'object' && typeof v.after === 'string' && gone(v.after)) {
        changed = true
        return { ...e, value: { ...v, after: null } }
      }
      return e
    })
  if (changed || keep.length !== list.length) write(JOURNAL_KEY, keep)
}
