import { ArrowLeft, FolderInput, Heart, Check, ChevronDown, GripVertical, Trash2, Play, CircleHelp, ChevronRight, DatabaseBackup, Eye, EyeOff, History, Library, Music2, Palette, PanelsTopLeft, RefreshCw, CornerLeftUp, Folder, FolderPlus, Moon, Pencil, Pipette, Plus, Sun, User, Users, X } from 'lucide-react'
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Modal } from '../components/Dialogs'
import { useDropdown } from '../components/CollectionControls'
import { ThemeEditor } from '../components/ThemeEditor'
import { TrashDialog } from '../components/TrashDialog'
import { ExportDialog } from '../components/ExportDialog'
import { cx, IconBtn, Toggle, DotLine } from '../components/ui'
import { fmtAgo, fmtSize, LANGS, t, tn, type Key } from '../i18n'
import { Avatar } from '../components/Avatar'
import { isHost } from '../mode'
import { NAV_CHOICES, SIDE_CHOICES } from '../components/Nav'
import type { NavId, SideId } from '../store'
import { api, ApiError, getApiBase, uploadBackup, type DirListing, type ServerPrefs, type ServerUser, type TrashItem, downloadBackup } from '../lib/api'
import { ACCENTS, effectiveTheme, themeSel, themeVars, FONTS, fontStack, PALETTE_GROUPS, RADIUS_PRESETS, customPalette, themeAccent, newCustomTheme, onAccent, paletteById, PALETTES, previewBackground, type CustomTheme, type FontId } from '../lib/themes'
import { MIN_PASSWORD, pathSep, QUALITY, selectIsOwner, userLabel, usePick, useStore, type Normalize, type QueueEnd, type SaverMode, type TrackCol } from '../store'
import type { MusicFolder } from '../types'
import type { View } from '../types'
import { PageTitle } from './Library'
import { AppFooter } from '../components/AppFooter'

// Название строки — для окна, которое на узком экране открывает переключатель (Segmented)
const RowTitle = createContext('')

// Окна из «Внешнего вида» показывают сверху живой пример: тема, акцент, выделение, блоки, скругление, шрифт
const LookPreviewCtx = createContext(false)

/**
 * Как будет выглядеть: кусочек MUSICH — фон темы с точками, блок с треком, кнопка, полоска, чипы. Всё на тех же
 * переменных, что и весь интерфейс, поэтому меняется сразу, как только что-то выбрали
 */
// какой цвет сейчас выбирают: в примере ярко то, что он меняет, остальное приглушено
type LookFocus = 'accent' | 'sel' | 'blocks'
const LookFocusCtx = createContext<LookFocus | null>(null)

function LookPreview({ style }: { style?: CSSProperties }) {
  const focus = useContext(LookFocusCtx)
  // ярко то, что меняет выбранный цвет; остальное — бледно. Без выбора — всё как есть
  const hl = (kind: LookFocus) => (focus && focus !== kind ? 'opacity-25' : '')
  const mark = (kind: LookFocus) => (focus === kind ? 'ring-2 ring-ink/70 ring-offset-2 ring-offset-[var(--page)]' : '')
  return (
    <>
    {/* style — переменные черновика (тема, шрифт), ещё не применённые; font-sans — чтобы шрифт брался отсюда, а не со страницы */}
    <div style={style} className="page-layer sticky top-0 z-10 mb-4 overflow-hidden rounded-[calc(22px*var(--rk,1))] p-3 font-sans shadow-lg ring-1 ring-line">
      <div className="mb-2.5 flex items-center justify-between px-1">
        <span className="font-logo text-lg leading-none font-black">MUSICH</span>
        <span className={cx('h-2 w-2 rounded-full bg-red transition-opacity', hl('accent'), mark('accent'))} />
      </div>
      <div className={cx('widget flex items-center gap-3 p-3 transition-shadow', mark('blocks'))}>
        <div className={cx('h-12 w-12 shrink-0 rounded-[calc(12px*var(--rk,1))] bg-gradient-to-br from-red to-card-3 transition-opacity', hl('accent'))} />
        <div className="min-w-0 flex-1">
          <div className={cx('truncate text-sm transition-colors', focus === 'accent' && 'text-red')}>{t('prev.title')}</div>
          <div className="truncate text-xs text-muted">{t('prev.artist')}</div>
          <div className={cx('mt-2 h-1 overflow-hidden rounded-full bg-card-3 transition-opacity', hl('accent'))}>
            <div className="h-full w-2/5 rounded-full bg-red" />
          </div>
        </div>
        <Heart size={18} className={cx('shrink-0 text-red transition-opacity', hl('accent'))} fill="currentColor" />
        <span className={cx('grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sel text-on-sel transition-opacity', hl('sel'), mark('sel'))}>
          <Play size={16} />
        </span>
      </div>
      <div className="mt-2.5 flex gap-1.5">
        <span className={cx('rounded-full bg-sel-page px-3 py-1 text-xs text-on-sel-page transition-opacity', hl('sel'), mark('sel'))}>{t('prev.on')}</span>
        <span className={cx('rounded-full border border-ink/20 px-3 py-1 text-xs text-ink-muted transition-opacity', focus && 'opacity-25')}>{t('prev.off')}</span>
      </div>
    </div>
    {/* словами — что именно перекрасится */}
    {focus && <p className="-mt-2 mb-4 px-1 text-xs text-muted">{t(`look.changes.${focus}`)}</p>}
    </>
  )
}

// Черновик внешнего вида в окне: выбор меняет только пример сверху, всё MUSICH — по «Применить»
type LookDraft = { palette: string; font: FontId; accent: string | null; sel: string | null; blocks: string | null; radius: number }
const DraftCtx = createContext<{ draft: LookDraft; set: (p: Partial<LookDraft>) => void } | null>(null)

/** Значения внешнего вида для выбора: в окне с черновиком — черновые (и меняются только они), иначе — настоящие */
function useLook() {
  const st = usePick('theme', 'palette', 'accent', 'sel', 'blocks', 'radius', 'ui', 'customThemes', 'setPalette', 'setAccent', 'setSel', 'setBlocks', 'setRadius', 'setUi')
  const d = useContext(DraftCtx)
  const cur: LookDraft = d ? d.draft : { palette: st.palette, font: st.ui.font, accent: st.accent, sel: st.sel, blocks: st.blocks, radius: st.radius }
  const set = (p: Partial<LookDraft>) => {
    if (d) return d.set(p)
    applyLook(st, p)
  }
  return { ...cur, theme: st.theme, customThemes: st.customThemes, set }
}

/** Записать выбранное (только то, что передали) */
function applyLook(
  st: { setPalette: (v: string) => void; setUi: (p: { font: FontId }) => void; setAccent: (v: string | null) => void; setSel: (v: string | null) => void; setBlocks: (v: string | null) => void; setRadius: (v: number) => void },
  p: Partial<LookDraft>,
) {
  if (p.palette !== undefined) st.setPalette(p.palette)
  if (p.font !== undefined) st.setUi({ font: p.font })
  if ('accent' in p) st.setAccent(p.accent ?? null)
  if ('sel' in p) st.setSel(p.sel ?? null)
  if ('blocks' in p) st.setBlocks(p.blocks ?? null)
  if (p.radius !== undefined) st.setRadius(p.radius)
}

/**
 * Окно выбора: заголовок, подсказка и сам выбор; из «Внешнего вида» — с примером сверху.
 * apply — выбор идёт в черновик: меняется только пример, а внизу «Отмена / Применить» (всегда видны, список
 * прокручивается между ними)
 */
function Sheet({ title, hint, onClose, children, wide, apply }: { title: string; hint?: string; onClose: () => void; children: ReactNode; wide?: boolean; apply?: boolean }) {
  const preview = useContext(LookPreviewCtx)
  const st = usePick('theme', 'palette', 'accent', 'sel', 'blocks', 'radius', 'ui', 'customThemes', 'setPalette', 'setAccent', 'setSel', 'setBlocks', 'setRadius', 'setUi')
  const start: LookDraft = { palette: st.palette, font: st.ui.font, accent: st.accent, sel: st.sel, blocks: st.blocks, radius: st.radius }
  const [draft, setDraft] = useState<LookDraft>(start)
  const changed = (Object.keys(start) as (keyof LookDraft)[]).filter((k) => draft[k] !== start[k])
  // пример — в переменных черновика; «initial» у шрифта — шрифт темы, если на странице выбран свой
  const previewStyle = apply
    ? ({
        ...Object.fromEntries(Object.entries(themeVars(st.theme, draft.palette, draft.accent, st.customThemes, draft.sel, draft.blocks).vars).filter(([, v]) => v)),
        '--user-font': fontStack(draft.font) || 'initial',
        '--rk': String(draft.radius),
      } as CSSProperties)
    : undefined
  const save = () => {
    applyLook(st, Object.fromEntries(changed.map((k) => [k, draft[k]])) as Partial<LookDraft>)
    onClose()
  }
  return (
    <Modal onClose={onClose} wide={wide}>
      <div className={cx('flex flex-col', apply && 'max-h-[calc(100svh-6rem)]')}>
        {preview && <LookPreview style={previewStyle} />}
        {/* «назад» слева от заголовка, крупный — на телефоне в маленький не попасть */}
        <div className="mb-4 flex shrink-0 items-center gap-3">
          <IconBtn title={t('common.back')} onClick={onClose} className="-ms-1 h-11 w-11 shrink-0 bg-card-3">
            <ArrowLeft size={20} className="rtl:rotate-180" />
          </IconBtn>
          <div className="min-w-0">
            <div className="text-lg font-medium">{title}</div>
            {hint && <div className="text-xs text-muted">{hint}</div>}
          </div>
        </div>
        {apply ? (
          <>
            <div className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2 pb-1">
              <DraftCtx.Provider value={{ draft, set: (p) => setDraft((d) => ({ ...d, ...p })) }}>{children}</DraftCtx.Provider>
            </div>
            <div className="mt-4 flex shrink-0 gap-2">
              <button onClick={onClose} className="flex-1 rounded-full bg-card-3 py-3.5 text-sm">
                {t('common.cancel')}
              </button>
              <button onClick={save} disabled={!changed.length} className="flex-1 rounded-full bg-sel py-3.5 text-sm text-on-sel disabled:opacity-40">
                {t('common.apply')}
              </button>
            </div>
          </>
        ) : (
          children
        )}
      </div>
    </Modal>
  )
}

// help — что показать в окне по кружку «?» рядом с заголовком.
// value — что выбрано сейчас: тогда на узком экране вместо самого выбора — строка со значением, а выбор — в окне
function Row({ title, hint, children, help, value, apply }: { title: string; hint?: string; children: ReactNode; help?: ReactNode; value?: ReactNode; apply?: boolean }) {
  const [helpOpen, setHelpOpen] = useState(false)
  const [sheet, setSheet] = useState(false)
  return (
    <RowTitle.Provider value={title}>
    {value !== undefined && (
      <button onClick={() => setSheet(true)} className="flex w-full items-center gap-3 border-b border-line py-4 text-start last:border-0 @lg:hidden">
        <span className="min-w-0 flex-1">
          <span className="block text-[15px]">{title}</span>
          {hint && <span className="block text-xs text-muted">{hint}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-sm text-muted">{value}</span>
        <ChevronRight size={16} className="shrink-0 text-muted rtl:rotate-180" />
      </button>
    )}
    {sheet && (
      <Sheet title={title} hint={hint} onClose={() => setSheet(false)} apply={apply}>
        <div className="flex justify-center">{children}</div>
      </Sheet>
    )}
    <div className={cx('flex flex-wrap items-center gap-4 border-b border-line py-4 last:border-0', value !== undefined && 'hidden @lg:flex')}>
      {/* название не сжимается в столбик: если рядом не помещается, настройка уходит строкой ниже */}
      <div className="min-w-[11rem] flex-1 basis-[11rem]">
        <div className="flex items-center gap-1.5 text-[15px]">
          {title}
          {help && (
            <button onClick={() => setHelpOpen(true)} title={t('help.what')} className="text-muted transition-colors hover:text-fg">
              <CircleHelp size={15} />
            </button>
          )}
        </div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      {/* без прокрутки вбок: не помещается — переносится строкой ниже (полоса прокрутки резала глаза и обрезала обводку выбранного) */}
      <div className="ms-auto flex min-w-0 max-w-full justify-end [&>*]:min-w-0">{children}</div>
      {helpOpen && (
        <Modal onClose={() => setHelpOpen(false)}>
          <div className="mb-4 flex items-start justify-between gap-3">
            <span className="text-lg font-medium">{title}</span>
            <IconBtn title={t('common.close')} onClick={() => setHelpOpen(false)} className="-mt-2 -me-2">
              <X size={18} />
            </IconBtn>
          </div>
          {help}
        </Modal>
      )}
    </div>
    </RowTitle.Provider>
  )
}

/** Что делает каждый режим «Правки трека» — для окна по «?» */
/** «Как сохранять правки»: теги и картинки — каждое своим выбором. Хранится на сервере, одно на все устройства */
function SaveEditsRow() {
  const prefs = useStore((s) => s.prefs)
  const tags: EditChoice = prefs.editMode === 'overlay' ? 'overlay' : prefs.fileNames === 'keep' ? 'tags' : 'tagsName'
  return (
    <PopupRow
      title={t('set.saveEdits')}
      hint={t('set.saveEditsHint')}
      apply={false}
      value={<span className="max-w-36 truncate text-xs">{`${t(`set.em.${tags}`)} · ${t(prefs.coverMode === 'file' ? 'set.cm.file' : 'set.cm.overlay')}`}</span>}
    >
      {(close) => <SaveEditsBody onDone={close} />}
    </PopupRow>
  )
}

function SaveEditsBody({ onDone }: { onDone: () => void }) {
  const { prefs, setPrefs } = usePick('prefs', 'setPrefs')
  const tags: EditChoice = prefs.editMode === 'overlay' ? 'overlay' : prefs.fileNames === 'keep' ? 'tags' : 'tagsName'
  const option = (on: boolean, title: string, hint: string, pick: () => void) => (
    <button
      key={title}
      onClick={pick}
      aria-pressed={on}
      className={cx('flex w-full items-start gap-3 rounded-2xl px-4 py-3 text-start transition-colors', on ? 'bg-sel text-on-sel' : 'bg-card-3 hover:bg-card-2')}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[15px]">{title}</span>
        <span className={cx('block text-xs leading-relaxed', on ? 'opacity-80' : 'text-muted')}>{hint}</span>
      </span>
      {on && <Check size={16} className="mt-1 shrink-0" />}
    </button>
  )
  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="label mb-2 text-muted">{t('set.tagsLabel')}</div>
        <div className="flex flex-col gap-1.5">
          {(['overlay', 'tags', 'tagsName'] as const).map((id) =>
            option(tags === id, t(`set.em.${id}`), t(`help.edit.${id}`), () =>
              void setPrefs(id === 'overlay' ? { editMode: 'overlay' } : { editMode: 'file', fileNames: id === 'tags' ? 'keep' : 'artist-title' }),
            ),
          )}
        </div>
      </div>
      <div>
        <div className="label mb-2 text-muted">{t('set.coversLabel')}</div>
        <div className="flex flex-col gap-1.5">
          {(['overlay', 'file'] as const).map((id) =>
            option(prefs.coverMode === id, t(`set.cm.${id}`), t(`set.cm.${id}.hint`), () => void setPrefs({ coverMode: id })),
          )}
        </div>
      </div>
      <p className="text-xs text-muted">{t('help.edit.note')}</p>
      <button onClick={onDone} className="w-full rounded-full bg-sel py-3 text-sm text-on-sel">
        {t('common.done')}
      </button>
    </div>
  )
}

/** Телефон: отдельный раздел «Правка треков» — на ПК эта строка в «Библиотеке» */
function EditsSettings() {
  return (
    <Group title={t('set.editsSection')}>
      <SaveEditsRow />
    </Group>
  )
}

/** Строка, которая открывает окно: тема и шрифт — выбор большой, в строку не помещается */
function PopupRow({
  title,
  hint,
  value,
  wide,
  apply = true,
  focus,
  children,
}: {
  focus?: LookFocus
  title: string
  hint?: string
  value: ReactNode
  wide?: boolean
  apply?: boolean // false — не внешний вид: выбор применяется сразу, окно закрывает «Готово»
  children: ReactNode | ((close: () => void) => ReactNode)
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)} className="group flex w-full items-center gap-3 border-b border-line py-4 text-start last:border-0">
        <span className="min-w-0 flex-1">
          <span className="block text-[15px]">{title}</span>
          {hint && <span className="block text-xs text-muted">{hint}</span>}
        </span>
        <span className="flex min-w-0 shrink-0 items-center gap-2 text-sm text-muted">{value}</span>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-card-3 text-muted transition-colors group-hover:text-fg">
          <ChevronRight size={16} className="rtl:rotate-180" />
        </span>
      </button>
      {open && (
        <LookFocusCtx.Provider value={focus ?? null}>
          <Sheet title={title} hint={hint} wide={wide} onClose={() => setOpen(false)} apply={apply}>
            {/* сетка тем считает колонки по ширине окна */}
            <div className="@container">{typeof children === 'function' ? children(() => setOpen(false)) : children}</div>
          </Sheet>
        </LookFocusCtx.Provider>
      )}
    </>
  )
}

/** Что сейчас выбрано: превью фона темы и её имя */
function ThemeValue() {
  const { theme, palette, customThemes } = usePick('theme', 'palette', 'customThemes')
  const p = paletteById(palette, customThemes)
  const own = customThemes.find((c) => c.id === p.id)
  return (
    <>
      <span className="h-6 w-9 shrink-0 rounded-lg ring-1 ring-line" style={previewBackground(p[effectiveTheme(p, theme)])} />
      <span className="max-w-32 truncate">{own ? own.name : t(`pal.${p.id}` as Key)}</span>
    </>
  )
}

function FontValue() {
  const font = useStore((s) => s.ui.font)
  const f = FONTS.find((x) => x.id === font) ?? FONTS[0]
  return (
    <span className="max-w-36 truncate" style={f.stack ? { fontFamily: fontStack(f.id) } : undefined}>
      {'name' in f ? f.name : t(`font.${f.id}` as Key)}
    </span>
  )
}

/** Темы: превью — фон страницы в текущем режиме, на нём виджет и точка акцента. Свои — с карандашом, в конце «+» */
function ThemePicker() {
  const { theme, customThemes, palette, set } = useLook()
  const setPalette = (id: string) => set({ palette: id })
  const [editing, setEditing] = useState<{ theme: CustomTheme; isNew: boolean } | null>(null)
  const byId = new Map(PALETTES.map((p) => [p.id, p]))
  const groups = [
    ...PALETTE_GROUPS.map((g) => ({ id: g.id, list: g.ids.map((id) => byId.get(id)!).filter(Boolean) })),
    { id: 'own', list: customThemes.map(customPalette) },
  ]

  // плитка темы: превью фона, виджет с точкой акцента, имя; у своих — карандаш
  const tile = (p: (typeof PALETTES)[number]) => {
    const m = p[theme]
    const active = p.id === palette
    const own = customThemes.find((c) => c.id === p.id)
    return (
      <div key={p.id} className="group relative">
        <button onClick={() => setPalette(p.id)} className="flex w-full flex-col gap-1.5 text-start">
          <span
            className={cx(
              // невысокая плитка: список тем короче, пример сверху виден вместе с ними
              'relative block h-11 overflow-hidden rounded-xl ring-1 transition-shadow',
              active ? 'ring-2 ring-fg' : 'ring-line group-hover:ring-fg/40',
            )}
            style={previewBackground(m)}
          >
            <span className="absolute inset-x-3 bottom-2 top-2.5 rounded-md" style={{ background: m.card, boxShadow: `inset 0 0 0 1px ${m.border}` }}>
              <span className="absolute top-2 left-2 h-1.5 w-1.5 rounded-full" style={{ background: themeAccent(p, theme) }} />
              <span className="absolute top-2 right-2 left-5 h-1 rounded-full" style={{ background: m.card3 }} />
            </span>
            {active && (
              <span className="absolute top-1.5 right-1.5 grid h-4 w-4 place-items-center rounded-full bg-sel text-on-sel">
                <Check size={10} strokeWidth={3} />
              </span>
            )}
          </span>
          <span className={cx('truncate text-xs', active ? 'text-fg' : 'text-muted group-hover:text-fg')}>
            {own ? own.name : t(`pal.${p.id}` as Key)}
          </span>
        </button>
        {own && (
          <button
            onClick={() => setEditing({ theme: own, isNew: false })}
            title={t('theme.edit')}
            className="absolute top-1.5 left-1.5 grid h-6 w-6 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <Pencil size={11} />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <div key={g.id}>
          <div className="label mb-2 text-muted">
            {t(`palg.${g.id}` as Key)}
            {/* темы «Сервисы» — только цвета в духе сервисов; с ними MUSICH не связан */}
            {g.id === 'services' && <BrandNote />}
          </div>
          {/* плитки чуть уже: в ряд на одну больше */}
          <div className="grid grid-cols-3 gap-2 @md:grid-cols-4 @xl:grid-cols-6">
            {g.list.map(tile)}
            {/* свои темы — в конце «+», новая тема */}
            {g.id === 'own' && (
              <button onClick={() => setEditing({ theme: newCustomTheme(), isNew: true })} className="group flex flex-col gap-1.5 text-start">
                <span className="grid h-11 place-items-center rounded-xl border-2 border-dashed border-line text-muted transition-colors group-hover:border-fg/50 group-hover:text-fg">
                  <Plus size={18} />
                </span>
                <span className="truncate text-xs text-muted group-hover:text-fg">{t('theme.new')}</span>
              </button>
            )}
          </div>
        </div>
      ))}
      {editing && <ThemeEditor initial={editing.theme} isNew={editing.isNew} onClose={() => setEditing(null)} />}
    </div>
  )
}

/** Скругление: готовые варианты и ползунок; превью — уголок виджета с текущим радиусом */
function RadiusPicker() {
  const { radius, set } = useLook()
  const setRadius = (v: number) => set({ radius: v })
  return (
    <div dir="ltr" className="flex w-full flex-wrap items-center justify-end gap-3 @lg:w-auto">
      <div className="flex gap-1.5">
        {RADIUS_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => setRadius(p.value)}
            title={t(`radius.${p.id}` as Key)}
            className={cx(
              'grid h-9 w-9 place-items-center rounded-full transition-colors',
              Math.abs(radius - p.value) < 0.05 ? 'bg-sel text-on-sel' : 'bg-card-3 text-muted hover:text-fg',
            )}
          >
            {/* уголок со скруглением этого варианта */}
            <span className="h-3.5 w-3.5 border-t-2 border-l-2 border-current" style={{ borderTopLeftRadius: 9 * p.value }} />
          </button>
        ))}
      </div>
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        value={radius}
        onChange={(e) => setRadius(Number(e.target.value))}
        aria-label={t('set.radius')}
        className="w-32 accent-[var(--red)]"
      />
      <span className="w-10 text-end font-mono text-xs text-muted">{Math.round(radius * 100)}%</span>
    </div>
  )
}

/** Шрифт: каждый вариант написан своим шрифтом; логотип не меняется */
function FontPicker() {
  const look = useLook()
  const ui = { font: look.font }
  const setUi = (p: { font: FontId }) => look.set(p)
  return (
    <div className="grid grid-cols-2 gap-2 @md:grid-cols-3 @xl:grid-cols-4">
      {FONTS.map((f) => (
        <button
          key={f.id}
          onClick={() => setUi({ font: f.id })}
          style={f.stack ? { fontFamily: f.stack } : undefined}
          className={cx(
            'flex flex-col items-start gap-0.5 rounded-2xl px-3 py-2.5 text-start ring-1 transition-colors',
            ui.font === f.id ? 'bg-sel text-on-sel ring-fg' : 'bg-card-3 ring-transparent hover:ring-fg/40',
          )}
        >
          <span className="text-lg leading-tight">Аа Bb 12</span>
          <span className={cx('truncate text-xs', ui.font === f.id ? 'text-on-sel/70' : 'text-muted')}>
            {'name' in f ? f.name : t(`font.${f.id}` as Key)}
          </span>
        </button>
      ))}
    </div>
  )
}

/** Прозрачность блоков: ползунок 0–100 %; 0 — плотные, как раньше, 100 — остаётся только размытие */
function GlassPicker() {
  const { ui, setUi } = usePick('ui', 'setUi')
  return (
    // на узком экране — во всю ширину под названием
    <div dir="ltr" className="flex w-full items-center gap-3 @lg:w-auto">
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={ui.glass}
        onChange={(e) => setUi({ glass: Number(e.target.value) })}
        aria-label={t('set.glass')}
        className="min-w-0 flex-1 touch-pan-y accent-[var(--red)] @lg:w-40 @lg:flex-none"
      />
      <span className="w-10 text-end font-mono text-xs text-muted">{ui.glass}%</span>
    </div>
  )
}

/** Выбор цвета: готовые варианты пилюлями со своим кружком и свой через пипетку */
function ColorChoice({ value, options, pick, onChange }: {
  value: string | null
  options: { id: string | null; label: string; color: string }[]
  pick: string // с какого цвета начинать пипетку
  onChange: (v: string | null) => void
}) {
  const custom = value?.startsWith('#') ? value : null
  return (
    <div dir="ltr" className="flex flex-wrap items-center justify-end gap-1.5">
      {options.map((o) => (
        <button
          key={o.id ?? 'theme'}
          onClick={() => onChange(o.id)}
          className={cx(
            'flex items-center gap-1.5 rounded-full py-1 pr-3 pl-1 text-xs transition-colors',
            value === o.id ? 'bg-card-3 text-fg ring-1 ring-fg' : 'bg-card-3 text-muted hover:text-fg',
          )}
        >
          <span className="h-5 w-5 rounded-full ring-1 ring-line" style={{ background: o.color }} />
          {o.label}
        </button>
      ))}
      <label title={t('clr.custom')} className="relative cursor-pointer">
        <span
          className={cx('grid h-7 w-7 place-items-center rounded-full ring-offset-2 ring-offset-card', custom ? 'ring-2 ring-fg' : 'ring-1 ring-line')}
          style={{ background: custom ?? 'conic-gradient(#ff3d3d, #ffc21a, #2fbf5b, #14b8a6, #2f6bff, #8b5cf6, #ff3d7f, #ff3d3d)', color: custom ? onAccent(custom) : '#fff' }}
        >
          {custom ? <Check size={13} strokeWidth={3} /> : <Pipette size={13} />}
        </span>
        <input type="color" value={custom ?? pick} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
    </div>
  )
}

/** Цвет выделения — второй акцент: выбранный пункт меню, переключатели, главные кнопки */
function SelPicker() {
  const { theme, palette, accent, customThemes, sel, set } = useLook()
  const setSel = (v: string | null) => set({ sel: v })
  const p = paletteById(palette, customThemes)
  const mode = effectiveTheme(p, theme)
  const text = mode === 'light' ? '#0a0a0a' : '#f4f4f4'
  const acc = accent ?? themeAccent(p, mode)
  return (
    <ColorChoice
      value={sel}
      pick={themeSel(p, mode) ?? acc}
      onChange={setSel}
      options={[
        { id: null, label: t('clr.theme'), color: themeSel(p, mode) ?? text },
        { id: 'text', label: t('clr.text'), color: text },
        { id: 'accent', label: t('clr.accent'), color: acc },
      ]}
    />
  )
}

/** Цвет блоков: как в теме, оттенок акцента или свой */
function BlocksPicker() {
  const { theme, palette, accent, customThemes, blocks, set } = useLook()
  const setBlocks = (v: string | null) => set({ blocks: v })
  const p = paletteById(palette, customThemes)
  const mode = effectiveTheme(p, theme)
  const card = p[mode].card
  const acc = accent ?? themeAccent(p, mode)
  return (
    <ColorChoice
      value={blocks}
      pick={card.startsWith('#') ? card : '#1b1b1b'}
      onChange={setBlocks}
      options={[
        { id: null, label: t('clr.theme'), color: card },
        { id: 'accent', label: t('clr.accentTint'), color: `color-mix(in srgb, ${card} ${mode === 'dark' ? 86 : 90}%, ${acc})` },
      ]}
    />
  )
}

/** Акцент: «как в теме», готовые цвета и свой через пипетку */
function AccentPicker() {
  const { theme, palette, accent, customThemes, set } = useLook()
  const setAccent = (v: string | null) => set({ accent: v })
  const ownAccent = themeAccent(paletteById(palette, customThemes), theme)
  const custom = accent && !ACCENTS.includes(accent) ? accent : null
  const dot = (color: string, active: boolean) => (
    <span
      className={cx('grid h-7 w-7 place-items-center rounded-full ring-offset-2 ring-offset-card transition-shadow', active ? 'ring-2 ring-fg' : 'ring-1 ring-line')}
      style={{ background: color, color: onAccent(color) }}
    >
      {active && <Check size={13} strokeWidth={3} />}
    </span>
  )
  return (
    <div dir="ltr" className="flex flex-wrap items-center justify-end gap-2">
      <button onClick={() => setAccent(null)} title={t('set.accentAuto')} className="flex items-center gap-1.5 rounded-full bg-card-3 py-0.5 pr-3 pl-0.5 text-xs text-muted hover:text-fg">
        {dot(ownAccent, accent === null)}
        {t('set.accentAuto')}
      </button>
      {ACCENTS.map((c) => (
        <button key={c} onClick={() => setAccent(c)} title={c}>
          {dot(c, accent === c)}
        </button>
      ))}
      {/* свой цвет: системная пипетка браузера */}
      <label title={t('set.accentCustom')} className="relative cursor-pointer">
        <span
          className={cx('grid h-7 w-7 place-items-center rounded-full ring-offset-2 ring-offset-card', custom ? 'ring-2 ring-fg' : 'ring-1 ring-line')}
          style={{ background: custom ?? 'conic-gradient(#ff3d3d, #ffc21a, #2fbf5b, #14b8a6, #2f6bff, #8b5cf6, #ff3d7f, #ff3d3d)', color: custom ? onAccent(custom) : '#fff' }}
        >
          {custom ? <Check size={13} strokeWidth={3} /> : <Pipette size={13} />}
        </span>
        <input type="color" value={accent ?? ownAccent} onChange={(e) => setAccent(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
    </div>
  )
}

/** Переключатель из нескольких вариантов — как у режима и качества. На узком экране — кнопка со значением и список в окне */
function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  const title = useContext(RowTitle)
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.id === value)
  return (
    <>
    <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded-full bg-card-3 px-4 py-2 text-sm @lg:hidden">
      {current?.label ?? '—'}
      <ChevronDown size={14} className="text-muted" />
    </button>
    {open && (
      <Sheet title={title} onClose={() => setOpen(false)}>
        <div className="flex flex-col gap-1">
          {options.map((o) => (
            <button
              key={o.id}
              onClick={() => {
                onChange(o.id)
                setOpen(false)
              }}
              className={cx('flex items-center justify-between rounded-2xl px-4 py-3 text-start text-[15px] transition-colors', value === o.id ? 'bg-sel text-on-sel' : 'hover:bg-card-2')}
            >
              {o.label}
              {value === o.id && <Check size={16} />}
            </button>
          ))}
        </div>
      </Sheet>
    )}
    <div className="hidden rounded-full bg-card-3 p-1 @lg:flex">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={cx('rounded-full px-3 py-1.5 text-xs transition-colors', value === o.id ? 'bg-sel text-on-sel' : 'text-muted hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
    </>
  )
}

/** История: с какой секунды засчитывать — на сервере (хранится она всегда); «не записывать» — только в этом браузере */
function HistorySettings() {
  const { prefs, setPrefs, historyPaused, setHistoryPaused } = usePick('prefs', 'setPrefs', 'historyPaused', 'setHistoryPaused')

  return (
    <Group title={t('set.history')}>
      <Row title={t('set.histThreshold')} hint={t('set.histThresholdHint')}>
        <Segmented
          value={prefs.playThreshold}
          onChange={(v) => void setPrefs({ playThreshold: v })}
          options={[5, 10, 30].map((n) => ({ id: n, label: t('set.sec', { n }) })).concat({ id: 0, label: t('set.half') })}
        />
      </Row>
      <Row title={t('set.histPause')} hint={t('set.histPauseHint')}>
        <Toggle on={historyPaused} onChange={setHistoryPaused} />
      </Row>
      <ScrobbleRows />
    </Group>
  )
}

// Правка трека: только в MUSICH · теги в файле (имя прежнее) · теги и имя файла «Артист - Название»
type EditChoice = 'overlay' | 'tags' | 'tagsName'

/** Хост: как сервер обращается с файлами — имена, номера, артисты, скан, корзина. Всё хранится на сервере */
function LibrarySettings() {
  const { prefs, setPrefs, settings, setSetting } = usePick('prefs', 'setPrefs', 'settings', 'setSetting')
  const [trash, setTrash] = useState<TrashItem[] | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  useEffect(() => {
    api<TrashItem[]>('/trash').then(setTrash, () => setTrash(null))
  }, [])
  const sep = (k: keyof ServerPrefs['separators'], label: string) => (
    <button
      key={k}
      onClick={() => void setPrefs({ separators: { ...prefs.separators, [k]: !prefs.separators[k] } })}
      className={cx(
        'min-w-11 rounded-full px-3 py-1.5 font-mono text-xs transition-colors',
        prefs.separators[k] ? 'bg-sel text-on-sel' : 'bg-card-3 text-muted hover:text-fg',
      )}
    >
      {label}
    </button>
  )
  const trashSize = (trash ?? []).reduce((a, x) => a + x.size, 0)

  return (
    <Group title={t('set.library')}>
      {/* что правка делает с файлом: теги и картинки — отдельно, в окне */}
      <SaveEditsRow />
      <UpdateCheckRow />
      <LanRow />
      <Row title={t('set.autoNumber')} hint={t('set.autoNumberHint')}>
        <Toggle on={prefs.autoNumber} onChange={(v) => void setPrefs({ autoNumber: v })} />
      </Row>
      <Row title={t('set.shiftOnDelete')} hint={t('set.shiftOnDeleteHint')}>
        <Toggle on={prefs.shiftOnDelete} onChange={(v) => void setPrefs({ shiftOnDelete: v })} />
      </Row>
      <Row title={t('set.separators')} hint={t('set.separatorsHint')}>
        <div dir="ltr" className="flex flex-wrap justify-end gap-1.5">
          {sep('comma', ',')}
          {sep('feat', 'feat.')}
          {sep('x', 'x')}
          {sep('amp', '&')}
        </div>
      </Row>
      <Row title={t('set.watch')} hint={t('set.watchHint')}>
        <Toggle on={prefs.watch} onChange={(v) => void setPrefs({ watch: v })} />
      </Row>
      <Row title={t('set.rescan')} hint={t('set.rescanHint')}>
        <Segmented
          value={prefs.rescanMinutes}
          onChange={(v) => void setPrefs({ rescanMinutes: v })}
          options={[
            { id: 15, label: t('common.minutes', { n: 15 }) },
            { id: 60, label: t('set.hours', { n: 1 }) },
            { id: 360, label: t('set.hours', { n: 6 }) },
            { id: 1440, label: t('set.hours', { n: 24 }) },
            { id: 0, label: t('set.off') },
          ]}
        />
      </Row>
      <Row title={t('set.askDel')} hint={t('set.askDelHostHint')}>
        <Toggle on={settings.askOnDelete} onChange={(v) => setSetting('askOnDelete', v)} />
      </Row>
      <Row title={t('set.trashDays')} hint={t('set.trashDaysHint')}>
        <Segmented
          value={prefs.trashDays}
          onChange={(v) => void setPrefs({ trashDays: v })}
          options={[7, 14, 30, 90].map((n) => ({ id: n, label: tn('n.days', n) }))}
        />
      </Row>
      <Row
        title={t('trash.title')}
        hint={trash === null ? undefined : trash.length ? `${tn('n.tracks', trash.length)} · ${fmtSize(trashSize / 1048576)}` : t('trash.empty')}
      >
        <button onClick={() => setTrashOpen(true)} className="rounded-full bg-card-3 px-4 py-2 text-sm hover:bg-sel hover:text-on-sel">
          {t('trash.open')}
        </button>
      </Row>
      {trashOpen && <TrashDialog onClose={() => setTrashOpen(false)} onChange={setTrash} />}
    </Group>
  )
}

/** Шпаргалка горячих клавиш — те же, что ловит App.tsx */
const HOTKEYS: [string[], Key][] = [
  [['Space'], 'hk.toggle'],
  [['←', '→'], 'hk.seek'],
  [['Shift', '←', '→'], 'hk.track'],
  [['Shift', '↑', '↓'], 'hk.volume'],
  [['M'], 'hk.mute'],
  [['L'], 'hk.like'],
  [['S'], 'hk.shuffle'],
  [['R'], 'hk.repeat'],
]
function HotkeyList() {
  return (
    <div className="grid gap-x-6 gap-y-2 border-b border-line pb-4 @lg:grid-cols-2">
      {HOTKEYS.map(([keys, label]) => (
        <div key={label} className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted">{t(label)}</span>
          <span dir="ltr" className="flex gap-1">
            {keys.map((k) => (
              <kbd key={k} className="min-w-6 rounded-md bg-card-3 px-1.5 py-0.5 text-center font-mono text-[11px] text-fg">
                {k}
              </kbd>
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Меню: что в нём и в каком порядке. Порядок — перетаскиванием за ручку слева (палец или мышь), убрать — корзина,
 * добавить — «+» в списке ниже. Нижнее (телефон) — от 2 до 6 пунктов: меньше неудобно, больше не помещается.
 * Левое (широкий экран) — сколько угодно, но «Настройки» не убираются: иначе в них не попасть
 */
function NavPicker({ field = 'nav' }: { field?: 'nav' | 'side' }) {
  const { ui, setUi } = usePick('ui', 'setUi')
  const side = field === 'side'
  const choices: { id: string; label: Key; icon: (typeof NAV_CHOICES)[number]['icon'] }[] = side ? SIDE_CHOICES : NAV_CHOICES
  const on: string[] = side ? (ui.side.includes('settings') ? ui.side : [...ui.side, 'settings']) : ui.nav
  const min = side ? 1 : 2
  const max = side ? choices.length : 6
  const locked = (id: string) => side && id === 'settings'
  const rest = choices.filter((c) => !on.includes(c.id))
  const set = (list: string[]) => setUi(side ? { side: list as SideId[] } : { nav: list as NavId[] })

  // перетаскивание: тянем за ручку, строка едет за пальцем, остальные расступаются; отпустил — порядок сохраняется
  const first = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ id: string; from: number; startY: number; dy: number; step: number } | null>(null)
  const to = drag ? Math.max(0, Math.min(on.length - 1, drag.from + Math.round(drag.dy / drag.step))) : -1
  const order = drag ? (() => {
    const next = on.filter((x) => x !== drag.id)
    next.splice(to, 0, drag.id)
    return next
  })() : on
  const grab = (e: React.PointerEvent, id: string) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const h = first.current?.offsetHeight ?? 48
    setDrag({ id, from: on.indexOf(id), startY: e.clientY, dy: 0, step: h + 6 })
  }
  const moveTo = (e: React.PointerEvent) => drag && setDrag({ ...drag, dy: e.clientY - drag.startY })
  const drop = () => {
    if (drag && to !== drag.from) set(order)
    setDrag(null)
  }

  return (
    <div className="flex flex-col gap-1.5">
      {order.map((id, i) => {
        const c = choices.find((x) => x.id === id)
        if (!c) return null
        const Icon = c.icon
        const dragging = drag?.id === id
        return (
          <div
            key={id}
            ref={i === 0 ? first : undefined}
            style={dragging ? { transform: `translateY(${drag.dy - (to - drag.from) * drag.step}px)` } : undefined}
            className={cx(
              'flex items-center gap-3 rounded-2xl bg-card-3 py-1.5 ps-1.5 pe-2',
              dragging ? 'relative z-10 shadow-2xl ring-1 ring-fg/30' : 'transition-transform duration-150',
            )}
          >
            {/* ручка: за неё и тянут; touch-none — чтобы палец двигал строку, а не прокручивал окно */}
            <span
              onPointerDown={(e) => grab(e, id)}
              onPointerMove={moveTo}
              onPointerUp={drop}
              onPointerCancel={drop}
              title={t('set.navDrag')}
              className="grid h-9 w-9 shrink-0 cursor-grab touch-none place-items-center rounded-xl text-muted active:cursor-grabbing"
            >
              <GripVertical size={18} />
            </span>
            <Icon size={18} strokeWidth={1.6} />
            <span className="flex-1 truncate text-sm">{t(c.label)}</span>
            {!locked(id) && (
              <IconBtn
                title={t('set.navOff')}
                onClick={() => on.length > min && set(on.filter((x) => x !== id))}
                className={cx('h-9 w-9 text-muted hover:text-red', on.length <= min && 'pointer-events-none opacity-30')}
              >
                <Trash2 size={16} />
              </IconBtn>
            )}
          </div>
        )
      })}
      {rest.length > 0 && <div className="label mt-3 mb-0.5 text-muted">{t('set.navMore')}</div>}
      {rest.map((c) => {
        const Icon = c.icon
        return (
          <button
            key={c.id}
            onClick={() => on.length < max && set([...on, c.id])}
            disabled={on.length >= max}
            className="flex items-center gap-3 rounded-2xl py-1.5 ps-1.5 pe-2 text-start text-muted transition-colors hover:bg-card-3 hover:text-fg disabled:opacity-40"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-card-3">
              <Plus size={16} />
            </span>
            <Icon size={18} strokeWidth={1.6} />
            <span className="flex-1 truncate text-sm">{t(c.label)}</span>
          </button>
        )
      })}
      {!side && on.length >= max && <p className="mt-1 text-xs text-muted">{t('set.navFull')}</p>}
    </div>
  )
}

/** Строка «Меню …»: сколько пунктов, нажал — окно с редактором */
function NavRow({ field }: { field: 'nav' | 'side' }) {
  const ui = useStore((s) => s.ui)
  const [open, setOpen] = useState(false)
  const side = field === 'side'
  const n = side ? (ui.side.includes('settings') ? ui.side.length : ui.side.length + 1) : ui.nav.length
  const title = t(side ? 'set.side' : 'set.nav')
  const hint = t(side ? 'set.sideHint' : 'set.navHint')
  return (
    <>
      <button onClick={() => setOpen(true)} className="group flex w-full items-center gap-3 border-b border-line py-4 text-start last:border-0">
        <span className="min-w-0 flex-1">
          <span className="block text-[15px]">{title}</span>
          <span className="block text-xs text-muted">{hint}</span>
        </span>
        <span className="text-sm text-muted">{tn('n.items', n)}</span>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-card-3 text-muted transition-colors group-hover:text-fg">
          <ChevronRight size={16} className="rtl:rotate-180" />
        </span>
      </button>
      {open && (
        <Sheet title={title} hint={hint} onClose={() => setOpen(false)}>
          <NavPicker field={field} />
        </Sheet>
      )}
    </>
  )
}

// масштаб интерфейса: от мелкого (много на экране) до крупного
const SCALES = [70, 80, 90, 100, 110, 125, 150] as const

/**
 * «Масштаб»: на телефоне — окном с крупными кнопками, на компьютере — выпадающим списком у значения.
 * Выбор применяется сразу (видно на самом интерфейсе)
 */
function ScaleRow() {
  const { ui, setUi } = usePick('ui', 'setUi')
  const narrow = useNarrowScreen()
  const { open, setOpen, box } = useDropdown()
  const [sheet, setSheet] = useState(false)
  return (
    <div ref={box} className="relative border-b border-line last:border-0">
      <button onClick={() => (narrow ? setSheet(true) : setOpen(!open))} aria-expanded={open || sheet} className="group flex w-full items-center gap-3 py-4 text-start">
        <span className="min-w-0 flex-1">
          <span className="block text-[15px]">{t('set.scale')}</span>
          <span className="block text-xs text-muted">{t('set.scaleHint')}</span>
        </span>
        <span className="font-dot text-sm font-black text-muted">{ui.scale}%</span>
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-card-3 text-muted transition-colors group-hover:text-fg">
          {narrow ? <ChevronRight size={16} className="rtl:rotate-180" /> : <ChevronDown size={16} className={cx('transition-transform', open && 'rotate-180')} />}
        </span>
      </button>
      {open && !narrow && (
        <div role="listbox" className="widget absolute end-0 top-full z-30 -mt-2 flex w-36 flex-col gap-0.5 rounded-[calc(22px*var(--rk,1))] p-1.5 shadow-2xl ring-1 ring-line">
          {SCALES.map((n) => (
            <button
              key={n}
              role="option"
              aria-selected={ui.scale === n}
              onClick={() => {
                setUi({ scale: n })
                setOpen(false)
              }}
              className={cx('flex items-center justify-between rounded-full px-3 py-2 font-dot text-sm font-black transition-colors', ui.scale === n ? 'bg-sel text-on-sel' : 'text-muted hover:bg-card-2 hover:text-fg')}
            >
              {n}%
              {ui.scale === n && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
      {sheet && (
        <Sheet title={t('set.scale')} hint={t('set.scaleHint')} onClose={() => setSheet(false)}>
          <div className="grid grid-cols-4 gap-2">
            {SCALES.map((n) => (
              <button
                key={n}
                onClick={() => setUi({ scale: n })}
                className={cx('rounded-2xl py-3 font-dot text-base font-black transition-colors', ui.scale === n ? 'bg-sel text-on-sel' : 'bg-card-3 hover:bg-card-2')}
              >
                {n}%
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  )
}

/** Узкий экран (телефон): там выбор — окнами, на широком — выпадающими списками */
function useNarrowScreen() {
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

/** Интерфейс — в этом браузере */
function InterfaceSettings() {
  const { ui, setUi } = usePick('ui', 'setUi')
  const COLS: [TrackCol, Key][] = [['album', 'col.album'], ['year', 'col.year'], ['added', 'col.added'], ['size', 'col.size'], ['duration', 'col.duration']]
  return (
    <Group title={t('set.interface')}>
      <ScaleRow />
      <Row title={t('set.start')} hint={t('set.startHint')}>
        <Segmented<View>
          value={ui.start}
          onChange={(v) => setUi({ start: v })}
          options={(['home', 'library', 'albums', 'artists', 'history'] as const).map((v) => ({ id: v, label: t(`nav.${v}` as Key) }))}
        />
      </Row>
      <Row title={t('set.cols')} hint={t('set.colsHint')}>
        <div className="flex flex-wrap justify-end gap-1.5">
          {COLS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => setUi({ cols: { ...ui.cols, [k]: !ui.cols[k] } })}
              className={cx('rounded-full px-3 py-1.5 text-xs transition-colors', ui.cols[k] ? 'bg-sel text-on-sel' : 'bg-card-3 text-muted hover:text-fg')}
            >
              {t(label)}
            </button>
          ))}
        </div>
      </Row>
      <Row title={t('set.motion')} hint={t('set.motionHint')}>
        <Toggle on={ui.motion} onChange={(v) => setUi({ motion: v })} />
      </Row>
      <NavRow field="side" />
      <NavRow field="nav" />
    </Group>
  )
}

/** Хост: бэкап базы (лайки, плейлисты, история, настройки, свои обложки) и выгрузка самой музыки */
function BackupSettings() {
  const { toast } = usePick('toast')
  const [exporting, setExporting] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  // пароль бэкапа: при скачивании — шифрует файл, при восстановлении — расшифровывает
  const [bpw, setBpw] = useState('')

  const restore = async () => {
    if (!file || busy) return
    setBusy(true)
    try {
      await uploadBackup(file, bpw || undefined)
      toast(t('bak.restarting'))
      // сервер поднимется уже с бэкапом — перечитываем страницу с нуля
      setTimeout(() => location.reload(), 4000)
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t('auth.offline'), 'error')
      setBusy(false)
      setFile(null)
    }
  }

  return (
    <Group title={t('bak.title')}>
      <Row title={t('bak.backup')} hint={t('bak.backupHint')}>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="password"
            value={bpw}
            onChange={(e) => setBpw(e.target.value)}
            placeholder={t('bak.passwordPh')}
            autoComplete="new-password"
            className="w-44 rounded-full bg-card-3 px-4 py-2 text-sm outline-none placeholder:text-muted focus:ring-1 focus:ring-fg"
          />
          <button
            onClick={() => void downloadBackup(bpw || undefined).catch((e: Error) => toast(e.message, 'error'))}
            className="rounded-full bg-card-3 px-4 py-2 text-sm hover:bg-sel hover:text-on-sel"
          >
            {t('bak.download')}
          </button>
        </div>
      </Row>
      <Row title={t('bak.restore')} hint={file ? t('bak.restoreSure', { name: file.name }) : t('bak.restoreHint')}>
        {file ? (
          <div className="flex gap-2">
            <button onClick={() => setFile(null)} disabled={busy} className="rounded-full px-4 py-2 text-sm text-muted hover:text-fg">
              {t('common.cancel')}
            </button>
            <button onClick={() => void restore()} disabled={busy} className="rounded-full bg-red px-4 py-2 text-sm text-on-red disabled:opacity-50">
              {t('bak.replace')}
            </button>
          </div>
        ) : (
          <label className="cursor-pointer rounded-full bg-card-3 px-4 py-2 text-sm hover:bg-sel hover:text-on-sel">
            {t('bak.choose')}
            <input type="file" accept=".db" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        )}
      </Row>
      <Row title={t('exp.title')} hint={t('exp.rowHint')}>
        <button onClick={() => setExporting(true)} className="rounded-full bg-card-3 px-4 py-2 text-sm hover:bg-sel hover:text-on-sel">
          {t('exp.open')}
        </button>
      </Row>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </Group>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    // @container: строки внутри становятся компактными по ширине самой группы, а не окна
    <section className="widget @container px-6 py-4">
      <div className="label pt-2 pb-1 text-muted">{title}</div>
      {children}
    </section>
  )
}

/** Кружок текущего цвета — значение строки на телефоне */
function Swatch({ className }: { className: string }) {
  return <span className={cx('h-5 w-5 rounded-full ring-1 ring-line', className)} />
}
function RadiusValue() {
  return <span className="font-mono text-xs">{Math.round(useStore((s) => s.radius) * 100)}%</span>
}
/** Внешний вид: режим, тема, акцент, скругление, шрифт, язык */
function LookSettings() {
  const { theme: chosenTheme, setTheme, lang, setLang, palette, customThemes } = usePick('theme', 'setTheme', 'lang', 'setLang', 'palette', 'customThemes')
  const darkOnlyPalette = !!paletteById(palette, customThemes).darkOnly
  const theme = darkOnlyPalette ? 'dark' : chosenTheme
  return (
    <LookPreviewCtx.Provider value>
    <Group title={t('set.look')}>
      <Row title={t('set.theme')} hint={darkOnlyPalette ? t('set.themeDarkOnly') : t('set.themeHint')}>
        <div className="flex rounded-full bg-card-3 p-1">
          {(['light', 'dark'] as const).map((th) => (
            <button
              key={th}
              onClick={() => setTheme(th)}
              disabled={darkOnlyPalette}
              className={cx(
                'flex items-center gap-2 rounded-full px-4 py-1.5 text-sm transition-colors disabled:cursor-not-allowed',
                theme === th ? 'bg-sel text-on-sel' : 'text-muted',
                darkOnlyPalette && th === 'light' && 'opacity-40',
              )}
            >
              {th === 'light' ? <Sun size={14} /> : <Moon size={14} />}
              {th === 'light' ? t('set.light') : t('set.dark')}
            </button>
          ))}
        </div>
      </Row>
      <PopupRow title={t('set.palette')} hint={t('set.paletteHint')} value={<ThemeValue />} wide>
        <ThemePicker />
      </PopupRow>
      {/* цвета — окнами и на ПК: сверху пример, в нём подсвечено то, что меняет этот цвет */}
      <PopupRow title={t('set.accent')} hint={t('set.accentHint')} value={<Swatch className="bg-red" />} focus="accent">
        <AccentPicker />
      </PopupRow>
      <PopupRow title={t('set.sel')} hint={t('set.selHint')} value={<Swatch className="bg-sel" />} focus="sel">
        <SelPicker />
      </PopupRow>
      <PopupRow title={t('set.blocks')} hint={t('set.blocksHint')} value={<Swatch className="bg-card-3" />} focus="blocks">
        <BlocksPicker />
      </PopupRow>
      <Row title={t('set.radius')} hint={t('set.radiusHint')} value={<RadiusValue />} apply>
        <RadiusPicker />
      </Row>
      {/* ползунок — прямо в строке, без окна: на телефоне в окне он работал криво */}
      <Row title={t('set.glass')} hint={t('set.glassHint')}>
        <GlassPicker />
      </Row>
      <PopupRow title={t('set.font')} hint={t('set.fontHint')} value={<FontValue />}>
        <FontPicker />
      </PopupRow>
      <Row title={t('set.lang')} hint={t('set.langHint')} value={<span className="font-dot font-black">{lang.toUpperCase()}</span>}>
        {/* коротко кодом точечным шрифтом; полное название на самом языке — в подсказке */}
        <div dir="ltr" className="flex flex-wrap justify-end gap-1.5">
          {LANGS.map((l) => (
            <button
              key={l.id}
              title={l.name}
              aria-label={l.name}
              onClick={() => setLang(l.id)}
              className={cx(
                'font-dot w-11 rounded-full py-1.5 text-center text-sm font-black transition-colors',
                lang === l.id ? 'bg-sel text-on-sel' : 'bg-card-3 text-fg/75 hover:text-fg',
              )}
            >
              {l.id.toUpperCase()}
            </button>
          ))}
        </div>
      </Row>
    </Group>
    </LookPreviewCtx.Provider>
  )
}

/** Воспроизведение — в этом браузере */
function PlaybackSettings() {
  const { settings, setSetting } = usePick('settings', 'setSetting')
  return (
    <Group title={t('set.playback')}>
      <Row title={t('set.crossfade')} hint={t('set.crossfadeHint')}>
        <Segmented
          value={settings.crossfade}
          onChange={(v) => setSetting('crossfade', v)}
          options={[{ id: 0, label: t('set.off') }, ...[3, 6, 9, 12].map((n) => ({ id: n, label: t('set.sec', { n }) }))]}
        />
      </Row>
      <Row title={t('set.normalize')} hint={t('set.normalizeHint')}>
        <Segmented<Normalize>
          value={settings.normalize}
          onChange={(v) => setSetting('normalize', v)}
          options={[
            { id: 'off', label: t('set.off') },
            { id: 'auto', label: t('set.normAuto') },
            { id: 'tags', label: t('set.normTags') },
          ]}
        />
      </Row>
      <Row title={t('set.queueEnd')} hint={t('set.queueEndHint')}>
        <Segmented<QueueEnd>
          value={settings.queueEnd}
          onChange={(v) => setSetting('queueEnd', v)}
          options={[
            { id: 'stop', label: t('set.qeStop') },
            { id: 'repeat', label: t('set.qeRepeat') },
            { id: 'radio', label: t('set.qeRadio') },
          ]}
        />
      </Row>
      <Row title={t('set.resume')} hint={t('set.resumeHint')}>
        <Segmented
          value={settings.resumeMin}
          onChange={(v) => setSetting('resumeMin', v)}
          options={[{ id: 0, label: t('set.off') }, ...[10, 20, 30].map((n) => ({ id: n, label: t('set.fromMin', { n }) }))]}
        />
      </Row>
      {/* на телефоне клавиатуры нет — горячие клавиши только на ПК */}
      {isHost && (
        <Row title={t('set.hotkeys')} hint={t('set.hotkeysHint')}>
          <Toggle on={settings.hotkeys} onChange={(v) => setSetting('hotkeys', v)} />
        </Row>
      )}
      {isHost && settings.hotkeys && <HotkeyList />}
      <Row title={t('set.quality')} hint={t('set.qualityHint')}>
        <div className="flex rounded-full bg-card-3 p-1">
          {QUALITY.map((q) => (
            <button
              key={q}
              title={t(`quality.${q}.hint`)}
              onClick={() => setSetting('quality', q)}
              className={cx('rounded-full px-3 py-1.5 text-xs transition-colors', settings.quality === q ? 'bg-sel text-on-sel' : 'text-muted')}
            >
              {t(`quality.${q}`)}
            </button>
          ))}
        </div>
      </Row>
      {settings.quality !== 'original' && (
        <Row title={t('set.qualityMobile')} hint={t('set.qualityMobileHint')}>
          <Toggle on={settings.qualityMobileOnly} onChange={(v) => setSetting('qualityMobileOnly', v)} />
        </Row>
      )}
    </Group>
  )
}

/** Устройство: адрес сервера и синхронизация (у хоста этого нет — он сам хранилище) */
function DeviceSettings() {
  const { settings, setSetting, tracks, conn, changeServer, standalone, startBinding, unbindServer } = usePick(
    'settings', 'setSetting', 'tracks', 'conn', 'changeServer', 'standalone', 'startBinding', 'unbindServer',
  )
  const [unbinding, setUnbinding] = useState(false)
  return (
    <div className="flex flex-col gap-3">
      {/* адрес сервера вписывают только на устройстве. Аккаунт — на своей странице, внизу сайдбара */}
      <Group title={t('set.server')}>
        {standalone ? (
          // без сервера: всё живёт на телефоне; привязать — экран подключения, потом окно «Объединить»
          <Row title={t('solo.noServer')} hint={t('solo.bindHint')}>
            <button onClick={startBinding} className="rounded-full bg-sel px-4 py-2 text-sm text-on-sel">
              {t('solo.bind')}
            </button>
          </Row>
        ) : (
          <>
            {/* адрес, к которому телефон подключён сейчас, и связь с ним; сменить — экран подключения */}
            <Row title={t('set.address')} hint={conn === 'online' ? t('server.online') : t('server.offline')}>
              <div className="flex items-center gap-2">
                <span dir="ltr" className="max-w-48 truncate font-mono text-xs">
                  {getApiBase().replace(/^https?:\/\//, '') || '—'}
                </span>
                <button onClick={changeServer} className="rounded-full bg-card-3 px-4 py-2 text-sm">
                  {t('common.change')}
                </button>
              </div>
            </Row>
            <Row title={t('solo.unbind')} hint={t('solo.unbindHint')}>
              <button onClick={() => setUnbinding(true)} className="rounded-full bg-card-3 px-4 py-2 text-sm">
                {t('solo.unbind')}
              </button>
            </Row>
          </>
        )}
      </Group>
      {unbinding && (
        <Sheet title={t('solo.unbindAsk')} hint={t('solo.unbindHint')} onClose={() => setUnbinding(false)}>
          <div className="flex gap-2">
            <button onClick={() => setUnbinding(false)} className="flex-1 rounded-full py-3 text-sm text-muted hover:text-fg">
              {t('common.cancel')}
            </button>
            <button
              onClick={() => {
                setUnbinding(false)
                void unbindServer()
              }}
              className="flex-1 rounded-full bg-sel py-3 text-sm text-on-sel"
            >
              {t('solo.unbind')}
            </button>
          </div>
        </Sheet>
      )}
      <StorageSettings />
      <SaverSettings />
      <PinSettings />
      <Group title={t('nav.sync')}>
        <Row title={t('set.keepWhat')} hint={t('set.autoDlHint', { size: fmtSize(tracks.reduce((a, x) => a + x.sizeMb, 0)) })}>
          <Segmented<'some' | 'all'>
            value={settings.autoDownload ? 'all' : 'some'}
            onChange={(v) => setSetting('autoDownload', v === 'all')}
            options={[
              { id: 'some', label: t('set.keepSome') },
              { id: 'all', label: t('set.keepAll') },
            ]}
          />
        </Row>
        <Row title={t('set.wifi')} hint={t('set.wifiHint')}>
          <Toggle on={settings.wifiOnly} onChange={(v) => setSetting('wifiOnly', v)} />
        </Row>
        <Row title={t('space.limit')} hint={t('space.limitHint')}>
          <Segmented<number>
            value={settings.storageLimitGb}
            onChange={(v) => setSetting('storageLimitGb', v)}
            options={[0, 5, 10, 20, 40].map((g) => ({ id: g, label: g ? t("space.gb", { n: g }) : t("space.noLimit") }))}
          />
        </Row>
        <Row title={t('set.askDel')} hint={t('set.askDelHint')}>
          <Toggle on={settings.askOnDelete} onChange={(v) => setSetting('askOnDelete', v)} />
        </Row>
      </Group>
    </div>
  )
}

/**
 * «Где хранить музыку»: папка (стандартная или своя) и что с музыкой после удаления приложения.
 * Android удаляет вместе с приложением только его папку: «не трогать» — значит общая «Музыка/MUSICH»,
 * «удалить» — папка приложения; своя папка остаётся всегда. Скачанное переезжает само, с прогрессом
 */
function StorageSettings() {
  const { storage, setStorage } = usePick('storage', 'setStorage')
  const custom = storage.folder === 'custom' && !!storage.tree
  const where = custom ? storage.tree!.name : storage.keep ? t('store.shared') : t('store.app')
  return (
    <Group title={t('store.title')}>
      <Row title={t('store.folder')} hint={where}>
        <div className="flex items-center gap-2">
          {custom && (
            <button onClick={() => void setStorage({ folder: 'custom' })} className="rounded-full bg-card-3 px-4 py-2 text-sm">
              {t('common.change')}
            </button>
          )}
          <Segmented<'default' | 'custom'>
            value={custom ? 'custom' : 'default'}
            onChange={(v) => void setStorage({ folder: v })}
            options={[
              { id: 'default', label: t('store.default') },
              { id: 'custom', label: t('store.custom') },
            ]}
          />
        </div>
      </Row>
      <Row title={t('store.afterUninstall')} hint={custom ? t('store.customKeeps') : storage.keep ? t('store.keepHint') : t('store.deleteHint')}>
        {custom ? (
          <span className="text-sm text-muted">{t('store.keep')}</span>
        ) : (
          <Segmented<'keep' | 'delete'>
            value={storage.keep ? 'keep' : 'delete'}
            onChange={(v) => void setStorage({ keep: v === 'keep' })}
            options={[
              { id: 'keep', label: t('store.keep') },
              { id: 'delete', label: t('store.delete') },
            ]}
          />
        )}
      </Row>
      {storage.moving && (
        <div className="flex flex-col gap-1.5 py-4">
          <DotLine size={4} value={storage.moving.done / storage.moving.total} />
          <span className="font-mono text-[11px] text-muted">{t('store.moving', { done: storage.moving.done, total: storage.moving.total })}</span>
        </div>
      )}
    </Group>
  )
}

/** «Защита»: PIN-код при запуске и после фона. Включить — придумать и повторить; выключить — ввести нынешний */
function PinSettings() {
  const { hasPin, setPinCode, toast } = usePick('hasPin', 'setPinCode', 'toast')
  const [open, setOpen] = useState(false)
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const close = () => {
    setOpen(false)
    setA('')
    setB('')
  }
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6)
  const field = 'w-full rounded-2xl bg-card-3 px-4 py-3 text-center font-mono text-2xl tracking-[0.4em] outline-none focus:ring-1 focus:ring-fg'
  const save = async () => {
    if (hasPin) {
      const { checkPin } = await import('../lib/pin')
      if (!(await checkPin(a))) return toast(t('pin.wrong'), 'error')
      await setPinCode(null)
      toast(t('pin.off'), 'ok')
    } else {
      if (a.length < 4) return
      if (a !== b) return toast(t('pin.mismatch'), 'error')
      await setPinCode(a)
      toast(t('pin.on'), 'ok')
    }
    close()
  }
  return (
    <Group title={t('pin.group')}>
      <Row title={t('pin.title')} hint={t('pin.hint')}>
        <Toggle on={hasPin} onChange={() => setOpen(true)} />
      </Row>
      {open && (
        <Sheet title={hasPin ? t('pin.turnOff') : t('pin.turnOn')} hint={hasPin ? t('pin.enterCurrent') : t('pin.forgot')} onClose={close}>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <input autoFocus type="password" inputMode="numeric" value={a} onChange={(e) => setA(digits(e.target.value))} placeholder="••••" className={field} />
            {!hasPin && (
              <input type="password" inputMode="numeric" value={b} onChange={(e) => setB(digits(e.target.value))} placeholder={t('pin.repeat')} className={field} />
            )}
            <button type="submit" disabled={a.length < 4 || (!hasPin && b.length < 4)} className="rounded-full bg-sel py-3 text-sm text-on-sel disabled:opacity-40">
              {hasPin ? t('pin.turnOff') : t('pin.turnOn')}
            </button>
          </form>
        </Sheet>
      )}
    </Group>
  )
}

/** «Экономия заряда»: авто / вкл / выкл и что сейчас */
function SaverSettings() {
  const { ui, setUi, power } = usePick('ui', 'setUi', 'power')
  const battery = power.battery === null ? '' : ` · ${t('set.saverBattery', { n: Math.round(power.battery * 100) })}`
  const hint = power.saving ? t('set.saverActive') + battery : ui.saver === 'auto' ? t('set.saverAutoHint') + battery : t('set.saverOffHint')
  return (
    <Group title={t('set.saver')}>
      <Row title={t('set.saver')} hint={hint}>
        <Segmented<SaverMode>
          value={ui.saver}
          onChange={(v) => setUi({ saver: v })}
          options={[
            { id: 'auto', label: t('set.saverAuto') },
            { id: 'on', label: t('set.saverOn') },
            { id: 'off', label: t('set.saverOff') },
          ]}
        />
      </Row>
      <p className="pt-1 pb-3 text-xs text-muted">{t('set.saverWhat')}</p>
    </Group>
  )
}

// Разделы настроек: слева список, справа выбранный. Библиотека и бэкапы — только у хоста, синхронизация — только у устройства.
// need: owner — только владельцу (старый сервер без ролей тоже считаем владельцем), users — только владельцу с сервером пользователей
const SECTIONS = [
  { id: 'look', label: 'set.look', icon: Palette, Body: LookSettings },
  { id: 'interface', label: 'set.interface', icon: PanelsTopLeft, Body: InterfaceSettings },
  { id: 'history', label: 'set.history', icon: History, Body: HistorySettings },
  { id: 'library', label: 'set.library', icon: Library, Body: LibrarySettings, host: true },
  { id: 'users', label: 'users.title', icon: Users, Body: UsersSettings, host: true, need: 'users' },
  { id: 'backup', label: 'bak.title', icon: DatabaseBackup, Body: BackupSettings, host: true, need: 'owner' },
  { id: 'playback', label: 'set.playback', icon: Music2, Body: PlaybackSettings },
  { id: 'edits', label: 'set.editsSection', icon: Pencil, Body: EditsSettings, host: false, need: 'server' },
  { id: 'device', label: 'nav.sync', icon: RefreshCw, Body: DeviceSettings, host: false },
] as const satisfies readonly { id: string; label: Key; icon: typeof Palette; Body: () => ReactNode; host?: boolean; need?: 'owner' | 'users' | 'server' }[]

/**
 * Настройки в две части: слева папки с музыкой (у хоста, всегда раскрыты) и список разделов, справа — выбранный раздел.
 * Выбор не запоминается: ушёл из настроек — в следующий раз снова чистый список
 */
export function Settings() {
  const [open, setOpen] = useState<(typeof SECTIONS)[number]['id'] | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLDivElement>(null)
  const isOwner = useStore(selectIsOwner)
  // «Пользователи» — владельцу и администраторам
  const hasUsers = useStore((s) => s.me?.role === 'owner' || s.me?.role === 'admin')
  // «Правка треков» на телефоне — только с сервером: правки и картинки живут там
  const standalone = useStore((s) => s.standalone)
  const sections = SECTIONS.filter(
    (x) => (!('host' in x) || x.host === isHost) && (!('need' in x) || (x.need === 'owner' ? isOwner : x.need === 'server' ? !standalone : hasUsers)),
  )
  const current = sections.find((x) => x.id === open)

  const pick = (id: (typeof SECTIONS)[number]['id']) => {
    setOpen(id)
    // в одну колонку раздел открывается под списком — подкручиваем к нему (колонки зависят от ширины страницы, а не окна)
    requestAnimationFrame(() => {
      const body = bodyRef.current
      const nav = navRef.current
      if (body && nav && body.offsetLeft <= nav.offsetLeft + 1) body.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  return (
    <div className="@container">
      <PageTitle>{t('nav.settings')}</PageTitle>
      {/* две колонки — когда самой странице хватает места (а не окну: рядом ещё боковое меню) */}
      <div className="grid items-start gap-3 @4xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
        <div ref={navRef} className="flex min-w-0 flex-col gap-3 @4xl:sticky @4xl:top-4">
          {/* хост: откуда брать музыку. Настраивается только здесь, без правки конфигов */}
          {isHost && <MusicFolders />}
          {/* дома — по локальному адресу (быстро, по Wi-Fi), вне дома — по домену */}
          {isHost && <RouteSwitch />}

          <nav className="widget flex flex-col p-2">
            {sections.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => pick(id)}
                aria-current={open === id}
                className={cx(
                  'flex items-center gap-3 rounded-2xl px-3 py-3 text-start text-[15px] transition-colors',
                  open === id ? 'bg-sel text-on-sel' : 'hover:bg-card-2',
                )}
              >
                <Icon size={18} strokeWidth={1.6} className={open === id ? '' : 'text-muted'} />
                <span className="flex-1">{t(label)}</span>
                <ChevronRight size={16} className={cx('rtl:rotate-180', open === id ? '' : 'text-muted')} />
              </button>
            ))}
          </nav>

          <AppFooter className="py-2" />
        </div>

        <div ref={bodyRef} className="min-w-0 scroll-mt-4">
          {/* пока раздел не выбран, справа пусто; key — заново при смене раздела, чтобы он плавно въезжал */}
          {current && (
            <div key={current.id} className="rise">
              <current.Body />
            </div>
          )}
        </div>
      </div>

    </div>
  )
}

/**
 * Хост: папки, которые сервер сканирует, и куда класть присланное с устройств. У владельца — все папки и чья каждая
 * (нажать — передать другому); остальные видят только свои, менять их может только владелец
 */
/**
 * Два режима веба: «Домен» (https, отовсюду, через интернет) и «Дома» (http://192.168…, по Wi-Fi напрямую — быстрее).
 * Это два разных адреса, у браузера для них разный вход — переходим с одноразовым кодом входа (как QR с телефона):
 * пароль не спрашивает. Адреса знает сервер (/api/health: lan — домашние, public — домен)
 */
function RouteSwitch() {
  const [r, setR] = useState<{ lan: string[]; pub: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useStore((s) => s.toast)
  useEffect(() => {
    api<{ lan?: string[]; public?: string | null }>('/health').then(
      (h) => setR({ lan: h.lan ?? [], pub: h.public ?? null }),
      () => setR(null),
    )
  }, [])
  if (!r) return null
  const home = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost$|127\.)|\.local$/.test(location.hostname)
  const target = home ? r.pub : r.lan[0]
  if (!target && !home && !r.lan.length && !r.pub) return null
  const go = async () => {
    if (!target || busy) return
    setBusy(true)
    try {
      const { code } = await api<{ code: string }>('/sync/codes', { method: 'POST' })
      location.href = `${target}/?pair=${code}`
    } catch (e) {
      setBusy(false)
      toast(e instanceof ApiError ? e.message : t('auth.offline'), 'error')
    }
  }
  const mode = home ? 'home' : 'domain'
  return (
    <div className="widget flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 text-[15px]">{t('route.title')}</div>
        <div className="flex rounded-full bg-card-3 p-1">
          {(['domain', 'home'] as const).map((m) => (
            <button
              key={m}
              disabled={busy || (m !== mode && !target)}
              onClick={() => m !== mode && void go()}
              className={cx('rounded-full px-4 py-1.5 text-sm transition-colors disabled:opacity-40', m === mode ? 'bg-sel text-on-sel' : 'text-muted hover:text-fg')}
            >
              {t(m === 'home' ? 'route.home' : 'route.domain')}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted">{!target ? t(home ? 'route.noDomain' : 'route.noHome') : t('route.hint')}</p>
    </div>
  )
}

function MusicFolders() {
  const { musicFolders, removeMusicFolder, setUploadFolder, users, loadUsers, me } = usePick('musicFolders', 'removeMusicFolder', 'setUploadFolder', 'users', 'loadUsers', 'me')
  const isOwner = useStore(selectIsOwner)
  const hasUsers = me?.role === 'owner' || me?.role === 'admin'
  const [picking, setPicking] = useState(false)
  const [ownerOf, setOwnerOf] = useState<MusicFolder | null>(null)
  const [moving, setMoving] = useState<MusicFolder | null>(null)
  // чьи папки — по списку пользователей; он нужен только владельцу
  useEffect(() => {
    if (hasUsers && !users.length) void loadUsers()
  }, [hasUsers, users.length, loadUsers])
  const ownerName = (id?: string) => {
    const u = users.find((x) => x.id === id)
    return u ? (u.id === me?.id ? t('users.you') : userLabel(u)) : t('folders.noOwner')
  }
  return (
    <Group title={t('folders.title')}>
      <p className="pb-2 text-xs text-muted">{isOwner ? t('folders.hint') : t('folders.hintUser')}</p>
      {musicFolders.map((f) => (
        <div key={f.path} className="flex items-center gap-3 border-b border-line py-3.5">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-card-3">
            <Folder size={17} strokeWidth={1.6} />
          </span>
          <div className="min-w-0 flex-1">
            <div dir="ltr" className="truncate text-start font-mono text-sm">{f.path}</div>
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
              {f.scanning ? (
                <span className="flex items-center gap-1.5">
                  <span className="blink h-1.5 w-1.5 rounded-full bg-red" />
                  {t('folders.scanning')}
                  {!!f.scanTotal && <span className="font-mono">{t('scan.progress', { done: f.scanDone ?? 0, total: f.scanTotal })}</span>}
                </span>
              ) : (
                <span>{tn('n.tracks', f.tracks)}</span>
              )}
              {f.uploads && <span className="text-fg">· {t('folders.uploads')}</span>}
              {/* чья папка: нажать — выбрать другого хозяина */}
              {hasUsers && users.length > 0 && (
                <button onClick={() => setOwnerOf(f)} title={t('folders.ownerPick')} className="flex items-center gap-1 text-fg hover:underline">
                  · <User size={11} /> {ownerName(f.userId)}
                </button>
              )}
            </div>
          </div>
          {isOwner && !f.uploads && (
            <button
              onClick={() => setUploadFolder(f.path)}
              title={t('folders.makeUploadsHint')}
              className="hidden rounded-full border border-line px-3 py-1.5 text-xs hover:border-fg @lg:block"
            >
              {t('folders.makeUploads')}
            </button>
          )}
          {isOwner && (
            <IconBtn title={t('folders.moved')} onClick={() => setMoving(f)} className="text-muted">
              <FolderInput size={17} />
            </IconBtn>
          )}
          {isOwner && (
            <IconBtn title={t('folders.remove')} onClick={() => removeMusicFolder(f.path)} className="text-muted">
              <X size={17} />
            </IconBtn>
          )}
        </div>
      ))}
      {isOwner && (
        <button
          onClick={() => setPicking(true)}
          className="my-3 flex items-center gap-2 rounded-full bg-sel px-4 py-2.5 text-sm text-on-sel transition-transform active:scale-95"
        >
          <FolderPlus size={16} /> {t('folders.add')}
        </button>
      )}
      {picking && <FolderPicker onClose={() => setPicking(false)} />}
      {ownerOf && <FolderOwnerSheet folder={ownerOf} onClose={() => setOwnerOf(null)} />}
      {moving && <MoveFolderSheet folder={moving} onClose={() => setMoving(null)} />}
    </Group>
  )
}

/** Выбор пользователя списком: себе или кому-то из сервера */
function UserChoice({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { users, me } = usePick('users', 'me')
  return (
    <div className="flex flex-col gap-1">
      {users.map((u) => (
        <button
          key={u.id}
          type="button"
          onClick={() => onChange(u.id)}
          className={cx('flex items-center gap-3 rounded-2xl px-3 py-2.5 text-start transition-colors', value === u.id ? 'bg-sel text-on-sel' : 'hover:bg-card-2')}
        >
          <Avatar name={userLabel(u)} size={28} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{u.id === me?.id ? `${userLabel(u)} · ${t('users.you')}` : userLabel(u)}</span>
            {u.login && (
              <span dir="ltr" className="block truncate text-start font-mono text-[11px] opacity-70">
                {u.login}
              </span>
            )}
          </span>
          {value === u.id && <Check size={16} />}
        </button>
      ))}
    </div>
  )
}

/** Передать папку другому: её треки переедут в его библиотеку */
function FolderOwnerSheet({ folder, onClose }: { folder: MusicFolder; onClose: () => void }) {
  const { setFolderOwner } = usePick('setFolderOwner')
  return (
    <Sheet title={t('folders.ownerTitle')} hint={t('folders.ownerHint')} onClose={onClose}>
      <div dir="ltr" className="mb-3 truncate text-start font-mono text-xs text-muted">{folder.path}</div>
      <UserChoice
        value={folder.userId ?? ''}
        onChange={(id) => {
          onClose()
          if (id !== folder.userId) void setFolderOwner(folder.path, id)
        }}
      />
    </Sheet>
  )
}

/**
 * Владелец: «Пользователи» — открыта ли регистрация и кто есть на сервере (логин, имя, когда заходил, треки, место).
 * У каждого: открыть библиотеку (только просмотр), сбросить пароль, удалить
 */
function UsersSettings() {
  const { users, loadUsers, loadServerSettings, registration, setRegistration, me, openUserLibrary, setUserRole } = usePick(
    'users',
    'loadUsers',
    'loadServerSettings',
    'registration',
    'setRegistration',
    'me',
    'openUserLibrary',
    'setUserRole',
  )
  const [loaded, setLoaded] = useState(false)
  const [handing, setHanding] = useState<ServerUser | null>(null)
  const iAmOwner = me?.role === 'owner'
  const [resetFor, setResetFor] = useState<ServerUser | null>(null)
  const [removing, setRemoving] = useState<ServerUser | null>(null)
  useEffect(() => {
    void Promise.all([loadUsers(), loadServerSettings()]).then(() => setLoaded(true))
  }, [loadUsers, loadServerSettings])
  const btn = 'rounded-full bg-card-3 px-3 py-1.5 text-xs transition-colors hover:bg-sel hover:text-on-sel'

  return (
    <div className="flex flex-col gap-3">
      <Group title={t('users.title')}>
        <Row title={t('users.registration')} hint={registration ? t('users.registrationOn') : t('users.registrationOff')}>
          <Toggle on={registration} onChange={(v) => void setRegistration(v)} />
        </Row>
      </Group>
      <Group title={t('users.list')}>
        {!loaded && !users.length && <div className="py-6 text-center text-sm text-muted">…</div>}
        {users.map((u) => {
          const self = u.id === me?.id
          return (
            <div key={u.id} className="flex items-start gap-3 border-b border-line py-3.5 last:border-0">
              <Avatar name={userLabel(u)} size={40} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 text-[15px]">
                  <span className="truncate">{userLabel(u)}</span>
                  {u.role === 'owner' && <span className="label text-muted">{t('acc.owner')}</span>}
                  {u.role === 'admin' && <span className="label text-muted">{t('users.admin')}</span>}
                  {self && <span className="text-xs text-muted">· {t('users.you')}</span>}
                </div>
                <div className="flex flex-wrap gap-x-2 text-xs text-muted">
                  <span dir="ltr" className="font-mono">{u.login ?? t('users.noLogin')}</span>
                  <span>· {tn('n.tracks', u.tracks)}</span>
                  <span>· {fmtSize(u.bytes / 1048576)}</span>
                  <span>· {u.lastSeenAt ? t('users.seen', { ago: fmtAgo(Date.parse(u.lastSeenAt)) }) : t('users.neverSeen')}</span>
                </div>
                {/* себя не удалить и не «посмотреть» — своя библиотека и так открыта; свой пароль — в «Аккаунте» */}
                {/* администратор не трогает владельца и других администраторов; роли и владение — только у владельца */}
                {!self && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button onClick={() => void openUserLibrary({ id: u.id, name: userLabel(u) })} className={btn}>
                      {t('users.openLib')}
                    </button>
                    {(iAmOwner || u.role === 'user') && (
                      <button onClick={() => setResetFor(u)} className={btn}>
                        {t('users.resetPass')}
                      </button>
                    )}
                    {iAmOwner && u.role !== 'owner' && (
                      <button onClick={() => void setUserRole(u.id, u.role === 'admin' ? 'user' : 'admin')} className={btn}>
                        {u.role === 'admin' ? t('users.unmakeAdmin') : t('users.makeAdmin')}
                      </button>
                    )}
                    {iAmOwner && u.login && (
                      <button onClick={() => setHanding(u)} className={btn}>
                        {t('users.giveOwner')}
                      </button>
                    )}
                    {u.role !== 'owner' && (iAmOwner || u.role === 'user') && (
                      <button onClick={() => setRemoving(u)} className="rounded-full px-3 py-1.5 text-xs text-red transition-colors hover:bg-red hover:text-on-red">
                        {t('users.delete')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
        {loaded && users.length <= 1 && <p className="pb-3 text-xs text-muted">{t('users.alone')}</p>}
      </Group>
      {resetFor && <ResetPasswordSheet user={resetFor} onClose={() => setResetFor(null)} />}
      {removing && <DeleteUserDialog user={removing} onClose={() => setRemoving(null)} />}
      {handing && <TransferOwnerSheet user={handing} onClose={() => setHanding(null)} />}
    </div>
  )
}

/** Передать владение: подтверждаем своим паролем; сам станешь администратором */
function TransferOwnerSheet({ user, onClose }: { user: ServerUser; onClose: () => void }) {
  const { transferOwner } = usePick('transferOwner')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const field = 'w-full rounded-2xl bg-card-3 px-4 py-3 text-[15px] outline-none placeholder:text-muted focus:ring-1 focus:ring-fg'
  return (
    <Sheet title={t('users.giveOwnerTitle', { name: userLabel(user) })} hint={t('users.giveOwnerHint')} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!password || busy) return
          setBusy(true)
          const ok = await transferOwner(user.id, password)
          setBusy(false)
          if (ok) onClose()
        }}
      >
        <input autoFocus type="password" autoComplete="current-password" placeholder={t('acc.current')} value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
        <button type="submit" disabled={!password || busy} className="rounded-full bg-red py-3 text-sm text-on-red disabled:opacity-40">
          {t('users.giveOwner')}
        </button>
      </form>
    </Sheet>
  )
}

/** Новый пароль пользователю: все его входы сбросятся */
function ResetPasswordSheet({ user, onClose }: { user: ServerUser; onClose: () => void }) {
  const { resetUserPassword } = usePick('resetUserPassword')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const hint = password && password.length < MIN_PASSWORD ? t('acc.passShort') : repeat && repeat !== password ? t('acc.passMismatch') : ''
  const ready = password.length >= MIN_PASSWORD && password === repeat
  const field = 'w-full rounded-2xl bg-card-3 px-4 py-3 text-[15px] outline-none placeholder:text-muted focus:ring-1 focus:ring-fg'
  return (
    <Sheet title={t('users.resetTitle', { name: userLabel(user) })} hint={t('users.resetHint')} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!ready || busy) return
          setBusy(true)
          const ok = await resetUserPassword(user.id, password)
          setBusy(false)
          if (ok) onClose()
        }}
      >
        <div className="relative">
          <input
            autoFocus
            type={show ? 'text' : 'password'}
            autoComplete="new-password"
            placeholder={t('acc.new')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={cx(field, 'pe-12')}
          />
          <button type="button" onClick={() => setShow(!show)} aria-label={show ? t('acc.hide') : t('acc.show')} className="absolute inset-y-0 end-0 grid w-12 place-items-center text-muted">
            {show ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <input type={show ? 'text' : 'password'} autoComplete="new-password" placeholder={t('auth.repeat')} value={repeat} onChange={(e) => setRepeat(e.target.value)} className={field} />
        <div className={cx('min-h-4 text-xs', hint ? 'text-red' : 'text-muted')}>{hint || t('acc.passHint')}</div>
        <button type="submit" disabled={!ready || busy} className="rounded-full bg-sel py-3 text-sm text-on-sel disabled:opacity-40">
          {t('users.resetGo')}
        </button>
      </form>
    </Sheet>
  )
}

/** Удалить пользователя: его записи и загруженную им музыку. Назначенные ему папки на диске остаются */
function DeleteUserDialog({ user, onClose }: { user: ServerUser; onClose: () => void }) {
  const { deleteUser } = usePick('deleteUser')
  const [busy, setBusy] = useState(false)
  return (
    <Modal onClose={onClose}>
      <div className="mb-2 text-lg font-medium">{t('users.deleteAsk', { name: userLabel(user) })}</div>
      <p className="mb-2 text-sm text-muted">{t('users.deleteHint', { login: user.login ?? '—' })}</p>
      <p className="mb-5 text-xs text-muted">{t('users.deleteKeep')}</p>
      <div className="flex gap-2">
        <button onClick={onClose} className="flex-1 rounded-full py-3 text-sm text-muted hover:text-fg">
          {t('common.cancel')}
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await deleteUser(user.id)
            onClose()
          }}
          className="flex-1 rounded-full bg-red py-3 text-sm text-on-red disabled:opacity-50"
        >
          {t('users.delete')}
        </button>
      </div>
    </Modal>
  )
}

/** Путь крошками: «/», «/mnt», «/mnt/das» — или «C:\», «C:\Music» на Windows */
function crumbsOf(path: string): { label: string; path: string }[] {
  const sep = pathSep(path)
  const root = sep === '/' ? '/' : path.slice(0, path.indexOf('\\') + 1)
  const parts = path.slice(root.length).split(sep).filter(Boolean)
  return [{ label: root, path: root }, ...parts.map((p, i) => ({ label: p, path: root + parts.slice(0, i + 1).join(sep) }))]
}

/** Обзор папок сервера: ходим по дереву и добавляем ту, где стоим */
function FolderPicker({ onClose }: { onClose: () => void }) {
  const { addMusicFolder, toast, users, me } = usePick('addMusicFolder', 'toast', 'users', 'me')
  const [dir, setDir] = useState<DirListing | null>(null)
  const [busy, setBusy] = useState(false)
  // чья будет папка: по умолчанию своя; выбор — когда на сервере есть кто-то ещё
  const [userId, setUserId] = useState(me?.id ?? '')
  const [choosingUser, setChoosingUser] = useState(false)
  const forUser = users.find((u) => u.id === userId)

  const open = async (path?: string) => {
    try {
      setDir(await api<DirListing>(`/fs${path ? `?path=${encodeURIComponent(path)}` : ''}`))
    } catch (e) {
      toast(e instanceof ApiError ? e.message : t('auth.offline'), 'error')
    }
  }

  // корень сервера — при открытии окна
  useEffect(() => {
    open()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cwd = dir?.path ?? ''
  const [typed, setTyped] = useState(cwd)
  useEffect(() => setTyped(cwd), [cwd])
  const join =(name: string) => (cwd.endsWith(pathSep(cwd)) ? cwd + name : cwd + pathSep(cwd) + name)
  const isRoot = !dir?.parent

  return (
    <Modal onClose={onClose}>
      <div className="mb-1 flex items-start justify-between gap-4">
        <h2 className="text-xl font-medium">{t('folders.pick')}</h2>
        <IconBtn title={t('common.close')} onClick={onClose} className="-mt-1 -me-2">
          <X size={18} />
        </IconBtn>
      </div>
      <p className="mb-4 text-xs text-muted">{t('folders.pickHint')}</p>

      {/* путь крошками: клик — подняться туда */}
      <div dir="ltr" className="mb-2 flex min-h-7 flex-wrap items-center gap-0.5 font-mono text-xs">
        {dir &&
          crumbsOf(cwd).map((c, i) => (
            <span key={c.path} className="flex items-center gap-0.5">
              {i > 1 && <span className="text-muted">{pathSep(cwd)}</span>}
              <button onClick={() => open(c.path)} className="rounded-full px-2 py-1 hover:bg-card-3">
                {c.label}
              </button>
            </span>
          ))}
      </div>

      {/* высота постоянная: окно не прыгает, когда в папке мало вложенных */}
      <div className="-mx-2 flex h-64 flex-col overflow-y-auto">
        {!dir && <div className="px-2 py-6 text-center text-sm text-muted">…</div>}
        {dir?.parent && (
          <button onClick={() => open(dir.parent!)} className="flex items-center gap-3 rounded-2xl px-2 py-2.5 text-sm text-muted hover:bg-card-2">
            <CornerLeftUp size={16} strokeWidth={1.6} /> {t('folders.up')}
          </button>
        )}
        {dir?.dirs.map((name) => (
          <button
            key={name}
            onClick={() => open(join(name))}
            className="flex items-center gap-3 rounded-2xl px-2 py-2.5 text-start text-sm hover:bg-card-2"
          >
            <Folder size={16} strokeWidth={1.6} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            <ChevronRight size={16} className="shrink-0 text-muted rtl:rotate-180" />
          </button>
        ))}
        {dir && !dir.dirs.length && <div className="px-2 py-6 text-center text-sm text-muted">{t('folders.empty')}</div>}
      </div>

      {/* путь можно и вставить: Enter — перейти туда */}
      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (typed.trim()) open(typed.trim())
        }}
      >
        <input
          dir="ltr"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-label={t('folders.pathLabel')}
          placeholder="/mnt/das/music"
          className="w-full rounded-full bg-card-3 px-4 py-2 font-mono text-xs outline-none focus:ring-1 focus:ring-fg"
        />
      </form>

      {me && (me.role === 'owner' || me.role === 'admin') && users.length > 1 && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-sm text-muted">{t('folders.forUser')}</span>
          <button onClick={() => setChoosingUser(true)} className="flex min-w-0 items-center gap-1.5 rounded-full bg-card-3 px-4 py-2 text-sm">
            <User size={14} className="shrink-0" />
            <span className="truncate">{forUser ? (forUser.id === me.id ? t('users.you') : userLabel(forUser)) : t('users.you')}</span>
            <ChevronDown size={14} className="shrink-0 text-muted" />
          </button>
        </div>
      )}
      {choosingUser && (
        <Sheet title={t('folders.forUser')} onClose={() => setChoosingUser(false)}>
          <UserChoice
            value={userId}
            onChange={(id) => {
              setUserId(id)
              setChoosingUser(false)
            }}
          />
        </Sheet>
      )}

      <div className="mt-4 flex items-center justify-end gap-3">
        <button onClick={onClose} className="rounded-full px-4 py-2.5 text-sm hover:bg-card-3">
          {t('common.cancel')}
        </button>
        <button
          disabled={isRoot || busy}
          onClick={async () => {
            setBusy(true)
            const ok = await addMusicFolder(cwd, userId || undefined)
            setBusy(false)
            if (ok) onClose()
          }}
          className="rounded-full bg-sel px-4 py-2.5 text-sm text-on-sel transition-transform active:scale-95 disabled:opacity-40"
        >
          {t('folders.choose')}
        </button>
      </div>
    </Modal>
  )
}

// ---------- ListenBrainz / Last.fm ----------

type ScrobbleOne = { connected: boolean; user: string | null; sent: number; lastSentAt: string | null; error: string | null; waiting?: boolean }
type ScrobbleStatus = { listenbrainz: ScrobbleOne; lastfm: ScrobbleOne }

/** Прослушивания — на ListenBrainz и Last.fm. Отправляет сервер (со всех устройств); без сервера — не показываем */
export function ScrobbleRows({ inPage, bare }: { inPage?: boolean; bare?: boolean } = {}) {
  const { standalone, conn } = usePick('standalone', 'conn')
  const [st, setSt] = useState<ScrobbleStatus | null>(null)
  useEffect(() => {
    if (!standalone && conn === 'online') api<ScrobbleStatus>('/scrobble').then(setSt, () => setSt(null))
  }, [standalone, conn])
  if (!st) return null
  const value = (o: ScrobbleOne) => <span className={cx('text-xs', o.connected ? 'text-fg' : 'text-muted')}>{o.connected ? o.user || t('scr.on') : t('scr.off')}</span>
  const rows = (
    <>
      {/* отдельной подпиской в «Истории» — иначе строки терялись среди настроек истории */}
      {!bare && <div className={cx('label pb-1 text-muted', inPage ? 'pt-3' : 'border-t border-line pt-5')}>{t('scr.section')}</div>}
      <PopupRow title="ListenBrainz" hint={t('scr.lbHint')} value={value(st.listenbrainz)} apply={false}>
        {(close) => <ScrobbleBody service="listenbrainz" st={st} onChange={setSt} onDone={close} />}
      </PopupRow>
      <PopupRow title="Last.fm" hint={t('scr.lfHint')} value={value(st.lastfm)} apply={false}>
        {(close) => <ScrobbleBody service="lastfm" st={st} onChange={setSt} onDone={close} />}
      </PopupRow>
    </>
  )
  // на странице «История» — своим блоком; в настройках — строками группы
  return inPage ? <section className="widget mb-6 px-5 pb-1">{rows}</section> : rows
}

function ScrobbleBody({ service, st, onChange, onDone }: { service: 'listenbrainz' | 'lastfm'; st: ScrobbleStatus; onChange: (s: ScrobbleStatus) => void; onDone: () => void }) {
  const toast = useStore((x) => x.toast)
  const o = st[service]
  const [token, setToken] = useState('')
  const [key, setKey] = useState('')
  const [secret, setSecret] = useState('')
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const field = 'w-full rounded-2xl bg-card-3 px-4 py-3 font-mono text-sm outline-none placeholder:text-muted focus:ring-1 focus:ring-fg'
  const btn = 'flex items-center justify-center gap-2 rounded-full px-5 py-3 text-sm transition-transform active:scale-95 disabled:opacity-40'
  const link = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-fg underline underline-offset-4">
      {label}
    </a>
  )

  if (o.connected)
    return (
      <div className="flex flex-col gap-4 text-sm">
        <div className="rounded-2xl bg-card-2 p-4">
          <div className="text-[15px]">{t('scr.connectedAs', { user: o.user || '—' })}</div>
          <div className="mt-1 text-xs text-muted">
            {t('scr.sent', { n: o.sent })}
            {o.lastSentAt && ` · ${fmtAgo(Date.parse(o.lastSentAt))}`}
          </div>
          {o.error && <div className="mt-2 text-xs text-red">{o.error}</div>}
        </div>
        <p className="text-xs text-muted">{t('scr.howItWorks')}</p>
        <div className="flex gap-2">
          <button disabled={busy} onClick={() => run(async () => onChange(await api<ScrobbleStatus>('/scrobble/now', { method: 'POST' })))} className={cx(btn, 'flex-1 bg-card-3')}>
            {t('scr.sendNow')}
          </button>
          <button disabled={busy} onClick={() => run(async () => onChange(await api<ScrobbleStatus>(`/scrobble/${service}`, { method: 'DELETE' })))} className={cx(btn, 'flex-1 bg-card-3 text-red')}>
            {t('scr.disconnect')}
          </button>
        </div>
        <button onClick={onDone} className={cx(btn, 'bg-sel text-on-sel')}>
          {t('common.done')}
        </button>
      </div>
    )

  if (service === 'listenbrainz')
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted">{t('scr.lbWhat')}</p>
        <ol className="flex list-decimal flex-col gap-1 ps-5 text-muted">
          <li>{link('https://listenbrainz.org/settings/', t('scr.lbStep1'))}</li>
          <li>{t('scr.lbStep2')}</li>
        </ol>
        <input value={token} onChange={(e) => setToken(e.target.value)} placeholder={t('scr.tokenPh')} className={field} autoComplete="off" spellCheck={false} />
        <button
          disabled={busy || !token.trim()}
          onClick={() => run(async () => onChange(await api<ScrobbleStatus>('/scrobble/listenbrainz', { method: 'PUT', body: { token } })))}
          className={cx(btn, 'bg-sel text-on-sel')}
        >
          {t('scr.connect')}
        </button>
      </div>
    )

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-muted">{t('scr.lfWhat')}</p>
      {!authUrl ? (
        <>
          <ol className="flex list-decimal flex-col gap-1 ps-5 text-muted">
            <li>{link('https://www.last.fm/api/account/create', t('scr.lfStep1'))}</li>
            <li>{t('scr.lfStep2')}</li>
          </ol>
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key" className={field} autoComplete="off" spellCheck={false} />
          <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Shared secret" className={field} autoComplete="off" spellCheck={false} />
          <button
            disabled={busy || !key.trim() || !secret.trim()}
            onClick={() => run(async () => setAuthUrl((await api<{ authUrl: string }>('/scrobble/lastfm/start', { method: 'POST', body: { apiKey: key, secret } })).authUrl))}
            className={cx(btn, 'bg-sel text-on-sel')}
          >
            {t('scr.next')}
          </button>
        </>
      ) : (
        <>
          <p className="text-muted">{t('scr.lfStep3')}</p>
          <a href={authUrl} target="_blank" rel="noopener noreferrer" className={cx(btn, 'border border-ink/20')}>
            {t('scr.lfOpen')}
          </a>
          <button
            disabled={busy}
            onClick={() => run(async () => onChange(await api<ScrobbleStatus>('/scrobble/lastfm/finish', { method: 'POST' })))}
            className={cx(btn, 'bg-sel text-on-sel')}
          >
            {t('scr.lfAllowed')}
          </button>
        </>
      )}
    </div>
  )
}

/** «!» у тем «Сервисы»: нажал — пояснение, что это лишь цвета в духе сервисов и MUSICH с ними не связан */
function BrandNote() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={t('palg.servicesNote')}
        aria-expanded={open}
        className="ms-1.5 inline-grid h-4 w-4 place-items-center rounded-full border border-current align-[-2px] text-[10px] leading-none font-bold normal-case"
      >
        !
      </button>
      {open && <span className="mt-1 block text-[11px] leading-snug tracking-normal normal-case">{t('palg.servicesNote')}</span>}
    </>
  )
}

/** «Папка переехала»: новый путь той же музыки на сервере — пути в базе переписываются, лайки и плейлисты остаются */
function MoveFolderSheet({ folder, onClose }: { folder: MusicFolder; onClose: () => void }) {
  const moveMusicFolder = useStore((s) => s.moveMusicFolder)
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    const ok = await moveMusicFolder(folder.path, to.trim())
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Sheet title={t('folders.moved')} hint={t('folders.movedHint')} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="text-xs text-muted">{t('folders.movedFrom')}</div>
        <div dir="ltr" className="truncate rounded-2xl bg-card-2 px-4 py-3 font-mono text-sm">{folder.path}</div>
        <div className="text-xs text-muted">{t('folders.movedTo')}</div>
        <input
          dir="ltr"
          autoFocus
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="/mnt/disk/Music"
          spellCheck={false}
          className="rounded-2xl bg-card-3 px-4 py-3 font-mono text-sm outline-none focus:ring-1 focus:ring-fg"
        />
        <button disabled={busy || !to.trim()} onClick={() => void go()} className="rounded-full bg-sel py-3 text-sm text-on-sel disabled:opacity-40">
          {t('folders.movedGo')}
        </button>
      </div>
    </Sheet>
  )
}

/**
 * Адрес сервера в домашней сети: телефон дома ходит по нему напрямую, вне дома — через домен. Сервер находит его сам
 * (адрес, по которому его открывали дома); здесь видно найденное и можно вписать свой. Только владельцу и админам
 */
function LanRow() {
  type Lan = { manual: string; found: string[] }
  const [data, setData] = useState<Lan | null>(null)
  const [text, setText] = useState('')
  const toast = useStore((s) => s.toast)
  useEffect(() => {
    api<Lan>('/server/lan').then(
      (r) => {
        setData(r)
        setText(r.manual.replace(/^http:\/\//, ''))
      },
      () => setData(null),
    )
  }, [])
  if (!data) return null
  const short = (u: string) => u.replace(/^http:\/\//, '')
  const save = () => {
    if (text.trim() === short(data.manual)) return
    api<Lan>('/server/lan', { method: 'PUT', body: { manual: text } }).then(
      (r) => {
        setData(r)
        setText(short(r.manual))
        toast(t('lan.saved'), 'ok')
      },
      (e) => toast(e instanceof ApiError && e.status === 400 ? t('lan.bad') : t('auth.offline'), 'error'),
    )
  }
  const auto = data.found.filter((u) => u !== data.manual).map(short)
  return (
    <Row title={t('lan.title')} hint={`${t('lan.hint')} ${auto.length ? t('lan.found', { list: auto.join(', ') }) : t('lan.none')}`}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        placeholder={auto[0] ?? '192.168.1.50:2290'}
        dir="ltr"
        className="w-60 max-w-full rounded-2xl bg-card-3 px-4 py-2.5 font-mono text-sm outline-none placeholder:text-muted focus:ring-1 focus:ring-fg"
      />
    </Row>
  )
}

/** Проверять, не вышла ли новая версия MUSICH (раз в сутки, только номер версии с GitHub) */
function UpdateCheckRow() {
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    api<{ check: boolean }>('/server/update').then((r) => setOn(r.check), () => setOn(null))
  }, [])
  if (on === null) return null
  return (
    <Row title={t('upd.check')} hint={t('upd.checkHint')}>
      <Toggle on={on} onChange={(v) => void api('/server/update', { method: 'PUT', body: { check: v } }).then(() => setOn(v), () => {})} />
    </Row>
  )
}
