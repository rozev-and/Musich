import { createReadStream, existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ZipFile } from 'yazl'
import type { Db } from './db.ts'
import { badRequest } from './errors.ts'
import type { Library } from './library.ts'
import { safeFileName } from './media.ts'

// Бэкап — один файл: снимок базы, а внутри таблица со своими картинками (covers/custom).
// Картинки из тегов не нужны: они лежат в самих файлах музыки
const FILES_TABLE = 'musich_backup_files'
const PENDING = 'restore-pending.db'

/** Снимок базы с картинками — во временный файл (вызывающий удаляет его, когда отдал) */
export async function makeBackup(db: Db, dataDir: string): Promise<string> {
  const file = join(dataDir, `backup-${Date.now()}.db`)
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  const b = new DatabaseSync(file)
  try {
    b.exec(`CREATE TABLE ${FILES_TABLE} (name TEXT PRIMARY KEY, data BLOB NOT NULL)`)
    const dir = join(dataDir, 'covers', 'custom')
    const ins = b.prepare(`INSERT INTO ${FILES_TABLE} (name, data) VALUES (?, ?)`)
    for (const name of await readdir(dir).catch(() => [] as string[])) ins.run(`covers/custom/${name}`, await readFile(join(dir, name)))
  } finally {
    b.close()
  }
  return file
}

/** Присланный бэкап: проверить, что это база MUSICH, и отложить до перезапуска (на живой базе подменять нельзя) */
export async function stageRestore(tmp: string, dataDir: string) {
  const fd = await open(tmp, 'r')
  const head = Buffer.alloc(16)
  await fd.read(head, 0, 16, 0)
  await fd.close()
  if (head.toString('latin1') !== 'SQLite format 3\0') throw badRequest('Это не файл бэкапа MUSICH')
  let ok = false
  try {
    const b = new DatabaseSync(tmp, { readOnly: true })
    const tables = b.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tracks', 'settings', 'playlists')").all()
    b.close()
    ok = tables.length === 3
  } catch {
    /* битый файл — ниже ошибка */
  }
  if (!ok) throw badRequest('Это не файл бэкапа MUSICH')
  await rename(tmp, join(dataDir, PENDING))
}

/**
 * Запуск сервера: если ждёт принятый бэкап — ставим его вместо базы, пока она не открыта.
 * Прежняя база остаётся рядом как musich.db.before-restore
 */
export async function applyPendingRestore(dataDir: string): Promise<boolean> {
  const pending = join(dataDir, PENDING)
  if (!existsSync(pending)) return false
  const b = new DatabaseSync(pending)
  let files: { name: string; data: Uint8Array }[] = []
  try {
    if (b.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(FILES_TABLE)) {
      files = b.prepare(`SELECT name, data FROM ${FILES_TABLE}`).all() as typeof files
      b.exec(`DROP TABLE ${FILES_TABLE}`)
    }
  } finally {
    b.close()
  }
  const custom = join(dataDir, 'covers', 'custom')
  await rm(custom, { recursive: true, force: true })
  await mkdir(custom, { recursive: true })
  for (const f of files) if (f.name.startsWith('covers/custom/')) await writeFile(join(custom, basename(f.name)), f.data)
  const dbFile = join(dataDir, 'musich.db')
  if (existsSync(dbFile)) await rename(dbFile, `${dbFile}.before-restore`)
  for (const ext of ['-wal', '-shm']) await rm(dbFile + ext, { force: true })
  await rename(pending, dbFile)
  return true
}

export interface ExportOptions {
  tracks: boolean // все треки одной папкой
  albums: boolean // по папке на альбом
  playlists: 'none' | 'copies' | 'm3u' // папки с копиями или один набор треков + .m3u8
  names: { tracks: string; albums: string; playlists: string; liked: string } // имена папок — на языке интерфейса
}

/**
 * Выгрузка музыки zip-архивом, без сжатия (музыка и так сжата). Идёт потоком — архив на десятки гигабайт
 * не ложится ни в память, ни на диск; размер известен заранее, браузер показывает прогресс
 */
export async function exportZip(lib: Library, userId: string, o: ExportOptions): Promise<{ stream: NodeJS.ReadableStream; size: number }> {
  const tracks = lib.listTracks(userId)
  const files = new Map<string, { path: string; size: number; mtime: Date }>()
  for (const t of tracks) {
    const f = lib.trackFile(userId, t.id)
    if (!f) continue
    const st = await stat(f.path).catch(() => null)
    if (st) files.set(t.id, { path: f.path, size: st.size, mtime: st.mtime })
  }
  const byId = new Map(tracks.filter((t) => files.has(t.id)).map((t) => [t.id, t]))
  const zip = new ZipFile()
  const add = (id: string, name: string) => {
    const f = files.get(id)!
    zip.addReadStreamLazy(name, { size: f.size, mtime: f.mtime, compress: false }, (cb) => cb(null, createReadStream(f.path)))
  }
  // в одной папке имена не повторяются: «Песня.mp3», «Песня (2).mp3»
  const namer = () => {
    const used = new Set<string>()
    return (name: string) => {
      const ext = extname(name)
      const base = name.slice(0, name.length - ext.length)
      let out = name
      for (let n = 2; used.has(out.toLowerCase()); n++) out = `${base} (${n})${ext}`
      used.add(out.toLowerCase())
      return out
    }
  }
  const dir = (s: string) => safeFileName(s) || '_'
  const fileOf = (id: string) => safeFileName(basename(files.get(id)!.path)) || `${id}${extname(files.get(id)!.path)}`

  const playlists = o.playlists === 'none' ? [] : [
    { name: o.names.liked, ids: tracks.filter((t) => t.liked).sort((a, b) => (b.likedAt ?? '').localeCompare(a.likedAt ?? '')).map((t) => t.id) },
    ...lib.listPlaylists(userId).map((p) => ({ name: p.name, ids: p.trackIds })),
  ].map((p) => ({ ...p, ids: p.ids.filter((id) => byId.has(id)) })).filter((p) => p.ids.length)

  // общая папка треков: если выбрана — все; для .m3u8 — хотя бы те, что в плейлистах
  const inTracks = new Map<string, string>()
  const needed = o.tracks ? [...byId.keys()] : o.playlists === 'm3u' ? [...new Set(playlists.flatMap((p) => p.ids))] : []
  const tracksName = namer()
  for (const id of needed) {
    const name = tracksName(fileOf(id))
    inTracks.set(id, name)
    add(id, `${dir(o.names.tracks)}/${name}`)
  }

  if (o.albums) {
    const albums = new Map<string, string[]>()
    for (const t of byId.values()) albums.set(t.album, [...(albums.get(t.album) ?? []), t.id])
    const albumDir = namer()
    for (const [album, ids] of albums) {
      const artists = new Set(ids.map((id) => byId.get(id)!.artist))
      const folder = albumDir(dir(artists.size === 1 ? `${[...artists][0]} - ${album}` : album))
      const inAlbum = namer()
      ids.sort((a, b) => (byId.get(a)!.trackNo ?? 0) - (byId.get(b)!.trackNo ?? 0))
      for (const id of ids) add(id, `${dir(o.names.albums)}/${folder}/${inAlbum(fileOf(id))}`)
    }
  }

  const listName = namer()
  for (const p of playlists) {
    const name = listName(dir(p.name))
    if (o.playlists === 'copies') {
      // номер впереди — чтобы в папке треки стояли в порядке плейлиста
      const w = String(p.ids.length).length
      p.ids.forEach((id, i) => add(id, `${dir(o.names.playlists)}/${name}/${String(i + 1).padStart(w, '0')} ${fileOf(id)}`))
    } else {
      const lines = ['#EXTM3U', ...p.ids.flatMap((id) => {
        const t = byId.get(id)!
        return [`#EXTINF:${t.duration},${t.artist} - ${t.title}`, `../${dir(o.names.tracks)}/${inTracks.get(id)}`]
      })]
      zip.addBuffer(Buffer.from(lines.join('\r\n') + '\r\n', 'utf8'), `${dir(o.names.playlists)}/${name}.m3u8`, { compress: false })
    }
  }

  const size = await new Promise<number>((resolve) => {
    ;(zip.end as (o: object, cb: (n: number) => void) => void)({}, (n) => resolve(n))
  })
  return { stream: zip.outputStream, size }
}
