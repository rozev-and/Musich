import type { Play } from './api'
import { artistsOf } from './artists'
import type { Track } from '../types'

/**
 * Радио по библиотеке: длинная очередь (≈200 треков — часов на десять) «похожего» на трек или артиста.
 * Похожесть без интернета, только по твоей музыке и истории:
 * - тот же артист — сильнее всего; артисты с общих альбомов (фиты) — тоже близко;
 * - «слушаешь рядом»: артисты, которые играли в пределах 45 минут от прослушиваний этого артиста;
 * - тот же альбом, близкий год, лайк — чуть выше; играло последние 3 часа — реже.
 * Дальше — случайный выбор с весами, один артист два раза подряд не идёт
 */
export function radioQueue(tracks: Track[], plays: Play[], seed: { trackId?: string; artist?: string }, size = 200): string[] {
  const start = seed.trackId ? tracks.find((t) => t.id === seed.trackId) : undefined
  const seedArtists = new Set(start ? artistsOf(start.artist) : seed.artist ? [seed.artist] : [])
  if (!seedArtists.size) return []
  const byId = new Map(tracks.map((t) => [t.id, t]))
  const has = (t: Track) => artistsOf(t.artist).some((a) => seedArtists.has(a))

  // близость артистов: общие альбомы и «слушаешь рядом»
  const near = new Map<string, number>()
  const bump = (a: string, n: number) => !seedArtists.has(a) && near.set(a, (near.get(a) ?? 0) + n)
  const seedAlbums = new Set(tracks.filter(has).map((t) => t.album))
  for (const t of tracks) if (seedAlbums.has(t.album)) for (const a of artistsOf(t.artist)) bump(a, 2)
  const timeline = plays
    .map((p) => ({ at: Date.parse(p.playedAt), t: byId.get(p.trackId) }))
    .filter((x): x is { at: number; t: Track } => !!x.t)
    .sort((a, b) => a.at - b.at)
  const WINDOW = 45 * 60_000
  timeline.forEach((x, i) => {
    if (!has(x.t)) return
    for (let j = i - 1; j >= 0 && x.at - timeline[j].at < WINDOW; j--) for (const a of artistsOf(timeline[j].t.artist)) bump(a, 1)
    for (let j = i + 1; j < timeline.length && timeline[j].at - x.at < WINDOW; j++) for (const a of artistsOf(timeline[j].t.artist)) bump(a, 1)
  })
  const top = Math.max(1, ...near.values())
  const recent = new Set(timeline.filter((x) => Date.now() - x.at < 3 * 3_600_000).map((x) => x.t.id))

  const weight = (t: Track) => {
    let w = 0.15
    const as = artistsOf(t.artist)
    if (as.some((a) => seedArtists.has(a))) w += 3
    w += (3 * Math.max(0, ...as.map((a) => near.get(a) ?? 0))) / top
    if (start && t.album === start.album) w += 0.7
    if (start?.year && t.year && Math.abs(start.year - t.year) <= 3) w += 0.4
    if (t.liked) w += 0.5
    if (recent.has(t.id)) w *= 0.3
    return w
  }
  const pool = tracks.filter((t) => t.id !== start?.id).map((t) => ({ t, w: weight(t) }))
  const out: string[] = start ? [start.id] : []
  let last = start ? artistsOf(start.artist)[0] : ''
  while (out.length < size && pool.length) {
    let pick = -1
    for (let tries = 0; tries < 6; tries++) {
      const sum = pool.reduce((s, x) => s + x.w, 0)
      let r = Math.random() * sum
      pick = pool.findIndex((x) => (r -= x.w) <= 0)
      if (pick < 0) pick = pool.length - 1
      if (artistsOf(pool[pick].t.artist)[0] !== last) break
    }
    const [{ t }] = pool.splice(pick, 1)
    out.push(t.id)
    last = artistsOf(t.artist)[0]
  }
  return out
}
