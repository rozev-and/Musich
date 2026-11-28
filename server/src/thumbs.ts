import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Маленькие копии обложек для списков: в строке трека картинка 48px, а файл обложки бывает 1000–3000px.
 * Делаем квадрат нужной ширины в webp один раз и кладём в <data>/thumbs; поменялась картинка — другой ключ.
 * Не вышло (нет sharp, битый файл) — отдаём оригинал, как раньше
 */
export const THUMB_SIZES = [160, 320, 480, 1280] as const

type Sharp = typeof import('sharp').default
let sharpP: Promise<Sharp | null> | null = null
const loadSharp = () => (sharpP ??= import('sharp').then((m) => m.default as unknown as Sharp).catch(() => null))

/** Ширина из запроса → ближайшая не меньше из разрешённых; больше всех — оригинал (undefined) */
export function thumbSize(w: unknown): number | undefined {
  const n = Number(w)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return THUMB_SIZES.find((s) => s >= n)
}

const making = new Map<string, Promise<string | null>>()

export async function thumbFile(dataDir: string, src: string, size: number): Promise<string | null> {
  const st = await stat(src).catch(() => null)
  if (!st) return null
  const key = createHash('sha1').update(`${src}|${st.size}|${st.mtimeMs}|${size}`).digest('hex')
  const out = join(dataDir, 'thumbs', key.slice(0, 2), `${key}.webp`)
  if (existsSync(out)) return out
  // одну и ту же картинку просят сразу несколько строк — делаем один раз
  let p = making.get(out)
  if (!p) {
    p = (async () => {
      const sharp = await loadSharp()
      if (!sharp) return null
      const tmp = `${out}.${process.pid}.tmp`
      try {
        await mkdir(dirname(out), { recursive: true })
        await sharp(src, { failOn: 'none' }).rotate().resize(size, size, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 80 }).toFile(tmp)
        await rename(tmp, out)
        return out
      } catch {
        await rm(tmp, { force: true })
        return null
      }
    })().finally(() => making.delete(out))
    making.set(out, p)
  }
  return p
}
