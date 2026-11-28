import { ArrowLeft, MicVocal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { t as tx } from '../i18n'
import { api } from '../lib/api'
import { selectCurrent, useStore } from '../store'
import { usePos } from '../lib/pos'
import { cx, IconBtn } from './ui'

/**
 * Текст песни поверх плеера. Синхронный (LRC: «[мм:сс.сс] строка») — текущая строка подсвечена и сама
 * встаёт в середину, нажал на строку — перемотка туда. Обычный текст — просто текстом.
 * Берём с сервера (.lrc рядом с файлом или теги) и помним на устройстве — потом виден и без сети
 */
type Line = { at: number; text: string }
const KEY = 'musich-lyrics'
const LIMIT = 400

const loadCache = (): Record<string, string | null> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}
const saveCache = (id: string, v: string | null) => {
  try {
    const all = loadCache()
    delete all[id]
    all[id] = v
    const keys = Object.keys(all)
    for (const k of keys.slice(0, Math.max(0, keys.length - LIMIT))) delete all[k]
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* не запомним — не страшно */
  }
}

/** Разбор LRC; null — в тексте нет меток времени (обычный текст) */
export function parseLrc(src: string): Line[] | null {
  const out: Line[] = []
  let offset = 0
  for (const raw of src.split(/\r?\n/)) {
    const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i)
    if (off) offset = Number(off[1]) / 1000
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
    if (!stamps.length) continue
    const text = raw.replace(/\[[^\]]*\]/g, '').trim()
    for (const m of stamps) {
      const frac = m[3] ? Number(m[3]) / 10 ** m[3].length : 0
      out.push({ at: Number(m[1]) * 60 + Number(m[2]) + frac - offset, text })
    }
  }
  return out.length ? out.sort((a, b) => a.at - b.at) : null
}

export function LyricsSheet() {
  const open = useStore((s) => s.lyricsOpen)
  const setOpen = useStore((s) => s.setLyricsOpen)
  const cur = useStore(selectCurrent)
  if (!open || !cur) return null
  return <Sheet key={cur.id} id={cur.id} title={cur.title} artist={cur.artist} onClose={() => setOpen(false)} />
}

function Sheet({ id, title, artist, onClose }: { id: string; title: string; artist: string; onClose: () => void }) {
  const cached = loadCache()
  const [text, setText] = useState<string | null | undefined>(id in cached ? cached[id] : undefined)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    api<{ lyrics: string | null }>(`/tracks/${encodeURIComponent(id)}/lyrics`)
      .then((r) => {
        if (!alive) return
        setText(r.lyrics)
        saveCache(id, r.lyrics)
      })
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [id])
  const lines = useMemo(() => (text ? parseLrc(text) : null), [text])

  return (
    <div className="page-layer rise fixed inset-0 z-[60] flex flex-col" style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}>
      <div className="flex shrink-0 items-center gap-3 px-3 py-2">
        <IconBtn title={tx('common.back')} onClick={onClose} className="h-11 w-11 bg-card-3">
          <ArrowLeft size={20} className="rtl:rotate-180" />
        </IconBtn>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-medium">{title}</div>
          <div className="truncate text-xs text-muted">{artist}</div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
        {text === undefined ? (
          <Empty text={failed ? tx('lyrics.offline') : tx('lyrics.loading')} />
        ) : !text ? (
          <Empty text={tx('lyrics.none')} />
        ) : lines ? (
          <Synced lines={lines} />
        ) : (
          <p className="mx-auto max-w-xl py-6 text-lg leading-relaxed whitespace-pre-wrap">{text}</p>
        )}
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted">
      <MicVocal size={28} strokeWidth={1.4} />
      {text}
    </div>
  )
}

function Synced({ lines }: { lines: Line[] }) {
  const pos = usePos((s) => s.position)
  const seek = useStore((s) => s.seek)
  let active = -1
  for (let i = 0; i < lines.length && lines[i].at <= pos + 0.15; i++) active = i
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    refs.current[active]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [active])
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-1 py-[30vh]">
      {lines.map((l, i) => (
        <button
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          onClick={() => seek(Math.max(0, l.at))}
          className={cx(
            'rounded-xl px-2 py-1.5 text-start text-2xl leading-snug font-semibold transition-all duration-300',
            i === active ? 'text-ink' : i < active ? 'text-ink/30' : 'text-ink/45',
          )}
        >
          {l.text || '♪'}
        </button>
      ))}
    </div>
  )
}
