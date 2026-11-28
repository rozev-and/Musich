import { useBuffering } from '../lib/pos'

/** Кольцо вокруг кнопки «играть», пока трек грузится. Кнопка — relative; tone — цвет кольца (как фон кнопки) */
export function BufferRing({ on = true, tone = 'border-sel' }: { on?: boolean; tone?: string }) {
  const buffering = useBuffering((s) => s.buffering)
  if (!on || !buffering) return null
  return <span aria-hidden className={`pointer-events-none absolute -inset-[4px] animate-spin rounded-full border-2 border-t-transparent [animation-duration:900ms] ${tone}`} />
}
