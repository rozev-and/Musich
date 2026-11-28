import { useRef, type ReactNode, useState } from 'react'
import { t } from '../i18n'
import { hue } from '../lib/format'
import type { TrackStatus } from '../types'
import { useThumb } from '../lib/thumbs'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')
export { cx }

/** Точечный индикатор, как в виджетах Nothing. Только для показа (место, загрузки) */
export function DotBar({
  value,
  dots = 40,
  size = 5,
  className,
}: {
  value: number // 0..1
  dots?: number
  size?: number
  className?: string
}) {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * dots)
  return (
    <div dir="ltr" className={cx('flex items-center justify-between gap-px', className)}>
      {Array.from({ length: dots }, (_, i) => (
        <span
          key={i}
          className={cx('shrink-0 rounded-full transition-colors', i < filled ? 'bg-fg' : 'bg-dot-off')}
          style={{ width: size, height: size }}
        />
      ))}
    </div>
  )
}

/** Точечная линия на всю ширину: шаг точек постоянный, сколько влезет — столько и рисуем */
export function DotLine({ value, size = 4, className }: { value: number; size?: number; className?: string }) {
  const step = size * 2
  const dots = (color: string) => ({
    backgroundImage: `radial-gradient(circle, ${color} ${size / 2}px, transparent ${size / 2 + 0.5}px)`,
    backgroundSize: `${step}px ${size}px`,
    backgroundPosition: 'left center',
  })
  const pct = Math.max(0, Math.min(1, value)) * 100
  return (
    <div dir="ltr" className={cx('relative w-full', className)} style={{ height: size }}>
      <div className="absolute inset-0" style={dots('var(--dot-off)')} />
      {/* заливку округляем до целой точки, но хотя бы одну показываем при ненулевом значении */}
      <div
        className="absolute inset-y-0 left-0"
        style={{ ...dots('var(--fg)'), width: pct > 0 ? `max(${step}px, round(${pct}%, ${step}px))` : 0 }}
      />
    </div>
  )
}

/** Сплошная полоса перемотки / громкости. Клик или драг меняет значение */
export function Seek({
  value,
  onChange,
  className,
}: {
  value: number // 0..1
  onChange: (v: number) => void
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const pct = `${Math.max(0, Math.min(1, value)) * 100}%`

  const seekAt = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect()
    if (r) onChange(Math.max(0, Math.min(1, (clientX - r.left) / r.width)))
  }

  return (
    <div
      ref={ref}
      dir="ltr"
      className={cx('group relative flex h-5 min-w-0 cursor-pointer touch-none items-center', className)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        seekAt(e.clientX)
      }}
      onPointerMove={(e) => e.buttons === 1 && seekAt(e.clientX)}
    >
      <div className="h-[3px] w-full overflow-hidden rounded-full bg-dot-off">
        <div className="h-full bg-fg" style={{ width: pct }} />
      </div>
      <span
        className="absolute h-3 w-3 -translate-x-1/2 rounded-full bg-fg transition-transform group-hover:scale-125"
        style={{ left: pct }}
      />
    </div>
  )
}

/** Обложка: картинка из тегов, а если её нет — симметричный точечный узор из названия (идентикон) */
export function Cover({
  seed,
  src,
  className,
  rounded = 'rounded-2xl',
  size = 160,
}: {
  seed: string
  src?: string
  className?: string
  rounded?: string
  /** ширина картинки в пикселях: в списках хватает маленькой копии (lib/thumbs); 0 — оригинал (большой плеер) */
  size?: number
}) {
  // картинка не открылась (нет сети, файла нет) — вместо значка «битой картинки» рисуем узор по названию, как без обложки
  const [broken, setBroken] = useState<string | null>(null)
  const shown = useThumb(src, size)
  // картинку с телефона ещё ужимаем — пустая плашка того же размера, без мигания узором
  if (src && !shown) return <div className={cx('shrink-0 bg-card-2', rounded, className)} />
  if (shown && broken !== shown)
    return <img src={shown} alt="" loading="lazy" decoding="async" onError={() => setBroken(shown)} className={cx('shrink-0 bg-card-2 object-cover', rounded, className)} />
  let h = hue(seed) * 7919 + seed.length
  const cells: boolean[] = []
  for (let i = 0; i < 15; i++) {
    h = (h * 1103515245 + 12345) % 2147483648
    cells.push(h % 3 !== 0)
  }
  const grid: boolean[] = []
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) grid.push(cells[y * 3 + (x < 3 ? x : 4 - x)])
  const redAt = hue(seed) % 25

  return (
    <div className={cx('relative grid shrink-0 place-items-center bg-card-2', rounded, className)}>
      <div className="grid h-[58%] w-[58%] grid-cols-5 grid-rows-5 place-items-center">
        {grid.map((on, i) => (
          <span
            key={i}
            className={cx('aspect-square w-[46%] rounded-full', on ? (i === redAt ? 'bg-red' : 'bg-fg') : 'bg-dot-off/60')}
          />
        ))}
      </div>
    </div>
  )
}

/** Статус трека: где он лежит */
export function StatusMark({
  status,
  progress,
  from,
  withLabel,
}: {
  status: TrackStatus
  progress?: number
  from?: string // хост: какое устройство сейчас присылает трек
  withLabel?: boolean
}) {
  const map: Record<TrackStatus, { dot: ReactNode; label: string }> = {
    synced: { dot: <span className="h-2 w-2 rounded-full bg-fg" />, label: t('status.synced') },
    cloud: { dot: <span className="h-2 w-2 rounded-full border border-muted" />, label: t('status.cloud') },
    uploading: {
      dot: <span className="blink h-2 w-2 rounded-full bg-red" />,
      label: from
        ? t('status.incoming', { device: from, p: Math.round(progress ?? 0) })
        : t('status.uploading', { p: Math.round(progress ?? 0) }),
    },
    downloading: { dot: <span className="blink h-2 w-2 rounded-full bg-fg" />, label: t('status.downloading', { p: Math.round(progress ?? 0) }) },
  }
  const m = map[status]
  return (
    <span className="inline-flex items-center gap-2" title={m.label}>
      {m.dot}
      {withLabel && <span className="label text-muted">{m.label}</span>}
    </span>
  )
}

/** Тумблер-пилюля как в Nothing OS */
export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={cx(
        'relative h-8 w-14 shrink-0 rounded-full transition-colors',
        on ? 'bg-sel' : 'bg-card-3',
      )}
    >
      <span
        className={cx(
          'absolute top-1 h-6 w-6 rounded-full transition-all',
          on ? 'left-7 bg-on-sel' : 'left-1 bg-muted',
        )}
      />
    </button>
  )
}

export function IconBtn({
  children,
  onClick,
  title,
  active,
  className,
}: {
  children: ReactNode
  onClick?: () => void
  title?: string
  active?: boolean
  className?: string
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cx(
        'grid h-9 w-9 place-items-center rounded-full transition-colors hover:bg-card-3',
        active ? 'text-red' : 'text-fg',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** Крупные цифры точечным шрифтом */
export function DotNum({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('font-dot font-bold leading-none tracking-tight', className)}>{children}</span>
}

/** Эквалайзер-анимация для играющего трека */
export function Eq({ playing }: { playing: boolean }) {
  return (
    <span className="inline-flex h-3.5 items-end gap-[2px]">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-[3px] origin-bottom rounded-full bg-red"
          style={{
            height: '100%',
            animation: playing ? `eq ${0.7 + i * 0.2}s ease-in-out ${i * 0.1}s infinite` : 'none',
            transform: playing ? undefined : 'scaleY(.35)',
          }}
        />
      ))}
    </span>
  )
}
