import { Dices, Disc3, Heart, History, Laptop, MicVocal, Monitor, Moon, Pause, Play, RefreshCw, Server as ServerIcon, Smartphone, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useState, useRef } from 'react'
import { groupByArtist } from '../lib/artists'
import { trackCover } from '../lib/covers'
import { fmtSize, t as tx, tn } from '../i18n'
import { fmtTime, isOnDevice } from '../lib/format'
import { isHost } from '../mode'
import { LIKED_ID, usePick, useStore } from '../store'
import { Cover, cx, DotLine, DotNum } from '../components/ui'
import { ScanBanner } from '../components/ScanBanner'
import { AppFooter } from '../components/AppFooter'
import { Logo as ServiceLogo } from '../components/Integrations'
import { useRemoteLists } from '../components/Nav'

const MB = 1024 * 1024

// «Сейчас играет» тут нет: плеер и так всегда внизу экрана.
// Ширины подобраны так, чтобы ряды закрывались без дыр и на 4, и на 6 колонках
export function Home() {
  // телефон: только нужное — плитки разделов, библиотека, синхронизация, место, устройства, любимые артисты
  if (!isHost)
    return (
      <div className="grid grid-cols-2 gap-3">
        <ScanBanner className="col-span-2" />
        <Sections />
        <RemoteLists />
        <Counter />
        <SyncWidget />
        <Storage />
        <Devices />
        <TopArtists />
        <AppFooter className="col-span-2 pt-3 pb-1" />
      </div>
    )
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 2xl:grid-cols-6">
      <ScanBanner className="col-span-2 lg:col-span-4 2xl:col-span-6" />
      <Clock />
      <Counter />
      {isHost ? <ServerWidget /> : <SyncWidget />}
      {isHost ? <DiskWidget /> : <Storage />}
      <Devices />
      <Liked />
      <Random />
      <TopArtists />
      <VolumeWidget />
      <SleepWidget />
      <Recent />
      <AppFooter className="col-span-2 pt-3 pb-1 lg:col-span-4 2xl:col-span-6" />
    </div>
  )
}

/** Телефон: Альбомы, Артисты и История — плитками на Главной (в нижнем меню их нет) */
function Sections() {
  const { tracks, setView } = usePick('tracks', 'setView')
  const albums = new Set(tracks.map((t) => t.album)).size
  const artists = groupByArtist(tracks).length
  const tiles = [
    { id: 'albums' as const, label: tx('nav.albums'), icon: Disc3, n: albums },
    { id: 'artists' as const, label: tx('nav.artists'), icon: MicVocal, n: artists },
    { id: 'history' as const, label: tx('nav.history'), icon: History, n: undefined },
  ]
  return (
    <div className="col-span-2 grid grid-cols-3 gap-3">
      {tiles.map(({ id, label, icon: Icon, n }) => (
        <button key={id} onClick={() => setView(id)} className="widget flex flex-col items-start gap-3 p-4 text-start active:scale-[.98]">
          <Icon size={20} strokeWidth={1.6} className="text-muted" />
          <span className="mt-auto text-sm font-medium">{label}</span>
          {n !== undefined && <span className="-mt-2 font-mono text-[11px] text-muted">{n}</span>}
        </button>
      ))}
    </div>
  )
}

/**
 * Телефон: плейлисты подключённых сервисов (Яндекс, Spotify, …) — на ПК они в сайдбаре. Нет подключённых — блока нет:
 * подключают сервисы на сервере (в веб-морде)
 */
function RemoteLists() {
  const lists = useRemoteLists()
  const openRemoteList = useStore((s) => s.openRemoteList)
  if (!lists.length) return null
  return (
    <section className="widget col-span-2 flex flex-col gap-1 p-3">
      <div className="px-2 pt-1 pb-1">
        <Head>{tx('nav.integrations')}</Head>
      </div>
      {lists.map((l) => (
        <button
          key={`${l.service}:${l.list}`}
          onClick={() => openRemoteList(l.service, l.list)}
          className="flex items-center gap-3 rounded-2xl px-2 py-2 text-start active:bg-card-2"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-card-2">
            <ServiceLogo s={l.s} size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{l.name}</span>
            <span className="block truncate text-xs text-muted">{tx(l.s.name)}</span>
          </span>
          <span className="font-mono text-[11px] text-muted">
            {l.have}/{l.total}
          </span>
        </button>
      ))}
    </section>
  )
}

/** Часы точечными цифрами; двоеточие мигает красным, снизу секунды точками */
function Clock() {
  const lang = useStore((s) => s.lang)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = now.toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long' })
  return (
    <section className="widget col-span-2 flex flex-col gap-3 p-5">
      <Head right={<span className="font-mono text-[11px] text-muted">{pad(now.getSeconds())}</span>}>{date}</Head>
      <div dir="ltr" className="mt-auto flex items-center pt-2">
        <DotNum className="text-7xl">{pad(now.getHours())}</DotNum>
        <span className="blink mx-3 flex flex-col gap-3">
          <span className="h-2.5 w-2.5 rounded-full bg-red" />
          <span className="h-2.5 w-2.5 rounded-full bg-red" />
        </span>
        <DotNum className="text-7xl">{pad(now.getMinutes())}</DotNum>
      </div>
      <DotLine value={now.getSeconds() / 59} />
    </section>
  )
}

/** Сколько лайков; клик — плейлист «Избранное» */
function Liked() {
  const n = useStore((s) => s.tracks.filter((t) => t.liked).length)
  const openPlaylist = useStore((s) => s.openPlaylist)
  return (
    <button onClick={() => openPlaylist(LIKED_ID)} className="widget flex flex-col p-5 text-start">
      <Head right={<Heart size={15} strokeWidth={1.6} fill="currentColor" className="text-red" />}>{tx('liked.name')}</Head>
      <DotNum className="mt-auto pt-3 text-5xl">{n}</DotNum>
      <div className="mt-1 text-sm text-muted">{tn('w.tracks', n)}</div>
    </button>
  )
}

/** Случайный трек из библиотеки: кубик — другой, клик по треку — играть */
function Random() {
  const { tracks, covers, play, currentId, playing } = usePick('tracks', 'covers', 'play', 'currentId', 'playing')
  const [pick, setPick] = useState(() => Math.random())
  const t = tracks[Math.floor(pick * tracks.length)]
  return (
    <section className="widget flex flex-col gap-3 p-5">
      <Head
        right={
          <button onClick={() => setPick(Math.random())} title={tx('home.another')} className="text-muted transition-transform hover:text-fg active:rotate-90">
            <Dices size={16} strokeWidth={1.6} />
          </button>
        }
      >
        {tx('home.random')}
      </Head>
      {t && (
        <button onClick={() => play(t.id)} className="group mt-auto flex items-center gap-3 text-start">
          <div className="relative shrink-0">
            <Cover seed={t.album} src={trackCover(t, covers)} className="h-12 w-12" rounded="rounded-xl" />
            <span className="absolute inset-0 grid place-items-center rounded-xl bg-black/40 text-white opacity-0 transition-opacity group-hover:opacity-100">
              {currentId === t.id && playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
            </span>
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm">{t.title}</div>
            <div className="truncate text-xs text-muted">{t.artist}</div>
          </div>
        </button>
      )}
    </section>
  )
}

/** Кого больше всего в библиотеке — точечными полосами; клик — треки артиста */
function TopArtists() {
  const tracks = useStore((s) => s.tracks)
  const openScope = useStore((s) => s.openScope)
  const counts = new Map<string, number>()
  for (const [name, list] of groupByArtist(tracks)) counts.set(name, list.length)
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4)
  const max = top[0]?.[1] ?? 1
  return (
    <section className="widget col-span-2 flex flex-col gap-3 p-5">
      <Head>{tx('home.topArtists')}</Head>
      <div className="mt-auto flex flex-col gap-2">
        {top.map(([artist, n]) => (
          <button key={artist} onClick={() => openScope({ type: 'artist', value: artist })} className="group flex items-center gap-3 text-start">
            <span className="w-28 shrink-0 truncate text-sm group-hover:underline sm:w-36">{artist}</span>
            <DotLine className="flex-1" value={n / max} />
            <span className="w-6 shrink-0 text-end font-mono text-[11px] text-muted">{n}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

/** Громкость лесенкой из точек, как индикатор в Nothing OS. Клик по столбику — громкость */
function VolumeWidget() {
  const { volume, setVolume } = usePick('volume', 'setVolume')
  // плотная «лесенка» из точек на всю ширину: 24 столбика, высота растёт к громкому краю; тянешь или жмёшь — громкость
  const COLS = 24
  const ROWS = 6
  const bar = useRef<HTMLDivElement>(null)
  const fromX = (x: number) => {
    const r = bar.current!.getBoundingClientRect()
    setVolume(Math.round(Math.min(1, Math.max(0, (x - r.left) / r.width)) * 100))
  }
  return (
    <section className="widget flex flex-col gap-4 p-5 lg:col-span-2 2xl:col-span-1">
      <Head
        right={
          <button onClick={() => setVolume(volume ? 0 : 70)} title={tx('home.volume')} className="text-muted hover:text-fg">
            {volume ? <Volume2 size={15} strokeWidth={1.6} /> : <VolumeX size={15} strokeWidth={1.6} />}
          </button>
        }
      >
        {tx('home.volume')}
      </Head>
      <div className="mt-auto flex items-baseline gap-1">
        <DotNum className="text-5xl">{volume}</DotNum>
        <span className="font-dot text-lg font-black text-muted">%</span>
      </div>
      <div
        ref={bar}
        dir="ltr"
        role="slider"
        aria-label={tx('home.volume')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={volume}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setVolume(Math.min(100, volume + 5))
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setVolume(Math.max(0, volume - 5))
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          fromX(e.clientX)
        }}
        onPointerMove={(e) => e.buttons && fromX(e.clientX)}
        onWheel={(e) => setVolume(Math.min(100, Math.max(0, volume + (e.deltaY < 0 ? 5 : -5))))}
        className="grid cursor-pointer touch-none items-end gap-x-[3px] py-1 outline-none"
        style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: COLS }, (_, i) => {
          const h = Math.max(1, Math.ceil(((i + 1) / COLS) * ROWS))
          const on = volume > 0 && (i + 0.5) / COLS <= volume / 100
          return (
            <span key={i} className="flex flex-col-reverse items-center gap-[3px]">
              {Array.from({ length: h }, (_, j) => (
                <span key={j} className={cx('aspect-square w-full max-w-1.5 rounded-full transition-colors', on ? 'bg-fg' : 'bg-dot-off')} />
              ))}
            </span>
          )
        })}
      </div>
    </section>
  )
}

/** Таймер сна в один клик; пока идёт — обратный отсчёт */
function SleepWidget() {
  const { sleepAt, sleepEndOfTrack, setSleep } = usePick('sleepAt', 'sleepEndOfTrack', 'setSleep')
  const [, redraw] = useState(0)
  useEffect(() => {
    if (!sleepAt) return
    const id = setInterval(() => redraw((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [sleepAt])
  const active = !!sleepAt || sleepEndOfTrack
  const left = sleepAt ? Math.max(0, (sleepAt - Date.now()) / 1000) : 0
  return (
    <section className="widget flex flex-col gap-3 p-5 lg:col-span-2 2xl:col-span-1">
      <Head right={<Moon size={15} strokeWidth={1.6} fill={active ? 'currentColor' : 'none'} className={active ? 'text-red' : 'text-muted'} />}>
        {tx('sleep.title')}
      </Head>
      {active ? (
        <div className="mt-auto">
          {sleepAt ? <DotNum className="text-4xl">{fmtTime(left)}</DotNum> : <div className="text-lg">{tx('sleep.afterTrack')}</div>}
          <button onClick={() => setSleep(null)} className="mt-2 block text-xs text-red hover:underline">
            {tx('sleep.off')}
          </button>
        </div>
      ) : (
        <div className="mt-auto">
          <div className="mb-2 text-xs text-muted">{tx('home.sleepPick')}</div>
          <div dir="ltr" className="flex gap-1.5">
            {[15, 30, 60].map((m) => (
              <button
                key={m}
                onClick={() => setSleep(m)}
                className="font-dot flex-1 rounded-full bg-card-3 py-1.5 text-center text-sm font-black transition-colors hover:bg-sel hover:text-on-sel"
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

/** Хост: сколько устройств сейчас на связи; клик — страница сервера */
function ServerWidget() {
  const setView = useStore((s) => s.setView)
  const devices = useStore((s) => s.devices)
  const online = devices.filter((d) => d.online).length
  return (
    <button onClick={() => setView('sync')} className="widget flex flex-col p-5 text-start">
      <Head right={<ServerIcon size={15} strokeWidth={1.6} className="text-muted" />}>{tx('nav.server')}</Head>
      <div className="mt-auto pt-3">
        <DotNum className="text-4xl">
          {online}/{devices.length}
        </DotNum>
        <div className="mt-1 text-sm text-muted">{tx('home.online')}</div>
      </div>
    </button>
  )
}

/** Хост: диск сервера — одной полосой, без деления на «устройство» и «хранилище» */
function DiskWidget() {
  const disk = useStore((s) => s.stats?.disk)
  const used = disk ? disk.total - disk.free : 0
  return (
    <section className="widget col-span-2 flex flex-col gap-3 p-5 2xl:col-span-1">
      <Head>{tx('home.disk')}</Head>
      {disk ? (
        <>
          <div className="mt-auto">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="text-sm">{tx('home.used')}</span>
              <span className="font-mono text-[11px] whitespace-nowrap text-muted">
                {fmtSize(used / MB)} / {fmtSize(disk.total / MB)}
              </span>
            </div>
            <DotLine value={used / disk.total} />
          </div>
          <div className="text-xs text-muted">{tx('home.free', { free: fmtSize(disk.free / MB) })}</div>
        </>
      ) : (
        <div className="mt-auto text-sm text-muted">{tx('server.diskUnknown')}</div>
      )}
    </section>
  )
}

function Head({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="label text-muted">{children}</span>
      {right}
    </div>
  )
}

function Counter() {
  const tracks = useStore((s) => s.tracks)
  const openView = useStore((s) => s.setView)
  const albums = new Set(tracks.map((t) => t.album)).size
  const artists = groupByArtist(tracks).length
  return (
    <button onClick={() => openView('library')} className="widget flex flex-col p-5 text-start">
      <Head>{tx('home.library')}</Head>
      <DotNum className="mt-auto pt-3 text-5xl">{tracks.length}</DotNum>
      <div className="mt-1 text-sm text-muted">{tn('w.tracks', tracks.length)}</div>
      <div className="mt-2 flex gap-4 font-mono text-[11px] text-muted">
        <span>{tx('home.albumsShort', { n: albums })}</span>
        <span>{tx('home.artistsShort', { n: artists })}</span>
      </div>
    </button>
  )
}

/**
 * Телефон: связь с сервером на Главной — честно. «OK» только когда синхронизация уже прошла до конца и ничего не ждёт;
 * рядом — сколько треков на телефоне из всей библиотеки (сразу после установки — 0, и это видно)
 */
function SyncWidget() {
  const tracks = useStore((s) => s.tracks)
  const { syncNow, setView, syncInfo, conn, standalone } = usePick('syncNow', 'setView', 'syncInfo', 'conn', 'standalone')
  const active = tracks.filter((t) => t.status === 'uploading' || t.status === 'downloading')
  const onPhone = tracks.filter((t) => isOnDevice(t.status)).length
  const waiting = syncInfo.up + syncInfo.down
  const busy = active.length > 0 || syncInfo.running
  // что показать крупно и что под ним
  const big = standalone ? '—' : busy ? String(active.length || waiting) : waiting ? String(waiting) : syncInfo.at ? 'OK' : '—'
  const line = standalone
    ? tx('solo.noServer')
    : conn !== 'online'
      ? tx('dev.offlineBadge')
      : syncInfo.paused
        ? tx('sync.paused')
        : busy
          ? tn('home.inTransit', active.length || waiting)
          : waiting
            ? tx('sync.waiting')
            : syncInfo.at
              ? tx('home.allSynced')
              : tx('home.notYet')
  return (
    <section className="widget flex flex-col p-5">
      <Head
        right={
          <button onClick={syncNow} title={tx('home.syncNow')} className="text-muted hover:text-fg">
            <RefreshCw size={15} strokeWidth={1.6} className={cx(busy && 'animate-spin')} />
          </button>
        }
      >
        {tx('nav.server')}
      </Head>
      <button onClick={() => setView('sync')} className="mt-auto pt-3 text-start">
        <div className="flex items-center gap-2">
          {(busy || waiting > 0) && !standalone && <span className={cx('h-2 w-2 rounded-full bg-red', busy && 'blink')} />}
          <DotNum className="text-4xl">{big}</DotNum>
        </div>
        <div className="mt-1 text-sm text-muted">{line}</div>
        <div className="mt-0.5 font-mono text-[11px] text-muted">{tx('home.onPhoneOf', { n: onPhone, total: tracks.length })}</div>
      </button>
    </section>
  )
}

function Storage() {
  const tracks = useStore((s) => s.tracks)
  const disk = useStore((s) => s.stats?.disk)
  const device = tracks.filter((t) => isOnDevice(t.status)).reduce((a, t) => a + t.sizeMb, 0)
  const server = tracks.filter((t) => t.status !== 'uploading').reduce((a, t) => a + t.sizeMb, 0)
  const total = disk ? disk.total / MB : server
  const ratio = total ? server / total : 0
  return (
    <section className="widget col-span-2 flex flex-col gap-3 p-5 2xl:col-span-1">
      <Head>{tx('home.space')}</Head>
      <div className="mt-auto">
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-sm">{tx('home.device')}</span>
          <span className="font-mono text-[11px] text-muted">{fmtSize(device)}</span>
        </div>
        <DotLine value={server ? device / server : 0} />
      </div>
      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-sm">{tx('home.storage')}</span>
          <span className="font-mono text-[11px] whitespace-nowrap text-muted">
            {fmtSize(server)} / {fmtSize(total)}
          </span>
        </div>
        <DotLine value={ratio} />
      </div>
    </section>
  )
}

function Devices() {
  const icons = { desktop: Monitor, laptop: Laptop, phone: Smartphone }
  const devices = useStore((s) => s.devices)
  return (
    <section className="widget col-span-2 flex flex-col gap-3 p-5 2xl:col-span-1">
      <Head>{tx('home.devices')}</Head>
      <div className="mt-auto flex flex-col gap-2.5">
        {devices.length === 0 && <p className="text-sm text-muted">{tx('server.noDevices')}</p>}
        {devices.map((d) => {
          const Icon = icons[d.kind]
          return (
            <div key={d.id} className="flex items-center gap-3">
              <Icon size={16} strokeWidth={1.6} className="text-muted" />
              <span className="flex-1 truncate text-sm">
                {d.name}
                {d.current && <span className="text-muted"> · {tx('home.thisShort')}</span>}
              </span>
              <span className={cx('h-1.5 w-1.5 rounded-full', d.online ? (isHost ? 'bg-green' : 'bg-fg') : 'bg-dot-off')} />
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Recent() {
  const tracks = useStore((s) => s.tracks)
  const { play, currentId, playing, covers } = usePick('play', 'currentId', 'playing', 'covers')
  const albums = [...new Map(tracks.map((t) => [t.album, t])).values()].slice(0, 6)
  return (
    <section className="widget col-span-2 flex flex-col gap-4 p-5 lg:col-span-4 2xl:col-span-6">
      <Head>{tx('home.recent')}</Head>
      {/* ровно один ряд: всё, что не влезло по ширине, прячем */}
      <div className="grid auto-rows-[0] grid-cols-[repeat(auto-fill,minmax(110px,1fr))] grid-rows-[auto] gap-x-3 overflow-hidden lg:grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
        {albums.map((t) => (
          <button key={t.album} onClick={() => play(t.id)} className="group min-w-0 text-start">
            <div className="relative">
              <Cover seed={t.album} src={trackCover(t, covers)} size={480} className="aspect-square w-full" />
              <span className="absolute right-2 bottom-2 grid h-8 w-8 place-items-center rounded-full bg-sel text-on-sel opacity-0 transition-opacity group-hover:opacity-100">
                {currentId === t.id && playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
              </span>
            </div>
            <div className="mt-2 truncate text-sm">{t.album}</div>
            <div className="truncate text-xs text-muted">{t.artist}</div>
          </button>
        ))}
      </div>
    </section>
  )
}
