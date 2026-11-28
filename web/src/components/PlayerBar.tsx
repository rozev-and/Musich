import { ChevronUp, Heart, Pause, Play, Repeat, Shuffle, SkipBack, SkipForward } from 'lucide-react'
import { BufferRing } from './BufferRing'
import { useEffect, useRef, useState, type PointerEvent, type MouseEvent } from 'react'
import { SleepButton, SoundButton, VolumeControl } from './PlayerExtras'
import { trackCover } from '../lib/covers'
import { t } from '../i18n'
import { fmtTime } from '../lib/format'
import { previousId, selectCurrent, upcoming, usePick, useStore } from '../store'
import type { Track } from '../types'
import { Cover, cx, IconBtn, StatusMark } from './ui'
import { PosSeek, PosTime } from './Position'
import { isHost } from '../mode'

/**
 * Жесты пальцем по мини-плееру: влево — следующий трек, вправо — предыдущий, вверх — большой плеер.
 * Только касание (мышь на ПК не трогаем); после жеста клик по обложке или названию не срабатывает
 */
function useSwipe(h: { left: () => void; right: () => void; up: () => void }) {
  const start = useRef<{ x: number; y: number; id: number } | null>(null)
  const moved = useRef(false)
  const [dx, setDx] = useState(0)
  const end = (e: PointerEvent) => {
    const s = start.current
    start.current = null
    setDx(0)
    if (!s || e.pointerId !== s.id) return
    const x = e.clientX - s.x
    const y = e.clientY - s.y
    if (Math.abs(x) > 70 && Math.abs(x) > Math.abs(y) * 1.5) (x < 0 ? h.left : h.right)()
    else if (y < -50 && Math.abs(y) > Math.abs(x) * 1.5) h.up()
  }
  return {
    dx,
    handlers: {
      onPointerDown: (e: PointerEvent) => {
        if (e.pointerType !== 'touch') return
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId }
        moved.current = false
      },
      onPointerMove: (e: PointerEvent) => {
        const s = start.current
        if (!s || e.pointerId !== s.id) return
        const x = e.clientX - s.x
        const y = e.clientY - s.y
        if (!moved.current && Math.hypot(x, y) > 10) moved.current = true
        if (moved.current && Math.abs(x) > Math.abs(y)) setDx(x)
      },
      onPointerUp: end,
      onPointerCancel: () => {
        start.current = null
        setDx(0)
      },
      onClickCapture: (e: MouseEvent) => {
        if (!moved.current) return
        moved.current = false
        e.stopPropagation()
        e.preventDefault()
      },
    },
  }
}

/** Узкий экран (телефон): мини-плеер — карусель карточек */
function useNarrow() {
  const q = '(max-width: 767px)'
  const [narrow, setNarrow] = useState(() => matchMedia(q).matches)
  useEffect(() => {
    const m = matchMedia(q)
    const update = () => setNarrow(m.matches)
    m.addEventListener('change', update)
    return () => m.removeEventListener('change', update)
  }, [])
  return narrow
}

const GAP = 12 // зазор между карточками, px

/** Карточка трека в мини-плеере. live — настоящая (кнопки работают, полоска идёт), иначе — соседняя, только картинка */
function MiniCard({ tr, live }: { tr: Track; live?: boolean }) {
  const { playing, toggle, toggleLike, setFullPlayer, covers } = usePick('playing', 'toggle', 'toggleLike', 'setFullPlayer', 'covers')
  const PlayIcon = live && playing ? Pause : Play
  return (
    <div className="widget float flex flex-col gap-1 px-4 py-3 shadow-2xl">
      <div className="flex min-w-0 items-center gap-3">
        <button onClick={() => live && setFullPlayer(true)} title={t('player.expand')} className="shrink-0">
          <Cover seed={tr.album} src={trackCover(tr, covers)} className="h-12 w-12" rounded="rounded-xl" />
        </button>
        <div className="min-w-0 flex-1" onClick={() => live && setFullPlayer(true)}>
          <div className="truncate text-[15px] font-medium">{tr.title}</div>
          <div className="flex items-center gap-2 text-xs text-muted">
            {!isHost && <StatusMark status={tr.status} progress={tr.progress} />}
            <span className="truncate">{tr.artist}</span>
          </div>
        </div>
        <IconBtn title={t('common.like')} active={tr.liked} onClick={() => live && toggleLike(tr.id)} className="shrink-0">
          <Heart size={17} strokeWidth={1.6} fill={tr.liked ? 'currentColor' : 'none'} />
        </IconBtn>
        <button
          onClick={() => live && toggle()}
          aria-label={live && playing ? t('common.pause') : t('common.play')}
          className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sel text-on-sel"
        >
          <PlayIcon size={16} fill="currentColor" className={live && playing ? '' : 'ml-0.5'} />
          <BufferRing on={live} />
        </button>
      </div>
      {live ? (
        <PosSeek className="flex-1" duration={tr.duration} />
      ) : (
        <div className="h-5" />
      )}
    </div>
  )
}

/**
 * Мини-плеер на телефоне. Тянешь карточку вбок — она едет за пальцем, следом едет карточка соседнего трека;
 * отпустил дальше трети (или быстро щёлкнул) — доезжают, и соседняя становится текущей без второй анимации.
 * Вверх — большой плеер. Трек сменился кнопкой или сам — карточка уезжает в ту же сторону, новая въезжает
 */
function PhoneMini({ cur }: { cur: Track }) {
  const s = usePick('tracks', 'history', 'setFullPlayer', 'next', 'prevTrack')
  const nextId = useStore((st) => upcoming(st, 1)[0])
  const prevIdv = useStore(previousId)
  const nextT = s.tracks.find((x) => x.id === nextId && x.id !== cur.id)
  const prevT = s.tracks.find((x) => x.id === prevIdv && x.id !== cur.id)
  const box = useRef<HTMLDivElement>(null)
  const start = useRef<{ x: number; y: number; id: number; t: number } | null>(null)
  const mode = useRef<'idle' | 'h' | 'v'>('idle')
  const moved = useRef(false)
  const swiped = useRef(false)
  const [dx, setDx] = useState(0)
  const [ms, setMs] = useState(0)
  const [turn, setTurn] = useState<{ old: Track; dir: 1 | -1 } | null>(null)

  // сменился не свайпом — перелистывание само
  const was = useRef(cur)
  useEffect(() => {
    const old = was.current
    was.current = cur
    if (old.id === cur.id) return
    if (swiped.current) {
      swiped.current = false
      return setTurn(null)
    }
    setTurn({ old, dir: s.history[s.history.length - 1] === old.id ? 1 : -1 })
    const id = setTimeout(() => setTurn(null), 380)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur.id])

  const width = () => box.current?.offsetWidth ?? 340
  const back = () => {
    setMs(200)
    setDx(0)
  }
  const handlers = {
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return
      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, t: e.timeStamp }
      mode.current = 'idle'
      moved.current = false
      setMs(0)
    },
    onPointerMove: (e: PointerEvent) => {
      const st = start.current
      if (!st || e.pointerId !== st.id) return
      const x = e.clientX - st.x
      const y = e.clientY - st.y
      if (mode.current === 'idle' && Math.hypot(x, y) > 8) {
        mode.current = Math.abs(x) > Math.abs(y) ? 'h' : 'v'
        moved.current = true
      }
      if (mode.current !== 'h') return
      const blocked = (x < 0 && !nextT) || (x > 0 && !prevT)
      setDx(blocked ? x / 4 : x)
    },
    onPointerUp: (e: PointerEvent) => {
      const st = start.current
      start.current = null
      if (!st || e.pointerId !== st.id) return
      const x = e.clientX - st.x
      const y = e.clientY - st.y
      if (mode.current === 'v') {
        if (y < -50) s.setFullPlayer(true)
        return
      }
      if (mode.current !== 'h') return
      const dir = x < 0 ? 1 : -1
      const fn = dir > 0 ? (nextT ? s.next : undefined) : prevT ? s.prevTrack : undefined
      const fast = Math.abs(x) > 30 && Math.abs(x) / Math.max(1, e.timeStamp - st.t) > 0.5
      if (!fn || (Math.abs(x) < width() / 3 && !fast)) return back()
      setMs(200)
      setDx(-dir * (width() + GAP))
      setTimeout(() => {
        swiped.current = true
        fn()
        setMs(0)
        setDx(0)
      }, 200)
    },
    onPointerCancel: () => {
      start.current = null
      back()
    },
    onClickCapture: (e: MouseEvent) => {
      if (!moved.current) return
      moved.current = false
      e.stopPropagation()
      e.preventDefault()
    },
  }

  return (
    <div ref={box} {...handlers} className="relative touch-pan-y select-none">
      <div className="relative" style={{ transform: `translateX(${dx}px)`, transition: ms ? `transform ${ms}ms cubic-bezier(.2,.8,.2,1)` : 'none' }}>
        {turn && (
          <div className={cx('pointer-events-none absolute inset-0', turn.dir > 0 ? 'card-out-next' : 'card-out-prev')}>
            <MiniCard tr={turn.old} />
          </div>
        )}
        {/* соседи — справа следующий, слева предыдущий; видны, пока тянут */}
        {dx < 0 && nextT && (
          <div className="pointer-events-none absolute inset-y-0 w-full" style={{ left: `calc(100% + ${GAP}px)` }}>
            <MiniCard tr={nextT} />
          </div>
        )}
        {dx > 0 && prevT && (
          <div className="pointer-events-none absolute inset-y-0 w-full" style={{ right: `calc(100% + ${GAP}px)` }}>
            <MiniCard tr={prevT} />
          </div>
        )}
        <div key={cur.id} className={cx(turn && (turn.dir > 0 ? 'card-in-next' : 'card-in-prev'))}>
          <MiniCard tr={cur} live />
        </div>
      </div>
    </div>
  )
}

export function PlayerBar() {
  const { playing, next, prev, setFullPlayer, toggle, toggleLike, shuffle, toggleShuffle, repeat, toggleRepeat, covers } = usePick(
    'playing', 'next', 'prev', 'setFullPlayer', 'toggle', 'toggleLike', 'shuffle', 'toggleShuffle', 'repeat', 'toggleRepeat', 'covers'
  )
  const cur = useStore(selectCurrent)
  const swipe = useSwipe({ left: next, right: prev, up: () => setFullPlayer(true) })
  const narrow = useNarrow()

  // ничего не играет — плеера нет совсем; появляется вместе с первым треком
  if (!cur) return null
  // телефон: карусель карточек
  if (narrow) return <PhoneMini cur={cur} />

  const PlayIcon = playing ? Pause : Play

  return (
    // rise — въезжает снизу, когда появляется (смена трека его не пересоздаёт)
    <div className="widget float rise flex flex-col gap-1 px-4 py-3 md:flex-row md:items-center md:gap-4 md:px-5">
      {/* трек; на телефоне его можно смахнуть — палец едет, строка едет следом */}
      <div
        {...swipe.handlers}
        className={cx('flex min-w-0 touch-none items-center gap-3 md:flex-1 md:touch-auto', !swipe.dx && 'transition-transform duration-200')}
        style={swipe.dx ? { transform: `translateX(${swipe.dx * 0.6}px)`, opacity: 1 - Math.min(Math.abs(swipe.dx) / 300, 0.5) } : undefined}
      >
        {/* клик по обложке/названию — развернуть плеер на весь экран */}
        <button onClick={() => setFullPlayer(true)} title={t('player.expand')} className="group/open relative shrink-0">
          <Cover seed={cur.album} src={trackCover(cur, covers)} className="h-12 w-12" rounded="rounded-xl" />
          <span className="absolute inset-0 grid place-items-center rounded-xl bg-black/50 text-white opacity-0 transition-opacity group-hover/open:opacity-100">
            <ChevronUp size={18} />
          </span>
        </button>
        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setFullPlayer(true)}>
          <div className="truncate text-[15px] font-medium">{cur.title}</div>
          <div className="flex items-center gap-2 text-xs text-muted">
            {!isHost && <StatusMark status={cur.status} progress={cur.progress} />}
            <span className="truncate">{cur.artist}</span>
          </div>
        </div>
        <IconBtn title={t('common.like')} active={cur.liked} onClick={() => toggleLike(cur.id)} className="shrink-0">
          <Heart size={17} strokeWidth={1.6} fill={cur.liked ? 'currentColor' : 'none'} />
        </IconBtn>
        {/* мини-плеер на телефоне */}
        <button
          onClick={toggle}
          aria-label={playing ? t('common.pause') : t('common.play')}
          className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sel text-on-sel md:hidden"
        >
          <PlayIcon size={16} fill="currentColor" className={playing ? '' : 'ml-0.5'} />
          <BufferRing />
        </button>
      </div>

      {/* центр: кнопки над полосой, как в обычных плеерах — не налезает при узком окне */}
      {/* кнопки и перемотка всегда слева направо — даже в арабском, как в любом плеере */}
      <div dir="ltr" className="flex min-w-0 flex-col md:flex-[1.6]">
        <div className="hidden items-center justify-center gap-1 md:flex">
          <IconBtn title={t('common.shuffle')} active={shuffle} onClick={toggleShuffle}>
            <Shuffle size={16} strokeWidth={1.6} />
          </IconBtn>
          <IconBtn title={t('common.prev')} onClick={prev}>
            <SkipBack size={18} strokeWidth={1.6} fill="currentColor" />
          </IconBtn>
          <button
            onClick={toggle}
            aria-label={playing ? t('common.pause') : t('common.play')}
            className="relative mx-1 grid h-10 w-10 place-items-center rounded-full bg-sel text-on-sel transition-transform active:scale-95"
          >
            <PlayIcon size={17} fill="currentColor" className={playing ? '' : 'ml-0.5'} />
            <BufferRing />
          </button>
          <IconBtn title={t('common.next')} onClick={next}>
            <SkipForward size={18} strokeWidth={1.6} fill="currentColor" />
          </IconBtn>
          <IconBtn title={t('common.repeat')} active={repeat} onClick={toggleRepeat}>
            <Repeat size={16} strokeWidth={1.6} />
          </IconBtn>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <span className="hidden w-9 shrink-0 text-end font-mono text-[11px] text-muted md:inline">
            <PosTime />
          </span>
          <PosSeek className="flex-1" duration={cur.duration} />
          <span className="hidden w-9 shrink-0 font-mono text-[11px] text-muted md:inline">{fmtTime(cur.duration)}</span>
        </div>
      </div>

      {/* таймер сна, настройки звука, громкость */}
      <div className="hidden min-w-0 flex-1 items-center justify-end gap-1 md:flex">
        <SleepButton />
        <SoundButton />
        {isHost && <VolumeControl />}
      </div>
    </div>
  )
}
