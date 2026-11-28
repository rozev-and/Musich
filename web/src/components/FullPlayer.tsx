import { BufferRing } from './BufferRing'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Check,
  ChevronDown,
  Equal,
  CloudDownload,
  HardDriveDownload,
  ChevronLeft,
  Copy,
  Disc3,
  Ellipsis,
  Hash,
  Heart,
  ImagePlus,
  Info,
  ListEnd,
  ListMusic,
  Radio,
  ListPlus,
  Share2,
  ListStart,
  MicVocal,
  Moon,
  Pause,
  PenLine,
  Play,
  Repeat,
  RotateCcw,
  Shuffle,
  SkipBack,
  SkipForward,
  Trash,
  TriangleAlert,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { artistsOf, hasArtist } from '../lib/artists'
import { trackCover } from '../lib/covers'
import { prefetchCover, sizedSrc } from '../lib/thumbs'
import { ArtistLinks } from './ArtistLinks'
import { fmtSize, getLang, t as tx, tn } from '../i18n'
import { fmtTime, isOnDevice } from '../lib/format'
import { SLEEP_OPTIONS } from './PlayerExtras'
import { previousId, selectCurrent, upcoming, usePick, useStore } from '../store'
import type { Track } from '../types'
import { Modal } from './Dialogs'
import { CropDialog } from './CropDialog'
import { mediaUrl } from '../lib/api'
import { Cover, cx, IconBtn, Seek, StatusMark, Toggle } from './ui'
import { PosSeek, PosTime } from './Position'
import { useShallow } from 'zustand/react/shallow'
import { isHost } from '../mode'

/** Круглая кнопка поверх обложки */
function Round({ children, onClick, title, active, size = 'md' }: { children: ReactNode; onClick: () => void; title: string; active?: boolean; size?: 'sm' | 'md' }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cx(
        'grid place-items-center rounded-full backdrop-blur transition-[transform,background-color,color] duration-200 ease-out hover:scale-105 active:scale-90',
        size === 'sm' ? 'h-10 w-10' : 'h-14 w-14',
        // включённое — светлая кнопка с красным значком, чтобы было видно издалека
        active ? 'bg-white text-red' : 'bg-black/70 text-white',
      )}
    >
      {/* key: при включении/выключении значок появляется заново — с «пружинкой» */}
      <span key={String(!!active)} className="pop grid place-items-center">
        {children}
      </span>
    </button>
  )
}

/** Полноэкранный минималистичный плеер: обложка, а управление — при наведении */
// обложка в большом плеере: 1280px хватает с запасом (блок ~450px × плотность экрана ~2.75), оригинал бывает 3000px
const PLAYER_COVER = 1280

/** Обложку следующего трека — заранее: перелистнул, а она уже в кэше и раскодирована */
function usePrefetchNext() {
  const nextId = useStore((st) => upcoming(st, 1)[0])
  useEffect(() => {
    if (!nextId) return
    const st = useStore.getState()
    const t = st.tracks.find((x) => x.id === nextId)
    if (t) prefetchCover(trackCover(t, st.covers), PLAYER_COVER)
  }, [nextId])
}

export function FullPlayer() {
  const { fullPlayer, setFullPlayer, playing, toggle, prev, next, shuffle, toggleShuffle, repeat, toggleRepeat, toggleLike, covers } = usePick(
    'fullPlayer', 'setFullPlayer', 'playing', 'toggle', 'prev', 'next', 'shuffle', 'toggleShuffle', 'repeat', 'toggleRepeat', 'toggleLike', 'covers'
  )
  const cur = useStore(selectCurrent)
  usePrefetchNext()
  const [queueOpen, setQueueOpen] = useState(false)
  const [opens, setOpens] = useState(0) // сколько раз открывали очередь: новое открытие — строки въезжают заново
  const [menuOpen, setMenuOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  // широкий экран: меню «⋯» — отдельный блок слева от обложки, её размера; узкий — поверх обложки
  const wide = useWide()
  // меню и очередь по бокам сразу не помещаются: открываешь одно — другое закрывается
  const toggleQueue = () => {
    if (!queueOpen) {
      setOpens(opens + 1)
      setMenuOpen(false)
    }
    setQueueOpen(!queueOpen)
  }
  const toggleMenu = () => {
    if (!menuOpen && wide && queueOpen) setQueueOpen(false)
    setMenuOpen(!menuOpen)
  }
  // закрытое меню ещё полсекунды живёт в блоке слева, пока тот плавно сворачивается
  const [menuMounted, setMenuMounted] = useState(false)
  useEffect(() => {
    if (menuOpen) return setMenuMounted(true)
    const id = setTimeout(() => setMenuMounted(false), 500)
    return () => clearTimeout(id)
  }, [menuOpen])

  useEffect(() => {
    if (!fullPlayer) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const st = useStore.getState()
      // Escape сначала закрывает то, что открыто поверх
      if (st.coverEdit || st.pickerIds || st.trackInfoId) return
      if (menuOpen) return setMenuOpen(false)
      st.setFullPlayer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullPlayer, menuOpen])

  // закрытие тоже плавное: плеер ещё немного живёт и уезжает вниз
  const [leaving, setLeaving] = useState(false)
  const [shown, setShown] = useState(fullPlayer)
  useEffect(() => {
    if (fullPlayer) {
      setShown(true)
      setLeaving(false)
      return
    }
    if (!shown) return
    setLeaving(true)
    const id = setTimeout(() => {
      setShown(false)
      setLeaving(false)
      setMenuOpen(false)
    }, 240)
    return () => clearTimeout(id)
  }, [fullPlayer, shown])

  if (!shown || !cur) return null

  const PlayIcon = playing ? Pause : Play

  // телефон: своя раскладка — всё управление под обложкой, пальцем
  if (!isHost)
    return (
      <PhoneShell leaving={leaving} cur={cur} />
    )

  return (
    <div className={cx('full-player fixed inset-0 z-40 flex flex-col overflow-y-auto text-ink', leaving && 'full-player-out pointer-events-none')}>
      <div className="flex justify-end p-5">
        <IconBtn title={tx('player.collapse')} onClick={() => setFullPlayer(false)} className="h-11 w-11 bg-card-3">
          <ChevronDown size={20} />
        </IconBtn>
      </div>

      {/* обе колонки всегда по центру: очередь раскрывается по ширине, и обложка плавно отъезжает в сторону */}
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-5 pb-10 lg:flex-row">
        {/* меню и обложка — одна группа. Меню открылось — группа сдвигается вправо на половину меню, чтобы вместе
            стоять по центру. Двигаем только transform: ширину не анимируем, иначе браузер перекладывает страницу каждый кадр */}
        <div
          className={cx(
            'transition-transform duration-500 ease-[cubic-bezier(.2,.8,.2,1)] will-change-transform',
            wide && menuOpen && 'translate-x-40',
          )}
        >
        {/* обложка + управление */}
        {/* на узком экране при открытой очереди обложка ужимается, чтобы список был виден сразу */}
        <div
          className={cx(
            'flex shrink-0 flex-col items-center transition-[width] duration-500 ease-[cubic-bezier(.2,.8,.2,1)]',
            queueOpen ? 'w-[min(240px,60vw)] lg:w-[min(400px,84vw)]' : 'w-[min(400px,84vw)]',
          )}
        >
          <div className="group relative aspect-square w-full">
            {/* меню «⋯» на широком экране: блок слева от обложки, той же высоты, уже неё (w-72 + отступ 2rem = сдвиг группы 10rem) */}
            {wide && (
              <div
                inert={!menuOpen}
                className={cx(
                  'absolute inset-y-0 right-full me-8 w-72 transition-[opacity,transform] duration-500 ease-[cubic-bezier(.2,.8,.2,1)] will-change-transform',
                  menuOpen ? 'translate-x-0 opacity-100' : 'pointer-events-none translate-x-8 opacity-0',
                )}
              >
                {menuMounted && <TrackMenu t={cur} variant="panel" active={menuOpen} trigger={moreRef.current} onClose={() => setMenuOpen(false)} />}
              </div>
            )}
            <Cover seed={cur.album} src={trackCover(cur, covers)} size={PLAYER_COVER} className="h-full w-full shadow-2xl" rounded="rounded-[calc(28px*var(--rk,1))]" />

            <div
              className={cx(
                'absolute inset-0 rounded-[calc(28px*var(--rk,1))] bg-black/40 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100',
                menuOpen && 'opacity-100',
              )}
            >
              <div className="absolute top-4 right-4 flex gap-2">
                <Round size="sm" title={tx('lyrics.title')} onClick={() => useStore.getState().setLyricsOpen(true)}>
                  <MicVocal size={18} />
                </Round>
                <Round size="sm" title={queueOpen ? tx('player.hideQueue') : tx('player.queue')} active={queueOpen} onClick={toggleQueue}>
                  <ListMusic size={18} />
                </Round>
              </div>

              {/* слой на всю обложку не должен перехватывать клики у угловых кнопок — ловят только сами кнопки */}
              <div dir="ltr" className="pointer-events-none absolute inset-0 flex items-center justify-center gap-3 [&>*]:pointer-events-auto">
                <Round size="sm" title={tx('common.prev')} onClick={prev}>
                  <SkipBack size={18} fill="currentColor" />
                </Round>
                <button
                  onClick={toggle}
                  aria-label={playing ? tx('common.pause') : tx('common.play')}
                  className="relative grid h-16 w-16 place-items-center rounded-full bg-red text-on-red shadow-lg transition-transform hover:scale-105 active:scale-95"
                >
                  <PlayIcon key={String(playing)} size={24} fill="currentColor" className={cx('pop', !playing && 'ml-1')} />
                  <BufferRing tone="border-red" />
                </button>
                <Round size="sm" title={tx('common.next')} onClick={next}>
                  <SkipForward size={18} fill="currentColor" />
                </Round>
              </div>

              <div className="pointer-events-none absolute inset-x-4 bottom-4 flex items-end justify-between [&>*]:pointer-events-auto">
                <div ref={moreRef} className="relative">
                  <Round title={tx('common.more')} active={menuOpen} onClick={toggleMenu}>
                    <Ellipsis size={22} />
                  </Round>
                </div>
                <div className="flex gap-2">
                  <Round title={tx('common.shuffle')} active={shuffle} onClick={toggleShuffle}>
                    <Shuffle size={20} />
                  </Round>
                  <Round title={tx('common.repeat')} active={repeat} onClick={toggleRepeat}>
                    <Repeat size={20} />
                  </Round>
                </div>
                <Round title={tx('common.like')} active={cur.liked} onClick={() => toggleLike(cur.id)}>
                  <Heart size={22} fill={cur.liked ? 'currentColor' : 'none'} />
                </Round>
              </div>
            </div>
            {/* меню «⋯» ложится поверх обложки ровно по её размеру */}
            {menuOpen && !wide && <TrackMenu t={cur} variant="cover" onClose={() => setMenuOpen(false)} />}
          </div>

          <div className="mt-6 w-full text-center">
            <div className="truncate text-xl font-medium">{cur.title}</div>
            <ArtistLinks artist={cur.artist} onOpen={() => setFullPlayer(false)} className="text-sm text-muted" />
          </div>

          <div className="mt-4 w-full">
            <PosSeek duration={cur.duration} />
            <div className="mt-1 flex justify-between font-mono text-[11px] text-muted">
              <span>
                <PosTime />
              </span>
              <span>{fmtTime(cur.duration)}</span>
            </div>
          </div>

          {/* на телефоне громкость — кнопками телефона, своей в приложении нет */}
          {isHost && <FullVolume />}
        </div>

        </div>

        {/* очередь: на широком экране раскрывается вбок, на узком — вниз; закрытая не ловит клики и фокус */}
        <div
          inert={!queueOpen}
          className={cx(
            'w-full overflow-hidden transition-[max-width,max-height,opacity,margin,transform] duration-500 ease-[cubic-bezier(.2,.8,.2,1)] lg:w-auto',
            queueOpen
              ? 'mt-6 max-h-[60vh] opacity-100 lg:mt-0 lg:ms-14 lg:max-h-none lg:max-w-xl lg:translate-x-0'
              : 'max-h-0 opacity-0 lg:ms-0 lg:max-h-none lg:max-w-0 lg:translate-x-10',
          )}
        >
          <div className="w-full lg:w-xl">
            <QueuePanel key={opens} open={queueOpen} />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Смахнуть обложку пальцем, как карусель: влево — следующий трек, вправо — предыдущий. Рядом с обложкой едет
 * соседняя; отпустил дальше четверти ширины (или быстро щёлкнул) — обе доезжают со скоростью пальца, и соседняя
 * становится текущей без второй анимации; не дотянул — возвращается. Нет соседа — тянется туго и возвращается.
 * Вертикальная прокрутка плеера остаётся браузеру (touch-action: pan-y)
 */
const SWIPE_GAP = 56 // зазор между обложками: больше поля экрана — соседняя не выглядывает, пока не потянешь, px

function useCoverSwipe(go: { next?: () => void; prev?: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const start = useRef<{ x: number; y: number; id: number } | null>(null)
  const speed = useRef({ x: 0, t: 0, v: 0 }) // скорость пальца, px/мс
  const horiz = useRef(false)
  const busy = useRef(false)
  const swiped = useRef(false) // трек сменили свайпом: перелистывание уже было, кнопочное не нужно
  const [x, setX] = useState(0)
  const [ms, setMs] = useState(0) // длительность перехода; 0 — обложку ведёт палец
  const [active, setActive] = useState(false) // соседей показываем только пока тянут
  const width = () => box.current?.offsetWidth ?? 300

  const back = () => {
    setMs(170)
    setX(0)
    setTimeout(() => !start.current && !busy.current && setActive(false), 180)
  }

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch' || busy.current) return
      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId }
      speed.current = { x: e.clientX, t: e.timeStamp, v: 0 }
      horiz.current = false
      setMs(0)
    },
    onPointerMove: (e: React.PointerEvent) => {
      const st = start.current
      if (!st || e.pointerId !== st.id) return
      const dx = e.clientX - st.x
      const dy = e.clientY - st.y
      if (!horiz.current && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        horiz.current = true
        setActive(true)
      }
      if (!horiz.current) return
      const dt = e.timeStamp - speed.current.t
      if (dt > 0) speed.current = { x: e.clientX, t: e.timeStamp, v: (e.clientX - speed.current.x) / dt }
      const blocked = (dx < 0 && !go.next) || (dx > 0 && !go.prev)
      setX(blocked ? dx / 4 : dx)
    },
    onPointerUp: (e: React.PointerEvent) => {
      const st = start.current
      start.current = null
      if (!st || !horiz.current) return
      const dx = e.clientX - st.x
      const w = width()
      const dir = dx < 0 ? -1 : 1
      const v = speed.current.v
      const fn = dir < 0 ? go.next : go.prev
      const far = Math.abs(dx) > w / 4 || (Math.abs(dx) > 24 && Math.abs(v) > 0.3 && Math.sign(v) === dir)
      if (!fn || !far) return back()
      busy.current = true
      const target = dir * (w + SWIPE_GAP)
      // остаток пути — чуть быстрее пальца (разгон), но не медленнее 200 мс и не резче 90
      const dur = Math.round(Math.max(90, Math.min(200, Math.abs(v) > 0.1 ? Math.abs(target - dx) / (Math.abs(v) * 1.3) : 200)))
      setMs(dur)
      setX(target)
      setTimeout(() => {
        // трек сменился, соседняя обложка — уже текущая: тот же элемент встаёт на место в том же кадре
        swiped.current = true
        fn()
        setMs(0)
        setX(0)
        setActive(false)
        busy.current = false
      }, dur)
    },
    onPointerCancel: () => {
      start.current = null
      back()
    },
  }
  const style: CSSProperties = {
    transform: `translateX(${x}px)`,
    transition: ms ? `transform ${ms}ms cubic-bezier(.16,1,.3,1)` : 'none',
  }
  // один раз: «это был свайп?» — и забыть
  const tookSwipe = () => {
    const was = swiped.current
    swiped.current = false
    return was
  }
  return { box, handlers, style, active, tookSwipe }
}

/**
 * Большой плеер на телефоне: сверху «свернуть» и очередь, чистая обложка (смахнуть — другой трек), название,
 * полоса, кнопки назад / играть / вперёд, под ними перемешать и повтор по краям; внизу — пункты меню списком.
 * Громкости нет: она — кнопками телефона
 */
/**
 * Телефон: плеер на весь экран. Фон — цвет обложки, подмешанный к фону темы (текст остаётся читаемым в любой теме);
 * сменился трек — цвет плавно перетекает
 */
function PhoneShell({ cur, leaving }: { cur: Track; leaving: boolean }) {
  const covers = useStore((s) => s.covers)
  const tint = useCoverTint(trackCover(cur, covers))
  return (
    <div
      style={tint ? { backgroundColor: `color-mix(in srgb, ${tint} 38%, var(--page))` } : undefined}
      className={cx('full-player fixed inset-0 z-40 flex flex-col overflow-y-auto text-ink', leaving && 'full-player-out pointer-events-none')}
    >
      <PhonePlayer cur={cur} />
    </div>
  )
}

// средний цвет обложки (уменьшаем до 12×12 и усредняем, самые тёмные и светлые точки не считаем); по адресу — один раз
const tintCache = new Map<string, string | null>()
function useCoverTint(src: string | undefined) {
  const [tint, setTint] = useState<string | null>(() => (src ? (tintCache.get(src) ?? null) : null))
  useEffect(() => {
    if (!src) return setTint(null)
    if (tintCache.has(src)) return setTint(tintCache.get(src) ?? null)
    let live = true
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      let out: string | null = null
      try {
        const c = document.createElement('canvas')
        c.width = c.height = 12
        const g = c.getContext('2d')
        if (g) {
          g.drawImage(img, 0, 0, 12, 12)
          const d = g.getImageData(0, 0, 12, 12).data
          let r = 0, gr = 0, b = 0, n = 0
          for (let i = 0; i < d.length; i += 4) {
            const l = (d[i] + d[i + 1] + d[i + 2]) / 3
            if (l < 18 || l > 240) continue
            r += d[i]
            gr += d[i + 1]
            b += d[i + 2]
            n++
          }
          if (n) out = `rgb(${Math.round(r / n)} ${Math.round(gr / n)} ${Math.round(b / n)})`
        }
      } catch {
        /* картинка с чужого адреса без разрешения — фон темы */
      }
      tintCache.set(src, out)
      if (live) setTint(out)
    }
    img.onerror = () => {
      tintCache.set(src, null)
      if (live) setTint(null)
    }
    // цвет фона — по маленькой копии: оригинал (до 3000px) второй раз качать незачем
    img.src = sizedSrc(src, 160)
    return () => {
      live = false
    }
  }, [src])
  return tint
}

function PhonePlayer({ cur }: { cur: Track }) {
  const s = usePick('tracks', 'history', 'next', 'prevTrack', 'playing', 'setFullPlayer', 'setPhoneQueue', 'covers', 'toggleShuffle', 'shuffle', 'prev', 'toggle', 'toggleRepeat', 'repeat', 'phoneQueue')
  // соседи по карусели: тот, что заиграет следующим, и тот, что «назад»
  const nextId = useStore((st) => upcoming(st, 1)[0])
  const prevId = useStore(previousId)
  const nextT = s.tracks.find((t) => t.id === nextId && t.id !== cur.id)
  usePrefetchNext()
  const prevT = s.tracks.find((t) => t.id === prevId && t.id !== cur.id)
  const swipe = useCoverSwipe({ next: nextT ? s.next : undefined, prev: prevT ? s.prevTrack : undefined })
  // key — id трека: при смене трека соседняя обложка остаётся тем же элементом, картинка не перегружается
  const slides = [
    ...(swipe.active && prevT ? [{ t: prevT, at: -1 }] : []),
    { t: cur, at: 0 },
    ...(swipe.active && nextT ? [{ t: nextT, at: 1 }] : []),
  ]
  // Трек сменился не свайпом (кнопки, сам доиграл) — та же карусель: старая обложка уезжает и темнеет, новая
  // въезжает с другой стороны чуть уменьшенной. Направление — по истории: старый трек стал последним сыгранным — вперёд
  const [turn, setTurn] = useState<{ old: Track; dir: 1 | -1 } | null>(null)
  const was = useRef(cur)
  useEffect(() => {
    const old = was.current
    was.current = cur
    if (old.id === cur.id) return
    if (swipe.tookSwipe()) return setTurn(null)
    const dir = s.history[s.history.length - 1] === old.id ? 1 : -1
    setTurn({ old, dir })
    const id = setTimeout(() => setTurn(null), 420)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur.id])
  const PlayIcon = s.playing ? Pause : Play
  return (
    <>
      <div className="flex shrink-0 items-center justify-between p-5">
        <IconBtn title={tx('player.collapse')} onClick={() => s.setFullPlayer(false)} className="h-11 w-11 bg-card-3">
          <ChevronDown size={20} />
        </IconBtn>
        <IconBtn title={tx('player.queue')} onClick={() => s.setPhoneQueue(true)} className="h-11 w-11 bg-card-3">
          <ListMusic size={19} />
        </IconBtn>
      </div>

      <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center px-5 pb-8">
        <div className="flex min-h-[calc(100svh-var(--safe-top)-var(--safe-bottom)-84px)] w-full flex-col items-center justify-center">
        <div ref={swipe.box} {...swipe.handlers} className="relative aspect-square w-full shrink-0 touch-pan-y select-none">
          <div style={swipe.style} className="absolute inset-0">
            {/* уезжающая обложка (смена трека кнопкой) */}
            {turn && (
              <div key={`out-${turn.old.id}`} className={cx('absolute inset-0', turn.dir > 0 ? 'cover-out-next' : 'cover-out-prev')}>
                <Cover seed={turn.old.album} src={trackCover(turn.old, s.covers)} size={PLAYER_COVER} className="pointer-events-none h-full w-full shadow-2xl" rounded="rounded-[calc(28px*var(--rk,1))]" />
              </div>
            )}
            {slides.map(({ t, at }) => (
              <div
                key={t.id}
                className={cx('absolute inset-0', at === 0 && turn && (turn.dir > 0 ? 'cover-in-next' : 'cover-in-prev'))}
                style={{ transform: `translateX(calc(${at * 100}% + ${at * SWIPE_GAP}px))` }}
              >
                <Cover seed={t.album} src={trackCover(t, s.covers)} size={PLAYER_COVER} className="pointer-events-none h-full w-full shadow-2xl" rounded="rounded-[calc(28px*var(--rk,1))]" />
              </div>
            ))}
          </div>
        </div>

        <div className="w-full pt-6 text-center">
          <div className="truncate text-xl font-medium">{cur.title}</div>
          <ArtistLinks artist={cur.artist} onOpen={() => s.setFullPlayer(false)} className="text-sm text-muted" />
        </div>

        <div className="mt-4 w-full">
          <PosSeek duration={cur.duration} />
          <div className="mt-1 flex justify-between font-mono text-[11px] text-muted">
            <span>
              <PosTime />
            </span>
            <span>{fmtTime(cur.duration)}</span>
          </div>
        </div>

        {/* перемешать по краям, назад / играть / вперёд посередине — одним рядом, всегда слева направо (даже в арабском) */}
        <div dir="ltr" className="mt-5 mb-2 flex w-full items-center justify-between">
          {/* перемешать и повтор — в прямоугольной рамке, как плитки ниже; включено — рамка и значок цветом акцента */}
          <button
            onClick={s.toggleShuffle}
            title={tx('common.shuffle')}
            aria-pressed={s.shuffle}
            className={cx('grid h-11 w-12 place-items-center rounded-xl border transition-colors', s.shuffle ? 'border-red text-red' : 'border-ink/15 text-ink-muted')}
          >
            <Shuffle size={19} />
          </button>
          <IconBtn title={tx('common.prev')} onClick={s.prev} className="h-14 w-14">
            <SkipBack size={24} fill="currentColor" />
          </IconBtn>
          <button
            onClick={s.toggle}
            aria-label={s.playing ? tx('common.pause') : tx('common.play')}
            className="relative grid h-18 w-18 place-items-center rounded-full bg-red text-on-red shadow-lg transition-transform active:scale-95"
          >
            <PlayIcon key={String(s.playing)} size={28} fill="currentColor" className={cx('pop', !s.playing && 'ml-1')} />
            <BufferRing tone="border-red" />
          </button>
          <IconBtn title={tx('common.next')} onClick={s.next} className="h-14 w-14">
            <SkipForward size={24} fill="currentColor" />
          </IconBtn>
          <button
            onClick={s.toggleRepeat}
            title={tx('common.repeat')}
            aria-pressed={s.repeat}
            className={cx('grid h-11 w-12 place-items-center rounded-xl border transition-colors', s.repeat ? 'border-red text-red' : 'border-ink/15 text-ink-muted')}
          >
            <Repeat size={19} />
          </button>
        </div>
        <PhoneActions t={cur} />
        </div>
      </div>
      {s.phoneQueue && <QueueSheet />}
    </>
  )
}

/** Телефон: очередь отдельным окном на весь экран — что играло, что сейчас и весь список дальше */
function QueueSheet() {
  const { setPhoneQueue, queueName } = usePick('setPhoneQueue', 'queueName')
  return (
    <div className="rise page-layer fixed inset-0 z-50 flex flex-col" style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}>
      {/* шапка: свернуть, что играет (откуда очередь), справа — пусто для равновесия */}
      <div className="flex shrink-0 items-center gap-2 px-2 py-2">
        <IconBtn title={tx('player.collapse')} onClick={() => setPhoneQueue(false)} className="h-11 w-11">
          <ChevronDown size={22} />
        </IconBtn>
        <div className="min-w-0 flex-1 text-center">
          <div className="label text-ink-muted">{tx('player.queue')}</div>
          <div className="truncate text-sm font-medium">{queueName || tx('player.allTracks')}</div>
        </div>
        <span className="h-11 w-11" />
      </div>
      <div className="min-h-0 flex-1">
        <QueuePanel open full />
      </div>
    </div>
  )
}

/**
 * Под кнопками — ряд действий в рамках: таймер сна (шторка с циферблатом), в плейлист, поделиться и «⋯».
 * В «⋯» — реже нужное: скачать / на телефоне, к альбому, изменить, о треке
 */
function PhoneActions({ t }: { t: Track }) {
  const s = usePick('sleepAt', 'sleepEndOfTrack', 'setFullPlayer', 'toast', 'conn', 'download', 'openScope', 'openRename', 'showTrackInfo', 'openPicker', 'covers')
  const [sleepOpen, setSleepOpen] = useState(false)
  const [more, setMore] = useState(false)
  const sleeping = !!s.sleepAt || s.sleepEndOfTrack
  const sleepLeft = s.sleepAt ? fmtTime(Math.max(0, (s.sleepAt - Date.now()) / 1000)) : s.sleepEndOfTrack ? tx('sleep.trackShort') : undefined
  const leave = (fn: () => void) => () => {
    setMore(false)
    s.setFullPlayer(false)
    fn()
  }
  // Поделиться — файлом: на телефоне через системное «Поделиться» (нет на телефоне — сначала скачаем с сервера),
  // в браузере — файлом, если браузер умеет, иначе просто скачать файл
  const share = async () => {
    const text = `${t.artist} — ${t.title}`
    const ext = (t.file ?? '').split('.').pop() || 'mp3'
    const name = `${t.artist} - ${t.title}.${ext}`
    const url = mediaUrl(`/tracks/${t.id}/file`, t.hash)
    try {
      if (!isHost) {
        if (!isOnDevice(t.status)) s.toast(tx('share.preparing'))
        const ok = await (await import('@device')).shareTrack(t.id, name, text, s.conn === 'online' ? url : undefined)
        if (!ok) s.toast(tx('share.noFile'), 'error')
        return
      }
      s.toast(tx('share.preparing'))
      const blob = await fetch(url).then((r) => r.blob())
      const file = new File([blob], name, { type: blob.type || 'audio/mpeg' })
      if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], title: text })
      // браузер не умеет делиться файлами — отдаём файл скачиванием
      const a = document.createElement('a')
      a.href = URL.createObjectURL(file)
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    } catch {
      /* передумали отправлять или нет связи */
    }
  }
  const tile = 'flex flex-1 flex-col items-center gap-2 rounded-2xl border-[1.5px] border-ink/20 py-4 text-[13px] text-ink-muted transition-colors active:bg-card-2'
  const dl =
    t.status === 'cloud'
      ? [{ icon: CloudDownload, label: tx('row.download'), onClick: () => (s.download(t.id), setMore(false)) }]
      : t.status === 'downloading'
        ? [{ icon: CloudDownload, label: `${tx('row.download')} · ${Math.round(t.progress ?? 0)}%`, onClick: () => {} }]
        : isOnDevice(t.status)
          ? [{ icon: HardDriveDownload, label: tx('dev.onPhone'), onClick: () => {}, active: true }]
          : []
  const rows: { icon: typeof Heart; label: string; onClick: () => void; active?: boolean }[] = [
    ...dl,
    { icon: MicVocal, label: tx('lyrics.title'), onClick: () => (setMore(false), useStore.getState().setLyricsOpen(true)) },
    { icon: Disc3, label: tx('menu.goAlbum'), onClick: leave(() => s.openScope({ type: 'album', value: t.album })) },
    { icon: PenLine, label: tx('menu.edit'), onClick: () => (setMore(false), s.openRename(t.id)) },
    { icon: Info, label: tx('menu.info'), onClick: () => (setMore(false), s.showTrackInfo(t.id)) },
  ]
  return (
    <div className="mt-6 flex w-full flex-col gap-3">
      <div className="flex w-full gap-2">
        <button onClick={() => setSleepOpen(true)} className={cx(tile, sleeping && 'border-red text-red')}>
          <Moon size={21} strokeWidth={1.7} />
          {sleepLeft ?? tx('sleep.title')}
        </button>
        <button onClick={() => s.openPicker([t.id])} className={tile}>
          <ListPlus size={21} strokeWidth={1.7} />
          {tx('player.toPlaylist')}
        </button>
        <button onClick={() => void share()} className={tile}>
          <Share2 size={21} strokeWidth={1.7} />
          {tx('player.share')}
        </button>
        <button onClick={() => setMore(true)} className={tile}>
          <Ellipsis size={21} strokeWidth={1.7} />
          {tx('common.more')}
        </button>
      </div>
      {sleepOpen && <SleepSheet onDone={() => setSleepOpen(false)} />}
      {more && (
        <Modal onClose={() => setMore(false)}>
          <div className="mb-3 flex items-center gap-3">
            <Cover seed={t.album} src={trackCover(t, s.covers)} className="h-12 w-12" rounded="rounded-xl" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px]">{t.title}</div>
              <div className="truncate text-xs text-muted">{t.artist}</div>
            </div>
          </div>
          {rows.map(({ icon: Icon, label, onClick, active }) => (
            <button key={label} onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-start text-[15px] transition-colors active:bg-card-2">
              <Icon size={19} strokeWidth={1.6} className={active ? 'text-red' : 'text-muted'} />
              <span className="flex-1">{label}</span>
            </button>
          ))}
        </Modal>
      )}
    </div>
  )
}

/**
 * Таймер сна шторкой снизу: круглый циферблат на час, тянешь точку пальцем (по минуте; второй круг — второй час, до 2 часов).
 * Сверху переключатель «До конца трека» — тогда циферблат не нужен. Закрыть: тап мимо или смахнуть шторку вниз
 */
function SleepSheet({ onDone }: { onDone: () => void }) {
  const { sleepAt, sleepEndOfTrack, setSleep } = usePick('sleepAt', 'sleepEndOfTrack', 'setSleep')
  const [min, setMin] = useState(() => (sleepAt ? Math.min(120, Math.max(1, Math.round((sleepAt - Date.now()) / 60_000))) : 30))
  const [track, setTrack] = useState(sleepEndOfTrack)
  const [drag, setDrag] = useState(0) // насколько шторку утянули вниз, px
  const [closing, setClosing] = useState(false)
  const dial = useRef<SVGSVGElement>(null)
  const sheetY = useRef<number | null>(null)
  const sleeping = !!sleepAt || sleepEndOfTrack
  const close = () => {
    setClosing(true)
    setTimeout(onDone, 200)
  }
  const done = (v: number | 'track' | null) => {
    setSleep(v)
    close()
  }

  // палец на циферблате: угол от «12 часов» по часовой → минуты. Тап — минуты в текущем часе;
  // ведёшь пальцем по кругу — время идёт следом, а проход через 0 переводит на следующий/прошлый час (до 2 часов)
  const dragging = useRef(false)
  const fromPointer = (e: React.PointerEvent, move: boolean) => {
    const r = dial.current!.getBoundingClientRect()
    const x = e.clientX - (r.left + r.width / 2)
    const y = e.clientY - (r.top + r.height / 2)
    if (!move && Math.hypot(x, y) < r.width * 0.22) return // в центре — время, а не кольцо
    const deg = (Math.atan2(x, -y) * 180) / Math.PI
    const inTurn = Math.round(((deg + 360) % 360) / 6) % 60
    setMin((prev) => {
      if (!move) {
        const hour = prev > 60 ? 60 : 0 // тап остаётся в том же часе (ровно 1:00 — ещё первый круг)
        return Math.min(120, Math.max(1, hour + inTurn))
      }
      let diff = inTurn - (prev % 60)
      if (diff < -30) diff += 60
      else if (diff > 30) diff -= 60
      return Math.min(120, Math.max(1, prev + diff))
    })
  }

  const R = 104
  const C = 2 * Math.PI * R
  const part = min % 60 === 0 ? 1 : (min % 60) / 60 // ровно час или два — кольцо замкнуто
  const angle = part * 2 * Math.PI
  const kx = 140 + R * Math.sin(angle)
  const ky = 140 - R * Math.cos(angle)
  const label = `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`

  return createPortal(
    <div className={cx('fixed inset-0 z-50 flex items-end bg-black/50 transition-opacity duration-200', closing && 'opacity-0')} onClick={close}>
      <div
        className={cx('sheet-up w-full rounded-t-[28px] bg-card px-5 pt-2', closing ? 'translate-y-full transition-transform duration-200' : drag ? '' : 'transition-transform')}
        style={{ paddingBottom: 'max(1.25rem, var(--safe-bottom))', transform: closing ? undefined : `translateY(${drag}px)` }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ручка: смахни вниз — закроется */}
        <div
          className="-mx-5 flex touch-none justify-center pb-3 pt-1"
          onPointerDown={(e) => {
            sheetY.current = e.clientY
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => sheetY.current !== null && setDrag(Math.max(0, e.clientY - sheetY.current))}
          onPointerUp={() => {
            sheetY.current = null
            if (drag > 80) close()
            else setDrag(0)
          }}
        >
          <span className="h-1 w-10 rounded-full bg-ink/25" />
        </div>
        <div className="mb-4 text-center text-lg font-semibold">{tx('sleep.title')}</div>
        <label className="mb-2 flex items-center justify-between gap-3 py-2">
          <span className="text-[15px]">{tx('sleep.endOfTrack')}</span>
          <Toggle on={track} onChange={setTrack} />
        </label>
        <div className={cx('mx-auto w-full max-w-[300px] transition-opacity', track && 'pointer-events-none opacity-30')}>
          <svg
            ref={dial}
            viewBox="0 0 280 280"
            className="w-full touch-none select-none"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              dragging.current = true
              fromPointer(e, false)
            }}
            onPointerMove={(e) => dragging.current && fromPointer(e, true)}
            onPointerUp={() => (dragging.current = false)}
            onPointerCancel={() => (dragging.current = false)}
          >
            {Array.from({ length: 12 }, (_, i) => {
              const r = (i * 30 * Math.PI) / 180
              return (
                <text key={i} x={140 + 128 * Math.sin(r)} y={140 - 128 * Math.cos(r)} textAnchor="middle" dominantBaseline="central" className="fill-[var(--ink-muted)] text-[13px]">
                  {i * 5}
                </text>
              )
            })}
            <circle cx={140} cy={140} r={R} fill="none" strokeWidth={6} className="stroke-ink/15" />
            {min > 60 && <circle cx={140} cy={140} r={R} fill="none" strokeWidth={6} className="stroke-[var(--red)] opacity-40" />}
            <circle
              cx={140}
              cy={140}
              r={R}
              fill="none"
              strokeWidth={6}
              strokeLinecap="round"
              strokeDasharray={`${part * C} ${C}`}
              transform="rotate(-90 140 140)"
              className="stroke-[var(--red)]"
            />
            <circle cx={kx} cy={ky} r={13} className="fill-[var(--red)]" />
            <circle cx={kx} cy={ky} r={5} className="fill-[var(--card)]" />
            <text x={140} y={140} textAnchor="middle" dominantBaseline="central" className="fill-[var(--ink)] font-dot text-[44px] font-black">
              {label}
            </text>
          </svg>
        </div>
        <button onClick={() => done(track ? 'track' : min)} className="mt-5 w-full rounded-full bg-sel py-3.5 text-[15px] font-medium text-on-sel">
          {tx('sleep.start')}
        </button>
        {sleeping && (
          <button onClick={() => done(null)} className="mt-1 w-full py-3 text-sm text-red">
            {tx('sleep.off')}
          </button>
        )}
      </div>
    </div>,
    document.body,
  )
}

function useWide() {
  const q = '(min-width: 1024px)'
  const [wide, setWide] = useState(() => matchMedia(q).matches)
  useEffect(() => {
    const m = matchMedia(q)
    const on = () => setWide(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return wide
}

/** Меню «⋯» у трека — без «Моей волны» и «Сообщить о проблеме» */
export function TrackMenu({
  t,
  onClose,
  anchor,
  style,
  variant,
  active = true,
  trigger,
}: {
  t: Track
  onClose: () => void
  // в большом плеере: cover — поверх обложки, panel — блок её размера слева; пункты растягиваются на всю высоту
  variant?: 'cover' | 'panel'
  active?: boolean // закрытое, но ещё видимое (сворачивается) — клики снаружи не ловит
  trigger?: HTMLElement | null // кнопка «⋯» вне меню: клик по ней она обработает сама
  anchor?: HTMLElement | null // кнопка, от которой открыли (для меню у строки списка)
  style?: CSSProperties
}) {
  const s = usePick('setFullPlayer', 'sleepAt', 'sleepEndOfTrack', 'toggleLike', 'playNext', 'addToQueue', 'download', 'openPicker', 'openScope', 'openRename', 'showTrackInfo', 'askDelete', 'setSleep', 'startRadio')
  const ref = useRef<HTMLDivElement>(null)

  const cover = !!variant
  useEffect(() => {
    if (!active) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      // клик по кнопке-якорю она обработает сама (откроет/закроет)
      if (ref.current?.contains(target) || trigger?.contains(target) || (anchor ?? ref.current?.parentElement)?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    // фиксированное меню у строки не должно висеть в воздухе при прокрутке
    if (anchor) window.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose, anchor, active, trigger])

  const go = (fn: () => void) => () => {
    fn()
    onClose()
  }
  const leave = (fn: () => void) =>
    go(() => {
      s.setFullPlayer(false)
      fn()
    })

  // таймер сна — подменю внутри того же блока (только в большом плеере)
  const [sleepView, setSleepView] = useState(false)
  // меню открыли заново — снова с основного списка
  useEffect(() => {
    if (active) setSleepView(false)
  }, [active])
  const sleeping = !!s.sleepAt || s.sleepEndOfTrack
  const sleepLeft = s.sleepAt ? fmtTime(Math.max(0, (s.sleepAt - Date.now()) / 1000)) : s.sleepEndOfTrack ? tx('sleep.trackShort') : undefined

  const items: { icon: typeof Heart; label: string; onClick: () => void; active?: boolean; hint?: string; danger?: boolean }[] = [
    { icon: Heart, label: t.liked ? tx('menu.unlike') : tx('menu.like'), onClick: go(() => s.toggleLike(t.id)), active: t.liked },
    // в большом плеере это играющий трек: «следующим» и «в конец очереди» ему ни к чему — там таймер сна
    ...(cover
      ? [{ icon: Moon, label: tx('sleep.title'), onClick: () => setSleepView(true), active: sleeping, hint: sleepLeft }]
      : [
          { icon: ListStart, label: tx('menu.playNext'), onClick: go(() => s.playNext(t.id)) },
          { icon: ListEnd, label: tx('menu.queueEnd'), onClick: go(() => s.addToQueue(t.id)) },
        ]),
    // телефон: трек с сервера — оставить в памяти телефона, чтобы играл без сети
    ...(!isHost && t.status === 'cloud' ? [{ icon: CloudDownload, label: tx('row.download'), onClick: go(() => s.download(t.id)) }] : []),
    { icon: ListPlus, label: tx('menu.addToPlaylist'), onClick: go(() => s.openPicker([t.id])) },
    { icon: Radio, label: tx('radio.byTrack'), onClick: go(() => void s.startRadio({ trackId: t.id })) },
    { icon: Disc3, label: tx('menu.goAlbum'), onClick: leave(() => s.openScope({ type: 'album', value: t.album })) },
    // у трека с несколькими артистами — по пункту на каждого, подписанному его именем
    ...artistsOf(t.artist).map((name, _, all) => ({
      icon: MicVocal,
      label: all.length > 1 ? name : tx('menu.goArtist'),
      onClick: leave(() => s.openScope({ type: 'artist', value: name })),
    })),
    { icon: PenLine, label: tx('menu.edit'), onClick: go(() => s.openRename(t.id)) },
    { icon: Info, label: tx('menu.info'), onClick: go(() => s.showTrackInfo(t.id)) },
    { icon: Hash, label: tx('menu.copyId'), onClick: go(() => copyId(t.id)) },
    // у строки списка — удалить, в самом конце
    ...(cover ? [] : [{ icon: Trash, label: tx('common.delete'), onClick: go(() => s.askDelete(t.id)), danger: true }]),
  ]

  const menu = (
    <div
      ref={ref}
      style={style}
      className={cx(
        'widget-text z-50 bg-card-2 p-2 text-fg shadow-2xl ring-1 ring-white/5',
        cover
          ? cx('absolute inset-0 flex flex-col overflow-y-auto rounded-[calc(28px*var(--rk,1))]', variant === 'cover' && 'rise')
          : cx('w-64 rounded-[calc(22px*var(--rk,1))]', anchor ? 'fixed' : 'absolute bottom-full left-0 mb-3 lg:bottom-0 lg:left-auto lg:right-full lg:mr-3 lg:mb-0'),
      )}
    >
      {cover && (
        <div className="flex shrink-0 items-center gap-3 px-3 pt-1 pb-1">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{t.title}</div>
            <div className="truncate text-xs text-muted">{t.artist}</div>
          </div>
          <IconBtn title={tx('common.close')} onClick={onClose}>
            <X size={18} />
          </IconBtn>
        </div>
      )}
      {sleepView ? (
        <>
          <div className="flex shrink-0 items-center gap-2 px-1 pb-1">
            <IconBtn title={tx('common.prev')} onClick={() => setSleepView(false)}>
              <ChevronLeft size={18} />
            </IconBtn>
            <span className="flex-1 text-sm font-medium">{tx('sleep.title')}</span>
            {sleepLeft && <span className="pe-3 font-mono text-xs text-red">{sleepLeft}</span>}
          </div>
          {SLEEP_OPTIONS.map((m) => (
            <button
              key={m}
              onClick={go(() => s.setSleep(m))}
              className="flex min-h-9 w-full flex-1 items-center rounded-2xl px-3 text-start text-sm transition-colors hover:bg-card-3"
            >
              {m < 60 ? tn('sleep.minutes', m) : m === 60 ? tx('sleep.hour') : tx('sleep.hourHalf')}
            </button>
          ))}
          <button
            onClick={go(() => s.setSleep('track'))}
            className="flex min-h-9 w-full flex-1 items-center justify-between rounded-2xl px-3 text-start text-sm transition-colors hover:bg-card-3"
          >
            {tx('sleep.endOfTrack')}
            {s.sleepEndOfTrack && <Check size={16} />}
          </button>
          {sleeping && (
            <button
              onClick={go(() => s.setSleep(null))}
              className="flex min-h-9 w-full flex-1 items-center rounded-2xl px-3 text-start text-sm text-red transition-colors hover:bg-card-3"
            >
              {tx('sleep.off')}
            </button>
          )}
        </>
      ) : (
        items.map(({ icon: Icon, label, onClick, active, hint, danger }) => (
          <button
            key={label}
            onClick={onClick}
            className={cx(
              'flex w-full items-center gap-3 rounded-2xl px-3 text-start text-sm transition-colors hover:bg-card-3',
              cover ? 'min-h-9 flex-1' : 'py-2.5',
              danger && 'text-red',
            )}
          >
            <Icon size={17} strokeWidth={1.6} className={active || danger ? 'text-red' : 'text-muted'} fill={active ? 'currentColor' : 'none'} />
            <span className="flex-1">{label}</span>
            {hint && <span className="font-mono text-xs text-red">{hint}</span>}
          </button>
        ))
      )}
    </div>
  )
  // у строки списка меню рисуем поверх всего, иначе его обрежет рамка списка
  return anchor ? createPortal(menu, document.body) : menu
}

/** ID трека в буфер — чтобы вставить в поиск («#…») или переслать */
const copyId = (id: string) => {
  const { toast } = useStore.getState()
  // без доступа к буферу (не https) хотя бы покажем ID в уведомлении
  if (!navigator.clipboard) return toast(id)
  navigator.clipboard.writeText(id).then(
    () => toast(tx('toast.idCopied', { id }), 'ok'),
    () => toast(id),
  )
}

const MENU_H = 400

/** Где показать меню у кнопки: под ней, а если снизу мало места — над ней; правым краем к кнопке */
export const menuPosition = (el: HTMLElement): CSSProperties => {
  const r = el.getBoundingClientRect()
  const right = Math.max(8, window.innerWidth - r.right)
  return r.bottom + MENU_H + 8 > window.innerHeight
    ? { right, bottom: window.innerHeight - r.top + 6 }
    : { right, top: r.bottom + 6 }
}

/** Очередь справа: что играло, что сейчас, что дальше */
/** Громкость прямо в большом плеере: значок — выключить/вернуть, ползунок, колесо мыши — шаг 5 */
function FullVolume() {
  const { volume, setVolume } = usePick('volume', 'setVolume')
  const last = useRef(70)
  const level = volume === 0 ? 'off' : volume < 50 ? 'low' : 'high'
  const Icon = level === 'off' ? VolumeX : level === 'low' ? Volume1 : Volume2
  return (
    <div
      className="mt-3 flex w-full items-center gap-3"
      onWheel={(e) => setVolume(Math.max(0, Math.min(100, volume + (e.deltaY < 0 ? 5 : -5))))}
    >
      <IconBtn
        title={volume ? tx('volume.mute') : tx('volume.unmute')}
        onClick={() => {
          if (volume) {
            last.current = volume
            setVolume(0)
          } else setVolume(last.current || 70)
        }}
        className="-ms-2 text-muted hover:text-fg"
      >
        <Icon key={level} size={18} strokeWidth={1.6} className="pop" />
      </IconBtn>
      <Seek className="flex-1" value={volume / 100} onChange={(v) => setVolume(Math.round(v * 100))} />
      <span className="w-7 text-end font-mono text-[11px] text-muted">{volume}</span>
    </div>
  )
}

function QueuePanel({ open, full }: { open: boolean; full?: boolean }) {
  const s = usePick('tracks', 'history', 'currentId', 'upNext', 'queueName')
  const index = useMemo(() => new Map(s.tracks.map((t) => [t.id, t])), [s.tracks])
  const byId = (id: string) => index.get(id)
  const played = s.history.slice(-5).map(byId).filter((t) => !!t)
  const cur = byId(s.currentId ?? '')
  // в окне очереди на телефоне — весь список дальше, в плеере на ПК — ближайшие 12
  const upIds = useStore(useShallow((st) => upcoming(st, full ? 1000 : 12)))
  const next = upIds.map(byId).filter((t) => !!t)
  const manual = new Set(s.upNext)
  const nowRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  // «Сейчас играет» держим посередине: сверху сыгранное, снизу — что дальше. Крутим только саму панель
  // (scrollIntoView дёрнул бы и весь плеер) и только открытую
  useEffect(() => {
    const box = boxRef.current
    const now = nowRef.current
    if (!open || !box || !now) return
    box.scrollTo({ top: now.offsetTop - box.clientHeight / 2 + now.clientHeight / 2, behavior: full ? 'auto' : 'smooth' })
  }, [s.currentId, open])

  // строки въезжают лесенкой: каждая чуть позже предыдущей
  let n = 0
  const delay = (): CSSProperties => ({ animationDelay: `${Math.min(n++, 14) * 35}ms` })

  // телефон: одним списком — сыгранное, текущий (подсвечен), дальше; без заголовков
  if (full)
    return (
      <div ref={boxRef} className="relative h-full w-full overflow-y-auto pb-6">
        {played.map((t, i) => (
          <PhoneQueueRow key={`${t.id}-${i}`} t={t} fade={0.45 + (0.35 * (i + 1)) / played.length} />
        ))}
        {cur && (
          <div ref={nowRef}>
            <PhoneQueueRow t={cur} current />
          </div>
        )}
        {next.length === 0 && <div className="px-5 py-6 text-sm text-ink-muted">{tx('player.nothingNext')}</div>}
        <EditableQueue tracks={next} manual={manual} />
      </div>
    )

  return (
    <div
      ref={boxRef}
      className={cx(
        'relative w-full max-w-xl self-center overflow-y-auto pe-1 [mask-image:linear-gradient(to_bottom,transparent,black_48px,black_calc(100%-48px),transparent)]',
        'max-h-[45vh] lg:max-h-[78vh]',
      )}
    >
      <div className="py-10">
        {/* сыгранное: чем раньше играло, тем бледнее */}
        {played.map((t, i) => (
          <QueueRow key={`${t.id}-${i}`} t={t} fade={0.3 + (0.45 * (i + 1)) / played.length} style={delay()} />
        ))}

        <div ref={nowRef} className="rise mt-4 mb-2" style={delay()}>
          <div className="text-sm text-muted">{tx('player.nowPlaying')}</div>
          <div className="truncate text-2xl font-medium">{s.queueName || tx('player.allTracks')}</div>
        </div>
        {cur && <QueueRow t={cur} current style={delay()} />}

        <div className="rise mt-5 mb-2 text-sm text-muted" style={delay()}>
          {tx('player.upNext')}
        </div>
        {next.length === 0 && <div className="py-4 text-sm text-muted">{tx('player.nothingNext')}</div>}
        {next.map((t) => <QueueRow key={t.id} t={t} tag={manual.has(t.id) ? tx('player.queuedTag') : undefined} style={delay()} />)}
      </div>
    </div>
  )
}

/**
 * «Дальше» в окне очереди на телефоне: смахнуть строку вбок — убрать трек из очереди; потянуть за ручку ≡ справа —
 * строка приподнимается и едет за пальцем (сразу, без долгого нажатия). Обычное нажатие — играть
 */
function EditableQueue({ tracks, manual }: { tracks: Track[]; manual: Set<string> }) {
  const { removeFromQueue, moveInQueue } = usePick('removeFromQueue', 'moveInQueue')
  const box = useRef<HTMLDivElement>(null)
  const g = useRef<{ i: number; x: number; y: number; mode: 'idle' | 'swipe' | 'drag' | 'scroll'; timer: ReturnType<typeof setTimeout> } | null>(null)
  const [swipe, setSwipe] = useState<{ i: number; dx: number } | null>(null)
  const [drag, setDrag] = useState<{ i: number; dy: number } | null>(null)
  const [gone, setGone] = useState<{ i: number; dir: number } | null>(null)
  const blockClick = useRef(false)

  // пока смахиваем или тащим — список не прокручивается
  useEffect(() => {
    const el = box.current
    if (!el) return
    const stop = (e: TouchEvent) => {
      const m = g.current?.mode
      if (m === 'swipe' || m === 'drag') e.preventDefault()
    }
    el.addEventListener('touchmove', stop, { passive: false })
    return () => el.removeEventListener('touchmove', stop)
  }, [])

  const rowH = () => (box.current?.firstElementChild as HTMLElement | null)?.offsetHeight ?? 60
  const width = () => box.current?.offsetWidth ?? 360
  const target = (i: number, dy: number) => Math.max(0, Math.min(tracks.length - 1, i + Math.round(dy / rowH())))

  const start = (i: number, e: React.TouchEvent) => {
    const p = e.touches[0]
    blockClick.current = false
    // за ручку — сразу перетаскивание
    if ((e.target as HTMLElement).closest('[data-handle]')) {
      const timer = setTimeout(() => {}, 0)
      g.current = { i, x: p.clientX, y: p.clientY, mode: 'drag', timer }
      blockClick.current = true
      navigator.vibrate?.(10)
      setDrag({ i, dy: 0 })
      return
    }
    const timer = setTimeout(() => {
      if (g.current?.mode !== 'idle') return
      g.current.mode = 'drag'
      blockClick.current = true
      navigator.vibrate?.(15)
      setDrag({ i, dy: 0 })
    }, 420)
    g.current = { i, x: p.clientX, y: p.clientY, mode: 'idle', timer }
  }
  const move = (e: React.TouchEvent) => {
    const c = g.current
    if (!c) return
    const p = e.touches[0]
    const dx = p.clientX - c.x
    const dy = p.clientY - c.y
    if (c.mode === 'idle') {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) c.mode = 'swipe'
      else if (Math.abs(dy) > 10) c.mode = 'scroll'
      if (c.mode !== 'idle') clearTimeout(c.timer)
    }
    if (c.mode === 'swipe') {
      blockClick.current = true
      setSwipe({ i: c.i, dx })
    }
    if (c.mode === 'drag') setDrag({ i: c.i, dy })
  }
  const end = () => {
    const c = g.current
    g.current = null
    if (!c) return
    clearTimeout(c.timer)
    if (c.mode === 'swipe' && swipe) {
      const dir = Math.sign(swipe.dx)
      setSwipe(null)
      if (Math.abs(swipe.dx) > width() * 0.35) {
        // улетает вбок и пропадает из очереди
        setGone({ i: c.i, dir })
        const id = tracks[c.i].id
        setTimeout(() => {
          removeFromQueue(id)
          setGone(null)
        }, 180)
      }
    }
    if (c.mode === 'drag' && drag) {
      const to = target(c.i, drag.dy)
      setDrag(null)
      if (to !== c.i) moveInQueue(c.i, to)
    }
  }

  // во время перетаскивания соседи раздвигаются, освобождая место
  const shiftOf = (k: number) => {
    if (!drag || k === drag.i) return 0
    const to = target(drag.i, drag.dy)
    if (drag.i < to && k > drag.i && k <= to) return -rowH()
    if (drag.i > to && k >= to && k < drag.i) return rowH()
    return 0
  }

  return (
    <div ref={box} className="relative">
      {tracks.map((t, k) => {
        const dragging = drag?.i === k
        const sw = swipe?.i === k ? swipe.dx : gone?.i === k ? gone.dir * width() : 0
        const style: CSSProperties = dragging
          ? { transform: `translateY(${drag!.dy}px) scale(1.02)`, zIndex: 10, transition: 'none' }
          : {
              transform: `translate(${sw}px, ${shiftOf(k)}px)`,
              opacity: sw ? 1 - Math.min(Math.abs(sw) / width(), 1) * 0.8 : 1,
              transition: swipe?.i === k ? 'none' : 'transform 180ms cubic-bezier(.2,.8,.2,1), opacity 180ms',
            }
        return (
          <div
            key={t.id}
            className="relative touch-pan-y select-none"
            onTouchStart={(e) => start(k, e)}
            onTouchMove={move}
            onTouchEnd={end}
            onTouchCancel={end}
            onClickCapture={(e) => {
              if (!blockClick.current) return
              blockClick.current = false
              e.stopPropagation()
            }}
          >
            {/* под смахиваемой строкой — «убрать» */}
            {(swipe?.i === k || gone?.i === k) && (
              <div className="absolute inset-0 flex items-center justify-between bg-red/15 px-5 text-red">
                <Trash size={18} />
                <Trash size={18} />
              </div>
            )}
            <div style={style} className={cx('relative bg-page', dragging && 'shadow-2xl ring-1 ring-line')}>
              <PhoneQueueRow t={t} tag={manual.has(t.id) ? tx('player.queuedTag') : undefined} handle />
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Строка очереди на телефоне: крупная обложка, название, исполнитель; справа — лежит ли на телефоне и ручка ≡.
 * Играющий — подсвечен строкой и точкой на обложке. Нажатие — играть
 */
function PhoneQueueRow({ t, current, fade, tag, handle }: { t: Track; current?: boolean; fade?: number; tag?: string; handle?: boolean }) {
  const { play, queue, queueName, covers, playing } = usePick('play', 'queue', 'queueName', 'covers', 'playing')
  return (
    <div
      onClick={() => !current && play(t.id, queue, queueName)}
      style={fade ? { opacity: fade } : undefined}
      className={cx('row-lazy flex cursor-pointer items-center gap-3.5 px-4 py-2 transition-colors active:bg-card-2', current && 'bg-card-2')}
    >
      <div className="relative shrink-0">
        <Cover seed={t.album} src={trackCover(t, covers)} className="h-14 w-14" rounded="rounded-lg" />
        {current && (
          <span className="absolute inset-0 grid place-items-center rounded-lg bg-black/30">
            <span className={cx('h-3 w-3 rounded-full bg-red', playing && 'blink')} />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cx('truncate text-[15px]', current && 'text-red')}>{t.title}</div>
        <div className="truncate text-[13px] text-ink-muted">{t.artist}</div>
      </div>
      {tag && <span className="label text-ink-muted">{tag}</span>}
      {/* лежит на телефоне — играет без сети */}
      {isOnDevice(t.status) && <ArrowDownToLine size={16} className="shrink-0 text-green" aria-label={tx('dev.onPhone')} />}
      {handle ? (
        <span data-handle className="-me-2 grid h-11 w-10 shrink-0 touch-none place-items-center text-ink-muted" title={tx('set.navDrag')}>
          <Equal size={20} />
        </span>
      ) : (
        <span className="w-8 shrink-0" />
      )}
    </div>
  )
}

function QueueRow({ t, current, fade, tag, style }: { t: Track; current?: boolean; fade?: number; tag?: string; style?: CSSProperties }) {
  const s = usePick('play', 'queue', 'queueName', 'covers', 'playing', 'toggleLike')
  return (
    // rise — въезд при открытии очереди; бледность сыгранного — на внутреннем слое, чтобы не спорить с анимацией
    <div className="rise" style={style}>
    <div
      onClick={() => !current && s.play(t.id, s.queue, s.queueName)}
      style={fade ? { opacity: fade } : undefined}
      className="group flex cursor-pointer items-center gap-3 rounded-2xl px-2 py-2 transition-[background-color,opacity,transform] hover:bg-card-2 hover:!opacity-100 active:scale-[.98]"
    >
      <div className="relative shrink-0">
        <Cover seed={t.album} src={trackCover(t, s.covers)} className="h-11 w-11" rounded="rounded-xl" />
        {/* играющий трек — красная точка прямо на обложке */}
        {current && (
          <span className="absolute inset-0 grid place-items-center rounded-xl bg-black/35">
            <span className={cx('h-3 w-3 rounded-full bg-red', s.playing && 'blink')} />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className={cx('truncate text-[15px]', current && 'text-red')}>{t.title}</div>
        <div className="truncate text-xs text-muted">{t.artist}</div>
      </div>
      {tag && <span className="label text-muted">{tag}</span>}
      <IconBtn
        title={tx('common.like')}
        active={t.liked}
        onClick={() => s.toggleLike(t.id)}
        className={cx(!t.liked && 'text-muted')}
      >
        <Heart size={16} strokeWidth={1.6} fill={t.liked ? 'currentColor' : 'none'} />
      </IconBtn>
      <span className="w-10 text-end font-mono text-xs text-muted">{fmtTime(t.duration)}</span>
    </div>
    </div>
  )
}

/** «изменено: теги, обложка» / «как пришёл» (+ «правки в MUSICH»). Номер MUSICH пишет в файлы сам — его не показываем */
function fileChangesText(t: Track) {
  const real = (t.fileChanged ? (t.fileChanges ?? []) : []).filter((c) => c !== 'number')
  const parts = real.length
    ? `${tx('info.fileChangedPrefix')}: ${real.map((c) => tx(c === 'tags' ? 'info.fileTags' : 'info.fileCover')).join(', ')}`
    : tx('info.fileOriginal')
  return t.edited ? `${parts} · ${tx('info.fileEditedMusich')}` : parts
}

/** «О треке»: что за файл и где он лежит */
export function TrackInfoDialog() {
  const id = useStore((s) => s.trackInfoId)
  const t = useStore((s) => s.tracks.find((x) => x.id === s.trackInfoId))
  const { showTrackInfo, covers } = usePick('showTrackInfo', 'covers')
  if (!id || !t) return null
  const close = () => showTrackInfo(null)

  const rows: [string, ReactNode][] = [
    [tx('info.artist'), t.artist],
    [tx('info.album'), t.album],
    [tx('info.year'), t.year ?? '—'],
    [tx('sort.number'), t.trackNo ?? '—'],
    [tx('info.duration'), fmtTime(t.duration)],
    [tx('info.format'), t.file ? t.file.split('.').pop()?.toUpperCase() : '—'],
    [tx('info.size'), fmtSize(t.sizeMb)],
    // на хосте всё лежит в хранилище — «где лежит» имеет смысл только на устройстве
    ...(isHost ? [] : [[tx('info.where'), <StatusMark key="s" status={t.status} progress={t.progress} withLabel />] as [string, ReactNode]]),
    [tx('info.file'), <span key="f" className="font-mono text-xs break-all" dir="ltr">{t.file ?? '—'}</span>],
    // что меняли в самом файле (по сравнению с тем, каким он пришёл) и есть ли правки поверх тегов
    [tx('info.changes'), fileChangesText(t)],
    [tx('info.added'), new Date(t.addedAt).toLocaleDateString(getLang())],
    [
      tx('info.id'),
      <button
        key="id"
        onClick={() => copyId(t.id)}
        title={tx('menu.copyId')}
        dir="ltr"
        className="group flex items-center gap-2 font-mono text-xs text-fg hover:text-red"
      >
        {t.id}
        <Copy size={13} className="text-muted group-hover:text-red" />
      </button>,
    ],
  ]

  return (
    <Modal onClose={close}>
      <div className="mb-5 flex items-start justify-between">
        <span className="label text-muted">{tx('menu.info')}</span>
        <IconBtn title={tx('common.close')} onClick={close} className="-mt-2 -me-2">
          <X size={18} />
        </IconBtn>
      </div>
      <div className="mb-5 flex items-center gap-4">
        <Cover seed={t.album} src={trackCover(t, covers)} className="h-16 w-16" />
        <div className="min-w-0">
          <div className="truncate text-lg font-medium">{t.title}</div>
          <div className="truncate text-sm text-muted">{t.artist}</div>
        </div>
      </div>
      <dl className="flex flex-col">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-4 border-b border-line py-2.5 text-sm last:border-0">
            <dt className="w-28 shrink-0 text-muted">{k}</dt>
            <dd className="min-w-0 flex-1">{v}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}

/**
 * «Редактировать» трек. Название, исполнитель и альбом записываются в сам файл на сервере (id меняется).
 * Обложка — нет: файл остаётся как был, MUSICH просто запоминает свою картинку для трека
 */
export function RenameDialog() {
  const id = useStore((s) => s.renameId)
  const t = useStore((s) => s.tracks.find((x) => x.id === s.renameId))
  if (!id || !t) return null
  // key — чтобы форма заново заполнялась для каждого трека
  return <EditForm key={id} t={t} />
}

function EditForm({ t }: { t: Track }) {
  const { openRename, renameTrack, setCover, covers, toast, prefs, resetTrackEdits, moveTrackNumber } = usePick('openRename', 'renameTrack', 'setCover', 'covers', 'toast', 'prefs', 'resetTrackEdits', 'moveTrackNumber')
  // номер трека: можно вписать или одной кнопкой — в начало (№1) или в конец списка
  const maxNo = useStore((s) => s.tracks.reduce((m, x) => Math.max(m, x.trackNo ?? 0), 0))
  const lastNo = t.trackNo ? maxNo : maxNo + 1
  const [num, setNum] = useState(t.trackNo ? String(t.trackNo) : '')
  const numVal = num.trim() ? Math.min(lastNo, Math.max(1, Number(num))) : undefined
  const numChanged = numVal !== undefined && numVal !== t.trackNo
  // выбранная картинка ждёт кадрирования
  const [crop, setCrop] = useState<Blob | null>(null)
  const inFile = prefs.editMode === 'file'
  const [title, setTitle] = useState(t.title)
  const [artist, setArtist] = useState(t.artist)
  const [album, setAlbum] = useState(t.album)
  const [year, setYear] = useState(t.year ? String(t.year) : '')
  const [saving, setSaving] = useState(false)
  const [drag, setDrag] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const close = () => !saving && openRename(null)

  // обложка: undefined — без изменений, null — вернуть картинку из тегов, строка — новая картинка
  const coverKey = `track:${t.id}`
  const own = covers[coverKey]
  const fallback = covers[`album:${t.album}`] ?? t.cover
  const [pending, setPending] = useState<string | null | undefined>(undefined)
  const preview = pending === null ? fallback : (pending ?? own ?? fallback)
  const hasOwn = pending === undefined ? !!own : pending !== null
  const takeFile = async (f?: File | null) => {
    if (!f) return
    if (!f.type.startsWith('image/')) return toast(tx('toast.notImage'), 'error')
    setCrop(f)
  }

  // в файл отправляем только изменённое и непустое
  const patch: { title?: string; artist?: string; album?: string; year?: number } = {}
  if (title.trim() && title.trim() !== t.title) patch.title = title.trim()
  if (artist.trim() && artist.trim() !== t.artist) patch.artist = artist.trim()
  if (album.trim() && album.trim() !== t.album) patch.album = album.trim()
  // пустое поле — убрать год из тегов (0)
  const yearNum = year.trim() ? Number(year) : 0
  const yearOk = !year.trim() || (Number.isInteger(yearNum) && yearNum > 0 && yearNum <= 9999)
  if (yearOk && yearNum !== (t.year ?? 0)) patch.year = yearNum
  const tagsChanged = Object.keys(patch).length > 0
  const changed = tagsChanged || pending !== undefined || numChanged

  const fields: [string, string, (v: string) => void, string?][] = [
    [tx('rename.title'), title, setTitle],
    [tx('info.artist'), artist, setArtist, tx('rename.artistHint')],
    [tx('info.album'), album, setAlbum],
  ]

  return (
    <>
    {crop && <CropDialog blob={crop} onCancel={() => setCrop(null)} onDone={(url) => (setPending(url), setCrop(null))} />}
    <Modal onClose={close}>
      <div className="mb-5 flex items-start justify-between">
        <span className="label text-muted">{tx('rename.head')}</span>
        <IconBtn title={tx('common.close')} onClick={close} className="-mt-2 -me-2">
          <X size={18} />
        </IconBtn>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!changed || saving) return
          setSaving(true)
          // номер — первым: файлы переписываются на сервере, а id трека не меняется
          // номер — в фоне: при большом сдвиге сервер переписывает теги у сотен файлов (минуты), окно не ждёт
          if (numChanged) void moveTrackNumber(t.id, numVal!)
          // картинку — на старый id: при переписывании файла сервер сам перенесёт её на новый
          if (pending !== undefined) await setCover(coverKey, pending)
          if (tagsChanged) await renameTrack(t.id, patch)
          else openRename(null)
          setSaving(false)
        }}
        className="flex flex-col gap-4"
      >
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => file.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDrag(true)
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDrag(false)
              void takeFile(e.dataTransfer.files[0])
            }}
            title={tx('cover.upload')}
            className={cx('group/pic relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl', drag && 'ring-2 ring-red')}
          >
            <Cover seed={t.album} src={preview} size={0} className="h-full w-full" />
            <span
              className={cx(
                'absolute inset-0 grid place-items-center rounded-2xl bg-black/60 text-white opacity-0 transition-opacity group-hover/pic:opacity-100',
                drag && 'opacity-100',
              )}
            >
              <ImagePlus size={20} />
            </span>
          </button>
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => void takeFile(e.target.files?.[0])} />
          <div className="flex min-w-0 flex-col items-start gap-1 text-sm">
            <button type="button" onClick={() => file.current?.click()} className="hover:underline">
              {tx('cover.uploadShort')}
            </button>
            {hasOwn && (
              <button type="button" onClick={() => setPending(null)} className="flex items-center gap-1.5 text-muted hover:text-fg">
                <RotateCcw size={13} /> {tx('cover.resetTags')}
              </button>
            )}
            <span className="text-xs text-muted">{tx(prefs.coverMode === 'file' ? 'edit.coverHintFile' : 'edit.coverHint')}</span>
          </div>
        </div>
        <div className="font-mono text-xs break-all text-muted" dir="ltr">
          {t.file}
          <span className="block opacity-70">ID: {t.id}</span>
        </div>
        {fields.map(([label, value, set, hint]) => (
          <label key={label} className="flex flex-col gap-1.5">
            <span className="label text-muted">{label}</span>
            <input
              value={value}
              onChange={(e) => set(e.target.value)}
              maxLength={500}
              className="rounded-2xl bg-card-3 px-4 py-3 text-[15px] outline-none focus:ring-1 focus:ring-fg"
            />
            {hint && <span className="text-xs text-muted">{hint}</span>}
          </label>
        ))}
        {/* номер трека — порядок «по номеру»; в начало / в конец — одной кнопкой */}
        <div className="flex flex-col gap-1.5">
          <span className="label text-muted">{tx('edit.number')}</span>
          <div className="flex items-center gap-2">
            <input
              value={num}
              onChange={(e) => setNum(e.target.value.replace(/\D/g, '').slice(0, 5))}
              inputMode="numeric"
              placeholder="—"
              aria-label={tx('edit.number')}
              className="w-24 rounded-2xl bg-card-3 px-4 py-3 font-mono text-[15px] outline-none focus:ring-1 focus:ring-fg"
            />
            <button type="button" onClick={() => setNum('1')} className="flex items-center gap-1.5 rounded-full border border-line px-3.5 py-2.5 text-sm hover:border-fg">
              <ArrowUpToLine size={15} /> {tx('edit.toTop')}
            </button>
            <button type="button" onClick={() => setNum(String(lastNo))} className="flex items-center gap-1.5 rounded-full border border-line px-3.5 py-2.5 text-sm hover:border-fg">
              <ArrowDownToLine size={15} /> {tx('edit.toBottom')}
            </button>
          </div>
          {/* сколько файлов перепишется: номер пишется в теги, и все треки между старым и новым местом сдвигаются */}
          {numChanged && (() => {
            const n = t.trackNo ? Math.abs(numVal! - t.trackNo) : Math.max(0, lastNo - numVal!)
            return n > 1 ? <span className="text-xs text-muted">{tx('edit.numShift', { n, min: Math.max(1, Math.round((n * 0.5) / 60)) })}</span> : null
          })()}
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="label text-muted">{tx('info.year')}</span>
          <input
            value={year}
            onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
            inputMode="numeric"
            placeholder="—"
            className={cx(
              'w-32 rounded-2xl bg-card-3 px-4 py-3 font-mono text-[15px] outline-none focus:ring-1 focus:ring-fg',
              !yearOk && 'ring-1 ring-red',
            )}
          />
        </label>
        {/* правится сам файл — предупреждаем заметно; «только в MUSICH» — спокойной подсказкой */}
        {inFile ? (
          <div className="flex gap-3 rounded-2xl bg-red/10 p-3 text-xs leading-relaxed text-fg">
            <TriangleAlert size={16} className="mt-px shrink-0 text-red" />
            <span>{tx('rename.note')}</span>
          </div>
        ) : (
          <div className="flex gap-3 rounded-2xl bg-card-3 p-3 text-xs leading-relaxed text-muted">
            <Info size={16} className="mt-px shrink-0" />
            <span>{tx('rename.noteOverlay')}</span>
          </div>
        )}
        {/* правки «только в MUSICH» можно снять — трек снова такой, как в тегах файла */}
        {t.edited && (
          <button
            type="button"
            onClick={() => {
              void resetTrackEdits(t.id)
              close()
            }}
            className="flex items-center gap-2 self-start rounded-full px-1 text-xs text-muted hover:text-fg"
          >
            <RotateCcw size={13} /> {tx('rename.reset')}
          </button>
        )}
        <div className="mt-1 flex gap-2">
          <button type="button" onClick={close} className="flex-1 rounded-full py-3 text-sm text-muted hover:text-fg">
            {tx('common.cancel')}
          </button>
          <button type="submit" disabled={!changed || saving || !yearOk} className="flex-1 rounded-full bg-sel py-3 text-sm text-on-sel disabled:opacity-40">
            {saving ? tx('rename.saving') : tx('common.save')}
          </button>
        </div>
      </form>
    </Modal>
    </>
  )
}

/** Переименование артиста во всех его треках: новое имя записывается в файлы на сервере */
export function ArtistRenameDialog() {
  const names = useStore((s) => s.artistRename)
  if (!names?.length) return null
  return <ArtistRenameForm key={names.join('\n')} names={names} />
}

function ArtistRenameForm({ names }: { names: string[] }) {
  const { openArtistRename, renameArtist, tracks } = usePick('openArtistRename', 'renameArtist', 'tracks')
  const [from, setFrom] = useState(names[0])
  const [to, setTo] = useState(names[0])
  const [saving, setSaving] = useState(false)
  const close = () => !saving && openArtistRename(null)
  const count = tracks.filter((t) => hasArtist(t, from)).length
  const changed = !!to.trim() && to.trim() !== from

  return (
    <Modal onClose={close}>
      <div className="mb-5 flex items-start justify-between">
        <span className="label text-muted">{tx('rename.artistHead')}</span>
        <IconBtn title={tx('common.close')} onClick={close} className="-mt-2 -me-2">
          <X size={18} />
        </IconBtn>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!changed || saving) return
          setSaving(true)
          await renameArtist(from, to.trim())
          setSaving(false)
        }}
        className="flex flex-col gap-4"
      >
        {/* у совместного трека сначала выбираем, кого из артистов переименовать */}
        {names.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {names.map((n) => (
              <button
                key={n}
                type="button"
                disabled={saving}
                onClick={() => {
                  setFrom(n)
                  setTo(n)
                }}
                className={cx(
                  'rounded-full border px-4 py-2 text-xs transition-colors',
                  n === from ? 'border-sel-page bg-sel-page text-on-sel-page' : 'border-ink/20 text-ink-muted hover:border-ink/50 hover:text-ink',
                )}
              >
                {n}
              </button>
            ))}
          </div>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="label text-muted">{tx('rename.artistNew')}</span>
          <input
            autoFocus
            value={to}
            onChange={(e) => setTo(e.target.value)}
            maxLength={500}
            disabled={saving}
            className="rounded-2xl bg-card-3 px-4 py-3 text-[15px] outline-none focus:ring-1 focus:ring-fg"
          />
        </label>
        <p className="text-xs leading-relaxed text-muted">{tx('rename.artistNote', { tracks: tn('n.tracks', count) })}</p>
        <div className="mt-1 flex gap-2">
          <button type="button" onClick={close} className="flex-1 rounded-full py-3 text-sm text-muted hover:text-fg">
            {tx('common.cancel')}
          </button>
          <button type="submit" disabled={!changed || saving} className="flex-1 rounded-full bg-sel py-3 text-sm text-on-sel disabled:opacity-40">
            {saving ? tx('rename.saving') : tx('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  )
}
