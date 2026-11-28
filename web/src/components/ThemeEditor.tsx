import { Pipette, Plus, Trash, X, ImagePlus } from 'lucide-react'
import { useState, type ReactNode, useRef } from 'react'
import { t } from '../i18n'
import { ACCENTS, customPalette, onAccent, previewBackground, type BgKind, type CustomTheme } from '../lib/themes'
import { usePick } from '../store'
import { Modal } from './Dialogs'
import { cx, IconBtn } from './ui'

// Быстрые цвета для виджетов: тёмные в духе Nothing и пара светлых
const WIDGETS = ['#0d0d0d', '#111827', '#1a1026', '#0f1f17', '#24140c', '#2a2a2a', '#e9e7e2', '#ffffff']

/** Кружок с системной пипеткой: показывает цвет, по клику — выбор любого */
function ColorDot({ value, onChange, title, children }: { value: string; onChange: (v: string) => void; title: string; children?: ReactNode }) {
  return (
    <label title={title} className="relative grid h-9 w-9 cursor-pointer place-items-center rounded-full ring-1 ring-line" style={{ background: value, color: onAccent(value) }}>
      {children ?? <Pipette size={13} />}
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
    </label>
  )
}

/** Готовые цвета + свой */
function Swatches({ value, options, onChange, title }: { value: string; options: string[]; onChange: (v: string) => void; title: string }) {
  return (
    <div dir="ltr" className="flex flex-wrap items-center gap-2">
      {options.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          title={c}
          className={cx('h-7 w-7 rounded-full ring-offset-2 ring-offset-card', value === c ? 'ring-2 ring-fg' : 'ring-1 ring-line')}
          style={{ background: c }}
        />
      ))}
      <ColorDot value={options.includes(value) ? '#888888' : value} onChange={onChange} title={title} />
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="label text-muted">{label}</span>
      {children}
    </div>
  )
}

/**
 * Своя тема: фон (цвет, плавный градиент или пятна), виджеты и акцент — с живым превью в текущем режиме.
 * Сохранённая тема сразу включается; в тёмном режиме её фон приглушается сам
 */
export function ThemeEditor({ initial, isNew, onClose }: { initial: CustomTheme; isNew: boolean; onClose: () => void }) {
  const { theme: mode, saveCustomTheme, deleteCustomTheme } = usePick('theme', 'saveCustomTheme', 'deleteCustomTheme')
  const [c, setC] = useState(initial)
  const patch = (p: Partial<CustomTheme>) => setC({ ...c, ...p })
  const m = customPalette(c)[mode]
  const count = c.bg === 'solid' ? 1 : c.colors.length

  const kinds: { id: BgKind; label: string }[] = [
    { id: 'solid', label: t('theme.solid') },
    { id: 'linear', label: t('theme.linear') },
    { id: 'mesh', label: t('theme.mesh') },
    { id: 'image', label: t('theme.image') },
  ]

  return (
    <Modal onClose={onClose}>
      <div className="mb-4 flex items-start justify-between">
        <span className="label text-muted">{isNew ? t('theme.new') : t('theme.edit')}</span>
        <IconBtn title={t('common.close')} onClick={onClose} className="-mt-2 -me-2">
          <X size={18} />
        </IconBtn>
      </div>

      {/* превью: фон страницы с подписью её цветом и виджет с акцентом */}
      <div className="relative mb-5 h-44 overflow-hidden rounded-3xl ring-1 ring-line" style={previewBackground(m)}>
        <span className="font-dot absolute top-3 left-4 text-lg font-black" style={{ color: m.ink }}>
          MUSICH
        </span>
        <span className="absolute top-4 left-[6.4rem] h-1.5 w-1.5 rounded-full" style={{ background: c.accent }} />
        <div className="absolute inset-x-4 top-12 bottom-4 rounded-2xl p-3" style={{ background: m.card, boxShadow: `inset 0 0 0 1px ${m.border}`, color: m.fg }}>
          <div className="flex items-center gap-2 rounded-xl px-2 py-1.5" style={{ background: m.card2 }}>
            <span className="h-2 w-2 rounded-full" style={{ background: c.accent }} />
            <span className="text-xs" style={{ color: c.accent }}>
              {c.name || t('theme.namePh')}
            </span>
          </div>
          <div className="mt-1.5 px-2 text-xs" style={{ color: m.muted }}>
            {t('theme.previewRow')}
          </div>
          <span className="absolute right-3 bottom-3 rounded-full px-3 py-1 text-xs" style={{ background: c.accent, color: onAccent(c.accent) }}>
            {t('common.play')}
          </span>
          <span className="absolute bottom-4 left-3 flex gap-1">
            {Array.from({ length: 10 }, (_, i) => (
              <span key={i} className="h-1.5 w-1.5 rounded-full" style={{ background: i < 6 ? m.fg : m.dotOff }} />
            ))}
          </span>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          saveCustomTheme({ ...c, name: c.name.trim() || t('theme.namePh') })
          onClose()
        }}
        className="flex flex-col gap-4"
      >
        <input
          autoFocus
          value={c.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder={t('theme.namePh')}
          maxLength={40}
          className="rounded-2xl bg-card-3 px-4 py-3 text-[15px] outline-none focus:ring-1 focus:ring-fg"
        />

        <Field label={t('theme.bg')}>
          <div className="flex rounded-full bg-card-3 p-1">
            {kinds.map((k) => (
              <button
                key={k.id}
                type="button"
                onClick={() => patch({ bg: k.id })}
                className={cx('flex-1 rounded-full py-1.5 text-sm transition-colors', c.bg === k.id ? 'bg-sel text-on-sel' : 'text-muted hover:text-fg')}
              >
                {k.label}
              </button>
            ))}
          </div>
          {c.bg === 'image' ? (
            <ImageBg c={c} patch={patch} />
          ) : (
          <div dir="ltr" className="flex items-center gap-2">
            {c.colors.slice(0, count).map((col, i) => (
              <div key={i} className="group relative">
                <ColorDot value={col} title={t('theme.color')} onChange={(v) => patch({ colors: c.colors.map((x, j) => (j === i ? v : x)) })} />
                {/* у градиента цветов 2–3: лишний можно убрать */}
                {c.bg !== 'solid' && count > 2 && (
                  <button
                    type="button"
                    onClick={() => patch({ colors: c.colors.filter((_, j) => j !== i) })}
                    title={t('theme.removeColor')}
                    className="absolute -top-1 -right-1 hidden h-4 w-4 place-items-center rounded-full bg-sel text-on-sel group-hover:grid"
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            ))}
            {c.bg !== 'solid' && count < 3 && (
              <button
                type="button"
                onClick={() => patch({ colors: [...c.colors, c.colors[c.colors.length - 1] ?? '#888888'] })}
                title={t('theme.addColor')}
                className="grid h-9 w-9 place-items-center rounded-full border border-dashed border-line text-muted hover:text-fg"
              >
                <Plus size={14} />
              </button>
            )}
            {c.bg === 'linear' && (
              <label className="ms-3 flex flex-1 items-center gap-2 text-xs text-muted">
                {t('theme.angle')}
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={5}
                  value={c.angle}
                  onChange={(e) => patch({ angle: Number(e.target.value) })}
                  className="flex-1 accent-[var(--red)]"
                />
                <span className="w-9 text-end font-mono">{c.angle}°</span>
              </label>
            )}
          </div>
          )}
        </Field>

        <Field label={t('theme.widgets')}>
          <Swatches value={c.widget} options={WIDGETS} onChange={(widget) => patch({ widget })} title={t('set.accentCustom')} />
        </Field>

        <Field label={t('set.accent')}>
          <Swatches value={c.accent} options={ACCENTS} onChange={(accent) => patch({ accent })} title={t('set.accentCustom')} />
        </Field>

        <p className="text-xs text-muted">{t('theme.darkNote')}</p>

        <div className="mt-1 flex gap-2">
          {!isNew && (
            <IconBtn
              title={t('theme.delete')}
              onClick={() => {
                deleteCustomTheme(c.id)
                onClose()
              }}
              className="h-12 w-12 text-muted hover:text-red"
            >
              <Trash size={17} />
            </IconBtn>
          )}
          <button type="button" onClick={onClose} className="flex-1 rounded-full py-3 text-sm text-muted hover:text-fg">
            {t('common.cancel')}
          </button>
          <button type="submit" className="flex-1 rounded-full bg-sel py-3 text-sm text-on-sel">
            {t('common.save')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Уменьшенная копия картинки для фона (до 1920 px по длинной стороне, JPEG) и её средняя яркость */
async function prepareImage(file: Blob): Promise<{ url: string; lum: number }> {
  const bmp = await createImageBitmap(file)
  const k = Math.min(1, 1920 / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.round(bmp.width * k)
  c.height = Math.round(bmp.height * k)
  const g = c.getContext('2d')!
  g.imageSmoothingQuality = 'high'
  g.drawImage(bmp, 0, 0, c.width, c.height)
  const s = document.createElement('canvas')
  s.width = s.height = 16
  const sg = s.getContext('2d')!
  sg.drawImage(bmp, 0, 0, 16, 16)
  bmp.close()
  const px = sg.getImageData(0, 0, 16, 16).data
  let sum = 0
  for (let i = 0; i < px.length; i += 4) sum += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255
  return { url: c.toDataURL('image/jpeg', 0.82), lum: sum / (px.length / 4) }
}

/**
 * Фон-картинка: выбрать файл, отметить на ней главное (точка фокуса — по ней картинка подрезается на любом экране),
 * затемнение для читаемости. Ниже — как фон ляжет на телефоне, планшете и ПК
 */
function ImageBg({ c, patch }: { c: CustomTheme; patch: (p: Partial<CustomTheme>) => void }) {
  const file = useRef<HTMLInputElement>(null)
  const [fx, fy] = c.focus ?? [50, 50]
  const pick = async (f?: File | null) => {
    if (!f || !f.type.startsWith('image/')) return
    const { url, lum } = await prepareImage(f)
    patch({ image: url, lum, focus: [50, 50], dim: c.dim ?? 25 })
  }
  const frame = (w: number, h: number, label: string) => (
    <div className="flex flex-col items-center gap-1">
      <div
        className="rounded-lg ring-1 ring-line"
        style={{ width: w, height: h, backgroundImage: `url("${c.image}")`, backgroundSize: 'cover', backgroundPosition: `${fx}% ${fy}%` }}
      />
      <span className="text-[10px] text-muted">{label}</span>
    </div>
  )
  return (
    <div className="flex flex-col gap-3">
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      {c.image ? (
        <>
          {/* нажми на главное на картинке — эта часть останется в кадре на любом экране */}
          <div
            className="relative w-full cursor-crosshair overflow-hidden rounded-2xl ring-1 ring-line"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              patch({ focus: [Math.round(((e.clientX - r.left) / r.width) * 100), Math.round(((e.clientY - r.top) / r.height) * 100)] })
            }}
          >
            <img src={c.image} alt="" className="block w-full select-none" draggable={false} />
            <span
              className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_2px_rgb(0_0_0/.5)]"
              style={{ left: `${fx}%`, top: `${fy}%` }}
            />
          </div>
          <p className="-mt-1 text-xs text-muted">{t('theme.focusHint')}</p>
          <div dir="ltr" className="flex items-end justify-center gap-3">
            {frame(36, 74, t('theme.onPhone'))}
            {frame(70, 92, t('theme.onTablet'))}
            {frame(128, 72, t('theme.onPc'))}
          </div>
          <label className="flex items-center gap-2 text-xs text-muted">
            {t('theme.dim')}
            <input type="range" min={0} max={80} step={5} value={c.dim ?? 25} onChange={(e) => patch({ dim: Number(e.target.value) })} className="flex-1 accent-[var(--red)]" />
            <span className="w-9 text-end font-mono">{c.dim ?? 25}%</span>
          </label>
          <button type="button" onClick={() => file.current?.click()} className="self-start rounded-full border border-line px-4 py-2 text-sm hover:border-fg">
            {t('theme.imageChange')}
          </button>
        </>
      ) : (
        <button type="button" onClick={() => file.current?.click()} className="flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-ink/20 py-6 text-sm text-muted hover:border-ink/50 hover:text-fg">
          <ImagePlus size={18} /> {t('theme.imagePick')}
        </button>
      )}
    </div>
  )
}
