// Движок синхронизации: локальная папка ↔ сервер по контракту docs/API.md.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { Api, IntegrityError, describeError, isRetryable, type Track } from './api.js'
import { TMP_SUFFIX, fromRel, freeName, hashFile, scanFolder, splitStable, toRel, trackFileName } from './files.js'
import { withLock } from './lock.js'
import type { Log } from './log.js'
import {
  DEFAULTS,
  loadConfig,
  loadConfigIfExists,
  loadState,
  saveConfig,
  saveState,
  emptyState,
  type Config,
  type DeviceKind,
  type DownloadMode,
  type RemoteTrack,
  type State,
} from './store.js'

export interface Context {
  dir: string
  config: Config
  api: Api
  log: Log
}

export function makeApi(config: Pick<Config, 'server' | 'token' | 'retries' | 'retryDelayMs'> & { deviceId?: string }, log: Log): Api {
  return new Api({ server: config.server, token: config.token, deviceId: config.deviceId || undefined, retries: config.retries, retryDelayMs: config.retryDelayMs, log })
}

export async function openContext(dir: string, log: Log): Promise<Context> {
  const config = await loadConfig(dir)
  return { dir, config, api: makeApi(config, log), log }
}

// ───────────────────────── init ─────────────────────────

export interface InitOptions {
  server?: string
  folder?: string
  name?: string
  kind?: DeviceKind
  token?: string
  mode?: DownloadMode
  pollIntervalSec?: number
}

export async function init(dir: string, opts: InitOptions, log: Log): Promise<Config> {
  const existing = (await loadConfigIfExists(dir)) ?? {}
  const server = (opts.server ?? existing.server)?.replace(/\/+$/, '')
  const folderRaw = opts.folder ?? existing.folder
  if (!server) throw new Error('Укажите адрес сервера: --server http://pi5.local:2290')
  if (!folderRaw) throw new Error('Укажите папку синхронизации: --folder <путь>')
  const folder = path.resolve(folderRaw)

  const draft = { ...DEFAULTS, ...existing, server, token: opts.token ?? existing.token }
  const api = makeApi(draft, log)
  const health = await api.health()
  log.info(`Сервер ${server} отвечает${health.version ? `, версия ${health.version}` : ''}`)

  const deviceName = opts.name ?? existing.deviceName ?? defaultDeviceName()
  const deviceKind = opts.kind ?? existing.deviceKind ?? 'desktop'
  let deviceId = existing.server === server ? existing.deviceId : undefined
  if (!deviceId) {
    deviceId = (await api.registerDevice(deviceName, deviceKind)).id
    log.info(`Устройство «${deviceName}» зарегистрировано, id ${deviceId}`)
  }

  await fs.mkdir(folder, { recursive: true })
  const config: Config = {
    ...draft,
    deviceId,
    deviceName,
    deviceKind,
    folder,
    mode: opts.mode ?? existing.mode ?? DEFAULTS.mode,
    pollIntervalSec: opts.pollIntervalSec ?? existing.pollIntervalSec ?? DEFAULTS.pollIntervalSec,
  }
  if (!config.token) delete config.token
  await withLock(dir, async () => {
    await saveConfig(dir, config)
    // Другой сервер или другая папка — старая карта файлов и курсор не годятся.
    if (existing.server !== server || (existing.folder && path.resolve(existing.folder) !== folder)) {
      await saveState(dir, emptyState())
    }
  })
  return config
}

function defaultDeviceName(): string {
  return process.env.COMPUTERNAME || process.env.HOSTNAME || 'Компьютер'
}

// ───────────────────────── один проход ─────────────────────────

export interface PassResult {
  uploaded: string[] // залито на сервер (rel)
  linked: string[] // уже было на сервере — только сопоставили (rel)
  growing: string[] // ещё пишутся, ждут следующего прохода (rel)
  downloaded: string[] // скачано (rel)
  removedByServer: string[] // удалены по надгробию (rel)
  removedByUser: string[] // удалены руками → «удалено только здесь» (id)
  failed: { item: string; error: string }[]
  cursor: number
}

function newResult(cursor: number): PassResult {
  return { uploaded: [], linked: [], growing: [], downloaded: [], removedByServer: [], removedByUser: [], failed: [], cursor }
}

/** Сохраняет состояние не чаще раза в пару секунд, чтобы долгий первый проход не терял прогресс при сбое. */
function checkpointer(dir: string, state: State) {
  let last = Date.now()
  return async (force = false) => {
    if (!force && Date.now() - last < 2000) return
    await saveState(dir, state)
    last = Date.now()
  }
}

export async function syncOnce(ctx: Context): Promise<PassResult> {
  return withLock(ctx.dir, async () => {
    const state = await loadState(ctx.dir)
    const result = newResult(state.cursor)
    const checkpoint = checkpointer(ctx.dir, state)
    try {
      await scanLocal(ctx, state, result, checkpoint)
      await pullChanges(ctx, state, result, checkpoint)
      await ctx.api.seen(ctx.config.deviceId).catch((e) => ctx.log.warn(`Не удалось отметить устройство: ${describeError(e)}`))
      if (ctx.config.mode === 'all') await downloadMissing(ctx, state, result, checkpoint)
      state.lastSyncAt = new Date().toISOString()
      delete state.lastError
    } catch (e) {
      state.lastError = describeError(e)
      throw e
    } finally {
      result.cursor = state.cursor
      await saveState(ctx.dir, state)
    }
    return result
  })
}

function idsOnDisk(state: State): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const [rel, entry] of Object.entries(state.files)) {
    const list = map.get(entry.id)
    if (list) list.push(rel)
    else map.set(entry.id, [rel])
  }
  return map
}

function rememberRemote(state: State, t: Track): void {
  state.remote[t.id] = {
    id: t.id,
    hash: t.hash ?? t.id,
    artist: t.artist ?? '',
    title: t.title ?? '',
    format: t.format ?? '',
    fileName: t.fileName ?? '',
    size: t.size ?? 0,
  }
}

function unforget(state: State, id: string): void {
  state.localOnlyDeleted = state.localOnlyDeleted.filter((x) => x !== id)
}

/** Новые и изменённые файлы → на сервер; пропавшие → «удалено только здесь». */
async function scanLocal(ctx: Context, state: State, result: PassResult, checkpoint: (force?: boolean) => Promise<void>) {
  const { folder, stableMs } = ctx.config
  const st = await fs.stat(folder).catch(() => undefined)
  // Папки нет (отключён диск?) — нельзя считать, что пользователь удалил все файлы.
  if (!st?.isDirectory()) throw new Error(`Папка синхронизации не найдена: ${folder}`)

  const scanned = await scanFolder(folder)
  const present = new Set(scanned.map((f) => f.rel))
  const changed = scanned.filter((f) => {
    const e = state.files[f.rel]
    return !e || e.size !== f.size || e.mtimeMs !== f.mtimeMs
  })
  const { stable, growing } = await splitStable(changed, stableMs)
  result.growing.push(...growing.map((f) => f.rel))

  for (const f of stable) {
    let hash: string
    try {
      hash = await hashFile(f.abs)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw e
    }
    // id трека постоянный, а отпечаток файла меняется при прошивке тегов: сначала узнаём, чей это файл
    let id = hash
    // Копия уже сопоставленного файла — сервер про него знает. Иначе спрашиваем сервер по отпечатку: локальный
    // каталог мог устареть (трек удалили из хранилища), а повторная загрузка восстанавливает надгробие.
    const twin = Object.entries(state.files).find(([rel, e]) => (e.hash ?? e.id) === hash && rel !== f.rel)
    try {
      const remote = twin ? undefined : await ctx.api.trackByHash(hash)
      if (twin) id = twin[1].id
      else if (remote) id = remote.id
      if (!twin && !remote) {
        const { track } = await ctx.api.uploadTrack(f.abs, path.basename(f.abs))
        id = track.id
        rememberRemote(state, track)
        result.uploaded.push(f.rel)
        ctx.log.info(`↑ ${f.rel}`)
      } else {
        result.linked.push(f.rel)
        ctx.log.debug(`= ${f.rel} уже в хранилище (${id})`)
      }
      // Пользователь вернул файл в папку — значит, он снова нужен на этом устройстве.
      unforget(state, id)
    } catch (e) {
      if (isRetryable(e)) throw e // сеть лежит — дальше идти бессмысленно
      result.failed.push({ item: f.rel, error: describeError(e) })
      ctx.log.error(`Не удалось загрузить ${f.rel}: ${describeError(e)}`)
      continue
    }
    const previous = state.files[f.rel]?.id
    state.files[f.rel] = { id, hash, size: f.size, mtimeMs: f.mtimeMs }
    // Файл перезаписали другим содержимым (например, поправили теги) — старую версию обратно не качаем.
    if (previous && previous !== id && !Object.values(state.files).some((e) => e.id === previous)) {
      state.localOnlyDeleted.push(previous)
    }
    await checkpoint()
  }

  // Пропавшие файлы. Если тот же id остался под другим путём — это переименование, а не удаление.
  const gone = Object.keys(state.files).filter((rel) => !present.has(rel))
  for (const rel of gone) {
    const { id } = state.files[rel]!
    delete state.files[rel]
    const stillHere = Object.values(state.files).some((e) => e.id === id)
    if (!stillHere && !state.localOnlyDeleted.includes(id)) {
      state.localOnlyDeleted.push(id)
      result.removedByUser.push(id)
      ctx.log.info(`− ${rel} удалён вручную: убираю только с этого устройства`)
    }
  }
}

/** Лента /changes: запоминаем серверные треки, по надгробиям удаляем локальные файлы. */
async function pullChanges(ctx: Context, state: State, result: PassResult, checkpoint: (force?: boolean) => Promise<void>) {
  for (let page = 0; page < 10_000; page++) {
    const since = state.cursor
    const changes = await ctx.api.changes(since)
    const tracks = [...(changes.tracks ?? [])].sort((a, b) => a.seq - b.seq)
    for (const t of tracks) {
      if (t.status === 'deleted') await applyTombstone(ctx, state, t.id, result)
      else rememberRemote(state, t)
    }
    const empty = !tracks.length && !changes.playlists?.length && !changes.covers?.length
    // Курсор двигаем только после того, как применили весь ответ: при сбое следующий проход начнёт с того же места.
    if (typeof changes.cursor === 'number' && changes.cursor > since) state.cursor = changes.cursor
    await checkpoint(true)
    if (empty || state.cursor <= since) break
  }
}

async function applyTombstone(ctx: Context, state: State, id: string, result: PassResult) {
  delete state.remote[id]
  unforget(state, id)
  for (const [rel, entry] of Object.entries(state.files)) {
    if (entry.id !== id) continue
    const abs = fromRel(ctx.config.folder, rel)
    delete state.files[rel]
    const st = await fs.stat(abs).catch(() => undefined)
    if (!st) continue
    if (st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) {
      // Файл успели изменить — это уже другой трек, его не трогаем (на следующем проходе он зальётся как новый).
      ctx.log.warn(`${rel}: трек удалён из хранилища, но файл изменён локально — оставляю`)
      continue
    }
    await fs.rm(abs, { force: true })
    result.removedByServer.push(rel)
    ctx.log.info(`✗ ${rel} удалён из хранилища`)
  }
}

function wanted(state: State): RemoteTrack[] {
  const local = idsOnDisk(state)
  const skip = new Set(state.localOnlyDeleted)
  return Object.values(state.remote).filter((r) => !local.has(r.id) && !skip.has(r.id))
}

async function downloadMissing(ctx: Context, state: State, result: PassResult, checkpoint: (force?: boolean) => Promise<void>) {
  for (const r of wanted(state)) {
    try {
      const rel = await downloadTrack(ctx, state, r)
      result.downloaded.push(rel)
    } catch (e) {
      if (isRetryable(e)) throw e
      result.failed.push({ item: r.id, error: describeError(e) })
      ctx.log.error(`Не удалось скачать ${r.artist} - ${r.title} (${r.id}): ${describeError(e)}`)
    }
    await checkpoint()
  }
}

/** Временный файл рядом с итоговым. Имя по id, чтобы после обрыва следующий проход докачал его через Range. */
export function partPath(folder: string, id: string): string {
  return path.join(folder, `.${id}${TMP_SUFFIX}`)
}

async function downloadTrack(ctx: Context, state: State, r: RemoteTrack): Promise<string> {
  const { folder } = ctx.config
  const part = partPath(folder, r.id)
  await ctx.api.download(r.id, part)
  const actual = await hashFile(part)
  if (actual !== (r.hash ?? r.id)) {
    await fs.rm(part, { force: true })
    throw new IntegrityError(`скачанный файл не совпал по хэшу (${actual})`)
  }
  const name = await freeName(folder, trackFileName(r))
  const abs = path.join(folder, name)
  await fs.rename(part, abs)
  const st = await fs.stat(abs)
  const rel = toRel(folder, abs)
  state.files[rel] = { id: r.id, hash: actual, size: st.size, mtimeMs: st.mtimeMs }
  ctx.log.info(`↓ ${rel}`)
  return rel
}

// ───────────────────────── команды ─────────────────────────

/** id целиком, его начало (от 4 символов) или путь к файлу в папке. */
export function resolveId(ctx: Context, state: State, ref: string): string {
  if (/^[0-9a-f]{16}$/i.test(ref)) return ref.toLowerCase()
  const abs = path.resolve(ctx.config.folder, ref)
  const byPath = state.files[toRel(ctx.config.folder, abs)]
  if (byPath) return byPath.id
  if (/^[0-9a-f]{4,15}$/i.test(ref)) {
    const all = new Set([...Object.keys(state.remote), ...Object.values(state.files).map((e) => e.id)])
    const hits = [...all].filter((id) => id.startsWith(ref.toLowerCase()))
    if (hits.length === 1) return hits[0]!
    if (hits.length > 1) throw new Error(`«${ref}» подходит к нескольким трекам: ${hits.join(', ')}`)
  }
  throw new Error(`Не нашёл трек «${ref}»: укажите id (16 hex) или путь к файлу в папке синхронизации`)
}

async function removeLocalFiles(ctx: Context, state: State, id: string): Promise<string[]> {
  const removed: string[] = []
  for (const [rel, entry] of Object.entries(state.files)) {
    if (entry.id !== id) continue
    await fs.rm(fromRel(ctx.config.folder, rel), { force: true })
    delete state.files[rel]
    removed.push(rel)
  }
  await fs.rm(partPath(ctx.config.folder, id), { force: true })
  return removed
}

export async function remove(ctx: Context, ref: string, where: 'local' | 'everywhere'): Promise<{ id: string; removed: string[] }> {
  return withLock(ctx.dir, async () => {
    const state = await loadState(ctx.dir)
    const id = resolveId(ctx, state, ref)
    if (where === 'everywhere') {
      await ctx.api.deleteTrack(id)
      delete state.remote[id]
      unforget(state, id)
    } else if (!state.localOnlyDeleted.includes(id)) {
      state.localOnlyDeleted.push(id)
    }
    const removed = await removeLocalFiles(ctx, state, id)
    await saveState(ctx.dir, state)
    return { id, removed }
  })
}

/** Скачать трек по запросу: для режима on-demand и чтобы вернуть «удалённое только здесь». */
export async function pull(ctx: Context, ref: string): Promise<{ id: string; path?: string }> {
  return withLock(ctx.dir, async () => {
    const state = await loadState(ctx.dir)
    const id = resolveId(ctx, state, ref)
    unforget(state, id)
    try {
      const existing = Object.entries(state.files).find(([, e]) => e.id === id)
      if (existing) return { id, path: existing[0] }
      if (!state.remote[id]) {
        const track = await ctx.api.getTrack(id)
        if (!track || track.status === 'deleted') throw new Error(`Трека ${id} нет в хранилище`)
        rememberRemote(state, track)
      }
      return { id, path: await downloadTrack(ctx, state, state.remote[id]!) }
    } finally {
      await saveState(ctx.dir, state)
    }
  })
}

export interface Status {
  config: Config
  cursor: number
  lastSyncAt?: string
  lastError?: string
  localTracks: number
  remoteTracks: number
  toUpload: string[] // файлы в папке, которые ещё не сопоставлены
  toDownload: RemoteTrack[] // ждут скачивания (в режиме on-demand — доступны по pull)
  localOnlyDeleted: string[]
}

export async function status(ctx: Context): Promise<Status> {
  const state = await loadState(ctx.dir)
  const scanned = await scanFolder(ctx.config.folder)
  const toUpload = scanned
    .filter((f) => {
      const e = state.files[f.rel]
      return !e || e.size !== f.size || e.mtimeMs !== f.mtimeMs
    })
    .map((f) => f.rel)
  return {
    config: ctx.config,
    cursor: state.cursor,
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError,
    localTracks: idsOnDisk(state).size,
    remoteTracks: Object.keys(state.remote).length,
    toUpload,
    toDownload: wanted(state),
    localOnlyDeleted: state.localOnlyDeleted,
  }
}
