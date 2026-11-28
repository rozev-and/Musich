import { CalendarDays, CalendarPlus, CaseSensitive, Disc3, GripVertical, ListMusic, MicVocal, Search } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  gridClass,
  SearchBox,
  SortPicker,
  tableClass,
  useSaved,
  ViewPicker,
  type SortOption,
  type SortState,
  type ViewState,
} from '../components/CollectionControls'
import { CornerEdit } from '../components/CoverEditor'
import { groupByArtist } from '../lib/artists'
import { albumCover, albumEdit, artistEdit, artistImage } from '../lib/covers'
import { getLang, t as tx, tn } from '../i18n'
import { isOnDevice } from '../lib/format'
import { usePick, useStore } from '../store'
import type { Track } from '../types'
import { Cover, cx, DotBar } from '../components/ui'
import { isHost } from '../mode'
import { PageTitle, STICKY_BAR } from './Library'
import { MinePlaylists } from './Playlists'

/** Карточка альбома или артиста — одна на все три вида */
interface Item {
  key: string
  title: string
  sub: string
  tracks: Track[]
  seconds: number
  seed: string
  image?: string
  artist: boolean // артист (а не альбом): у него в подписи уже число треков
  local: number // сколько треков на этом устройстве (телефон)
  open: () => void
  edit: () => void
}

// Длинный список рисуем порциями: следующие появляются, когда долистали до конца
const PAGE = 120

const minutes = (sec: number) => tx('common.minutes', { n: Math.round(sec / 60) })
// у артиста число треков уже в подписи — справа только минуты
const meta = (i: Item) => (i.artist ? minutes(i.seconds) : `${tn('n.tracks', i.tracks.length)} · ${minutes(i.seconds)}`)
const textCmp = () => new Intl.Collator(getLang(), { sensitivity: 'base', numeric: true }).compare

/**
 * Что было на странице, когда с неё ушли (открыли альбом или артиста): прокрутка, сколько карточек подгружено, поиск.
 * Живёт, пока открыта вкладка браузера, — вернулся назад и оказался там же
 */
const memory = new Map<string, { scroll: number; limit: number; query: string }>()
const remembered = (key: string) => memory.get(key) ?? { scroll: 0, limit: PAGE, query: '' }
const scroller = () => document.querySelector('main')

/** Сетка, список или таблица (строки списка в 2–4 колонки) */
function ItemsView({ items, view, memoryKey }: { items: Item[]; view: ViewState; memoryKey: string }) {
  const [limit, setLimit] = useState(() => remembered(memoryKey).limit)
  const end = useRef<HTMLDivElement>(null)
  const round = view.shape === 'round'

  // новый поиск, порядок или вид — снова с первой порции (но не при возвращении на страницу)
  const prev = useRef({ n: items.length, mode: view.mode })
  useEffect(() => {
    if (prev.current.n === items.length && prev.current.mode === view.mode) return
    prev.current = { n: items.length, mode: view.mode }
    setLimit(PAGE)
  }, [items.length, view.mode])

  // вернулись — прокручиваем туда, где были, до первой отрисовки; уходим — запоминаем
  const limitRef = useRef(limit)
  limitRef.current = limit
  useLayoutEffect(() => {
    const main = scroller()
    if (main) main.scrollTop = remembered(memoryKey).scroll
    return () => {
      memory.set(memoryKey, { ...remembered(memoryKey), scroll: scroller()?.scrollTop ?? 0, limit: limitRef.current })
    }
  }, [memoryKey])
  useEffect(() => {
    const el = end.current
    if (!el || limit >= items.length) return
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setLimit((l) => l + PAGE), { rootMargin: '800px' })
    io.observe(el)
    return () => io.disconnect()
  }, [limit, items.length])

  if (!items.length) return <div className="widget py-16 text-center text-sm text-muted">{tx('col.nothing')}</div>
  const shown = items.slice(0, limit)

  return (
    <>
      {view.mode === 'grid' && (
        <div className={cx('grid', view.size === 1 ? 'gap-2' : 'gap-3', gridClass(view.size))}>
          {shown.map((i) => (
            <GridCard key={i.key} item={i} small={view.size === 1} round={round} size={view.size} />
          ))}
        </div>
      )}
      {view.mode === 'list' && (
        <div className="widget p-2">
          {shown.map((i) => (
            <Row key={i.key} item={i} round={round} />
          ))}
        </div>
      )}
      {view.mode === 'table' && (
        <div className={cx('grid gap-2', tableClass(view.cols))}>
          {shown.map((i) => (
            <div key={i.key} className="widget p-1">
              <Row item={i} compact round={round} />
            </div>
          ))}
        </div>
      )}
      <div ref={end} />
    </>
  )
}

// карточка перерисовывается, только если поменялось то, что на ней видно
const sameItem = (a: Item, b: Item) =>
  a.key === b.key && a.title === b.title && a.sub === b.sub && a.image === b.image && a.local === b.local && a.tracks.length === b.tracks.length
const GridCard = memo(GridCardView, (a, b) => sameItem(a.item, b.item) && a.small === b.small && a.round === b.round && a.size === b.size)
const Row = memo(RowView, (a, b) => sameItem(a.item, b.item) && a.compact === b.compact && a.round === b.round)

function GridCardView({ item: i, small, round, size }: { item: Item; small: boolean; round: boolean; size: ViewState['size'] }) {
  const local = i.local
  return (
    <button
      onClick={i.open}
      className={cx('card-lazy widget group text-start', round ? 'flex flex-col items-center text-center' : '', small ? 'p-2' : round ? 'p-5' : 'p-3')}
    >
      <div className="relative w-full">
        <Cover
          seed={i.seed}
          src={i.image}
          size={size === 1 ? 160 : size === 2 ? 320 : 480}
          className={cx('aspect-square w-full transition-transform', round ? 'group-hover:scale-[.97]' : 'group-hover:scale-[.98]')}
          rounded={round ? 'rounded-full' : small ? 'rounded-xl' : 'rounded-[calc(20px*var(--rk,1))]'}
        />
        <CornerEdit onEdit={i.edit} />
      </div>
      <div className={cx('w-full', small ? 'px-0.5 pt-2' : round ? 'pt-4' : 'px-1 pt-3 pb-1')}>
        <div className={cx('truncate', small ? 'text-xs' : 'text-[15px]')}>{i.title}</div>
        <div className={cx('truncate text-muted', small ? 'text-[10px]' : 'text-xs')}>{i.sub}</div>
        {/* сколько треков альбома на этом устройстве — только у устройства */}
        {!isHost && !i.artist && !small && (
          <div className="mt-3 flex items-center gap-2">
            <DotBar className="flex-1" dots={Math.min(20, i.tracks.length)} size={4} value={local / i.tracks.length} />
            <span className="font-mono text-[10px] text-muted">
              {local}/{i.tracks.length}
            </span>
          </div>
        )}
      </div>
    </button>
  )
}

/** Строка списка и таблицы: обложка, название, подпись, справа — треков и минут */
function RowView({ item: i, compact, round }: { item: Item; compact?: boolean; round: boolean }) {
  return (
    <button onClick={i.open} className="row-lazy group flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-start transition-colors hover:bg-card-2">
      <Cover seed={i.seed} src={i.image} className={compact ? 'h-11 w-11' : 'h-12 w-12'} rounded={round ? 'rounded-full' : 'rounded-xl'} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px]">{i.title}</div>
        <div className="truncate text-xs text-muted">{compact && !i.artist ? `${i.sub} · ${tn('n.tracks', i.tracks.length)}` : i.sub}</div>
      </div>
      {!compact && <span className="hidden shrink-0 font-mono text-xs text-muted sm:block">{meta(i)}</span>}
    </button>
  )
}

/** Строка над списком: поиск, порядок, вид. tabs — вкладки в той же строке сразу после поиска */
function Controls<K extends string>(p: {
  tabs?: ReactNode
  query: string
  setQuery: (q: string) => void
  placeholder: string
  sorts: SortOption<K>[]
  sort: SortState<K>
  setSort: (s: SortState<K>) => void
  view: ViewState
  setView: (v: ViewState) => void
  gridOnly?: boolean
}) {
  return (
    <div className={cx(STICKY_BAR, 'mb-2 flex items-center gap-2 p-2 md:gap-3')}>
      {/* телефон: поиск — кнопкой с лупой (открывает общий поиск), на ПК — поле на всё свободное место */}
      <SearchIcon />
      {/* поле поиска — с sm; на телефоне вместо него лупа */}
      <div className="hidden min-w-0 flex-1 sm:flex">
        <SearchBox value={p.query} onChange={p.setQuery} placeholder={p.placeholder} />
      </div>
      {p.tabs}
      <div className="ms-auto flex items-center gap-2">
        <SortPicker options={p.sorts} sort={p.sort} onChange={p.setSort} />
        <ViewPicker view={p.view} onChange={p.setView} gridOnly={p.gridOnly} />
      </div>
    </div>
  )
}

/** Телефон: поиск круглой кнопкой с лупой — место в панели остаётся вкладкам, порядку и виду */
function SearchIcon() {
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  return (
    <button
      onClick={() => setSearchOpen(true)}
      title={tx('lib.search')}
      aria-label={tx('lib.search')}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-ink/20 text-ink-muted sm:hidden"
    >
      <Search size={18} strokeWidth={1.8} />
    </button>
  )
}

// ---------- альбомы ----------

type AlbumSort = 'title' | 'artist' | 'tracks' | 'year' | 'added'
const ALBUM_SORTS: SortOption<AlbumSort>[] = [
  { id: 'title', label: 'sort.title', icon: CaseSensitive, desc: false },
  { id: 'artist', label: 'sort.artist', icon: MicVocal, desc: false },
  { id: 'tracks', label: 'sort.tracks', icon: ListMusic, desc: true },
  { id: 'year', label: 'sort.year', icon: CalendarDays, desc: true },
  { id: 'added', label: 'sort.added', icon: CalendarPlus, desc: true },
]

export function Albums() {
  const tracks = useStore((s) => s.tracks)
  const playlists = useStore((s) => s.playlists)
  const { albumsTab, setAlbumsTab } = usePick('albumsTab', 'setAlbumsTab')
  const albumCount = new Set(tracks.map((t) => t.album)).size

  const mineCount = playlists.length + 1 // +1 — «Избранное»
  const tabs = [
    { id: 'albums' as const, label: tx('nav.albums') },
    { id: 'mine' as const, label: tx('col.mine') },
  ]

  // компактный переключатель — помещается в одну строку с поиском, порядком и видом
  const tabsRow = (
    <div className="flex shrink-0 rounded-full bg-card-3 p-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setAlbumsTab(t.id)}
          className={cx(
            'rounded-full px-3 py-2 text-sm transition-colors sm:px-4 sm:py-1.5 sm:text-xs',
            albumsTab === t.id ? 'bg-sel-page text-on-sel-page' : 'text-ink-muted hover:text-ink',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )

  return (
    <div>
      {/* количество — под заголовком, как у артистов */}
      <PageTitle sub={albumsTab === 'albums' ? tn('n.albums', albumCount) : tn('n.playlists', mineCount)}>{tx('nav.albums')}</PageTitle>
      {/* вкладки — в одной строке с поиском, порядком и видом; у «Моих» — то же самое */}
      {albumsTab === 'albums' ? <TagAlbums tabs={tabsRow} /> : <MineWithControls tabs={tabsRow} />}
    </div>
  )
}

type MineSort = 'manual' | 'title' | 'tracks' | 'updated'
const MINE_SORTS: SortOption<MineSort>[] = [
  { id: 'manual', label: 'sort.manual', icon: GripVertical, desc: false },
  { id: 'title', label: 'sort.title', icon: CaseSensitive, desc: false },
  { id: 'tracks', label: 'sort.tracks', icon: ListMusic, desc: true },
  { id: 'updated', label: 'sort.updated', icon: CalendarPlus, desc: true },
]

/** «Мои» плейлисты: поиск по названию, порядок (свой — с перетаскиванием, по названию, по числу треков, по изменению) и размер сетки */
function MineWithControls({ tabs }: { tabs: ReactNode }) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useSaved<SortState<MineSort>>('tunich-mine-sort', { key: 'manual', desc: false })
  const [view, setView] = useSaved<ViewState>('tunich-mine-view', { mode: 'grid', size: 2, cols: 3, shape: 'square' })
  return (
    <>
      <Controls
        tabs={tabs}
        query={query}
        setQuery={setQuery}
        placeholder={tx('col.searchPlaylists')}
        sorts={MINE_SORTS}
        sort={sort}
        setSort={setSort}
        view={view}
        setView={setView}
        gridOnly
      />
      <MinePlaylists query={query} sort={sort.key} desc={sort.desc} size={view.size} />
    </>
  )
}

function TagAlbums({ tabs }: { tabs: ReactNode }) {
  const { tracks, openScope, covers, openCoverEdit } = usePick('tracks', 'openScope', 'covers', 'openCoverEdit')
  const [query, setQueryState] = useState(() => remembered('albums').query)
  const setQuery = (q: string) => {
    setQueryState(q)
    memory.set('albums', { ...remembered('albums'), query: q })
  }
  const [sort, setSort] = useSaved<SortState<AlbumSort>>('tunich-albums-sort', { key: 'title', desc: false })
  const [view, setView] = useSaved<ViewState>('tunich-albums-view', { mode: 'grid', size: 2, cols: 3, shape: 'square' })

  // альбом = треки с одинаковым тегом альбома; артист — самый частый у его треков, год и «добавлен» — самые свежие.
  // Считаем только когда меняются треки, картинки, поиск или порядок — не на каждую перерисовку
  const items = useMemo((): Item[] => {
  const groups = new Map<string, Track[]>()
  for (const t of tracks) {
    const g = groups.get(t.album)
    if (g) g.push(t)
    else groups.set(t.album, [t])
  }
  const albums = [...groups].map(([name, list]) => {
    const artists = new Map<string, number>()
    for (const t of list) artists.set(t.artist, (artists.get(t.artist) ?? 0) + 1)
    const artist = [...artists].sort((a, b) => b[1] - a[1])[0][0]
    const year = Math.max(0, ...list.map((t) => t.year ?? 0)) || undefined
    const added = list.reduce((a, t) => (t.addedAt > a ? t.addedAt : a), '')
    return { name, list, artist, year, added, seconds: list.reduce((a, t) => a + t.duration, 0) }
  })

  const q = query.trim().toLowerCase()
  const cmp = textCmp()
  const by: Record<AlbumSort, (a: (typeof albums)[number], b: (typeof albums)[number]) => number> = {
    title: (a, b) => cmp(a.name, b.name),
    artist: (a, b) => cmp(a.artist, b.artist) || cmp(a.name, b.name),
    tracks: (a, b) => a.list.length - b.list.length,
    year: (a, b) => (a.year ?? 0) - (b.year ?? 0) || cmp(a.name, b.name),
    added: (a, b) => a.added.localeCompare(b.added),
  }
  return albums
    .filter((a) => !q || `${a.name} ${a.artist}`.toLowerCase().includes(q))
    .sort((a, b) => (sort.desc ? -1 : 1) * by[sort.key](a, b))
    .map((a) => ({
      key: a.name,
      title: a.name,
      sub: a.year ? `${a.artist} · ${a.year}` : a.artist,
      tracks: a.list,
      seconds: a.seconds,
      seed: a.name,
      image: albumCover(a.name, a.list, covers),
      artist: false,
      local: isHost ? 0 : a.list.filter((t) => isOnDevice(t.status)).length,
      open: () => openScope({ type: 'album', value: a.name }),
      edit: () => openCoverEdit(albumEdit(a.name, a.list)),
    }))
  }, [tracks, covers, query, sort.key, sort.desc, openScope, openCoverEdit])

  return (
    <>
      <Controls tabs={tabs} query={query} setQuery={setQuery} placeholder={tx('col.searchAlbums')} sorts={ALBUM_SORTS} sort={sort} setSort={setSort} view={view} setView={setView} />
      <ItemsView items={items} view={view} memoryKey="albums" />
      <p className="label mt-4 text-ink-muted">{tx(isHost ? 'col.albumsHintHost' : 'col.albumsHint')}</p>
    </>
  )
}

// ---------- артисты ----------

type ArtistSort = 'title' | 'tracks' | 'albums' | 'added'
const ARTIST_SORTS: SortOption<ArtistSort>[] = [
  { id: 'title', label: 'sort.name', icon: CaseSensitive, desc: false },
  { id: 'tracks', label: 'sort.tracks', icon: ListMusic, desc: true },
  { id: 'albums', label: 'sort.albums', icon: Disc3, desc: true },
  { id: 'added', label: 'sort.added', icon: CalendarPlus, desc: true },
]

export function Artists() {
  const { tracks, openScope, covers, openCoverEdit } = usePick('tracks', 'openScope', 'covers', 'openCoverEdit')
  const [query, setQueryState] = useState(() => remembered('artists').query)
  const setQuery = (q: string) => {
    setQueryState(q)
    memory.set('artists', { ...remembered('artists'), query: q })
  }
  const [sort, setSort] = useSaved<SortState<ArtistSort>>('tunich-artists-sort', { key: 'title', desc: false })
  const [view, setView] = useSaved<ViewState>('tunich-artists-view', { mode: 'grid', size: 2, cols: 3, shape: 'round' })

  // «Kordhell, Ravens Rock» — два артиста: трек есть у каждого. Считаем только при изменениях (useMemo)
  const items = useMemo((): Item[] => {
  const artists = groupByArtist(tracks).map(([name, list]) => ({
    name,
    list,
    albums: new Set(list.map((t) => t.album)).size,
    added: list.reduce((a, t) => (t.addedAt > a ? t.addedAt : a), ''),
    seconds: list.reduce((a, t) => a + t.duration, 0),
  }))

  const q = query.trim().toLowerCase()
  const cmp = textCmp()
  const by: Record<ArtistSort, (a: (typeof artists)[number], b: (typeof artists)[number]) => number> = {
    title: (a, b) => cmp(a.name, b.name),
    tracks: (a, b) => a.list.length - b.list.length || cmp(a.name, b.name),
    albums: (a, b) => a.albums - b.albums || cmp(a.name, b.name),
    added: (a, b) => a.added.localeCompare(b.added),
  }
  return artists
    .filter((a) => !q || a.name.toLowerCase().includes(q))
    .sort((a, b) => (sort.desc ? -1 : 1) * by[sort.key](a, b))
    .map((a) => ({
      key: a.name,
      title: a.name,
      sub: `${tn('n.tracks', a.list.length)} · ${tn('n.albums', a.albums)}`,
      tracks: a.list,
      seconds: a.seconds,
      seed: a.name + '#a',
      image: artistImage(a.name, a.list, covers),
      artist: true,
      local: 0,
      open: () => openScope({ type: 'artist', value: a.name }),
      edit: () => openCoverEdit(artistEdit(a.name, a.list)),
    }))
  }, [tracks, covers, query, sort.key, sort.desc, openScope, openCoverEdit])

  return (
    <div>
      <PageTitle sub={tn('n.artists', items.length)}>{tx('nav.artists')}</PageTitle>
      <Controls query={query} setQuery={setQuery} placeholder={tx('col.searchArtists')} sorts={ARTIST_SORTS} sort={sort} setSort={setSort} view={view} setView={setView} />
      <ItemsView items={items} view={view} memoryKey="artists" />
    </div>
  )
}
