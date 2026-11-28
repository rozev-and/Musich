import type { Track } from '../types'

/**
 * Импорт плейлиста .m3u/.m3u8: каждую запись ищем в библиотеке —
 * по имени файла, по «#EXTINF:…,Артист - Название», по имени файла как «Артист - Название».
 * Сравнение без регистра, ё/е, скобок, feat. и знаков. Возвращает найденные id по порядку и сколько было записей
 */
const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[([{].*?[)\]}]/g, ' ')
    .replace(/\b(feat|ft)\.?\s.*$/, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
const base = (path: string) => path.split(/[\\/]/).pop() ?? path
const stem = (name: string) => name.replace(/\.[^.]+$/, '')

export function matchM3u(text: string, tracks: Track[]): { ids: string[]; total: number } {
  const byFile = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const t of tracks) {
    if (t.file) byFile.set(base(t.file).toLowerCase(), t.id)
    byName.set(`${norm(t.artist)}|${norm(t.title)}`, t.id)
  }
  const byPair = (s: string) => {
    const i = s.indexOf(' - ')
    return i > 0 ? byName.get(`${norm(s.slice(0, i))}|${norm(s.slice(i + 3))}`) : undefined
  }
  const ids: string[] = []
  let total = 0
  let info = ''
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXTINF')) {
      info = line.slice(line.indexOf(',') + 1).trim()
      continue
    }
    if (line.startsWith('#')) continue
    total++
    const file = base(decodeURIComponent(line.replace(/^file:\/\//, '')))
    const id = byFile.get(file.toLowerCase()) ?? (info ? byPair(info) : undefined) ?? byPair(stem(file))
    if (id && !ids.includes(id)) ids.push(id)
    info = ''
  }
  return { ids, total }
}
