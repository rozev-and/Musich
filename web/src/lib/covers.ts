import type { CoverEdit } from '../store'
import type { Track } from '../types'

// Свои картинки лежат в store.covers по ключам вида track:<id>, album:<название>, artist:<имя>
export type Covers = Record<string, string>

/** Картинка артиста из тегов: самая частая обложка среди его треков */
// картинка с самого устройства (скачанный трек) — она есть и без сети, её и берём, если можно
const onDevice = (src?: string) => !!src && src.includes('_capacitor_')

export const artistCover = (list: Track[]) => {
  const n = new Map<string, number>()
  const local = list.filter((t) => onDevice(t.cover))
  ;(local.length ? local : list).forEach((t) => t.cover && n.set(t.cover, (n.get(t.cover) ?? 0) + 1))
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

// Своя картинка трека важнее своей картинки альбома, а та — обложки из тегов
export const trackCover = (t: Track, covers: Covers) =>
  covers[`track:${t.id}`] ?? covers[`album:${t.album}`] ?? t.cover

export const albumCover = (name: string, list: Track[], covers: Covers) =>
  covers[`album:${name}`] ?? list.find((t) => onDevice(t.cover))?.cover ?? list.find((t) => t.cover)?.cover

export const artistImage = (name: string, list: Track[], covers: Covers) =>
  covers[`artist:${name}`] ?? artistCover(list)

// Что передать в диалог картинки для альбома и артиста
export const albumEdit = (name: string, list: Track[]): CoverEdit => ({
  key: `album:${name}`,
  kind: 'album',
  title: name,
  fallback: list.find((t) => t.cover)?.cover,
})

export const artistEdit = (name: string, list: Track[]): CoverEdit => ({
  key: `artist:${name}`,
  kind: 'artist',
  title: name,
  fallback: artistCover(list),
})

/** Ужимаем картинку до квадрата 600px в jpeg, чтобы влезала в память браузера */
export const toCoverDataUrl = (file: Blob, size = 600) =>
  new Promise<string>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const side = Math.min(img.width, img.height)
      const out = Math.min(size, side)
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = out
      // обрезаем по центру до квадрата
      canvas
        .getContext('2d')!
        .drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, out, out)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('not an image'))
    }
    img.src = url
  })
