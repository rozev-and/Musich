import type { Track } from '../types'

type Separators = { comma: boolean; feat: boolean; x: boolean; amp: boolean }

// Регулярка из выбранных разделителей — те же правила, что на сервере (server/src/media.ts, artistSep)
function buildSep(s: Separators): RegExp {
  const parts = [
    s.comma && String.raw`\s*,\s*`,
    s.feat && String.raw`\s+(?:feat|ft)\.?\s+`,
    s.x && String.raw`\s+x\s+(?!\(|(?:feat|ft)\.?\s)`,
    s.amp && String.raw`\s+&\s+`,
  ].filter(Boolean)
  return parts.length ? new RegExp(parts.join('|'), 'i') : /(?!)/
}

/** Настройки сервера поменялись — разбираем артистов по-новому */
export function setArtistSeparators(s: Separators) {
  SEP = buildSep(s)
  cache.clear()
}

/**
 * В теге артиста бывает несколько человек: «Kordhell, Ravens Rock», «Future feat. Kendrick Lamar», «DK x CMН».
 * Делим по запятой, feat./ft. и « x ». «X» в конце имени, перед скобкой или feat. — часть имени:
 * «Lil Nas X», «Lil Nas X (пародия)», «Lil Nas X feat. Billy Ray Cyrus».
 * «&» не трогаем: «Artik & Asti», «Fitz & The Tantrums» — это один артист.
 */
let SEP = /\s*,\s*|\s+(?:feat|ft)\.?\s+|\s+x\s+(?!\(|(?:feat|ft)\.?\s)/i

const cache = new Map<string, string[]>()

/** Отдельные артисты трека, без повторов («10AGE, Ramil', Ramil', 10AGE» → 10AGE, Ramil') */
export function artistsOf(artist: string): string[] {
  let list = cache.get(artist)
  if (!list) {
    const seen = new Set<string>()
    list = []
    for (const part of artist.split(SEP)) {
      const name = part.trim()
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase())
        list.push(name)
      }
    }
    if (!list.length) list = [artist]
    cache.set(artist, list)
  }
  return list
}

/** Трек этого артиста? Регистр не важен: «KORDHELL» и «Kordhell» — один и тот же */
export const hasArtist = (t: Track, name: string) => {
  const key = name.toLowerCase()
  return artistsOf(t.artist).some((a) => a.toLowerCase() === key)
}

/** Треки по артистам: трек с двумя артистами попадает к обоим. Имя — как в первом встреченном треке */
export function groupByArtist(tracks: Track[]): [string, Track[]][] {
  const m = new Map<string, [string, Track[]]>()
  for (const t of tracks)
    for (const name of artistsOf(t.artist)) {
      const key = name.toLowerCase()
      const g = m.get(key)
      if (g) g[1].push(t)
      else m.set(key, [name, [t]])
    }
  return [...m.values()]
}
