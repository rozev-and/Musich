import { fmtTime } from '../lib/format'
import { useStore } from '../store'
import { usePos } from '../lib/pos'
import { Seek } from './ui'

/**
 * Позиция трека меняется ~4 раза в секунду. Слушают её только эти два кусочка — полоска и время,
 * а не весь плеер: иначе обложка, кнопки и очередь перерисовываются вместе с ними и всё дёргается
 */
export function PosSeek({ duration, className }: { duration: number; className?: string }) {
  const position = usePos((s) => s.position)
  const seek = useStore((s) => s.seek)
  return <Seek className={className} value={duration ? position / duration : 0} onChange={(v) => seek(v * duration)} />
}

/** Сколько проиграно, «1:23» — перерисовывается раз в секунду, а не на каждое обновление позиции */
export function PosTime() {
  const sec = usePos((s) => Math.floor(s.position))
  return <>{fmtTime(sec)}</>
}
