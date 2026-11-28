import {
  ArrowDownWideNarrow,
  ArrowLeft,
  Radio,
  ArrowUpNarrowWide,
  CalendarPlus,
  CaseSensitive,
  Check,
  ChevronDown,
  FilterX,
  Disc3,
  HardDrive,
  MicVocal,
  Search,
  Settings2,
  SlidersHorizontal,
  Timer,
  Upload,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { createPortal } from 'react-dom'
import { getLang, t as tx, tn, type Key } from '../i18n'
import { hasArtist } from '../lib/artists'
import { isOnDevice } from '../lib/format'
import { usePick, useStore } from '../store'
import type { Filter, Sort, SortKey, Track } from '../types'
import type { TracksView } from '../lib/api'
import { Cover, cx, IconBtn } from '../components/ui'
import { DotText } from '../components/DotText'
import { SelectionBar, TrackRow } from '../components/TrackRow'
import { useDropdown } from '../components/CollectionControls'
import { Modal } from '../components/Dialogs'
import { EditableCover } from '../components/CoverEditor'
import { ScanBanner } from '../components/ScanBanner'
import { ScopeSettings } from '../components/ScopeSettings'
import { isHost } from '../mode'
import { albumCover, albumEdit, artistEdit, artistImage } from '../lib/covers'

// хост: всё или только лайкнутое; устройство — ещё и где лежит трек
const filters: { id: Filter; label: Key }[] = isHost
  ? [
      { id: 'all', label: 'lib.all' },
      { id: 'liked', label: 'liked.name' },
    ]
  : [
      { id: 'all', label: 'lib.all' },
      { id: 'liked', label: 'liked.name' },
      { id: 'device', label: 'lib.device' },
      { id: 'cloud', label: 'lib.cloud' },
      { id: 'syncing', label: 'lib.syncing' },
    ]

const byFilter: Record<Filter, (t: Track) => boolean> = {
  all: () => true,
  liked: (t) => !!t.liked,
  device: (t) => isOnDevice(t.status),
  cloud: (t) => t.status === 'cloud',
  syncing: (t) => t.status === 'uploading' || t.status === 'downloading',
}

const SORTS: SortKey[] = ['number', 'added', 'title', 'artist', 'album', 'duration', 'size']

// По умолчанию: номер и текст — по возрастанию, новые сверху, длительность и размер — большие сверху
const DEFAULT_DESC: Record<SortKey, boolean> = { number: false, added: true, title: false, artist: false, album: false, duration: true, size: true }


function compare(key: SortKey): (a: Track, b: Track) => number {
  const text = new Intl.Collator(getLang(), { sensitivity: 'base', numeric: true })
  // ничья (одна дата добавления у всей пачки, одна длительность) — дальше по номеру, названию и id: иначе ПК и телефон
  // раскладывают равные треки каждый по-своему (у них разный порядок списка до сортировки)
  const tie = (a: Track, b: Track) => (a.trackNo ?? 0) - (b.trackNo ?? 0) || text.compare(a.title, b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const main = byKey(key, text)
  return (a, b) => main(a, b) || tie(a, b)
}

function byKey(key: SortKey, text: Intl.Collator): (a: Track, b: Track) => number {
  switch (key) {
    case 'number':
      return (a, b) => (a.trackNo ?? 0) - (b.trackNo ?? 0) || text.compare(a.title, b.title)
    case 'added':
      return (a, b) => a.addedAt.localeCompare(b.addedAt)
    case 'title':
      return (a, b) => text.compare(a.title, b.title)
    case 'artist':
      // внутри артиста — по альбому и названию, чтобы альбомы не перемешивались
      return (a, b) => text.compare(a.artist, b.artist) || text.compare(a.album, b.album) || text.compare(a.title, b.title)
    case 'album':
      return (a, b) => text.compare(a.album, b.album) || text.compare(a.title, b.title)
    case 'duration':
      return (a, b) => a.duration - b.duration
    case 'size':
      return (a, b) => a.sizeMb - b.sizeMb
  }
}

// подсказку «переставлять — в порядке Номер» показываем один раз за заход
let dragHinted = false

// Выбранный порядок помним в браузере — это настройка вида, а не данные
const SORT_KEY = 'tunich-sort'
const loadSort = (): Sort => {
  try {
    const s = JSON.parse(localStorage.getItem(SORT_KEY) ?? 'null') as Sort | null
    if (s && SORTS.includes(s.key)) return s
  } catch {
    /* нет хранилища — по умолчанию */
  }
  return { key: 'added', desc: true }
}

/** «5», «1, 5, 9», «10-20» → проверка номера трека; null, если это не список номеров */
function numberSet(s: string): ((n: number | undefined) => boolean) | null {
  const parts = s.split(/[\s,;]+/).filter(Boolean)
  if (!parts.length || !parts.every((p) => /^\d+(?:[-–]\d+)?$/.test(p))) return null
  const ranges = parts.map((p) => {
    const [a, b = a] = p.split(/[-–]/).map(Number)
    return [Math.min(a, b), Math.max(a, b)]
  })
  return (n) => n != null && ranges.some(([a, b]) => n >= a && n <= b)
}

/**
 * Поиск.
 * «№12», «#12», «#1, 5, 9», «#10-20» — только по номеру трека из тегов («№» в проводнике).
 * «id: 7a13, 20f8» — по служебному ID (начало хэша файла).
 * Обычный запрос ищет в названии/артисте/альбоме; если это просто число — ещё и по номеру трека.
 */
export function matcher(q: string): (t: Track) => boolean {
  if (!q) return () => true
  const byNo = q.match(/^(?:#|№|no:)\s*(.*)$/)
  if (byNo) {
    const ok = numberSet(byNo[1])
    return ok ? (t) => ok(t.trackNo) : () => !byNo[1].trim()
  }
  const byId = q.match(/^id:\s*(.*)$/)
  if (byId) {
    const parts = byId[1].split(/[\s,;]+/).filter(Boolean)
    return (t) => parts.length === 0 || parts.some((p) => t.id.startsWith(p))
  }
  const num = /^\d+$/.test(q) ? Number(q) : null
  return (t) => (num != null && t.trackNo === num) || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)
}

type IconLike = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>

/** «№» вместо «#»: номер трека — это номер, а не хэштег */
const NumeroIcon: IconLike = ({ size = 14, className }) => (
  <span className={cx('grid place-items-center leading-none font-medium', className)} style={{ width: size, height: size, fontSize: size * 0.92 }}>
    №
  </span>
)

const SORT_ICON: Record<SortKey, IconLike> = {
  number: NumeroIcon,
  added: CalendarPlus,
  title: CaseSensitive,
  artist: MicVocal,
  album: Disc3,
  duration: Timer,
  size: HardDrive,
}

/**
 * Порядок треков: своя выпадашка вместо <select> — список у <select> рисует браузер, его не стилизовать.
 * Меню шириной во весь фильтр, у пунктов иконки; направление — отдельной кнопкой справа.
 */
function SortMenu({ sort, setSort }: { sort: Sort; setSort: (s: Sort) => void }) {
  const { open, setOpen, box } = useDropdown()
  const Icon = SORT_ICON[sort.key]

  return (
    // relative — чтобы меню встало ровно под фильтром и было той же ширины
    // на телефоне порядок — в общем окне «Фильтры и порядок» (FiltersMenu)
    <div ref={box} className="hidden shrink-0 items-center rounded-full border border-fg/20 sm:relative sm:flex sm:min-w-[13.5rem]">
      <button
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={tx('sort.label')}
        className="flex min-w-0 flex-1 items-center gap-2 py-2.5 ps-4 pe-1 text-xs text-fg"
      >
        <Icon size={14} strokeWidth={1.8} className="shrink-0 text-muted" />
        <span className="hidden flex-1 truncate text-start sm:block">{tx(`sort.${sort.key}`)}</span>
        <ChevronDown size={14} className={cx('hidden shrink-0 text-muted transition-transform sm:block', open && 'rotate-180')} />
      </button>
      <button
        onClick={() => setSort({ ...sort, desc: !sort.desc })}
        title={sort.desc ? tx('sort.desc') : tx('sort.asc')}
        aria-label={sort.desc ? tx('sort.desc') : tx('sort.asc')}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted hover:text-fg"
      >
        {sort.desc ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={tx('sort.label')}
          className="widget absolute end-0 top-full z-30 mt-2 flex w-52 flex-col gap-0.5 rounded-[calc(22px*var(--rk,1))] p-1.5 shadow-2xl ring-1 ring-line sm:start-0 sm:w-auto"
        >
          <SortOptions sort={sort} setSort={setSort} done={() => setOpen(false)} />
        </div>
      )}

    </div>
  )
}

/** Направление порядка двумя половинками — в окне на телефоне (маленькая кнопка со стрелкой там неудобна) */
function SortDirection({ sort, setSort }: { sort: Sort; setSort: (s: Sort) => void }) {
  return (
    <div className="flex rounded-full bg-card-3 p-1">
      {([false, true] as const).map((desc) => (
        <button
          key={String(desc)}
          onClick={() => setSort({ ...sort, desc })}
          className={cx('flex flex-1 items-center justify-center gap-2 rounded-full px-3 py-2 text-sm transition-colors', sort.desc === desc ? 'bg-sel text-on-sel' : 'text-muted')}
        >
          {desc ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
          {tx(desc ? 'sort.desc' : 'sort.asc')}
        </button>
      ))}
    </div>
  )
}

/** Варианты порядка: тот же список в выпадашке на ПК и в окне на телефоне. done — закрыть выпадашку */
function SortOptions({ sort, setSort, done, big }: { sort: Sort; setSort: (s: Sort) => void; done?: () => void; big?: boolean }) {
  return (
    <>
      {SORTS.map((k) => {
        const ItemIcon = SORT_ICON[k]
        const active = k === sort.key
        return (
          <button
            key={k}
            role="option"
            aria-selected={active}
            onClick={() => {
              setSort({ key: k, desc: active ? sort.desc : DEFAULT_DESC[k] })
              done?.()
            }}
            className={cx(
              'flex items-center gap-2.5 rounded-full px-3 text-start transition-colors',
              big ? 'py-3 text-[15px]' : 'py-2 text-sm',
              active ? 'bg-sel text-on-sel' : 'text-muted hover:bg-card-2 hover:text-fg',
            )}
          >
            <ItemIcon size={big ? 17 : 15} strokeWidth={1.8} className="shrink-0" />
            <span className="flex-1 truncate">{tx(`sort.${k}`)}</span>
            {active && <Check size={14} className="shrink-0" />}
          </button>
        )
      })}
    </>
  )
}

// Год: null — все годы, 'none' — треки без года в тегах
type YearFilter = number | 'none' | null
const YEAR_KEY = 'tunich-year'
const loadYear = (): YearFilter => {
  try {
    const v = localStorage.getItem(YEAR_KEY)
    return v === 'none' ? 'none' : v ? Number(v) || null : null
  } catch {
    return null
  }
}
const byYear = (y: YearFilter) => (t: Track) => y === null || (y === 'none' ? !t.year : t.year === y)

// Состояние файла: в нём поменяли теги или обложку; изменён только в MUSICH (правки поверх тегов); нетронут.
// Номер «№» MUSICH пишет в файлы сам (перенумерация) — это правкой не считаем
type FileState = 'all' | 'changed' | 'edited' | 'untouched'
const FILE_KEY = 'tunich-lib-file'
const loadFileState = (): FileState => {
  try {
    const v = localStorage.getItem(FILE_KEY)
    return v === 'changed' || v === 'edited' || v === 'untouched' ? v : 'all'
  } catch {
    return 'all'
  }
}
// «Изменены теги» — меняли теги или обложку (перенумерация не в счёт)
const realChange = (t: Track) => !!t.fileChanged && !!t.fileChanges?.some((c) => c !== 'number')
const byFileState = (f: FileState) => (t: Track) =>
  f === 'all' || (f === 'changed' ? realChange(t) : f === 'edited' ? !!t.edited : !realChange(t) && !t.edited)

/** Кнопка-чип в окошке фильтров: выбранный — залит, рядом сколько треков */
function Chip({ on, onClick, children, n }: { on: boolean; onClick: () => void; children: React.ReactNode; n?: number }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-2 text-xs transition-colors',
        on ? 'border-sel bg-sel text-on-sel' : 'border-fg/20 text-muted hover:border-fg/50 hover:text-fg',
      )}
    >
      {children}
      {n !== undefined && <span className={cx('font-mono text-[10px]', on ? 'text-on-sel/70' : 'text-muted')}>{n}</span>}
    </button>
  )
}

/**
 * Все фильтры одной кнопкой: «Показать» (все, понравившиеся, а на телефоне — где лежит трек), год выпуска,
 * состояние файла. На кнопке — сколько фильтров включено; «Сбросить» — вернуть всё
 */
function FiltersMenu(p: {
  tracks: Track[]
  filter: Filter
  setFilter: (f: Filter) => void
  year: YearFilter
  setYear: (y: YearFilter) => void
  file: FileState
  setFile: (f: FileState) => void
  sort: Sort
  setSort: (s: Sort) => void
}) {
  const { open, setOpen, box } = useDropdown()
  // телефон: окно поверх всего (выпадашка там тесная и уезжает за край); своё состояние — у выпадашки закрытие
  // по нажатию мимо, а окно рисуется вне неё и закрывалось бы от любого касания
  const narrow = useNarrow()
  const [sheet, setSheet] = useState(false)
  const active = Number(p.filter !== 'all') + Number(p.year !== null) + Number(p.file !== 'all')

  return (
    // на телефоне окошко встаёт от правого края всей полосы (а не кнопки) — иначе уезжало за левый край экрана
    <div ref={box} className="shrink-0 sm:relative">
      <button
        onClick={() => (narrow ? setSheet(true) : setOpen(!open))}
        aria-haspopup="dialog"
        aria-expanded={open || sheet}
        className={cx(
          'flex items-center gap-2 rounded-full border py-2.5 ps-4 pe-3 text-xs transition-colors',
          active ? 'border-sel bg-sel text-on-sel' : 'border-fg/20 text-fg hover:border-fg/50',
        )}
      >
        <SlidersHorizontal size={14} strokeWidth={1.8} className={cx('shrink-0', !active && 'text-muted')} />
        <span className="hidden sm:inline">{tx('lib.filters')}</span>
        {active > 0 && <span className="grid h-4 min-w-4 place-items-center rounded-full bg-on-sel px-1 font-mono text-[10px] text-sel">{active}</span>}
        <ChevronDown size={14} className={cx('hidden shrink-0 transition-transform sm:block', !active && 'text-muted', open && 'rotate-180')} />
      </button>

      {open && !narrow && (
        <div
          role="dialog"
          aria-label={tx('lib.filters')}
          className="widget absolute end-0 top-full z-30 mt-2 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-4 rounded-[calc(22px*var(--rk,1))] p-4 shadow-2xl ring-1 ring-line"
        >
          <FiltersBody {...p} active={active} />
        </div>
      )}

      {sheet && (
        <Modal onClose={() => setSheet(false)}>
          <div className="mb-4 flex items-center gap-3">
            <IconBtn title={tx('common.back')} onClick={() => setSheet(false)} className="-ms-1 h-11 w-11 shrink-0 bg-card-3">
              <ArrowLeft size={20} className="rtl:rotate-180" />
            </IconBtn>
            <div className="text-lg font-medium">{tx('lib.filtersSort')}</div>
          </div>
          {/* одно окно на телефоне: сверху порядок, ниже фильтры, год — в самом низу */}
          <div className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto">
            <div>
              <div className="label mb-2 text-muted">{tx('sort.label')}</div>
              <div role="listbox" aria-label={tx('sort.label')} className="mb-3 flex flex-col gap-1">
                <SortOptions sort={p.sort} setSort={p.setSort} big />
              </div>
              <SortDirection sort={p.sort} setSort={p.setSort} />
            </div>
            <FiltersBody {...p} active={active} tall />
          </div>
          <button onClick={() => setSheet(false)} className="mt-5 w-full rounded-full bg-sel py-3 text-sm text-on-sel">
            {tx('common.done')}
          </button>
        </Modal>
      )}
    </div>
  )
}

/** Узкий экран (телефон): там фильтры — окном */
function useNarrow() {
  const q = '(max-width: 639px)'
  const [narrow, setNarrow] = useState(() => matchMedia(q).matches)
  useEffect(() => {
    const m = matchMedia(q)
    const update = () => setNarrow(m.matches)
    m.addEventListener('change', update)
    return () => m.removeEventListener('change', update)
  }, [])
  return narrow
}

/** Сами фильтры: одно и то же в выпадашке на ПК и в окне на телефоне */
function FiltersBody(p: Parameters<typeof FiltersMenu>[0] & { active: number; tall?: boolean }) {
  const counts = new Map<number, number>()
  let noYear = 0
  for (const t of p.tracks) {
    if (t.year) counts.set(t.year, (counts.get(t.year) ?? 0) + 1)
    else noYear++
  }
  const years = [...counts.keys()].sort((a, b) => b - a)
  const files: { value: FileState; label: Key }[] = [
    { value: 'all', label: 'lib.fileAll' },
    { value: 'changed', label: 'lib.fileChanged' },
    { value: 'edited', label: 'lib.fileEdited' },
    { value: 'untouched', label: 'lib.fileUntouched' },
  ]
  const section = 'label mb-2 text-muted'
  return (
    <>
      <div>
        <div className={section}>{tx('lib.show')}</div>
        <div className="flex flex-wrap gap-1.5">
          {filters.map((x) => (
            <Chip key={x.id} on={p.filter === x.id} onClick={() => p.setFilter(x.id)} n={p.tracks.filter(byFilter[x.id]).length}>
              {tx(x.label)}
            </Chip>
          ))}
        </div>
      </div>
      <div>
        <div className={section}>{tx('lib.file')}</div>
        <div className="flex flex-wrap gap-1.5">
          {files.map((x) => (
            <Chip key={x.value} on={p.file === x.value} onClick={() => p.setFile(x.value)} n={p.tracks.filter(byFileState(x.value)).length}>
              {tx(x.label)}
            </Chip>
          ))}
        </div>
      </div>
      <div>
        <div className={section}>{tx('lib.year')}</div>
        <div className={cx('flex flex-wrap gap-1.5 overflow-y-auto', p.tall ? 'max-h-52' : 'max-h-32')}>
          <Chip on={p.year === null} onClick={() => p.setYear(null)} n={p.tracks.length}>
            {tx('lib.allYears')}
          </Chip>
          {years.map((y) => (
            <Chip key={y} on={p.year === y} onClick={() => p.setYear(y)} n={counts.get(y)}>
              {y}
            </Chip>
          ))}
          {noYear > 0 && (
            <Chip on={p.year === 'none'} onClick={() => p.setYear('none')} n={noYear}>
              {tx('lib.noYear')}
            </Chip>
          )}
        </div>
      </div>
      {p.active > 0 && (
        <button
          onClick={() => {
            p.setFilter('all')
            p.setYear(null)
            p.setFile('all')
          }}
          className="flex items-center gap-2 self-start text-xs text-muted hover:text-fg"
        >
          <FilterX size={14} /> {tx('lib.resetFilters')}
        </button>
      )}
    </>
  )
}

/** Телефон: вместо поля поиска — кнопка, похожая на поле: занимает всё свободное место и открывает окно поиска */
export function SearchButton() {
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  return (
    <button
      onClick={() => setSearchOpen(true)}
      className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full border border-fg/20 px-3.5 text-sm text-muted sm:hidden"
    >
      <Search size={16} strokeWidth={1.8} className="shrink-0" />
      <span className="truncate">{tx('lib.search')}</span>
    </button>
  )
}

/** Полоса поиска и фильтров: прилипает к верху прокрутки; это блок темы — её цвет, прозрачность и скругление */
export const STICKY_BAR = 'widget sticky top-0 z-20 rounded-[calc(28px*var(--rk,1))] p-1.5'

// Длинный список рисуем порциями: строки добавляются, когда долистали до конца
const PAGE = 150

/** Что это за страница — «Альбом», «Артист», «Плейлист»: на телефоне — в шапке, на широком экране — строкой сверху */
export function HeaderTitle({ text }: { text: string }) {
  const slot = useHeaderSlot()
  if (slot) return createPortal(<h1 className="truncate text-2xl font-extralight tracking-tight"><DotText text={text} size={26} trimTop /></h1>, slot)
  return <div className="label mb-2 text-ink-muted">{text}</div>
}

/** Место в шапке телефона под название страницы (#page-title в App); на широком экране — null */
function useHeaderSlot() {
  const [el, setEl] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const m = matchMedia('(max-width: 767px)')
    const update = () => setEl(m.matches ? document.getElementById('page-title') : null)
    update()
    m.addEventListener('change', update)
    return () => m.removeEventListener('change', update)
  }, [])
  return el
}

export function PageTitle({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  // телефон: заголовок — в шапке, она не прокручивается; на странице — только подпись
  const slot = useHeaderSlot()
  return (
    <div className={slot ? 'mb-3' : 'mb-5'}>
      {slot &&
        createPortal(
          <h1 className="truncate text-2xl font-extralight tracking-tight">{typeof children === 'string' ? <DotText text={children} size={26} trimTop /> : children}</h1>,
          slot,
        )}
      {/* заголовок страницы — из точек, как логотип; не строка (редко) — обычным текстом */}
      {!slot && (
        <h1 className="text-4xl font-extralight tracking-tight md:text-5xl">
          {typeof children === 'string' ? <DotText text={children} size={44} trimTop /> : children}
        </h1>
      )}
      {sub && <div className={cx('text-sm text-ink-muted', !slot && 'mt-1')}>{sub}</div>}
    </div>
  )
}

export function Library() {
  const { tracks, filter, setFilter, query, setQuery, scope, openScope, setView, setUploadOpen, covers, openCoverEdit, renumbering, moveTrackNumber, playlists, ui, toast, prefs, saveTracksView } = usePick('tracks', 'filter', 'setFilter', 'query', 'setQuery', 'scope', 'openScope', 'setView', 'setUploadOpen', 'covers', 'openCoverEdit', 'openArtistRename', 'renumbering', 'moveTrackNumber', 'playlists', 'ui', 'toast', 'prefs', 'saveTracksView')
  const libLoading = useStore((s) => s.libLoading)

  const [gear, setGear] = useState(false)
  const [sort, setSortState] = useState(loadSort)
  const setSort = (s: Sort) => {
    setSortState(s)
    syncView({ sort: s.key, desc: s.desc })
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(s))
    } catch {
      /* не запомним — не страшно */
    }
  }

  const [year, setYearState] = useState(loadYear)
  const setYear = (y: YearFilter) => {
    setYearState(y)
    syncView({ year: y })
    try {
      if (y === null) localStorage.removeItem(YEAR_KEY)
      else localStorage.setItem(YEAR_KEY, String(y))
    } catch {
      /* не запомним — не страшно */
    }
  }

  // Вид «Треков» общий для всех устройств аккаунта: меняют здесь — уходит в аккаунт, пришёл из аккаунта — встаёт здесь.
  // Своё (localStorage) — запасной вариант без сервера
  // Самый свежий вид — в ref: «Сбросить фильтры» меняет три поля подряд, и раньше каждое сохранение несло старые
  // значения остальных (последнее возвращало старый год). Сохраняем одним разом, через полсекунды после последней правки
  const view = useRef<TracksView>({ sort: sort.key, desc: sort.desc, filter, year, file: loadFileState() })
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncView = (patch: Partial<TracksView>) => {
    view.current = { ...view.current, ...patch }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => saveTracksView(view.current), 400)
  }
  const setFilterSynced = (f: Filter) => {
    setFilter(f)
    syncView({ filter: f })
  }
  const shared = prefs.tracksView
  useEffect(() => {
    if (!shared) return
    view.current = shared
    setSortState({ key: shared.sort, desc: shared.desc })
    setYearState(shared.year || null) // 0 — «все годы» (старая ошибка сервера)
    setFileStateRaw(shared.file)
    if (!scope) setFilter(shared.filter)
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify({ key: shared.sort, desc: shared.desc }))
      if (!shared.year) localStorage.removeItem(YEAR_KEY)
      else localStorage.setItem(YEAR_KEY, String(shared.year))
      localStorage.setItem(FILE_KEY, shared.file)
    } catch {
      /* не запомним — не страшно */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared?.sort, shared?.desc, shared?.filter, shared?.year, shared?.file])

  const [fileState, setFileStateRaw] = useState(loadFileState)
  const setFileState = (f: FileState) => {
    setFileStateRaw(f)
    syncView({ file: f })
    try {
      localStorage.setItem(FILE_KEY, f)
    } catch {
      /* не запомним — не страшно */
    }
  }

  const q = query.trim().toLowerCase()
  const match = matcher(q)
  // все треки альбома/артиста — для картинки, без учёта фильтров и поиска
  // общий список без скрытых альбомов, артистов и плейлистов (шестерёнка → «Не показывать в Треках»)
  const hiddenIds = new Set(playlists.filter((p) => ui.hidden.playlist.includes(p.id)).flatMap((p) => p.trackIds))
  const hiddenAlbums = new Set(ui.hidden.album)
  const visible = (t: Track) => !hiddenIds.has(t.id) && !hiddenAlbums.has(t.album) && !ui.hidden.artist.some((a) => hasArtist(t, a))
  const scoped = tracks.filter((t) => (scope ? (scope.type === 'album' ? t.album === scope.value : hasArtist(t, scope.value)) : visible(t)))
  // список — заново, только когда поменялось то, из чего он строится: строки (TrackRow) сверяют список, очередь и
  // перетаскивание по ссылке и без нужды не перерисовываются
  const list = useMemo(() => {
    const cmp = compare(sort.key)
    return scoped
      .filter(byFilter[filter] ?? byFilter.all)
      .filter(byYear(year))
      .filter(byFileState(fileState))
      .filter(match)
      // треков без номера (сервер ещё не успел его записать) — в конце при любом направлении
      .sort((a, b) => (sort.key === 'number' ? Number(a.trackNo == null) - Number(b.trackNo == null) : 0) || (sort.desc ? -cmp(a, b) : cmp(a, b)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, playlists, ui.hidden, scope, filter, year, fileState, q, sort])

  // сколько строк сейчас нарисовано; новый поиск/фильтр/порядок — снова с первой порции
  const [limit, setLimit] = useState(PAGE)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => setLimit(PAGE), [q, filter, sort, scope, year, fileState])
  useEffect(() => {
    const el = end.current
    if (!el || limit >= list.length) return
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setLimit((l) => l + PAGE), { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [limit, list.length])

  const total = list.reduce((a, t) => a + t.duration, 0)
  // Играем то и в том порядке, что на экране: альбом/артист, сортировка, фильтр, поиск
  // тот же порядок — тот же массив: иначе прогресс загрузки одного трека перерисовывал бы все строки списка
  const queueRef = useRef<string[]>([])
  const queue = useMemo(() => {
    const ids = list.map((t) => t.id)
    const prev = queueRef.current
    if (ids.length === prev.length && ids.every((id, i) => id === prev[i])) return prev
    return (queueRef.current = ids)
  }, [list])

  // Перетаскивание — только в порядке «Номер»: трек встаёт на номер соседа, номер пишется в файл.
  // Поднял выше — берёт номер трека, который теперь под ним; опустил ниже — номер того, что над ним
  const byNumber = sort.key === 'number'
  const dragHint = () => {
    if (dragHinted) return
    dragHinted = true
    toast(tx('lib.dragNeedsNumber'))
  }
  const reorder = useMemo(
    () =>
      byNumber && !renumbering
        ? (from: number, to: number) => {
            const rest = list.filter((_, i) => i !== from)
            // у соседа может не быть номера — берём ближайший с номером в ту же сторону
            const near = to < from ? rest.slice(to) : rest.slice(0, to).reverse()
            const target = near.find((x) => x.trackNo != null)
            if (target?.trackNo != null) void moveTrackNumber(list[from].id, target.trackNo)
          }
        : undefined,
    [byNumber, renumbering, list, moveTrackNumber],
  )

  return (
    <div>
      {scope && (
        <button
          onClick={() => {
            openScope(null)
            setView(scope.type === 'album' ? 'albums' : 'artists')
          }}
          className="label mb-4 inline-flex items-center gap-2 rounded-full bg-card-3 py-2.5 ps-3.5 pe-4 text-[13px] text-ink transition-colors hover:bg-sel hover:text-on-sel"
        >
          <ArrowLeft size={18} className="rtl:rotate-180" /> {scope.type === 'album' ? tx('nav.albums') : tx('nav.artists')}
        </button>
      )}

      {scope && <HeaderTitle text={scope.type === 'album' ? tx('lib.album') : tx('lib.artist')} />}
      {scope && gear && <ScopeSettings kind={scope.type} value={scope.value} onClose={() => setGear(false)} />}
      {scope ? (
        <div className="widget relative mb-4 flex items-center gap-5 p-5">
          <IconBtn title={tx('scope.settings')} onClick={() => setGear(true)} className="absolute top-3 end-3 h-9 w-9 text-muted">
            <Settings2 size={18} strokeWidth={1.6} />
          </IconBtn>
          <EditableCover
            rounded={scope.type === 'artist' ? 'rounded-full' : 'rounded-3xl'}
            onEdit={() => openCoverEdit(scope.type === 'album' ? albumEdit(scope.value, scoped) : artistEdit(scope.value, scoped))}
          >
            <Cover
              seed={scope.type === 'album' ? scope.value : scope.value + '#a'}
              src={scope.type === 'album' ? albumCover(scope.value, scoped, covers) : artistImage(scope.value, scoped, covers)}
              size={320}
              className="h-24 w-24 md:h-32 md:w-32"
              rounded={scope.type === 'artist' ? 'rounded-full' : 'rounded-3xl'}
            />
          </EditableCover>
          <div className="min-w-0">
            <div className="truncate pe-8 text-2xl font-medium md:text-3xl">{scope.value}</div>
            <div className="mt-1 text-sm text-muted">
              {/* у артиста и альбома — все его треки, а не только то, что прошло фильтры */}
              {tn('n.tracks', scoped.length)} · {tx('common.minutes', { n: Math.round(scoped.reduce((a, t) => a + t.duration, 0) / 60) })}
            </div>
            {/* у артиста — радио: его треки и похожее из твоей библиотеки */}
            {scope.type === 'artist' && (
              <button
                onClick={() => void useStore.getState().startRadio({ artist: scope.value })}
                className="mt-3 flex items-center gap-2 rounded-full bg-sel px-4 py-2 text-sm text-on-sel transition-transform active:scale-95"
              >
                <Radio size={15} /> {tx('radio.byArtist')}
              </button>
            )}
          </div>
        </div>
      ) : (
        <PageTitle sub={`${tn('n.tracks', list.length)} · ${tx('common.minutes', { n: Math.round(total / 60) })}`}>
          {tx('lib.title')}
        </PageTitle>
      )}

      {/* поиск и фильтры прилипают к верху при прокрутке */}
      <div className={cx(STICKY_BAR, 'mb-2 flex items-center gap-2 md:gap-3')}>
        <SearchButton />
        <label className="widget hidden min-w-0 flex-1 items-center gap-3 rounded-full px-4 py-2.5 sm:flex sm:px-5 sm:py-3">
          <Search size={16} strokeWidth={1.6} className="text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tx('lib.search')}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
          />
        </label>
        {/* фильтры — одной кнопкой с окошком, рядом сортировка */}
        <div className="flex items-center gap-2">
          <FiltersMenu tracks={scoped} filter={filter} setFilter={setFilterSynced} year={year} setYear={setYear} file={fileState} setFile={setFileState} sort={sort} setSort={setSort} />
          <SortMenu sort={sort} setSort={setSort} />
        </div>
      </div>

      <ScanBanner className="mb-4" />

      {renumbering && <div className="mb-3 px-2 text-xs text-ink-muted">{tx('lib.renumbering')}</div>}

      <SelectionBar />

      {/* строки треков — прямо на странице, во всю ширину; на телефоне — до самых краёв экрана.
          Тянут строку не в порядке «Номер» — переставить нельзя (перенос меняет номер трека), только бросить в плейлист: подсказываем */}
      <div className="-mx-4 sm:mx-0" onDragStart={() => !byNumber && dragHint()}>
        {list.length === 0 && scoped.length > 0 ? (
          // треки есть, но их спрятали фильтр, год или поиск — говорим об этом и даём вернуть всё
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="text-sm text-muted">{tx('lib.filteredOut', { n: scoped.length })}</span>
            <button
              onClick={() => {
                setYear(null)
                setFileState('all')
                setFilterSynced('all')
                setQuery('')
              }}
              className="flex items-center gap-2 rounded-full bg-sel px-5 py-2.5 text-sm text-on-sel"
            >
              <FilterX size={15} /> {tx('lib.resetFilters')}
            </button>
          </div>
        ) : list.length === 0 && libLoading ? (
          // открыли страницу — библиотека ещё идёт с сервера: не «пусто», а загрузка
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-sel border-t-transparent" />
            <span className="text-sm text-muted">{tx('lib.loading')}</span>
          </div>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="text-sm text-muted">{tx('lib.empty')}</span>
            <button onClick={() => setUploadOpen(true)} className="flex items-center gap-2 rounded-full bg-sel px-5 py-2.5 text-sm text-on-sel">
              <Upload size={15} /> {tx('nav.addMusic')}
            </button>
          </div>
        ) : (
          list.slice(0, limit).map((t, i) => <TrackRow key={t.id} t={t} i={i} reorder={reorder} no={t.trackNo != null ? String(t.trackNo).padStart(2, '0') : '—'} queue={queue} source={scope ? scope.value : ''} />)
        )}
        {limit < list.length && <div ref={end} className="h-px" />}
      </div>
    </div>
  )
}
