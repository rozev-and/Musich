import { ArrowDownWideNarrow, ArrowLeft, ArrowUpNarrowWide, Check, ChevronDown, Columns3, LayoutGrid, List, Search, X } from 'lucide-react'
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { t as tx, type Key } from '../i18n'
import { Modal } from './Dialogs'
import { cx, IconBtn } from './ui'

/**
 * Строка над списками «Альбомов» и «Артистов»: поиск, сортировка, вид.
 * Выпадашки — в стиле сортировки на «Треках»; выбор вида и порядка помним в браузере (у каждой страницы свой)
 */

export type IconLike = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>

/** Выпадашка: открыта/закрыта, закрывается кликом мимо и Escape */
export function useDropdown() {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  return { open, setOpen, box }
}

/** Значение, которое помним в localStorage (вид, порядок) */
export function useSaved<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback
    } catch {
      return fallback
    }
  })
  const save = (v: T) => {
    setValue(v)
    try {
      localStorage.setItem(key, JSON.stringify(v))
    } catch {
      /* не запомним — не страшно */
    }
  }
  return [value, save]
}

export function SearchBox({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string }) {
  return (
    <label className={cx('widget flex min-w-0 flex-1 items-center gap-3 rounded-full px-4 py-2.5 sm:px-5 sm:py-3', className)}>
      <Search size={16} strokeWidth={1.6} className="shrink-0 text-muted" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted"
      />
      {value && (
        <button onClick={() => onChange('')} title={tx('common.clear')} className="shrink-0 text-muted hover:text-fg">
          <X size={15} />
        </button>
      )}
    </label>
  )
}

// ---------- сортировка ----------

export type SortState<K extends string> = { key: K; desc: boolean }
export interface SortOption<K extends string> {
  id: K
  label: Key
  icon: IconLike
  desc: boolean // направление по умолчанию: новые/большие сверху или по алфавиту
}

/** Узкий экран (телефон): порядок и вид открываются окном, а не выпадашкой — она там тесная и уезжает за край */
export function useNarrow() {
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

/** Окно на телефоне: стрелка «назад» и название сверху, «Готово» снизу — как «Фильтры и порядок» на «Треках» */
function PhoneSheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal onClose={onClose}>
      <div className="mb-4 flex items-center gap-3">
        <IconBtn title={tx('common.back')} onClick={onClose} className="-ms-1 h-11 w-11 shrink-0 bg-card-3">
          <ArrowLeft size={20} className="rtl:rotate-180" />
        </IconBtn>
        <div className="text-lg font-medium">{title}</div>
      </div>
      <div className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto">{children}</div>
      <button onClick={onClose} className="mt-5 w-full rounded-full bg-sel py-3 text-sm text-on-sel">
        {tx('common.done')}
      </button>
    </Modal>
  )
}

// кнопки панели: на телефоне высотой 44px (крупнее, по пальцу), на ПК как были
const barBtn = 'flex h-11 items-center gap-2 rounded-full border border-ink/20 px-4 text-sm text-ink transition-colors hover:border-ink/50 sm:h-auto sm:py-2.5 sm:ps-4 sm:pe-3 sm:text-xs'

/** Список вариантов порядка: в выпадашке на ПК и крупнее в окне на телефоне */
function SortList<K extends string>({ options, sort, onChange, big, done }: { options: SortOption<K>[]; sort: SortState<K>; onChange: (s: SortState<K>) => void; big?: boolean; done?: () => void }) {
  return (
    <>
      {options.map((o) => {
        const active = o.id === sort.key
        const ItemIcon = o.icon
        return (
          <button
            key={o.id}
            role="option"
            aria-selected={active}
            onClick={() => {
              onChange({ key: o.id, desc: active ? sort.desc : o.desc })
              done?.()
            }}
            className={cx(
              'flex items-center gap-2.5 rounded-full px-3 text-start transition-colors',
              big ? 'py-3 text-[15px]' : 'py-2 text-sm',
              active ? 'bg-sel text-on-sel' : 'text-muted hover:bg-card-2 hover:text-fg',
            )}
          >
            <ItemIcon size={big ? 17 : 15} strokeWidth={1.8} className="shrink-0" />
            <span className="flex-1 truncate">{tx(o.label)}</span>
            {active && <Check size={14} className="shrink-0" />}
          </button>
        )
      })}
    </>
  )
}

/** Порядок: на ПК — поле списком и направление отдельной кнопкой; на телефоне — одна кнопка и окно со всем сразу */
export function SortPicker<K extends string>({ options, sort, onChange }: { options: SortOption<K>[]; sort: SortState<K>; onChange: (s: SortState<K>) => void }) {
  const { open, setOpen, box } = useDropdown()
  const narrow = useNarrow()
  const [sheet, setSheet] = useState(false)
  const cur = options.find((o) => o.id === sort.key) ?? options[0]
  const Icon = cur.icon

  if (narrow)
    return (
      <>
        <button onClick={() => setSheet(true)} aria-haspopup="dialog" aria-label={tx('sort.label')} className={cx(barBtn, 'shrink-0 px-3.5')}>
          {/* одна иконка — по чему сортируем; направление — в окне. Иначе с вкладками «Альбомы | Мои» не влезает в строку */}
          <Icon size={17} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
        </button>
        {sheet && (
          <PhoneSheet title={tx('sort.label')} onClose={() => setSheet(false)}>
            <div role="listbox" aria-label={tx('sort.label')} className="flex flex-col gap-1">
              <SortList options={options} sort={sort} onChange={onChange} big />
            </div>
            <div className="flex rounded-full bg-card-3 p-1">
              {([false, true] as const).map((desc) => (
                <button
                  key={String(desc)}
                  onClick={() => onChange({ ...sort, desc })}
                  className={cx('flex flex-1 items-center justify-center gap-2 rounded-full px-3 py-2.5 text-sm transition-colors', sort.desc === desc ? 'bg-sel text-on-sel' : 'text-muted')}
                >
                  {desc ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
                  {tx(desc ? 'sort.desc' : 'sort.asc')}
                </button>
              ))}
            </div>
          </PhoneSheet>
        )}
      </>
    )

  return (
    <div ref={box} className="relative flex min-w-[12.5rem] shrink-0 items-center rounded-full border border-ink/20">
      <button
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={tx('sort.label')}
        className="flex min-w-0 flex-1 items-center gap-2 py-2.5 ps-4 pe-1 text-xs text-ink"
      >
        <Icon size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
        <span className="flex-1 truncate text-start">{tx(cur.label)}</span>
        <ChevronDown size={14} className={cx('shrink-0 text-ink-muted transition-transform', open && 'rotate-180')} />
      </button>
      <button
        onClick={() => onChange({ ...sort, desc: !sort.desc })}
        title={sort.desc ? tx('sort.desc') : tx('sort.asc')}
        aria-label={sort.desc ? tx('sort.desc') : tx('sort.asc')}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-muted hover:text-ink"
      >
        {sort.desc ? <ArrowDownWideNarrow size={15} /> : <ArrowUpNarrowWide size={15} />}
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={tx('sort.label')}
          className="widget absolute start-0 top-full z-30 mt-2 flex w-auto flex-col gap-0.5 rounded-[calc(22px*var(--rk,1))] p-1.5 shadow-2xl ring-1 ring-line"
        >
          <SortList options={options} sort={sort} onChange={onChange} done={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}

// ---------- вид ----------

export type ViewMode = 'grid' | 'list' | 'table'
/** size — размер сетки 1 (мелкая) … 4 (огромная); cols — колонок в таблице; shape — обложки кругом или квадратом */
export type ViewState = { mode: ViewMode; size: 1 | 2 | 3 | 4; cols: 2 | 3 | 4; shape: 'round' | 'square' }

// Колонок сетки при каждом размере: чем крупнее, тем меньше колонок на той же ширине
const GRID: Record<ViewState['size'], string> = {
  1: 'grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8 2xl:grid-cols-10',
  2: 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7',
  3: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
}
export const gridClass = (size: ViewState['size']) => GRID[size]

// Таблица: те же строки, что в списке, разложенные в 2–4 колонки (на узком экране колонок меньше)
const TABLE: Record<ViewState['cols'], string> = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-2 lg:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
}
export const tableClass = (cols: ViewState['cols']) => TABLE[cols]

const MODES: { id: ViewMode; label: Key; icon: IconLike }[] = [
  { id: 'grid', label: 'view.grid', icon: LayoutGrid },
  { id: 'list', label: 'view.list', icon: List },
  { id: 'table', label: 'view.table', icon: Columns3 },
]

/** Значок размера сетки: квадрат из точек — чем крупнее сетка, тем меньше и крупнее точки */
function SizeGlyph({ size }: { size: ViewState['size'] }) {
  const n = 5 - size // 4×4 … 1×1
  return (
    <span className="grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${n}, 1fr)`, width: 16, height: 16 }}>
      {Array.from({ length: n * n }, (_, i) => (
        <span key={i} className="rounded-[1px] bg-current" />
      ))}
    </span>
  )
}

/** Вид: сетка (4 размера), список или таблица (2–4 колонки); на телефоне — окном */
export function ViewPicker({ view, onChange, gridOnly }: { view: ViewState; onChange: (v: ViewState) => void; gridOnly?: boolean }) {
  const { open, setOpen, box } = useDropdown()
  const narrow = useNarrow()
  const [sheet, setSheet] = useState(false)
  const cur = MODES.find((m) => m.id === view.mode)!
  const Icon = cur.icon

  if (narrow)
    return (
      <>
        <button onClick={() => setSheet(true)} aria-haspopup="dialog" aria-label={tx('view.label')} className={cx(barBtn, 'shrink-0 px-3.5')}>
          <Icon size={17} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
        </button>
        {sheet && (
          <PhoneSheet title={tx('view.label')} onClose={() => setSheet(false)}>
            <ViewBody view={view} onChange={onChange} gridOnly={gridOnly} big />
          </PhoneSheet>
        )}
      </>
    )

  return (
    <div ref={box} className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={tx('view.label')}
        className="flex items-center gap-2 rounded-full border border-ink/20 py-2.5 ps-4 pe-3 text-xs text-ink transition-colors hover:border-ink/50"
      >
        <Icon size={14} strokeWidth={1.8} className="shrink-0 text-ink-muted" />
        <span>{tx(cur.label)}</span>
        <ChevronDown size={14} className={cx('shrink-0 text-ink-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="widget absolute end-0 top-full z-30 mt-2 flex w-64 flex-col gap-3 rounded-[calc(22px*var(--rk,1))] p-3 shadow-2xl ring-1 ring-line">
          <ViewBody view={view} onChange={onChange} gridOnly={gridOnly} />
        </div>
      )}
    </div>
  )
}

/** Что внутри «Вида»: одно и то же в выпадашке на ПК и в окне на телефоне (там крупнее) */
function ViewBody({ view, onChange, gridOnly, big }: { view: ViewState; onChange: (v: ViewState) => void; gridOnly?: boolean; big?: boolean }) {
  const chip = (active: boolean) =>
    cx('grid flex-1 place-items-center rounded-full text-xs transition-colors', big ? 'h-11' : 'h-9', active ? 'bg-sel text-on-sel' : 'bg-card-3 text-muted hover:text-fg')
  return (
    <>
      <div className={cx('flex flex-col gap-0.5', gridOnly && 'hidden')}>
        {MODES.map((m) => {
          const ModeIcon = m.icon
          const active = m.id === view.mode
          return (
            <button
              key={m.id}
              onClick={() => onChange({ ...view, mode: m.id })}
              className={cx(
                'flex items-center gap-2.5 rounded-full px-3 text-start transition-colors',
                big ? 'py-3 text-[15px]' : 'py-2 text-sm',
                active ? 'bg-sel text-on-sel' : 'text-muted hover:bg-card-2 hover:text-fg',
              )}
            >
              <ModeIcon size={big ? 17 : 15} strokeWidth={1.8} className="shrink-0" />
              <span className="flex-1">{tx(m.label)}</span>
              {active && <Check size={14} className="shrink-0" />}
            </button>
          )
        })}
      </div>
      {view.mode === 'grid' && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <span className="label px-1 text-muted">{tx('view.size')}</span>
          <div dir="ltr" className="flex gap-1.5">
            {([1, 2, 3, 4] as const).map((size) => (
              <button key={size} onClick={() => onChange({ ...view, size })} title={tx(`view.size${size}`)} className={chip(view.size === size)}>
                <SizeGlyph size={size} />
              </button>
            ))}
          </div>
        </div>
      )}
      {/* форма обложек: круг или квадрат — для любого вида */}
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <span className="label px-1 text-muted">{tx('view.shape')}</span>
        <div className="flex gap-1.5">
          {(['square', 'round'] as const).map((shape) => (
            <button key={shape} onClick={() => onChange({ ...view, shape })} title={tx(`view.${shape}`)} className={cx(chip(view.shape === shape), 'gap-2')}>
              <span className={cx('h-3.5 w-3.5 bg-current', shape === 'round' ? 'rounded-full' : 'rounded-[3px]')} />
            </button>
          ))}
        </div>
      </div>
      {view.mode === 'table' && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <span className="label px-1 text-muted">{tx('view.cols')}</span>
          <div dir="ltr" className="flex gap-1.5">
            {([2, 3, 4] as const).map((cols) => (
              <button key={cols} onClick={() => onChange({ ...view, cols })} className={cx(chip(view.cols === cols), 'font-dot text-sm font-black')}>
                {cols}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
