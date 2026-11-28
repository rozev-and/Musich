import { ArrowLeft, CalendarPlus, FileInput, HardDriveDownload, Heart, History as HistoryIcon, ListMusic, Play, Plus, Settings2, Sparkles, Trash, X } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { getLang, t as tx, tn } from '../i18n'
import { isOnDevice } from '../lib/format'
import { DRAG_TRACKS, usePick, useStore, withLiked } from '../store'
import type { Playlist } from '../types'
import { Cover, cx, DotLine, IconBtn } from '../components/ui'
import { SelectionBar, TrackRow } from '../components/TrackRow'
import { EditableCover } from '../components/CoverEditor'
import { isHost } from '../mode'
import { ScopeSettings } from '../components/ScopeSettings'
import { SharePlaylistButton, SharedWithMe } from '../components/SharedPlaylists'
import { HeaderTitle } from './Library'
import { gridClass, type ViewState } from '../components/CollectionControls'

/** Импорт .m3u: ищем записи в библиотеке и открываем «Новый плейлист» с найденным и именем файла */
function ImportTile() {
  const input = useRef<HTMLInputElement>(null)
  const pick = async (file: File) => {
    const { matchM3u } = await import('../lib/m3u')
    const s = useStore.getState()
    const { ids, total } = matchM3u(await file.text(), s.tracks)
    if (!ids.length) return s.toast(tx('imp.none', { total }), 'error')
    s.toast(tx('imp.found', { n: ids.length, total }))
    s.openPlaylistEditor({ mode: 'create', addIds: ids, name: file.name.replace(/\.m3u8?$/i, '') })
  }
  return (
    <button
      onClick={() => input.current?.click()}
      title={tx('imp.m3uHint')}
      className="flex items-center gap-1.5 rounded-full border border-ink/20 px-4 py-2 text-sm text-ink transition-colors hover:border-ink/50"
    >
      <FileInput size={15} /> {tx('imp.m3u')}
      <input
        ref={input}
        type="file"
        accept=".m3u,.m3u8,audio/x-mpegurl,audio/mpegurl"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void pick(f)
          e.target.value = ''
        }}
      />
    </button>
  )
}

/** Обложка умного плейлиста: значок правила на плашке цвета акцента */
function SmartCover({ id, className, rounded }: { id: string; className?: string; rounded?: string }) {
  const Icon = id.endsWith('recent') ? CalendarPlus : id.endsWith('year') ? Sparkles : HistoryIcon
  return (
    <div className={cx('grid shrink-0 place-items-center bg-red/15 text-red', rounded, className)}>
      <Icon className="h-[40%] w-[40%]" strokeWidth={1.4} />
    </div>
  )
}

export function PlaylistCover({ p, className, rounded = 'rounded-2xl' }: { p: Playlist; className?: string; rounded?: string }) {
  if (p.smart) return <SmartCover id={p.id} className={className} rounded={rounded} />
  if (p.system) return <HeartCover className={className} rounded={rounded} />
  if (p.coverUrl) return <img src={p.coverUrl} alt="" className={cx('shrink-0 object-cover', rounded, className)} />
  return <Cover seed={p.name + '#p'} className={className} rounded={rounded} />
}

// Обложка «Избранного»: красное сердце на тёмном
function HeartCover({ className, rounded }: { className?: string; rounded?: string }) {
  return (
    <div className={cx('grid shrink-0 place-items-center bg-card-2', rounded, className)}>
      <Heart className="h-[46%] w-[46%] text-red" fill="currentColor" strokeWidth={1.5} />
    </div>
  )
}

/** Куда можно бросить перетаскиваемые треки */
export function useTrackDrop(pid: string) {
  const addToPlaylist = useStore((s) => s.addToPlaylist)
  const [over, setOver] = useState(false)
  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_TRACKS)
  return {
    over,
    handlers: {
      onDragOver: (e: DragEvent) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        setOver(false)
        if (!accepts(e)) return
        e.preventDefault()
        addToPlaylist(pid, JSON.parse(e.dataTransfer.getData(DRAG_TRACKS)))
      },
    },
  }
}

const DRAG_PLAYLIST = 'application/x-musich-playlist'

/**
 * Плейлист как цель перетаскивания: на него бросают треки (добавить) и другие плейлисты (поменять порядок).
 * axis — где «до» и «после»: в столбике сайдбара это выше/ниже, в сетке — левее/правее.
 * «Избранное» стоит первым всегда: его не тащат, и перед ним не встают.
 */
export function usePlaylistDrop(p: Playlist, axis: 'x' | 'y') {
  const tracks = useTrackDrop(p.id)
  const movePlaylist = useStore((s) => s.movePlaylist)
  const [side, setSide] = useState<'before' | 'after' | null>(null)
  const sideOf = (e: DragEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    const after = axis === 'y' ? e.clientY > r.top + r.height / 2 : (e.clientX > r.left + r.width / 2) !== (document.dir === 'rtl')
    return p.system || after ? 'after' : 'before'
  }
  const isPlaylist = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_PLAYLIST)
  return {
    over: tracks.over,
    side,
    handlers: {
      draggable: !p.system,
      onDragStart: (e: DragEvent) => {
        if (p.system) return
        e.dataTransfer.setData(DRAG_PLAYLIST, p.id)
        e.dataTransfer.effectAllowed = 'move'
      },
      onDragOver: (e: DragEvent) => {
        if (!isPlaylist(e)) return tracks.handlers.onDragOver(e)
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setSide(sideOf(e))
      },
      onDragLeave: () => {
        setSide(null)
        tracks.handlers.onDragLeave()
      },
      onDrop: (e: DragEvent) => {
        if (!isPlaylist(e)) return tracks.handlers.onDrop(e)
        e.preventDefault()
        setSide(null)
        const own = useStore.getState().playlists
        const from = own.findIndex((x) => x.id === e.dataTransfer.getData(DRAG_PLAYLIST))
        if (from < 0) return
        // на «Избранное» — значит в самое начало своих
        let to = p.system ? 0 : own.findIndex((x) => x.id === p.id) + (sideOf(e) === 'after' ? 1 : 0)
        if (from < to) to -= 1
        if (from !== to) movePlaylist(from, to)
      },
    },
  }
}

export function MinePlaylists({
  query = '',
  sort = 'manual',
  desc = false,
  size = 2,
}: {
  query?: string
  sort?: 'manual' | 'title' | 'tracks' | 'updated'
  desc?: boolean
  size?: ViewState['size']
}) {
  const { tracks, playlists, likedOffline, openPlaylistEditor, plays } = usePick('tracks', 'playlists', 'likedOffline', 'openPlaylistEditor', 'plays')
  const [liked, ...all] = withLiked(tracks, playlists, likedOffline, plays)
  const q = query.trim().toLowerCase()
  const cmp = (a: Playlist, b: Playlist) =>
    sort === 'title' ? a.name.localeCompare(b.name) : sort === 'tracks' ? a.trackIds.length - b.trackIds.length : sort === 'updated' ? a.updatedAt.localeCompare(b.updatedAt) : 0
  const hit = (p: Playlist) => !q || p.name.toLowerCase().includes(q)
  // сверху — системные: «Избранное» и умные (собираются сами); ниже — свои
  const system = [liked, ...all.filter((p) => p.smart)].filter(hit)
  const own = all.filter((p) => !p.smart && hit(p))
  if (sort !== 'manual') own.sort((a, b) => (desc ? -cmp(a, b) : cmp(a, b)))
  const grid = cx('grid', size === 1 ? 'gap-2' : 'gap-3', gridClass(size))

  return (
    <>
      {system.length > 0 && (
        <div className={grid}>
          {system.map((p) => (
            <PlaylistCard key={p.id} p={p} />
          ))}
        </div>
      )}
      {/* свои плейлисты: заголовок, справа — «Новый плейлист» и «Импорт .m3u» */}
      <div className="mt-8 mb-3 flex flex-wrap items-center gap-2">
        <span className="label flex-1 text-ink-muted">{tx('pl.mineHint')}</span>
        <button
          onClick={() => openPlaylistEditor({ mode: 'create', addIds: [] })}
          className="flex items-center gap-1.5 rounded-full bg-sel-page px-4 py-2 text-sm text-on-sel-page transition-transform active:scale-95"
        >
          <Plus size={15} /> {tx('nav.newPlaylist')}
        </button>
        <ImportTile />
      </div>
      {own.length > 0 ? (
        <div className={grid}>
          {own.map((p) => (
            <PlaylistCard key={p.id} p={p} />
          ))}
        </div>
      ) : (
        <p className="py-6 text-center text-sm text-ink-muted">{q ? tx('col.nothing') : tx('pl.noOwn')}</p>
      )}
      <SharedWithMe />
    </>
  )
}

function PlaylistCard({ p }: { p: Playlist }) {
  const tracks = useStore((s) => s.tracks)
  const openPlaylist = useStore((s) => s.openPlaylist)
  const { over, side, handlers } = usePlaylistDrop(p, 'x')
  const list = tracks.filter((t) => p.trackIds.includes(t.id))
  const local = list.filter((t) => isOnDevice(t.status)).length

  return (
    <button
      {...handlers}
      onClick={() => openPlaylist(p.id)}
      className={cx('widget group relative p-3 text-start transition-shadow', over && 'ring-2 ring-red')}
    >
      {/* куда встанет перетаскиваемый плейлист */}
      {side && <span className={cx('absolute inset-y-4 w-1 rounded-full bg-red', side === 'before' ? '-start-2' : '-end-2')} />}
      <div className="relative">
        <PlaylistCover p={p} className="aspect-square w-full transition-transform group-hover:scale-[.98]" rounded="rounded-[calc(20px*var(--rk,1))]" />
        {!isHost && p.keepOffline && (
          <span title={tx('pl.keptOffline')} className="absolute top-2 end-2 grid h-7 w-7 place-items-center rounded-full bg-sel text-on-sel">
            <HardDriveDownload size={14} />
          </span>
        )}
      </div>
      <div className="px-1 pt-3 pb-1">
        <div className="truncate text-[15px]">{p.name}</div>
        <div className="truncate text-xs text-muted">
          {tn('n.tracks', list.length)}
          {p.description && ` · ${p.description}`}
        </div>
        {/* сколько треков плейлиста лежит на этом устройстве — только у устройства */}
        {!isHost && (
          <div className="mt-3 flex items-center gap-2">
            <DotLine className="flex-1" size={4} value={list.length ? local / list.length : 0} />
            <span className="font-mono text-[10px] text-muted">
              {local}/{list.length}
            </span>
          </div>
        )}
      </div>
    </button>
  )
}

export function PlaylistPage() {
  const s = usePick(
    'tracks', 'playlists', 'playlistId', 'likedOffline', 'setView', 'setAlbumsTab', 'openPlaylistEditor', 'play',
    'askDeletePlaylist', 'setKeepOffline', 'movePlaylistTrack', 'removeFromPlaylist', 'plays', 'loadPlays',
  )
  const p = withLiked(s.tracks, s.playlists, s.likedOffline, s.plays).find((x) => x.id === s.playlistId)
  // «Давно не слушал» считается по истории — подгружаем её, если ещё не брали
  const needPlays = !!p?.smart && s.plays === null
  useEffect(() => {
    if (needPlays) void s.loadPlays()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needPlays])
  const [gear, setGear] = useState(false)

  if (!p) {
    return <div className="py-20 text-center text-sm text-ink-muted">{tx('pl.notFound')}</div>
  }

  // Треки в порядке плейлиста
  const list = p.trackIds.map((id) => s.tracks.find((t) => t.id === id)).filter((t) => !!t)
  const ids = list.map((t) => t.id)
  const total = list.reduce((a, t) => a + t.duration, 0)

  return (
    <div>
      <button
        onClick={() => {
          s.setView('albums')
          s.setAlbumsTab('mine')
        }}
        className="label mb-4 inline-flex items-center gap-2 rounded-full bg-card-3 py-2.5 ps-3.5 pe-4 text-[13px] text-ink transition-colors hover:bg-sel hover:text-on-sel"
      >
        <ArrowLeft size={18} className="rtl:rotate-180" /> {tx('col.mine')}
      </button>

      <HeaderTitle text={p.system ? tx('pl.system') : tx('pl.playlist')} />
      {gear && <ScopeSettings kind="playlist" value={p.id} onClose={() => setGear(false)} />}
      <div className="widget relative mb-4 flex flex-col gap-5 p-5 md:flex-row md:items-center">
        <IconBtn title={tx('scope.settings')} onClick={() => setGear(true)} className="absolute top-3 end-3 h-9 w-9 text-muted">
          <Settings2 size={18} strokeWidth={1.6} />
        </IconBtn>
        <div className="flex min-w-0 flex-1 items-center gap-5">
          {p.system ? (
            <PlaylistCover p={p} className="h-24 w-24 md:h-32 md:w-32" rounded="rounded-3xl" />
          ) : (
            <EditableCover onEdit={() => s.openPlaylistEditor({ mode: 'edit', id: p.id })}>
              <PlaylistCover p={p} className="h-24 w-24 md:h-32 md:w-32" rounded="rounded-3xl" />
            </EditableCover>
          )}
          <div className="min-w-0">
            <div className="truncate pe-8 text-2xl font-medium md:text-3xl">{p.name}</div>
            {p.description && <div className="truncate text-sm text-muted">{p.description}</div>}
            <div className="mt-1 font-mono text-[11px] text-muted">
              {tn('n.tracks', list.length)} · {tx('common.minutes', { n: Math.round(total / 60) })}
              {!p.system && ` · ${tx('pl.updated', { date: new Date(p.updatedAt).toLocaleDateString(getLang()) })}`}
            </div>
            <div className="mt-3 flex items-center gap-1">
              <button
                disabled={!list.length}
                onClick={() => s.play(ids[0], ids, p.name)}
                className="mr-2 flex items-center gap-2 rounded-full bg-sel px-5 py-2 text-sm text-on-sel disabled:opacity-40"
              >
                <Play size={14} fill="currentColor" /> {tx('pl.listen')}
              </button>
              {!p.system && <SharePlaylistButton pid={p.id} />}
              {!p.system && (
                <IconBtn title={tx('pl.delete')} onClick={() => s.askDeletePlaylist(p.id)}>
                  <Trash size={16} strokeWidth={1.6} />
                </IconBtn>
              )}
            </div>
          </div>
        </div>


      </div>

      <SelectionBar />

      <div className="widget overflow-hidden p-2">
        {list.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <ListMusic size={28} strokeWidth={1.4} className="text-muted" />
            <span className="max-w-xs text-sm text-muted">
              {p.smart
                ? tx('smart.empty')
                : p.system
                ? tx('pl.emptyLiked')
                : tx('pl.empty')}
            </span>
            <button onClick={() => s.setView('library')} className="rounded-full bg-sel px-5 py-2.5 text-sm text-on-sel">
              {tx('pl.toTracks')}
            </button>
          </div>
        ) : (
          list.map((t, i) => (
            <TrackRow
              key={t.id}
              t={t}
              i={i}
              queue={ids}
              source={p.name}
              // в «Избранном» порядок — по времени лайка, двигать нечего
              reorder={p.system ? undefined : (from, to) => s.movePlaylistTrack(p.id, p.trackIds.indexOf(list[from].id), p.trackIds.indexOf(list[to].id))}
              extra={
                p.smart ? undefined : (
                  <IconBtn title={p.system ? tx('pl.unlike') : tx('pl.remove')} onClick={() => s.removeFromPlaylist(p.id, t.id)}>
                    <X size={16} strokeWidth={1.6} />
                  </IconBtn>
                )
              }
            />
          ))
        )}
      </div>
      {list.length > 1 && (
        <p className="label mt-3 text-ink-muted">
          {p.system ? tx('pl.likedOrder') : tx('pl.dragOrder')}
        </p>
      )}
    </div>
  )
}
