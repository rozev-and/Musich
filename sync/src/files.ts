// Работа с локальной папкой: какие файлы считаем музыкой, хэш, имена, ожидание стабильности.
import { createReadStream, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

export const AUDIO_EXTENSIONS = new Set([
  'mp3', 'flac', 'm4a', 'aac', 'alac', 'ogg', 'oga', 'opus', 'wav', 'aif', 'aiff', 'wma', 'ape', 'wv', 'dsf', 'dff', 'mka',
])

/** Суффикс временных файлов загрузки. Сканер их игнорирует. */
export const TMP_SUFFIX = '.musich-part'

export function isAudioFile(name: string): boolean {
  if (name.startsWith('.') || name.endsWith(TMP_SUFFIX)) return false
  const ext = path.extname(name).slice(1).toLowerCase()
  return AUDIO_EXTENSIONS.has(ext)
}

/** id трека = первые 16 hex sha256 содержимого. */
export async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256')
  await pipeline(createReadStream(file), h)
  return h.digest('hex').slice(0, 16)
}

export interface ScannedFile {
  rel: string // относительный путь через «/»
  abs: string
  size: number
  mtimeMs: number
}

/** Рекурсивно собирает аудиофайлы папки. Скрытые папки и временные файлы пропускает. */
export async function scanFolder(root: string): Promise<ScannedFile[]> {
  const out: ScannedFile[] = []
  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) await walk(abs)
      } else if (entry.isFile() && isAudioFile(entry.name)) {
        try {
          const st = await fs.stat(abs)
          out.push({ rel: toRel(root, abs), abs, size: st.size, mtimeMs: st.mtimeMs })
        } catch {
          // файл исчез между readdir и stat — заметим на следующем проходе
        }
      }
    }
  }
  await walk(root)
  return out
}

export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/')
}

export function fromRel(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'))
}

const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f]/g
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/** Имя файла, допустимое в Windows (и, значит, везде): без <>:"/\|?*, управляющих символов, точки/пробела в конце. */
export function sanitizeName(name: string, maxLength = 180): string {
  let s = name.replace(/\s+/g, ' ').replace(FORBIDDEN, '_').trim()
  if (s.length > maxLength) s = s.slice(0, maxLength).trim()
  s = s.replace(/[. ]+$/, '')
  if (!s) s = '_'
  if (RESERVED.test(s)) s = `_${s}`
  return s
}

/** «Артист - Название.формат». Если тегов нет — исходное имя файла. */
export function trackFileName(t: { artist?: string; title?: string; format?: string; fileName?: string }): string {
  const fromName = t.fileName ? path.parse(t.fileName) : undefined
  const ext = (t.format || fromName?.ext.slice(1) || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
  const artist = t.artist?.trim()
  const title = t.title?.trim()
  let base: string
  if (artist && title) base = `${artist} - ${title}`
  else if (title) base = title
  else if (fromName?.name) base = fromName.name
  else base = 'track'
  return `${sanitizeName(base)}.${ext}`
}

/** Первое свободное имя в папке: «X.mp3», «X (2).mp3», «X (3).mp3»… Существующие файлы не затираем. */
export async function freeName(dir: string, fileName: string, taken: Set<string> = new Set()): Promise<string> {
  const { name, ext } = path.parse(fileName)
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? fileName : `${name} (${i})${ext}`
    const abs = path.join(dir, candidate)
    if (taken.has(candidate.toLowerCase())) continue
    try {
      await fs.lstat(abs)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return candidate
      throw e
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Делит файлы на «перестали расти» и «ещё пишутся». Файл, который не меняли дольше stableMs,
 * готов сразу; для свежих ждём stableMs один раз на всех и сравниваем размер и mtime.
 */
export async function splitStable(
  files: ScannedFile[],
  stableMs: number,
): Promise<{ stable: ScannedFile[]; growing: ScannedFile[] }> {
  const now = Date.now()
  const stable: ScannedFile[] = []
  const fresh: ScannedFile[] = []
  for (const f of files) (now - f.mtimeMs >= stableMs ? stable : fresh).push(f)
  if (!fresh.length) return { stable, growing: [] }
  await sleep(stableMs)
  const growing: ScannedFile[] = []
  for (const f of fresh) {
    const st = await fs.stat(f.abs).catch(() => undefined)
    if (st && st.size === f.size && st.mtimeMs === f.mtimeMs) stable.push(f)
    else growing.push(f)
  }
  return { stable, growing }
}
