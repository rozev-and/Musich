import { Share2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { getLang, t as tx, tn } from '../i18n'
import { artistsOf } from '../lib/artists'
import type { Play } from '../lib/api'
import { trackCover } from '../lib/covers'
import { isHost } from '../mode'
import { useStore } from '../store'
import type { Track } from '../types'
import { Cover, cx } from './ui'

/**
 * «Итоги» сверху «Истории»: за этот месяц или год — часы, прослушивания, топ треков/артистов/альбомов,
 * новые артисты, когда слушаешь чаще всего. «Поделиться» — картинка-карточка в цветах темы
 */
type Period = 'month' | 'year'
type Top = { key: string; label: string; sub?: string; n: number; track?: Track }

function useRecap(plays: Play[], tracks: Track[], period: Period) {
  return useMemo(() => {
    const now = new Date()
    const from = period === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(now.getFullYear(), 0, 1)
    const byId = new Map(tracks.map((t) => [t.id, t]))
    const firstAt = new Map<string, number>() // когда артиста впервые слушали вообще
    for (const p of plays) {
      const t = byId.get(p.trackId)
      if (!t) continue
      const at = Date.parse(p.playedAt)
      for (const a of artistsOf(t.artist)) if (at < (firstAt.get(a) ?? Infinity)) firstAt.set(a, at)
    }
    const tr = new Map<string, number>()
    const ar = new Map<string, number>()
    const al = new Map<string, number>()
    const days = new Array(7).fill(0)
    const hours = new Array(24).fill(0)
    let seconds = 0
    let count = 0
    for (const p of plays) {
      const d = new Date(p.playedAt)
      if (d < from) continue
      const t = byId.get(p.trackId)
      if (!t) continue
      count++
      seconds += t.duration
      tr.set(t.id, (tr.get(t.id) ?? 0) + 1)
      for (const a of artistsOf(t.artist)) ar.set(a, (ar.get(a) ?? 0) + 1)
      if (t.album) al.set(t.album, (al.get(t.album) ?? 0) + 1)
      days[(d.getDay() + 6) % 7]++
      hours[d.getHours()]++
    }
    const top = (m: Map<string, number>, make: (k: string, n: number) => Top) =>
      [...m].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => make(k, n))
    const fresh = [...firstAt].filter(([, at]) => at >= from.getTime()).map(([a]) => a)
    const day = days.indexOf(Math.max(...days))
    const hour = hours.indexOf(Math.max(...hours))
    // название дня недели на языке интерфейса: 2024-01-01 — понедельник
    const dayName = new Intl.DateTimeFormat(getLang(), { weekday: 'long' }).format(new Date(2024, 0, 1 + day))
    const label =
      period === 'month' ? new Intl.DateTimeFormat(getLang(), { month: 'long', year: 'numeric' }).format(now) : String(now.getFullYear())
    return {
      label,
      count,
      hoursText: (seconds / 3600).toFixed(seconds < 36_000 ? 1 : 0),
      when: count ? `${dayName}, ${String(hour).padStart(2, '0')}:00` : '—',
      fresh,
      tracks: top(tr, (k, n) => {
        const t = byId.get(k)!
        return { key: k, label: t.title, sub: t.artist, n, track: t }
      }),
      artists: top(ar, (k, n) => ({ key: k, label: k, n })),
      albums: top(al, (k, n) => ({ key: k, label: k, n, track: tracks.find((t) => t.album === k) })),
    }
  }, [plays, tracks, period])
}

export function Recap({ plays, tracks }: { plays: Play[]; tracks: Track[] }) {
  const [period, setPeriod] = useState<Period>('month')
  const r = useRecap(plays, tracks, period)
  const covers = useStore((s) => s.covers)
  const play = useStore((s) => s.play)
  const [busy, setBusy] = useState(false)

  const share = async () => {
    if (busy || !r.count) return
    setBusy(true)
    try {
      const blob = await drawCard(r, r.tracks[0]?.track ? trackCover(r.tracks[0].track, covers) : undefined)
      await shareImage(blob, `musich-${period}.png`, `${tx('recap.title')} · ${r.label}`)
    } catch {
      /* передумали или не вышло */
    } finally {
      setBusy(false)
    }
  }

  const list = (title: string, items: Top[], onPick?: (x: Top) => void) => (
    <div className="min-w-0">
      <div className="label mb-2 text-muted">{title}</div>
      {items.length === 0 && <div className="text-xs text-muted">—</div>}
      {items.map((x, i) => (
        <button
          key={x.key}
          onClick={() => onPick?.(x)}
          className="flex w-full min-w-0 items-center gap-3 rounded-xl px-1 py-1.5 text-start transition-colors hover:bg-card-2"
        >
          <span className="w-4 shrink-0 font-dot text-sm font-black text-muted">{i + 1}</span>
          {x.track && <Cover seed={x.track.album} src={trackCover(x.track, covers)} className="h-9 w-9" rounded="rounded-lg" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{x.label}</span>
            {x.sub && <span className="block truncate text-xs text-muted">{x.sub}</span>}
          </span>
          <span className="shrink-0 font-mono text-xs text-muted">{x.n}</span>
        </button>
      ))}
    </div>
  )

  return (
    <section className="widget mb-6 p-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="label flex-1 text-muted">
          {tx('recap.title')} · {r.label}
        </span>
        <div className="flex rounded-full bg-card-3 p-1">
          {(['month', 'year'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={cx('rounded-full px-3.5 py-1.5 text-xs transition-colors', period === p ? 'bg-sel text-on-sel' : 'text-muted hover:text-fg')}
            >
              {tx(p === 'month' ? 'recap.month' : 'recap.year')}
            </button>
          ))}
        </div>
        <button
          onClick={() => void share()}
          disabled={!r.count || busy}
          className="flex items-center gap-1.5 rounded-full border border-fg/20 px-3.5 py-1.5 text-xs transition-colors hover:border-fg/50 disabled:opacity-40"
        >
          <Share2 size={14} /> {tx('player.share')}
        </button>
      </div>

      {!r.count ? (
        <div className="py-6 text-center text-sm text-muted">{tx('recap.empty')}</div>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              [r.hoursText, tx('recap.hours')],
              [String(r.count), tn('n.plays', r.count).replace(/^[\d\s.,]+/, '')],
              [String(r.fresh.length), tx('recap.newArtists')],
              [r.when, tx('recap.when')],
            ].map(([big, small], i) => (
              <div key={i} className="min-w-0 rounded-2xl bg-card-2 p-3">
                <div className={cx('truncate font-black', i === 3 ? 'text-base' : 'font-dot text-3xl')}>{big}</div>
                <div className="truncate text-xs text-muted">{small}</div>
              </div>
            ))}
          </div>
          <div className="grid gap-5 md:grid-cols-3">
            {list(tx('recap.topTracks'), r.tracks, (x) => x.track && play(x.track.id))}
            {list(tx('recap.topArtists'), r.artists)}
            {list(tx('recap.topAlbums'), r.albums)}
          </div>
        </>
      )}
    </section>
  )
}

// ---------- карточка ----------

type R = ReturnType<typeof useRecap>

/** Картинка 1080×1350 в цветах темы: обложка самого слушаемого трека, главные цифры, топ-5 треков и артистов */
async function drawCard(r: R, coverSrc?: string): Promise<Blob> {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fb: string) => css.getPropertyValue(name).trim() || fb
  const bg = v('--page', '#000')
  const ink = v('--ink', '#fff')
  const muted = v('--ink-muted', '#888')
  const accent = v('--red', '#d71921')
  const card = v('--card', '#111')
  const font = getComputedStyle(document.body).fontFamily || 'sans-serif'
  const W = 1080
  const H = 1350
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')!
  g.fillStyle = bg
  g.fillRect(0, 0, W, H)
  // точки фона, как в приложении
  g.fillStyle = muted
  g.globalAlpha = 0.18
  for (let y = 18; y < H; y += 36) for (let x = 18; x < W; x += 36) g.fillRect(x, y, 3, 3)
  g.globalAlpha = 1

  const P = 72
  g.fillStyle = accent
  g.font = `900 40px ${font}`
  g.fillText('MUSICH', P, P + 40)
  g.fillStyle = muted
  g.font = `400 36px ${font}`
  g.fillText(`${tx('recap.title')} · ${r.label}`, P, P + 96)

  // обложка — без «грязного» холста: картинку берём fetch'ем, а не <img>
  const side = 360
  let img: ImageBitmap | null = null
  if (coverSrc) img = await fetch(coverSrc).then((x) => x.blob()).then((b) => createImageBitmap(b)).catch(() => null)
  const cy = 190
  g.fillStyle = card
  roundRect(g, P, cy, side, side, 36)
  g.fill()
  if (img) {
    g.save()
    roundRect(g, P, cy, side, side, 36)
    g.clip()
    const s = Math.min(img.width, img.height)
    g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, P, cy, side, side)
    g.restore()
  }
  // цифры справа от обложки
  const nx = P + side + 56
  g.fillStyle = ink
  g.font = `900 120px ${font}`
  g.fillText(r.hoursText, nx, cy + 120)
  g.fillStyle = muted
  g.font = `400 34px ${font}`
  g.fillText(tx('recap.hours'), nx, cy + 170)
  g.fillStyle = ink
  g.font = `900 72px ${font}`
  g.fillText(String(r.count), nx, cy + 280)
  g.fillStyle = muted
  g.font = `400 34px ${font}`
  g.fillText(tn('n.plays', r.count).replace(/^[\d\s.,]+/, ''), nx, cy + 326)

  // топ-5 треков и артистов
  const top = (title: string, items: Top[], y: number) => {
    g.fillStyle = accent
    g.font = `700 30px ${font}`
    g.fillText(title.toUpperCase(), P, y)
    items.forEach((x, i) => {
      const yy = y + 62 + i * 58
      g.fillStyle = muted
      g.font = `900 34px ${font}`
      g.fillText(String(i + 1), P, yy)
      g.fillStyle = ink
      g.font = `500 36px ${font}`
      g.fillText(fit(g, x.sub ? `${x.label} — ${x.sub}` : x.label, W - P * 2 - 70), P + 60, yy)
    })
  }
  top(tx('recap.topTracks'), r.tracks, 650)
  top(tx('recap.topArtists'), r.artists, 1010)

  return new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error('canvas'))), 'image/png'))
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath()
  g.roundRect(x, y, w, h, r)
}

// строка не длиннее ширины — с многоточием
function fit(g: CanvasRenderingContext2D, s: string, max: number) {
  if (g.measureText(s).width <= max) return s
  while (s.length > 1 && g.measureText(`${s}…`).width > max) s = s.slice(0, -1)
  return `${s}…`
}

/** Отдать картинку в системное «Поделиться»: телефон — через файл во временной папке, браузер — файлом или скачиванием */
async function shareImage(blob: Blob, name: string, title: string) {
  if (!isHost) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem')
    const { Share } = await import('@capacitor/share')
    const data = await new Promise<string>((ok) => {
      const fr = new FileReader()
      fr.onload = () => ok(String(fr.result).split(',')[1])
      fr.readAsDataURL(blob)
    })
    await Filesystem.writeFile({ path: `share/${name}`, directory: Directory.Cache, data, recursive: true })
    const { uri } = await Filesystem.getUri({ path: `share/${name}`, directory: Directory.Cache })
    await Share.share({ title, files: [uri], dialogTitle: title })
    return
  }
  const file = new File([blob], name, { type: 'image/png' })
  if (navigator.canShare?.({ files: [file] })) return navigator.share({ files: [file], title })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(file)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}
