import { App } from '@capacitor/app'
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { Device } from '@capacitor/device'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Network } from '@capacitor/network'
import type { Changes, ServerPlaylist, ServerTrack } from './api'

/**
 * Приложение на телефоне (режим device, Capacitor): своя копия музыки и библиотеки, чтобы слушать без сети.
 *  - адрес сервера и id устройства — в localStorage;
 *  - файлы треков и обложек — в папке приложения (Android/data/…/files/MUSICH), без разрешений на память;
 *  - библиотека (что прислал сервер через /changes) — в library.json: открывается и без сервера.
 * Всё, что про сеть и файлы, — здесь; что качать и когда — решает стор.
 */

const DIR = Directory.External // папка приложения: видна по USB, удаляется вместе с приложением
const ROOT = 'MUSICH'
const LIBRARY_FILE = 'library.json'

// ---------- сервер и устройство ----------

const SERVER_KEY = 'musich-server'
const NODE_KEY = 'musich-node' // id сервера: по нему узнаём его, когда роутер выдал ПК другой адрес
const DEVICE_KEY = 'musich-device'

export const savedServer = () => localStorage.getItem(SERVER_KEY) ?? ''
export const saveServer = (url: string | null) => (url ? localStorage.setItem(SERVER_KEY, url) : localStorage.removeItem(SERVER_KEY))

// Свой профиль телефона без сервера: имя и фото. С сервером профиль — его (после «Объединить» этот удаляется)
const PROFILE_KEY = 'musich-profile'
export type LocalProfile = { name: string; email?: string; avatar?: string }
export function loadProfile(): LocalProfile | null {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE_KEY) ?? 'null') as LocalProfile | null
    return p?.name ? p : null
  } catch {
    return null
  }
}
export const saveProfile = (p: LocalProfile) => localStorage.setItem(PROFILE_KEY, JSON.stringify(p))
export const clearProfile = () => localStorage.removeItem(PROFILE_KEY)
export const savedNode = () => localStorage.getItem(NODE_KEY) ?? ''
export const saveNode = (node: string) => localStorage.setItem(NODE_KEY, node)

/** «192.168.1.5:2290» → «http://192.168.1.5:2290»: схему и лишние слеши дописываем за человека */
export function normalizeServer(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '').replace(/\/api$/, '')
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  // домен (music.example.com) — https: http у таких обычно переадресует на https, а переадресацию запросов к
  // чужому сайту WebView не пропускает, и сервер «не находился». IP, localhost, .local и имя без точки — домашняя сеть, http
  const host = s.split(/[/:]/)[0]
  const home = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host === 'localhost' || host.endsWith('.local') || !host.includes('.')
  return `${home ? 'http' : 'https'}://${s}`
}

export const savedDeviceId = () => localStorage.getItem(DEVICE_KEY)
export const saveDeviceId = (id: string | null) => (id ? localStorage.setItem(DEVICE_KEY, id) : localStorage.removeItem(DEVICE_KEY))

/** Как назвать телефон на сервере: производитель и модель, например «Xiaomi 2201117TY» */
/**
 * Постоянный номер устройства: у Android он свой у приложения и переживает переустановку (пока приложение
 * подписано тем же ключом). По нему сервер узнаёт телефон, а не заводит новый после каждой установки
 */
export async function hardwareId(): Promise<string | undefined> {
  try {
    const { identifier } = await Device.getId()
    return identifier && identifier.length >= 4 ? identifier : undefined
  } catch {
    return undefined
  }
}

export async function deviceName(): Promise<string> {
  try {
    const info = await Device.getInfo()
    const name = [info.manufacturer, info.model].filter(Boolean).join(' ').trim()
    return name || 'Телефон'
  } catch {
    return 'Телефон'
  }
}

// ---------- скачанные файлы ----------

export interface LocalFile {
  file: string // путь трека внутри папки приложения (у перенесённого — откуда имя файла)
  uri?: string // перенесён из папки приложения: file:// в «Музыка/MUSICH» или content:// в своей папке
  at?: StoreAt // где лежит сейчас; нет — в папке приложения
  hash?: string // отпечаток скачанного файла; нет — скачан до постоянных id, тогда он равен id
  cover?: string // путь обложки
  size: number
}

const LOCAL_KEY = 'musich-local' // id трека → файл
const EXCLUDED_KEY = 'musich-excluded' // «удалено только здесь»: само больше не качаем
const PINNED_KEY = 'musich-pinned' // скачано вручную: держим, даже если не в избранном и не в плейлисте
const PLAYS_KEY = 'musich-plays-queue' // прослушивания без сети — отправим, когда сервер появится

const readJson = <T>(key: string, fallback: T): T => {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? 'null') as T) ?? fallback
  } catch {
    return fallback
  }
}
const writeJson = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value))

let local: Record<string, LocalFile> = readJson(LOCAL_KEY, {})
const uriCache = new Map<string, string>() // путь → адрес для <audio>/<img>

export const localFiles = () => local
export const isLocal = (id: string) => !!local[id]
export const localHash = (id: string) => local[id]?.hash ?? id
export const excluded = () => new Set(readJson<string[]>(EXCLUDED_KEY, []))
export const pinned = () => new Set(readJson<string[]>(PINNED_KEY, []))
const setList = (key: string, set: Set<string>) => writeJson(key, [...set])

export function pin(ids: string[]) {
  const p = pinned()
  const ex = excluded()
  for (const id of ids) {
    p.add(id)
    ex.delete(id) // скачал руками то, что раньше удалял «только здесь», — значит, снова нужен
  }
  setList(PINNED_KEY, p)
  setList(EXCLUDED_KEY, ex)
}

/** Адрес файла приложения для <audio>/<img> (WebView не открывает file:// напрямую) */
async function fileSrc(path: string): Promise<string> {
  const known = uriCache.get(path)
  if (known) return known
  const { uri } = await Filesystem.getUri({ path, directory: DIR })
  const src = Capacitor.convertFileSrc(uri)
  uriCache.set(path, src)
  return src
}

/** Заранее разворачиваем адреса всех скачанных (и ждущих отправки) файлов: стору они нужны синхронно */
export async function warmUp() {
  await Promise.all(Object.values(images).map((p) => fileSrc(p).catch(() => '')))
  await Promise.all(
    [...Object.values(local), ...outbox()]
      .flatMap((f) => [...((f as LocalFile).uri ? [] : [fileSrc(f.file)]), ...(f.cover ? [fileSrc(f.cover)] : [])])
      .map((p) => p.catch(() => '')),
  )
}

/** Адрес скачанного трека и его обложки, если они уже есть (в том числе ещё не отправленного) */
export const localSrc = (id: string) => {
  const f = local[id] ?? (isPending(id) ? outboxItem(id) : undefined)
  if (!f) return undefined
  // перенесённый в общую или свою папку: Capacitor отдаёт и file://, и content://
  const uri = (f as LocalFile).uri
  return uri ? Capacitor.convertFileSrc(uri) : uriCache.get(f.file)
}
export const localCover = (id: string) => {
  const c = (local[id] ?? (isPending(id) ? outboxItem(id) : undefined))?.cover
  return c ? uriCache.get(c) : undefined
}

const extOf = (t: ServerTrack) => (t.format || t.fileName.split('.').pop() || 'audio').toLowerCase()

// downloadFile в Filesystem 8 не создаёт папки (recursive там не работает): на свежей установке Music/ и Covers/
// ещё нет — запрос уходит, а записать некуда, и скачивание сразу падает. Создаём сами, один раз
const madeDirs = new Set<string>()
async function ensureDir(path: string) {
  if (madeDirs.has(path)) return
  await Filesystem.mkdir({ path, directory: DIR, recursive: true }).catch(() => {}) // уже есть — тоже хорошо
  madeDirs.add(path)
}

/**
 * Скачать трек (и обложку) в папку приложения. url — адрес файла на сервере (с токеном),
 * onProgress — 0..100. Сначала во временное имя: оборванная загрузка не выглядит скачанной
 */
export async function downloadTrack(t: ServerTrack, url: string, coverUrl: string | undefined, onProgress: (p: number) => void) {
  const file = `${ROOT}/Music/${t.id}.${extOf(t)}`
  const part = `${file}.part`
  const old = local[t.id]
  // в общей или своей папке уже лежит такой файл (музыку оставили при удалении приложения) — берём его, не качаем
  const kept = !old ? await keptFile(`${t.id}.${extOf(t)}`, t.size) : undefined
  if (kept) {
    local = { ...local, [t.id]: { file, uri: kept.uri, at: kept.at, size: t.size, hash: t.hash ?? t.id } }
    writeJson(LOCAL_KEY, local)
    onProgress(100)
    return
  }
  await ensureDir(`${ROOT}/Music`)
  if (coverUrl) await ensureDir(`${ROOT}/Covers`)
  const listener = await Filesystem.addListener('progress', (e) => {
    if (e.url === url && e.contentLength > 0) onProgress((e.bytes / e.contentLength) * 100)
  })
  try {
    await Filesystem.downloadFile({ readTimeout: 60_000, connectTimeout: 15_000, url, path: part, directory: DIR, progress: true, recursive: true })
    // перекачиваем прошитый на сервере трек — старая версия лежит под тем же именем (или в другой папке)
    if (old?.uri) await MusicStore.remove({ uri: old.uri }).catch(() => {})
    else if (old) await Filesystem.deleteFile({ path: file, directory: DIR }).catch(() => {})
    await Filesystem.rename({ from: part, to: file, directory: DIR, toDirectory: DIR })
  } catch (e) {
    await Filesystem.deleteFile({ path: part, directory: DIR }).catch(() => {})
    throw e
  } finally {
    await listener.remove()
  }
  let cover: string | undefined
  if (coverUrl) {
    cover = `${ROOT}/Covers/${t.id}`
    // без обложки трек всё равно играет — её ошибка не мешает
    await Filesystem.downloadFile({ readTimeout: 60_000, connectTimeout: 15_000, url: coverUrl, path: cover, directory: DIR, recursive: true }).catch(() => (cover = undefined))
  }
  local = { ...local, [t.id]: { file, cover, size: t.size, hash: t.hash ?? t.id } }
  writeJson(LOCAL_KEY, local)
  uriCache.delete(file)
  if (cover) uriCache.delete(cover)
  await fileSrc(file)
  if (cover) await fileSrc(cover).catch(() => {})
}

// ---------- поделиться ----------

/**
 * Отправить трек в другое приложение (Telegram, ВК, почта…) самим файлом под понятным именем «Исполнитель - Название.ext».
 * Файл кладём во временную папку: с телефона — копией (из папки приложения, «Музыки» или своей папки), а если трека
 * на телефоне нет — скачиваем с сервера (remoteUrl). Не вышло ни так ни так — false, ничего не отправляем
 */
export async function shareTrack(id: string, fileName: string, text: string, remoteUrl?: string): Promise<boolean> {
  const { Share } = await import('@capacitor/share')
  const path = `share/${fileName.replace(/[\\/:*?"<>|]/g, '_')}`
  // папку пересоздаём: прошлый отправленный файл не нужен (раньше папку удаляли и не создавали — копия молча не получалась)
  await Filesystem.rmdir({ path: 'share', directory: Directory.Cache, recursive: true }).catch(() => {})
  await Filesystem.mkdir({ path: 'share', directory: Directory.Cache, recursive: true }).catch(() => {})
  const f = local[id] ?? (isPending(id) ? outboxItem(id) : undefined)
  let ready = false
  if (f) {
    try {
      const from = (f as LocalFile).uri ?? (await Filesystem.getUri({ path: f.file, directory: DIR })).uri
      if (from.startsWith('file:')) await Filesystem.copy({ from, to: path, toDirectory: Directory.Cache })
      // своя папка (content://) — читаем через WebView и пишем копию
      else await writeBlobTo(path, Directory.Cache, await fetch(Capacitor.convertFileSrc(from)).then((r) => r.blob()))
      ready = true
    } catch {
      ready = false
    }
  }
  if (!ready && remoteUrl) {
    try {
      await Filesystem.downloadFile({ readTimeout: 60_000, connectTimeout: 15_000, url: remoteUrl, path, directory: Directory.Cache, recursive: true })
      ready = true
    } catch {
      ready = false
    }
  }
  if (!ready) return false
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
  await Share.share({ title: text, files: [uri], dialogTitle: text })
  return true
}

/** Записать Blob в файл в любой папке Filesystem кусками (как writeBlob, но не только в папку приложения) */
async function writeBlobTo(path: string, directory: Directory, blob: Blob) {
  const CHUNK = 3 * 1024 * 1024
  await Filesystem.writeFile({ path, directory, data: await toBase64(blob.slice(0, CHUNK)), recursive: true })
  for (let at = CHUNK; at < blob.size; at += CHUNK) await Filesystem.appendFile({ path, directory, data: await toBase64(blob.slice(at, at + CHUNK)) })
}

// ---------- картинки без сети ----------
// Свои обложки (альбом, артист, трек — поставленные в MUSICH) лежат на сервере отдельно от файлов. Держим их копию
// здесь, чтобы и без сети альбомы были с картинками. Ключ — «вид:имя:версия»: сменили картинку — новая версия

const IMG_KEY = 'musich-images'
let images: Record<string, string> = readJson(IMG_KEY, {})
const keyFile = (key: string) => {
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0
  return `img-${h.toString(36)}-${key.length.toString(36)}`
}
export const hasImage = (key: string) => !!images[key]
export const localImage = (key: string) => {
  const p = images[key]
  return p ? uriCache.get(p) : undefined
}
export async function cacheImage(key: string, url: string) {
  if (images[key]) return
  await ensureDir(`${ROOT}/Covers`)
  const path = `${ROOT}/Covers/${keyFile(key)}`
  await Filesystem.downloadFile({ readTimeout: 60_000, connectTimeout: 15_000, url, path, directory: DIR, recursive: true })
  images = { ...images, [key]: path }
  writeJson(IMG_KEY, images)
  await fileSrc(path).catch(() => '')
}

/** Скачанный трек без своей обложки (скачан до того или подхвачен после переустановки) — докачать её */
export async function fetchTrackCover(id: string, url: string): Promise<boolean> {
  const f = local[id]
  if (!f || f.cover) return false
  await ensureDir(`${ROOT}/Covers`)
  const cover = `${ROOT}/Covers/${id}`
  try {
    await Filesystem.downloadFile({ readTimeout: 60_000, connectTimeout: 15_000, url, path: cover, directory: DIR, recursive: true })
  } catch {
    return false
  }
  local = { ...local, [id]: { ...local[id], cover } }
  writeJson(LOCAL_KEY, local)
  await fileSrc(cover).catch(() => '')
  return true
}

/**
 * Проверить скачанное: файл на месте и по размеру совпадает с тем, что прислал сервер. Пропавшее и битое
 * убираем из списка скачанного (не «удалено здесь») — синхронизация скачает его заново
 */
export async function verifyLocal(): Promise<{ checked: number; broken: number }> {
  if (moving) await moving.catch(() => 0)
  let broken = 0
  const entries = Object.entries(local)
  for (const [id, f] of entries) {
    const ok = f.uri
      ? await MusicStore.stat({ uri: f.uri }).then(
          (st) => st.exists && (!f.size || st.size === f.size),
          () => false,
        )
      : await Filesystem.stat({ path: f.file, directory: DIR }).then(
          (st) => !f.size || st.size === f.size,
          () => false,
        )
    if (ok) continue
    broken++
    await removeLocal(id, false)
  }
  return { checked: entries.length, broken }
}

/** Убрать трек с телефона. onlyHere — человек сам удалил «только на устройстве»: само больше не качаем */
export async function removeLocal(id: string, onlyHere: boolean) {
  const f = local[id]
  if (f) {
    if (f.uri) await MusicStore.remove({ uri: f.uri }).catch(() => {})
    else await Filesystem.deleteFile({ path: f.file, directory: DIR }).catch(() => {})
    if (f.cover) await Filesystem.deleteFile({ path: f.cover, directory: DIR }).catch(() => {})
    uriCache.delete(f.file)
    if (f.cover) uriCache.delete(f.cover)
    const { [id]: _gone, ...rest } = local
    local = rest
    writeJson(LOCAL_KEY, local)
  }
  const p = pinned()
  p.delete(id)
  setList(PINNED_KEY, p)
  if (onlyHere) {
    const ex = excluded()
    ex.add(id)
    setList(EXCLUDED_KEY, ex)
  }
}

/** Сколько места занимает музыка на телефоне, байты (вместе с ещё не отправленной) */
export const usedBytes = () => Object.values(local).reduce((a, f) => a + f.size, 0) + outbox().reduce((a, o) => a + o.size, 0)

// ---------- очередь отправки на сервер ----------

/**
 * Трек, добавленный на телефоне («Добавить музыку» или «Поделиться → MUSICH»): файл уже в папке приложения
 * и сразу играет, а на сервер уходит при синхронизации. Пока не отправлен — у него свой id «up:…»
 */
export interface OutboxItem {
  id: string // 'up:…'
  name: string // исходное имя файла
  file: string // путь в папке приложения (у перенесённого — откуда имя)
  uri?: string // перенесён в «Музыка/MUSICH» или свою папку (файл там называется «up-….ext»)
  at?: StoreAt
  cover?: string
  size: number
  title: string
  artist: string
  album: string
  duration: number
  addedAt: string
}

const OUTBOX_KEY = 'musich-outbox'
export const outbox = () => readJson<OutboxItem[]>(OUTBOX_KEY, [])
const saveOutbox = (list: OutboxItem[]) => writeJson(OUTBOX_KEY, list)
export const isPending = (id: string) => id.startsWith('up:')
const outboxItem = (id: string) => outbox().find((o) => o.id === id)

const AUDIO_EXT = /\.(mp3|flac|m4a|aac|ogg|oga|opus|wav|aiff?|wma|ape|wv)$/i
export const looksLikeAudio = (name: string, mime = '') => mime.startsWith('audio/') || AUDIO_EXT.test(name)

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })

/** Записать Blob в файл кусками: целиком в base64 большой flac занял бы память дважды */
async function writeBlob(path: string, blob: Blob) {
  const CHUNK = 3 * 1024 * 1024 // кратно 3 — куски base64 склеиваются без «=» в середине
  await Filesystem.writeFile({ path, directory: DIR, data: await toBase64(blob.slice(0, CHUNK)), recursive: true })
  for (let at = CHUNK; at < blob.size; at += CHUNK) {
    await Filesystem.appendFile({ path, directory: DIR, data: await toBase64(blob.slice(at, at + CHUNK)) })
  }
}

/** Теги и обложку читаем прямо на телефоне — трек сразу выглядит как надо; пустые берём из имени «Артист - Название» */
async function readTags(blob: Blob, name: string) {
  const base = name.replace(/\.[^.]+$/, '').trim()
  const [fArtist, ...rest] = base.split(' - ')
  const fallback = { title: rest.length ? rest.join(' - ') : base, artist: rest.length ? fArtist : '', album: '', duration: 0, picture: undefined as Blob | undefined }
  try {
    const { parseBlob } = await import('music-metadata')
    const { common, format } = await parseBlob(blob, { duration: true })
    const pic = common.picture?.[0]
    return {
      title: common.title?.trim() || fallback.title,
      artist: common.artist?.trim() || fallback.artist,
      album: common.album?.trim() || '',
      duration: Math.round(format.duration ?? 0),
      picture: pic ? new Blob([new Uint8Array(pic.data)], { type: pic.format }) : undefined,
    }
  } catch {
    return fallback
  }
}

/** Файл уже лежит в папке приложения — читаем теги, сохраняем обложку и ставим в очередь */
async function enqueue(id: string, path: string, name: string, size: number): Promise<OutboxItem> {
  const blob = await fetch(await fileSrc(path)).then((r) => r.blob())
  const tags = await readTags(blob, name)
  let cover: string | undefined
  if (tags.picture) {
    cover = `${ROOT}/Covers/${id.slice(3)}`
    await writeBlob(cover, tags.picture).catch(() => (cover = undefined))
    if (cover) await fileSrc(cover).catch(() => {})
  }
  const item: OutboxItem = {
    id,
    name,
    file: path,
    cover,
    size,
    title: tags.title,
    artist: tags.artist,
    album: tags.album || tags.title,
    duration: tags.duration,
    addedAt: new Date().toISOString(),
  }
  saveOutbox([...outbox(), item])
  return item
}

const newOutboxId = () => `up:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
const extOfName = (name: string) => (name.split('.').pop() || 'mp3').toLowerCase()

/** «Добавить музыку» в приложении: выбранный файл копируем в папку приложения */
export async function addFileToOutbox(file: File): Promise<OutboxItem> {
  const id = newOutboxId()
  const path = `${ROOT}/Outbox/${id.slice(3)}.${extOfName(file.name)}`
  await writeBlob(path, file)
  return enqueue(id, path, file.name, file.size)
}

/** «Поделиться → MUSICH»: Android уже скопировал файл в кэш приложения — переносим к себе и чистим кэш */
export async function addSharedToOutbox(absPath: string, name: string): Promise<OutboxItem> {
  const id = newOutboxId()
  const path = `${ROOT}/Outbox/${id.slice(3)}.${extOfName(name)}`
  const from = absPath.startsWith('file://') ? absPath : `file://${absPath}`
  await Filesystem.copy({ from, to: path, toDirectory: DIR })
  await Filesystem.deleteFile({ path: from }).catch(() => {})
  const { size } = await Filesystem.stat({ path, directory: DIR })
  return enqueue(id, path, name, size)
}

/** Файл трека из очереди — для отправки */
export async function outboxFile(item: OutboxItem): Promise<File> {
  const blob = await fetch(item.uri ? Capacitor.convertFileSrc(item.uri) : await fileSrc(item.file)).then((r) => r.blob())
  return new File([blob], item.name, { type: blob.type || 'application/octet-stream' })
}

/**
 * Трек ушёл на сервер: его файл становится обычным скачанным треком под серверным id
 * (уже был на телефоне — копия не нужна). Держим его на устройстве: человек сам его сюда добавил
 */
export async function settleOutbox(item: OutboxItem, t: ServerTrack) {
  if (local[t.id]) {
    if (item.uri) await MusicStore.remove({ uri: item.uri }).catch(() => {})
    else await Filesystem.deleteFile({ path: item.file, directory: DIR }).catch(() => {})
    if (item.cover) await Filesystem.deleteFile({ path: item.cover, directory: DIR }).catch(() => {})
  } else if (item.uri) {
    // лежит в общей или своей папке: переименовываем на месте под серверный id — так его узнают и после переустановки
    const name = `${t.id}.${extOf(t)}`
    const { uri } = await MusicStore.rename({ uri: item.uri, name }).catch(() => ({ uri: item.uri! }))
    let cover: string | undefined
    if (item.cover) {
      cover = `${ROOT}/Covers/${t.id}`
      await Filesystem.rename({ from: item.cover, to: cover, directory: DIR, toDirectory: DIR }).catch(() => (cover = undefined))
    }
    local = { ...local, [t.id]: { file: `${ROOT}/Music/${name}`, uri, at: item.at, cover, size: item.size, hash: t.hash ?? t.id } }
    writeJson(LOCAL_KEY, local)
    if (cover) await fileSrc(cover).catch(() => {})
  } else {
    const file = `${ROOT}/Music/${t.id}.${extOf(t)}`
    await Filesystem.rename({ from: item.file, to: file, directory: DIR, toDirectory: DIR })
    let cover: string | undefined
    if (item.cover) {
      cover = `${ROOT}/Covers/${t.id}`
      await Filesystem.rename({ from: item.cover, to: cover, directory: DIR, toDirectory: DIR }).catch(() => (cover = undefined))
    }
    local = { ...local, [t.id]: { file, cover, size: item.size, hash: t.hash ?? t.id } }
    writeJson(LOCAL_KEY, local)
    await fileSrc(file)
    if (cover) await fileSrc(cover).catch(() => {})
  }
  uriCache.delete(item.file)
  if (item.cover) uriCache.delete(item.cover)
  saveOutbox(outbox().filter((o) => o.id !== item.id))
  pin([t.id])
}

/** Убрать из очереди (передумали или файл не аудио) — вместе с файлами */
export async function dropOutbox(id: string) {
  const item = outboxItem(id)
  if (!item) return
  if (item.uri) await MusicStore.remove({ uri: item.uri }).catch(() => {})
  else await Filesystem.deleteFile({ path: item.file, directory: DIR }).catch(() => {})
  if (item.cover) await Filesystem.deleteFile({ path: item.cover, directory: DIR }).catch(() => {})
  uriCache.delete(item.file)
  if (item.cover) uriCache.delete(item.cover)
  saveOutbox(outbox().filter((o) => o.id !== id))
}

// ---------- «Поделиться → MUSICH» ----------

/** Файлы, которыми поделились с приложением (из Telegram, браузера, файлового менеджера) */
export async function onShare(fn: (files: { uri: string; name: string; mimeType: string }[]) => void) {
  try {
    const { CapacitorShareTarget } = await import('@capgo/capacitor-share-target')
    // плагин придерживает событие, пока мы не подписались, — работает и когда приложение было закрыто
    await CapacitorShareTarget.addListener('shareReceived', (e) => {
      const files = e.files.filter((f) => looksLikeAudio(f.name, f.mimeType))
      if (files.length) fn(files)
    })
  } catch {
    /* в браузере при разработке плагина нет */
  }
}

// ---------- библиотека без сети ----------

/**
 * Зеркало сервера: всё, что приходило через /changes, — чтобы без сети открыть ту же библиотеку.
 * Хранится файлом (а не в localStorage): у большой библиотеки это мегабайты
 */
interface Mirror {
  server: string // с какого сервера: другой адрес — другая библиотека
  cursor: number
  tracks: Record<string, ServerTrack>
  playlists: Record<string, ServerPlaylist>
  covers: Record<string, Changes['covers'][number]>
}

let mirror: Mirror = { server: '', cursor: 0, tracks: {}, playlists: {}, covers: {} }
let saveTimer: ReturnType<typeof setTimeout> | null = null

export async function loadMirror(server: string): Promise<Changes | null> {
  try {
    const { data } = await Filesystem.readFile({ path: `${ROOT}/${LIBRARY_FILE}`, directory: DIR, encoding: Encoding.UTF8 })
    const m = JSON.parse(String(data)) as Mirror
    if (m.server !== server) return null
    mirror = m
    return mirrorChanges()
  } catch {
    mirror = { server, cursor: 0, tracks: {}, playlists: {}, covers: {} }
    return null
  }
}

/** Без сервера: что осталось от прежнего (скачанные треки живут на телефоне и после «Отвязать») */
export async function loadAnyMirror(): Promise<Changes | null> {
  try {
    const { data } = await Filesystem.readFile({ path: `${ROOT}/${LIBRARY_FILE}`, directory: DIR, encoding: Encoding.UTF8 })
    mirror = JSON.parse(String(data)) as Mirror
    return mirrorChanges()
  } catch {
    return null
  }
}

/** Всё зеркало как один ответ /changes — стор принимает его так же, как ответ сервера */
export const mirrorChanges = (): Changes => ({
  cursor: mirror.cursor,
  tracks: Object.values(mirror.tracks),
  playlists: Object.values(mirror.playlists),
  covers: Object.values(mirror.covers),
})

export const mirrorTrack = (id: string): ServerTrack | undefined => mirror.tracks[id]

/** Тот же сервер на новом адресе (роутер выдал ПК другой): библиотека на телефоне остаётся его */
export async function moveMirror(server: string) {
  if (!Object.keys(mirror.tracks).length) {
    try {
      const { data } = await Filesystem.readFile({ path: `${ROOT}/${LIBRARY_FILE}`, directory: DIR, encoding: Encoding.UTF8 })
      mirror = JSON.parse(String(data)) as Mirror
    } catch {
      /* на диске ещё ничего нет */
    }
  }
  mirror.server = server
  await Filesystem.writeFile({ path: `${ROOT}/${LIBRARY_FILE}`, directory: DIR, data: JSON.stringify(mirror), encoding: Encoding.UTF8, recursive: true }).catch(() => {})
}

/** Вошёл другой пользователь того же сервера: зеркало прошлого — не его библиотека, начинаем с нуля */
export async function resetMirror(server: string) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  mirror = { server, cursor: 0, tracks: {}, playlists: {}, covers: {} }
  await Filesystem.writeFile({ path: `${ROOT}/${LIBRARY_FILE}`, directory: DIR, data: JSON.stringify(mirror), encoding: Encoding.UTF8, recursive: true }).catch(() => {})
}

/** Пришли изменения с сервера: обновляем зеркало и через секунду пишем на диск (пачкой, а не на каждый опрос) */
export function mergeIntoMirror(server: string, ch: Changes) {
  if (mirror.server !== server) mirror = { server, cursor: 0, tracks: {}, playlists: {}, covers: {} }
  mirror.cursor = ch.cursor
  for (const t of ch.tracks) {
    if (t.status === 'deleted') delete mirror.tracks[t.id]
    else mirror.tracks[t.id] = t
  }
  for (const p of ch.playlists) {
    if (p.deleted) delete mirror.playlists[p.id]
    else mirror.playlists[p.id] = p
  }
  for (const c of ch.covers) {
    const key = `${c.kind}:${c.key}`
    if (c.deleted) delete mirror.covers[key]
    else mirror.covers[key] = c
  }
  if (!ch.tracks.length && !ch.playlists.length && !ch.covers.length) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void Filesystem.writeFile({
      path: `${ROOT}/${LIBRARY_FILE}`,
      directory: DIR,
      data: JSON.stringify(mirror),
      encoding: Encoding.UTF8,
      recursive: true,
    }).catch(() => {})
  }, 1000)
}

// ---------- где хранить музыку ----------
// Две настройки (Настройки → Синхронизация): папка — стандартная или своя; после удаления приложения — не трогать
// (по умолчанию) или удалить. Android удаляет вместе с приложением только его папку, поэтому:
//   стандартная + не трогать → общая «Музыка/MUSICH»;  стандартная + удалить → папка приложения;
//   своя → выбранная папка (остаётся всегда). Скачивается всё в папку приложения, переносит relocate().
// Обложки остаются в папке приложения: это кэш, их легко скачать снова

export type StoreAt = 'app' | 'shared' | 'tree'
export type StoragePrefs = { folder: 'default' | 'custom'; keep: boolean; tree?: { uri: string; name: string } }

type MusicStoreNative = {
  shared(): Promise<{ path: string; app: string; canRead: boolean; free?: number; total?: number }>
  requestRead(): Promise<{ granted: boolean }>
  pickFolder(): Promise<{ uri?: string; name?: string }>
  move(o: { from: string; target: StoreAt; tree?: string; name: string }): Promise<{ uri: string; size: number }>
  rename(o: { uri: string; name: string }): Promise<{ uri: string }>
  remove(o: { uri: string }): Promise<void>
  stat(o: { uri: string }): Promise<{ exists: boolean; size: number }>
  list(o: { target: 'shared' | 'tree'; tree?: string }): Promise<{ files: { name: string; size: number; uri: string }[] }>
}
const MusicStore = registerPlugin<MusicStoreNative>('MusicStore')

const STORAGE_KEY = 'musich-storage'
export const storagePrefs = (): StoragePrefs => ({ folder: 'default', keep: true, ...readJson<Partial<StoragePrefs>>(STORAGE_KEY, {}) })
export const saveStoragePrefs = (p: StoragePrefs) => {
  writeJson(STORAGE_KEY, p)
  keptList = null
}
export const storageTarget = (p = storagePrefs()): StoreAt => (p.folder === 'custom' && p.tree ? 'tree' : p.keep ? 'shared' : 'app')
export const storageInfo = () => MusicStore.shared()
export const pickFolder = () => MusicStore.pickFolder()
export const requestRead = () => MusicStore.requestRead().catch(() => ({ granted: false }))
/** Сколько файлов ещё лежит не там, где должно */
export const misplaced = () =>
  [...Object.values(local), ...outbox()].filter((f) => ((f as LocalFile).at ?? 'app') !== storageTarget()).length
const outboxName = (o: OutboxItem) => `up-${o.id.slice(3)}.${extOfName(o.name)}`

// что лежит в общей/своей папке — один раз на заход, чтобы не перебирать папку на каждый трек
let keptList: Promise<Map<string, { uri: string; size: number }>> | null = null
async function keptFile(name: string, size: number): Promise<{ uri: string; at: StoreAt } | undefined> {
  const p = storagePrefs()
  const at = storageTarget(p)
  if (at === 'app') return undefined
  keptList ??= MusicStore.list({ target: at, tree: p.tree?.uri })
    .then((r) => new Map(r.files.map((f) => [f.name, f])))
    .catch(() => new Map())
  const f = (await keptList).get(name)
  return f && (!size || f.size === size) ? { uri: f.uri, at } : undefined
}

/**
 * Музыку оставили при удалении приложения, теперь его поставили снова: файлы на месте, а списков нет.
 * «up-….ext» — своё, так и не отправленное: возвращаем в очередь. Скачанное с сервера («<id>.ext») возвращаем
 * в очередь только без сервера (withServer=false) — с сервером его и так подхватит скачивание (keptFile), без перекачки.
 * Теги и обложку читаем заново. Возвращает, сколько вернули
 */
export async function importKept(withServer: boolean): Promise<number> {
  const p = storagePrefs()
  const at = storageTarget(p)
  if (at === 'app') return 0
  const files = await MusicStore.list({ target: at, tree: p.tree?.uri })
    .then((r) => r.files)
    .catch(() => [])
  const known = new Set([...Object.values(local).map((f) => f.uri), ...outbox().map((o) => o.uri)].filter(Boolean))
  const knownNames = new Set(Object.values(local).map((f) => f.file.split('/').pop()))
  let added = 0
  for (const f of files) {
    if (known.has(f.uri) || knownNames.has(f.name) || !looksLikeAudio(f.name)) continue
    const own = f.name.startsWith('up-') // своё, так и не отправленное
    if (!own && (withServer || !/^[0-9a-f]{16}\./.test(f.name))) continue
    try {
      const id = newOutboxId()
      const blob = await fetch(Capacitor.convertFileSrc(f.uri)).then((r) => r.blob())
      const tags = await readTags(blob, f.name)
      let cover: string | undefined
      if (tags.picture) {
        cover = `${ROOT}/Covers/${id.slice(3)}`
        await writeBlob(cover, tags.picture).catch(() => (cover = undefined))
        if (cover) await fileSrc(cover).catch(() => {})
      }
      // имя для сервера — по тегам, как у добавленного вручную (на диске файл остаётся под своим именем)
      const name = `${tags.artist ? `${tags.artist} - ` : ''}${tags.title}.${extOfName(f.name)}`
      saveOutbox([
        ...outbox(),
        { id, name, file: f.name, uri: f.uri, at, cover, size: f.size, title: tags.title, artist: tags.artist, album: tags.album || tags.title, duration: tags.duration, addedAt: new Date().toISOString() },
      ])
      added++
    } catch {
      /* не прочитался — пропускаем */
    }
  }
  return added
}

let moving: Promise<number> | null = null
/**
 * Перенести скачанное туда, где оно должно лежать по настройкам. По одному файлу, каждый — сразу в список;
 * busy(id) — этот сейчас играет: его не трогаем (перенесётся в следующий раз). Возвращает, сколько перенесено
 */
export function relocate(busy: (id: string) => boolean, onProgress?: (done: number, total: number) => void): Promise<number> {
  moving ??= (async () => {
    const p = storagePrefs()
    const target = storageTarget(p)
    const todo = Object.entries(local).filter(([id, f]) => (f.at ?? 'app') !== target && !busy(id))
    const todoOut = outbox().filter((o) => (o.at ?? 'app') !== target && !busy(o.id))
    let done = 0
    let moved = 0
    for (const [id, f] of todo) {
      if (storageTarget() !== target) break // передумали посреди переноса — следующий заход доделает
      const name = f.file.split('/').pop() ?? `${id}`
      try {
        const from = f.uri ?? (await Filesystem.getUri({ path: f.file, directory: DIR })).uri
        const r = await MusicStore.move({ from, target, tree: p.tree?.uri, name })
        const cur = local[id]
        if (cur) {
          local = { ...local, [id]: target === 'app' ? { ...cur, file: `${ROOT}/Music/${name}`, uri: undefined, at: 'app' } : { ...cur, uri: r.uri, at: target } }
          writeJson(LOCAL_KEY, local)
          uriCache.delete(cur.file)
          if (target === 'app') await fileSrc(local[id].file).catch(() => '')
          moved++
        }
      } catch {
        /* этот не перенёсся (нет места, пропал доступ к папке) — попробуем в следующий раз */
      }
      onProgress?.(++done, todo.length + todoOut.length)
    }
    // своё, ещё не отправленное
    for (const o of todoOut) {
      if (storageTarget() !== target) break
      const name = target === 'app' ? (o.file.split('/').pop() ?? outboxName(o)) : outboxName(o)
      try {
        const from = o.uri ?? (await Filesystem.getUri({ path: o.file, directory: DIR })).uri
        const r = await MusicStore.move({ from, target, tree: p.tree?.uri, name })
        const list = outbox()
        const cur = list.find((x) => x.id === o.id)
        if (cur) {
          const next: OutboxItem = target === 'app' ? { ...cur, file: `${ROOT}/Music/${name}`, uri: undefined, at: 'app' } : { ...cur, uri: r.uri, at: target }
          saveOutbox(list.map((x) => (x.id === o.id ? next : x)))
          uriCache.delete(cur.file)
          if (target === 'app') await fileSrc(next.file).catch(() => '')
          moved++
        } else await MusicStore.remove({ uri: r.uri }).catch(() => {}) // пока переносили, трек ушёл на сервер или его убрали
      } catch {
        /* попробуем в следующий раз */
      }
      onProgress?.(++done, todo.length + todoOut.length)
    }
    return moved
  })().finally(() => (moving = null))
  return moving
}

// ---------- прослушивания без сети ----------

export const queuedPlays = () => readJson<{ trackId: string; at: string }[]>(PLAYS_KEY, [])
export const queuePlay = (trackId: string, at = new Date().toISOString()) => writeJson(PLAYS_KEY, [...queuedPlays(), { trackId, at }])
export const clearPlays = (n: number) => writeJson(PLAYS_KEY, queuedPlays().slice(n))

/** Файл с телефона ушёл на сервер — у трека серверный id: меняем его в истории и в очереди прослушиваний */
export function remapPlays(map: Map<string, string>) {
  if (!map.size) return
  const q = queuedPlays()
  if (q.some((p) => map.has(p.trackId))) writeJson(PLAYS_KEY, q.map((p) => ({ ...p, trackId: map.get(p.trackId) ?? p.trackId })))
  const h = readJson<{ trackId: string; playedAt: string }[]>(HISTORY_KEY, [])
  if (h.some((p) => map.has(p.trackId))) writeJson(HISTORY_KEY, h.map((p) => ({ ...p, trackId: map.get(p.trackId) ?? p.trackId })))
}

// ---------- своя история ----------
// Телефон помнит, что слушал, и без сервера. Есть сервер — истории сливаются в одну: одно и то же прослушивание
// узнаётся по треку и времени до миллисекунды (телефон шлёт серверу своё время)

const HISTORY_KEY = 'musich-history-local'
const HISTORY_CAP = 5000 // ~400 КБ; весь архив — на сервере
type LocalPlay = { trackId: string; playedAt: string; source?: string }
const playKey = (p: LocalPlay) => `${p.trackId}|${p.playedAt}`
const byNewest = (a: LocalPlay, b: LocalPlay) => b.playedAt.localeCompare(a.playedAt)

/** Свежие сверху. В первый раз берём то, что ждало отправки: оно уже было историей, просто не на экране */
export function localPlays(): LocalPlay[] {
  if (localStorage.getItem(HISTORY_KEY) === null) {
    const seed = queuedPlays().map((q) => ({ trackId: q.trackId, playedAt: q.at })).sort(byNewest)
    writeJson(HISTORY_KEY, seed)
    return seed
  }
  return readJson<LocalPlay[]>(HISTORY_KEY, [])
}

export function addLocalPlay(p: LocalPlay) {
  writeJson(HISTORY_KEY, [p, ...localPlays()].slice(0, HISTORY_CAP))
}

/** Своя история + серверная (там и другие устройства) без повторов. Запоминаем свежее, показываем всё */
export function mergePlays(server: LocalPlay[]): LocalPlay[] {
  const all = new Map<string, LocalPlay>()
  for (const p of localPlays()) all.set(playKey(p), p)
  for (const p of server) all.set(playKey(p), p) // серверная запись знает, с какого устройства слушали
  const merged = [...all.values()].sort(byNewest)
  writeJson(HISTORY_KEY, merged.slice(0, HISTORY_CAP))
  return merged
}

// ---------- сеть ----------

/** Можно ли сейчас качать: сеть есть, а при «только по Wi‑Fi» — именно Wi‑Fi */
export async function canDownload(wifiOnly: boolean): Promise<boolean> {
  try {
    const s = await Network.getStatus()
    return s.connected && (!wifiOnly || s.connectionType === 'wifi')
  } catch {
    return true
  }
}

/** Сеть появилась или сменилась — стор сразу пробует достучаться до сервера */
export function onNetworkChange(fn: (connected: boolean) => void) {
  void Network.addListener('networkStatusChange', (s) => fn(s.connected))
}

/** Телефон сейчас на Wi-Fi (тогда стоит попробовать сервер напрямую по домашней сети) */
export async function onWifi(): Promise<boolean> {
  try {
    return (await Network.getStatus()).connectionType === 'wifi'
  } catch {
    return false
  }
}

// ---------- кнопка «Назад» ----------

/**
 * «Назад» на Android: back() закрывает то, что открыто поверх (true — закрыл).
 * Закрывать нечего — сворачиваем приложение, а не выходим: музыка играет дальше
 */
export function onBackButton(back: () => boolean) {
  App.addListener('backButton', () => {
    if (!back()) void App.minimizeApp()
  }).catch((e) => console.error('MUSICH: «Назад» не подключилась', e))
}

// ---------- шторка и экран блокировки ----------

export interface NowPlaying {
  title: string
  artist: string
  album: string
  cover?: string
  playing: boolean
  duration: number
  position: number
}

// Свой плагин (android/.../NowPlayingPlugin.java): готовый показывал в шторке чужую обложку, не обновлял позицию,
// а «пауза/играть» в шторке не работали
type NowPlayingNative = {
  update(o: { title: string; artist: string; album: string; playing: boolean; duration: number; position: number; color?: string; artwork?: string }): Promise<void>
  stop(): Promise<void>
  addListener(e: 'action', fn: (d: { action: string; seekTime?: number }) => void): Promise<PluginListenerHandle>
}
const NowPlayingPlugin = registerPlugin<NowPlayingNative>('NowPlaying')

const cssVar = (name: string, fallback: string) =>
  (typeof document !== 'undefined' && getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || fallback

/** Цвет в rgba с прозрачностью: canvas сам приводит любой CSS-цвет к #rrggbb */
function withAlpha(g: CanvasRenderingContext2D, color: string, a: number) {
  g.fillStyle = '#000'
  g.fillStyle = color
  const hex = String(g.fillStyle)
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  return m ? `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})` : hex
}

/**
 * Картинка для шторки: обложка во весь квадрат, по краям — лёгкое свечение цветом темы. На Android 13+ шторка берёт
 * её фоном плеера. Нет обложки (или не загрузилась) — фон темы с точками и свечением. JPEG в base64 без префикса
 */
async function artworkFor(cover: string | undefined, accent: string, page: string): Promise<string> {
  const S = 512
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const g = c.getContext('2d')
  if (!g) return ''
  g.fillStyle = page
  g.fillRect(0, 0, S, S)
  let drawn = false
  if (cover) {
    try {
      // fetch, а не <img>: картинка с сервера (CORS открыт) не «пачкает» холст, и toDataURL работает
      const img = await createImageBitmap(await (await fetch(cover)).blob())
      const k = Math.max(S / img.width, S / img.height)
      const w = img.width * k
      const h = img.height * k
      g.drawImage(img, (S - w) / 2, (S - h) / 2, w, h)
      img.close()
      drawn = true
    } catch {
      /* нет файла или сети — рисуем фон темы */
    }
  }
  if (!drawn) {
    g.fillStyle = withAlpha(g, cssVar('--page-dot', '#cfcfcc'), 1)
    for (let y = 16; y < S; y += 32) for (let x = 16; x < S; x += 32) g.fillRect(x - 3, y - 3, 6, 6)
  }
  const glow = g.createRadialGradient(S / 2, S / 2, S * 0.3, S / 2, S / 2, S * 0.75)
  glow.addColorStop(0, withAlpha(g, accent, 0))
  glow.addColorStop(1, withAlpha(g, accent, drawn ? 0.5 : 0.8))
  g.fillStyle = glow
  g.fillRect(0, 0, S, S)
  return c.toDataURL('image/jpeg', 0.85).split(',')[1] ?? ''
}

let artKey: string | null = null
let artPending: Promise<string> | null = null

/** Что играет — в системный плеер (шторка, экран блокировки, наушники); он же держит приложение живым в фоне */
let lastNp: NowPlaying | null = null
export async function setNowPlaying(n: NowPlaying | null) {
  lastNp = n
  try {
    if (!n) {
      artKey = null
      return await NowPlayingPlugin.stop()
    }
    const accent = cssVar('--red', '#d71921')
    const key = `${n.cover ?? ''}|${accent}`
    // обложку собираем и шлём только когда сменилась; пока собирается — отправляем без неё (трек и кнопки сразу)
    let artwork: string | undefined
    if (key !== artKey) {
      artKey = key
      const job = (artPending = artworkFor(n.cover, accent, cssVar('--page', '#000000')))
      artwork = await job
      if (artPending !== job) return // пока рисовали, трек уже сменили — покажет следующий вызов
      if (lastNp && lastNp !== n) n = { ...lastNp, cover: n.cover }
    }
    await NowPlayingPlugin.update({
      title: n.title,
      artist: n.artist,
      album: n.album,
      playing: n.playing,
      duration: n.duration,
      position: Math.max(0, Math.min(n.position, n.duration || n.position)),
      color: accent,
      ...(artwork !== undefined ? { artwork } : {}),
    })
  } catch {
    /* в браузере при разработке системного плеера нет */
  }
}

export async function onMediaButtons(h: { play: () => void; pause: () => void; next: () => void; prev: () => void; seek: (s: number) => void }) {
  try {
    await NowPlayingPlugin.addListener('action', (d) => {
      if (d.action === 'play') h.play()
      else if (d.action === 'pause') h.pause()
      else if (d.action === 'nexttrack') h.next()
      else if (d.action === 'previoustrack') h.prev()
      else if (d.action === 'seekto' && d.seekTime != null) h.seek(d.seekTime)
    })
  } catch {
    /* в браузере при разработке системного плеера нет */
  }
}
