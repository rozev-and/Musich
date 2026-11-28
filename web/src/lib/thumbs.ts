import { useEffect, useState } from 'react'

/**
 * Маленькие обложки для списков. В строке картинка 48px, а файл бывает 1000–3000px: браузер держит в памяти
 * каждую целиком, и длинный список листается рывками.
 * - картинка с сервера — просим у него копию нужной ширины (?w=160, см. server/src/thumbs.ts);
 * - картинка с самого телефона (скачанный трек, кэш без сети) — ужимаем один раз здесь же и держим в памяти.
 * size = 0 — оригинал (большой плеер, редактор картинки)
 */

const isServer = (src: string) => /\/api\/(tracks|covers|playlists)\//.test(src) && !src.includes('_capacitor_')
const isLocal = (src: string) => src.includes('_capacitor_')

export function thumbUrl(src: string, size: number) {
  return `${src}${src.includes('?') ? '&' : '?'}w=${size}`
}

// уже ужатые картинки с телефона: «адрес|ширина» → blob:; держим последние ~600, старые отпускаем
const made = new Map<string, string>()
const LIMIT = 600
const remember = (key: string, url: string) => {
  made.set(key, url)
  if (made.size > LIMIT) {
    const [old, oldUrl] = made.entries().next().value as [string, string]
    made.delete(old)
    URL.revokeObjectURL(oldUrl)
  }
}

// ужимаем не больше трёх сразу: при быстрой прокрутке не забиваем телефон
let running = 0
const waiting: (() => void)[] = []
const slot = () => (running < 3 ? (running++, Promise.resolve()) : new Promise<void>((r) => waiting.push(() => (running++, r()))))
const free = () => {
  running--
  waiting.shift()?.()
}
const pending = new Map<string, Promise<string | null>>()

async function shrink(src: string, size: number): Promise<string | null> {
  await slot()
  try {
    const blob = await fetch(src).then((r) => (r.ok ? r.blob() : Promise.reject()))
    const bmp = await createImageBitmap(blob) // декодирует вне основного потока
    const side = Math.min(bmp.width, bmp.height)
    const out = Math.min(size, side)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = out
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out)
    bmp.close()
    const small = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.85))
    return small ? URL.createObjectURL(small) : null
  } catch {
    return null
  } finally {
    free()
  }
}

/** Адрес картинки для показа: маленькая копия, если можно. undefined — ещё ужимаем (рисуем пустую плашку) */
export function useThumb(src: string | undefined, size: number): string | undefined {
  // крупную (плеер, 1280) с телефона не ужимаем: файл рядом, а ожидание ужатия мигало бы пустой плашкой при перелистывании
  const local = !!src && size > 0 && size < 1000 && isLocal(src)
  const key = `${src}|${size}`
  const [, redraw] = useState(0)
  useEffect(() => {
    if (!local || made.has(key)) return
    let alive = true
    let p = pending.get(key)
    if (!p) {
      p = shrink(src!, size).then((url) => {
        pending.delete(key)
        remember(key, url ?? src!) // не вышло — показываем оригинал
        return url
      })
      pending.set(key, p)
    }
    void p.then(() => alive && redraw((n) => n + 1))
    return () => {
      alive = false
    }
  }, [key, local, src, size])
  if (!src || size <= 0) return src
  if (local) return made.get(key)
  return isServer(src) ? thumbUrl(src, size) : src
}

/** Адрес нужной ширины без хука: копия с сервера (?w=) или как есть (картинка с телефона, data:, чужая ссылка) */
export function sizedSrc(src: string, size: number) {
  return size > 0 && isServer(src) ? thumbUrl(src, size) : src
}

// обложку следующего трека — заранее в кэш браузера и раскодировать, чтобы перелистывание не ждало сеть
const warmed = new Set<string>()
export function prefetchCover(src: string | undefined, size: number) {
  if (!src) return
  const url = sizedSrc(src, size)
  if (warmed.has(url)) return
  warmed.add(url)
  if (warmed.size > 50) warmed.delete(warmed.values().next().value as string)
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  void img.decode?.().catch(() => {})
}
