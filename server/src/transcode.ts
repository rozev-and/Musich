import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Качество потока: на мобильном интернете FLAC в 30–50 МБ ни к чему. Сервер пережимает трек в MP3 нужного битрейта
 * (ffmpeg, libmp3lame), кладёт копию в <data>/transcode и дальше отдаёт её как обычный файл — с перемоткой (Range).
 * Первый раз трек ждёт пережатия (на Pi 5 — секунды); следующий в очереди приложение просит заранее (warm).
 * Пережимаем, только если это выгодно: без потерь (flac, wav…) или битрейт заметно выше нужного. Нет ffmpeg — оригинал.
 * Кэш — не больше 3 ГБ: старые копии удаляются сами
 */
export const QUALITIES = [128, 192, 320] as const
const LOSSLESS = new Set(['flac', 'wav', 'alac', 'aiff', 'aif', 'ape', 'wv'])
const CACHE_LIMIT = 3 * 1024 ** 3

let ffmpeg: Promise<boolean> | null = null
export const hasFfmpeg = () =>
  (ffmpeg ??= new Promise((ok) => {
    const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' })
    p.on('error', () => ok(false))
    p.on('exit', (code) => ok(code === 0))
  }))

/** Нужно ли пережимать: качество из запроса (128/192/320) и сам файл */
export function wantTranscode(q: unknown, f: { format: string; size: number }, durationSec: number): number | undefined {
  const kbps = Number(q)
  if (!QUALITIES.includes(kbps as (typeof QUALITIES)[number])) return undefined
  if (LOSSLESS.has(f.format.toLowerCase())) return kbps
  const source = durationSec > 0 ? (f.size * 8) / durationSec / 1000 : 0
  return source > kbps * 1.25 ? kbps : undefined
}

const making = new Map<string, Promise<string | null>>()

/** Путь к пережатой копии (готовой или только что сделанной); null — не вышло, отдаём оригинал */
export async function transcoded(dataDir: string, src: string, hash: string, kbps: number): Promise<string | null> {
  if (!(await hasFfmpeg())) return null
  const dir = join(dataDir, 'transcode')
  const out = join(dir, `${hash}-${kbps}.mp3`)
  if (existsSync(out)) {
    void utimes(out, new Date(), new Date()).catch(() => {}) // свежая — дольше живёт в кэше
    return out
  }
  let p = making.get(out)
  if (!p) {
    p = (async () => {
      await mkdir(dir, { recursive: true })
      const tmp = `${out}.${process.pid}.tmp`
      const ok = await new Promise<boolean>((resolve) => {
        const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-i', src, '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-map_metadata', '-1', '-f', 'mp3', tmp], { stdio: 'ignore' })
        const timer = setTimeout(() => ff.kill('SIGKILL'), 10 * 60_000)
        ff.on('error', () => resolve(false))
        ff.on('exit', (code) => {
          clearTimeout(timer)
          resolve(code === 0)
        })
      })
      if (!ok) {
        await rm(tmp, { force: true })
        return null
      }
      await rename(tmp, out)
      void trim(dir)
      return out
    })().finally(() => making.delete(out))
    making.set(out, p)
  }
  return p
}

/** Кэш больше лимита — убираем самые давно нужные копии */
async function trim(dir: string) {
  const files = await Promise.all(
    (await readdir(dir).catch(() => [] as string[]))
      .filter((n) => n.endsWith('.mp3'))
      .map(async (n) => ({ path: join(dir, n), st: await stat(join(dir, n)).catch(() => null) })),
  )
  const list = files.filter((f) => f.st).sort((a, b) => a.st!.mtimeMs - b.st!.mtimeMs)
  let total = list.reduce((s, f) => s + f.st!.size, 0)
  for (const f of list) {
    if (total <= CACHE_LIMIT) break
    await rm(f.path, { force: true })
    total -= f.st!.size
  }
}
