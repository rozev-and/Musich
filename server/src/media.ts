import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { extname } from 'node:path'
import { parseFile, type IAudioMetadata } from 'music-metadata'
import { ByteVector, File as TagFile, Picture, PictureType } from 'node-taglib-sharp'

export const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  wma: 'audio/x-ms-wma',
  ape: 'audio/x-ape',
  wv: 'audio/x-wavpack',
}

export const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** 'flac' | 'mp3' | ... по расширению, либо undefined, если это не аудио */
export function audioFormat(fileName: string): string | undefined {
  const ext = extname(fileName).slice(1).toLowerCase()
  return ext in AUDIO_MIME ? ext : undefined
}

export const trackIdFromHash = (hex: string) => hex.slice(0, 16)

export async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer)
  return trackIdFromHash(h.digest('hex'))
}

export const UNKNOWN_ARTIST = 'Неизвестный исполнитель'
// Яндекс пишет в тег альбома название плейлиста — это не альбом, такой трек считаем синглом
const NOT_ALBUMS = new Set(['мне нравится'])

export interface TrackTags {
  title: string
  artist: string
  album: string
  year?: number
  trackNo?: number // номер трека из тегов
  duration: number
  // ReplayGain из тегов: насколько убавить/прибавить (дБ) и пик (доля от 1) — выравнивание громкости на клиенте
  gain?: number
  albumGain?: number
  peak?: number
}

/** Правила из контракта: пустые теги добираем из имени файла «Артист - Название», пустой альбом = название */
export function resolveTags(
  common: {
    title?: string; artist?: string; album?: string; year?: number; track?: { no: number | null }
    replaygain_track_gain?: { dB: number }; replaygain_album_gain?: { dB: number }; replaygain_track_peak?: { ratio: number }
  },
  fileName: string,
  durationSec: number | undefined,
): TrackTags {
  const base = fileName.replace(/\.[^.]+$/, '').trim()
  const [fArtist, ...rest] = base.split(' - ')
  const title = common.title?.trim() || (rest.length ? rest.join(' - ').trim() : base) || base
  const artist = common.artist?.trim() || (rest.length ? fArtist.trim() : '') || UNKNOWN_ARTIST
  const tagAlbum = common.album?.trim()
  const album = tagAlbum && !NOT_ALBUMS.has(tagAlbum.toLowerCase()) ? tagAlbum : title
  const year = common.year && Number.isInteger(common.year) && common.year > 0 ? common.year : undefined
  const no = common.track?.no
  const trackNo = no && Number.isInteger(no) && no > 0 ? no : undefined
  const db = (v: { dB: number } | undefined) => (v && Number.isFinite(v.dB) && Math.abs(v.dB) < 60 ? Math.round(v.dB * 100) / 100 : undefined)
  const peakRatio = common.replaygain_track_peak?.ratio
  return {
    title, artist, album, year, trackNo, duration: Math.round(durationSec ?? 0),
    gain: db(common.replaygain_track_gain),
    albumGain: db(common.replaygain_album_gain),
    peak: peakRatio && Number.isFinite(peakRatio) && peakRatio > 0 ? Math.round(peakRatio * 10000) / 10000 : undefined,
  }
}

export interface ParsedFile {
  tags: TrackTags
  picture?: { mime: string; data: Uint8Array }
}

/** Читает теги. Бросает, если файл не разбирается как аудио. */
export async function readFileTags(file: string, fileName: string): Promise<ParsedFile> {
  const meta: IAudioMetadata = await parseFile(file, { duration: true })
  const pic = meta.common.picture?.[0]
  let picture: ParsedFile['picture']
  if (pic?.data?.length) {
    const fmt = pic.format.toLowerCase()
    const mime = fmt.includes('png') ? 'image/png' : fmt.includes('webp') ? 'image/webp' : 'image/jpeg'
    picture = { mime, data: pic.data }
  }
  return { tags: resolveTags(meta.common, fileName, meta.format.duration), picture }
}

/** Что делит артистов в одном теге — выбирается в настройках (те же правила в web/src/lib/artists.ts) */
export type Separators = { comma: boolean; feat: boolean; x: boolean; amp: boolean }
const ALL_SEPARATORS: Separators = { comma: true, feat: true, x: true, amp: false }

/**
 * Регулярка разделителей: запятая, feat./ft., « x » («X» в конце имени, перед скобкой или feat. — часть имени:
 * «Lil Nas X»), « & ». Скобки — чтобы split оставил разделители и строку можно было собрать обратно как была
 */
export function artistSep(s: Separators = ALL_SEPARATORS): RegExp {
  const parts = [
    s.comma && String.raw`\s*,\s*`,
    s.feat && String.raw`\s+(?:feat|ft)\.?\s+`,
    s.x && String.raw`\s+x\s+(?!\(|(?:feat|ft)\.?\s)`,
    s.amp && String.raw`\s+&\s+`,
  ].filter(Boolean)
  // ничего не выбрано — тег целиком один артист
  return parts.length ? new RegExp(`(${parts.join('|')})`, 'i') : /(?!)/
}

/** Есть ли артист name в теге (регистр не важен) */
export const hasArtist = (artist: string, name: string, s?: Separators) =>
  artist.split(artistSep(s)).some((part, i) => i % 2 === 0 && part.trim().toLowerCase() === name.trim().toLowerCase())

/** «Kordhell, Ravens Rock» + Kordhell → KORDHELL = «KORDHELL, Ravens Rock»: меняем только этого артиста, разделители как были */
export function replaceArtist(artist: string, from: string, to: string, s?: Separators): string {
  const key = from.trim().toLowerCase()
  return artist
    .split(artistSep(s))
    .map((part, i) => (i % 2 === 0 && part.trim().toLowerCase() === key ? to : part))
    .join('')
}

export interface TagPatch {
  title?: string
  artist?: string
  album?: string
  year?: number // 0 — убрать год из тегов
  trackNo?: number
  picture?: { mime: string; data: Uint8Array } // обложка — вшивается в файл вместо прежней
}

/**
 * Записывает теги в сам файл (ID3 у mp3, Vorbis-комментарии у flac, INFO у wav).
 * Остальные теги — год, обложка и то, чего нет в patch, — остаются как были.
 */
export function writeFileTags(file: string, patch: TagPatch) {
  const f = TagFile.createFromPath(file)
  try {
    if (patch.title !== undefined) f.tag.title = patch.title
    // несколько артистов в теге пишем одной строкой, как они и были: «Kordhell, Ravens Rock»
    if (patch.artist !== undefined) f.tag.performers = [patch.artist]
    if (patch.album !== undefined) f.tag.album = patch.album
    if (patch.trackNo !== undefined) f.tag.track = patch.trackNo
    if (patch.year !== undefined) f.tag.year = patch.year
    if (patch.picture) {
      f.tag.pictures = [Picture.fromFullData(ByteVector.fromByteArray(patch.picture.data), PictureType.FrontCover, patch.picture.mime, '')]
    }
    f.save()
  } finally {
    f.dispose()
  }
}

/** Безопасное имя файла: без путей и запрещённых в Windows/Linux символов */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  return base
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 200)
}

/** Сигнатура картинки совпадает с заявленным типом? */
export function looksLikeImage(mime: string, buf: Buffer): boolean {
  if (mime === 'image/jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  if (mime === 'image/png') return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (mime === 'image/webp') return buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP'
  return false
}
