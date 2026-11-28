import { DotText } from './DotText'
import { cx } from './ui'

/**
 * Аватарка: фото, а если его нет — первая буква имени точками, как логотип MUSICH.
 * size — диаметр в px.
 */
export function Avatar({ name, src, size = 36, className }: { name: string; src?: string; size?: number; className?: string }) {
  if (src) return <img src={src} alt="" className={cx('shrink-0 rounded-full object-cover', className)} style={{ width: size, height: size }} />
  const letter = [...name.trim()][0]?.toUpperCase() ?? '?'
  return (
    <span
      className={cx('grid shrink-0 place-items-center rounded-full bg-sel text-on-sel', className)}
      style={{ width: size, height: size }}
      aria-label={name}
    >
      {/* буква — примерно в половину круга; не латиница/кириллица — обычным шрифтом */}
      <DotText text={letter} size={size * 0.62} trimTop className="font-dot font-black" />
    </span>
  )
}
