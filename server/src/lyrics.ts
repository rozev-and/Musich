import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parseFile } from 'music-metadata'

/**
 * Текст песни: сначала .lrc рядом с файлом (то же имя), потом теги файла (USLT/SYLT, LYRICS).
 * Отдаём одной строкой в виде LRC: синхронный текст из тегов переводим в «[мм:сс.сс] строка»,
 * обычный — как есть (бывает, что в тег уже вписан LRC). Нет нигде — null
 */
const stamp = (ms: number) => {
  const s = ms / 1000
  return `[${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}]`
}

export async function readLyrics(path: string): Promise<string | null> {
  const lrc = path.replace(/\.[^./\\]+$/, '.lrc')
  if (lrc !== path && existsSync(lrc)) {
    const text = (await readFile(lrc, 'utf8').catch(() => '')).replace(/^﻿/, '').trim()
    if (text) return text
  }
  const meta = await parseFile(path, { skipCovers: true, duration: false }).catch(() => null)
  for (const l of meta?.common.lyrics ?? []) {
    const synced = (l.syncText ?? []).filter((x) => x.text?.trim())
    if (synced.length && synced.every((x) => typeof x.timestamp === 'number')) return synced.map((x) => `${stamp(x.timestamp!)} ${x.text.trim()}`).join('\n')
    if (l.text?.trim()) return l.text.trim()
  }
  return null
}
