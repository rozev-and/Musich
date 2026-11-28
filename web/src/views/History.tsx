import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getLang, t as tx, tn } from '../i18n'
import type { Play } from '../lib/api'
import { TrackRow } from '../components/TrackRow'
import { cx } from '../components/ui'
import { useStore } from '../store'
import type { Track } from '../types'
import { PageTitle } from './Library'
import { Recap } from '../components/Recap'
import { ScrobbleRows } from './Settings'

const DAY = 86_400_000
// сетка: клетка не мельче ~22 px; недель столько, сколько влезает в ширину блока, но не больше года
const CELL = 22
const GAP = 4
const MAX_WEEKS = 53
// дни списком под сеткой — порциями, история хранится всегда и бывает длинной
const PAGE_DAYS = 14
// день недели с понедельника: пн = 0 … вс = 6
const weekday = (d: Date) => (d.getDay() + 6) % 7

// ключ дня в местном времени: прослушивание в 00:30 — это уже «сегодня», а не вчера по UTC
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())

type Day = { key: string; date: Date; items: { play: Play; track: Track }[]; seconds: number }

/** История прослушиваний по дням: сверху сетка дней как в GitHub на всю ширину, ниже — что играло */
export function History() {
  const plays = useStore((s) => s.plays)
  const tracks = useStore((s) => s.tracks)
  const loadPlays = useStore((s) => s.loadPlays)
  const refs = useRef(new Map<string, HTMLElement>())
  const gridRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [shown, setShown] = useState(PAGE_DAYS)
  const [pending, setPending] = useState<string | null>(null) // день, к которому крутим после того, как он отрисуется

  // недель в сетке — по ширине блока
  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // с других устройств история приходит только с сервера — обновляем при каждом открытии
  useEffect(() => {
    void loadPlays()
  }, [loadPlays])

  const byId = new Map(tracks.map((t) => [t.id, t]))
  const days: Day[] = []
  for (const play of plays ?? []) {
    const track = byId.get(play.trackId)
    if (!track) continue // трек удалили из хранилища — в истории его не показать
    const date = new Date(play.playedAt)
    const key = dayKey(date)
    let day = days[days.length - 1]
    if (day?.key !== key) days.push((day = { key, date: startOfDay(date), items: [], seconds: 0 }))
    day.items.push({ play, track })
    day.seconds += track.duration
  }

  const today = startOfDay(new Date())
  // раскладка как в GitHub: колонка — неделя (пн…вс), последняя колонка — текущая неделя
  const weeks = Math.min(MAX_WEEKS, Math.max(4, Math.floor((width - 28 + GAP) / (CELL + GAP))))
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - weekday(today) - (weeks - 1) * 7)
  const counts = new Map(days.map((d) => [d.key, d.items.length]))
  const cols = Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => {
      const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + w * 7 + d)
      return { date, key: dayKey(date), n: counts.get(dayKey(date)) ?? 0, future: date > today }
    }),
  )
  const cells = cols.flat().filter((c) => !c.future)
  // подпись месяца — над неделей, с которой он начался
  const monthOf = (w: number) => {
    const m = cols[w][0].date.getMonth()
    return w === 0 || cols[w - 1][0].date.getMonth() !== m ? cols[w][0].date.toLocaleDateString(getLang(), { month: 'short' }) : ''
  }
  const max = Math.max(1, ...cells.map((c) => c.n))
  // яркость клетки: 0 — пусто, дальше четыре ступени акцента
  const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)))
  const LEVELS = ['bg-dot-off', 'bg-red/30', 'bg-red/55', 'bg-red/80', 'bg-red']
  const weekdayName = (i: number) => new Date(2024, 0, 1 + i).toLocaleDateString(getLang(), { weekday: 'short' }) // 1 янв 2024 — понедельник
  const total = days.reduce((a, d) => a + d.items.length, 0)
  const minutes = Math.round(days.reduce((a, d) => a + d.seconds, 0) / 60)

  // день из сетки может быть ещё не показан в списке — сначала показываем, потом крутим к нему
  const jump = (key: string) => {
    const i = days.findIndex((d) => d.key === key)
    if (i < 0) return
    if (i >= shown) setShown(i + 1)
    setPending(key)
  }
  useEffect(() => {
    if (!pending) return
    refs.current.get(pending)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setPending(null)
  }, [pending, shown])

  return (
    <div>
      <PageTitle sub={`${tn('n.plays', total)} · ${tx('common.minutes', { n: minutes })}`}>{tx('nav.history')}</PageTitle>

      {plays && <Recap plays={plays} tracks={tracks} />}
      {/* отправка прослушиваний на ListenBrainz / Last.fm — прямо здесь (то же есть в «Настройки → История») */}
      <ScrobbleRows inPage />

      <section className="widget mb-6 p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <span className="label text-muted">{tx('hist.activity')}</span>
          {/* легенда: меньше → больше */}
          <span className="flex items-center gap-1 font-mono text-[10px] text-muted">
            {tx('hist.less')}
            {LEVELS.map((l) => (
              <span key={l} className={cx('h-2.5 w-2.5 rounded-[calc(3px*var(--rk,1))]', l)} />
            ))}
            {tx('hist.more')}
          </span>
        </div>
        {/* одна сетка: первая колонка — дни недели, первая строка — месяцы; клетки квадратные и тянутся на всю ширину */}
        <div
          ref={gridRef}
          dir="ltr"
          className="grid grid-flow-col gap-1 font-mono text-[10px] leading-none text-muted"
          style={{ gridTemplateColumns: `auto repeat(${weeks}, minmax(0, 1fr))`, gridTemplateRows: 'auto repeat(7, auto)' }}
        >
          <span />
          {Array.from({ length: 7 }, (_, i) => (
            <span key={`wd${i}`} className="flex items-center pe-1">
              {i % 2 === 0 ? weekdayName(i) : ''}
            </span>
          ))}
          {cols.map((col, w) => [
            <span key={`m${w}`} className="h-3 overflow-visible whitespace-nowrap">
              {monthOf(w)}
            </span>,
            ...col.map((cell) => {
              if (cell.future) return <span key={cell.key} />
              const isToday = cell.key === dayKey(today)
              return (
                <button
                  key={cell.key}
                  disabled={!cell.n}
                  onClick={() => jump(cell.key)}
                  title={`${fmtDay(cell.date, today)} · ${tn('n.plays', cell.n)}`}
                  className={cx(
                    'aspect-square w-full rounded-[calc(4px*var(--rk,1))] transition-transform enabled:hover:scale-125',
                    LEVELS[level(cell.n)],
                    isToday && 'ring-1 ring-fg ring-offset-1 ring-offset-card',
                  )}
                />
              )
            }),
          ])}
        </div>
      </section>

      {plays === null ? null : days.length === 0 ? (
        <div className="widget p-8 text-center text-sm text-muted">{tx('hist.empty')}</div>
      ) : (
        <div className="flex flex-col gap-6">
          {days.slice(0, shown).map((d) => {
            const queue = d.items.map((x) => x.track.id)
            return (
              <section
                key={d.key}
                ref={(el) => {
                  if (el) refs.current.set(d.key, el)
                  else refs.current.delete(d.key)
                }}
                className="scroll-mt-4"
              >
                <div className="mb-2 flex items-baseline justify-between gap-3 px-2">
                  <span className="label text-ink">{fmtDay(d.date, today)}</span>
                  <span className="text-xs text-ink-muted">
                    {tn('n.plays', d.items.length)} · {tx('common.minutes', { n: Math.round(d.seconds / 60) })}
                  </span>
                </div>
                <div className="widget p-2">
                  {d.items.map(({ play, track }, i) => (
                    <TrackRow
                      key={`${play.playedAt}-${i}`}
                      t={track}
                      i={i}
                      no={new Date(play.playedAt).toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' })}
                      queue={queue}
                      source={fmtDay(d.date, today)}
                    />
                  ))}
                </div>
              </section>
            )
          })}
          {days.length > shown && (
            <button onClick={() => setShown(shown + PAGE_DAYS)} className="self-center rounded-full bg-card-3 px-5 py-2.5 text-sm text-fg hover:bg-card-2">
              {tx('hist.earlier')} · {tn('n.days', Math.min(PAGE_DAYS, days.length - shown))}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** «Сегодня», «Вчера», дальше — «пн, 28 октября» */
function fmtDay(date: Date, today: Date) {
  const diff = Math.round((today.getTime() - date.getTime()) / DAY)
  if (diff === 0) return tx('hist.today')
  if (diff === 1) return tx('hist.yesterday')
  return date.toLocaleDateString(getLang(), { weekday: 'short', day: 'numeric', month: 'long' })
}
