import { Circle, CircleCheck, CloudDownload, Ellipsis, GripVertical, Heart, ListPlus, Trash, X } from 'lucide-react'
import { useRef, useState, memo, type CSSProperties, type ReactNode } from 'react'
import { ArtistLinks } from './ArtistLinks'
import { menuPosition, TrackMenu } from './FullPlayer'
import { isHost } from '../mode'
import { trackCover } from '../lib/covers'
import { fmtSize, getLang, t as tx } from '../i18n'
import { fmtTime } from '../lib/format'
import { DRAG_TRACKS, usePick, useStore } from '../store'
import { useProgress } from '../lib/pos'
import type { Track } from '../types'
import { Cover, cx, DotBar, Eq, IconBtn, StatusMark } from './ui'

const DRAG_INDEX = 'application/x-musich-index'

/**
 * Строка трека. Общая для библиотеки и плейлиста.
 * queue — порядок, в котором играть дальше; reorder — включает перетаскивание внутри списка.
 */
function TrackRowComponent({
  t,
  i,
  queue,
  source,
  extra,
  reorder,
  no,
}: {
  t: Track
  i: number
  no?: string
  queue: string[] | null
  source?: string
  extra?: ReactNode
  reorder?: (from: number, to: number) => void
}) {
  // каждая строка следит только за своим: играет ли она, выбрана ли, её обложка. Раньше пауза, смена трека или выбор
  // перерисовывали все строки списка (их бывает 1800). Действия берём из стора в момент нажатия — без подписки
  const current = useStore((s) => s.currentId === t.id)
  const playing = useStore((s) => s.currentId === t.id && s.playing)
  const isSelected = useStore((s) => s.selected.includes(t.id))
  const selecting = useStore((s) => s.selected.length > 0)
  const cover = useStore((s) => trackCover(t, s.covers))
  const cols = useStore((s) => s.ui.cols)
  // проценты загрузки — из своего маленького стора (lib/pos.ts), в списке треков только начало и конец
  const progress = useProgress((p) => p[t.id]) ?? t.progress
  const unavailable = useStore((s) => !isHost && s.conn !== 'online' && t.status !== 'synced')
  const { play, download, askDelete, toggleLike, openScope, toggleSelect } = useStore.getState()
  const [dropHint, setDropHint] = useState<'above' | 'below' | null>(null)
  const [menu, setMenu] = useState<CSSProperties | null>(null)
  const moreRef = useRef<HTMLSpanElement>(null)
  const moving = t.status === 'uploading' || t.status === 'downloading'

  return (
    <div
      draggable
      onDragStart={(e) => {
        const ids = isSelected ? useStore.getState().selected : [t.id]
        e.dataTransfer.setData(DRAG_TRACKS, JSON.stringify(ids))
        if (reorder) e.dataTransfer.setData(DRAG_INDEX, String(i))
        e.dataTransfer.effectAllowed = 'copyMove'
      }}
      onDragOver={(e) => {
        if (!reorder || !e.dataTransfer.types.includes(DRAG_INDEX)) return
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        setDropHint(e.clientY < r.top + r.height / 2 ? 'above' : 'below')
      }}
      onDragLeave={() => setDropHint(null)}
      onDrop={(e) => {
        if (!reorder) return
        const raw = e.dataTransfer.getData(DRAG_INDEX)
        setDropHint(null)
        if (!raw) return
        const from = Number(raw)
        const r = e.currentTarget.getBoundingClientRect()
        let to = e.clientY >= r.top + r.height / 2 ? i + 1 : i
        if (from < to) to -= 1
        if (from !== to) reorder(from, to)
      }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, a, input, label')) return
        if (selecting) return toggleSelect(t.id)
        if (useStore.getState().ui.motion && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
          e.currentTarget.animate(
            [{ transform: 'scale(1)' }, { transform: 'scale(.985)', filter: 'brightness(1.25)' }, { transform: 'scale(1)' }],
            { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' },
          )
        }
        play(t.id, queue, source)
      }}
      className={cx(
        'row-lazy group relative flex cursor-pointer items-center gap-3.5 px-4 py-2.5 transition-colors hover:bg-card-2 sm:gap-3 sm:rounded-2xl sm:px-3 sm:py-2',
        (current || isSelected) && 'bg-card-2',
        unavailable && 'opacity-40',
      )}
    >
      {dropHint && (
        <span className={cx('absolute inset-x-3 h-0.5 rounded-full bg-red', dropHint === 'above' ? 'top-0' : 'bottom-0')} />
      )}

      {reorder && (
        <GripVertical size={14} className="-mr-1 hidden shrink-0 cursor-grab text-muted opacity-0 group-hover:opacity-100 sm:block" />
      )}

      <button
        onClick={() => toggleSelect(t.id)}
        title={isSelected ? tx('row.deselect') : tx('row.select')}
        className={cx('hidden shrink-0 justify-center font-mono text-xs text-muted sm:flex', no !== undefined ? 'w-10' : 'w-6')}
      >
        {isSelected ? (
          <CircleCheck size={17} className="text-fg" />
        ) : (
          <>
            <Circle size={17} className={cx('hover:text-fg', selecting ? 'block' : 'hidden group-hover:block')} />
            {!selecting &&
              (current ? <span className="group-hover:hidden"><Eq playing={playing} /></span> : <span className="group-hover:hidden">{no ?? String(i + 1).padStart(2, '0')}</span>)}
          </>
        )}
      </button>

      <button onClick={() => play(t.id, queue, source)} className="shrink-0" title={tx('common.play')}>
        <Cover seed={t.album} src={cover} className="h-13 w-13 sm:h-11 sm:w-11" rounded="rounded-xl" />
      </button>

      <div className="min-w-0 flex-1">
        <div className={cx('truncate text-base sm:text-[15px]', current && 'text-red')}>{t.title}</div>
        <ArtistLinks artist={t.artist} plain={!isHost} className="text-sm text-muted sm:text-xs" />
      </div>

      {cols.album && (
        <button
          onClick={() => openScope({ type: 'album', value: t.album })}
          className="hidden w-44 truncate text-start text-sm text-muted hover:text-fg xl:block"
        >
          {t.album}
        </button>
      )}
      {cols.year && <span className="hidden w-10 text-end font-mono text-xs text-muted lg:block">{t.year ?? ''}</span>}
      {cols.added && (
        <span className="hidden w-20 text-end font-mono text-[11px] text-muted xl:block">
          {new Date(t.addedAt).toLocaleDateString(getLang(), { day: '2-digit', month: '2-digit', year: '2-digit' })}
        </span>
      )}

      <div className="hidden w-36 md:block">
        {moving ? (
          <div className="flex flex-col gap-1.5">
            <StatusMark status={t.status} progress={progress} from={t.from} withLabel />
            <DotBar dots={16} size={3} value={(progress ?? 0) / 100} />
          </div>
        ) : (
          !isHost && <StatusMark status={t.status} withLabel />
        )}
      </div>
      {(!isHost || moving) && (
        <span className="md:hidden">
          <StatusMark status={t.status} progress={progress} from={t.from} />
        </span>
      )}

      {cols.size && <span className="hidden w-14 text-end font-mono text-[11px] text-muted lg:block">{fmtSize(t.sizeMb).replace(' ', ' ')}</span>}
      {cols.duration && <span className={cx('w-10 text-end font-mono text-xs text-muted', extra ? 'hidden sm:block' : '')}>{fmtTime(t.duration)}</span>}

      <div className={cx('flex items-center opacity-100 transition-opacity md:group-hover:opacity-100', !menu && 'md:opacity-0')}>
        <IconBtn title={tx('common.like')} active={t.liked} onClick={() => toggleLike(t.id)} className="hidden sm:grid">
          <Heart size={16} strokeWidth={1.6} fill={t.liked ? 'currentColor' : 'none'} />
        </IconBtn>
        {isHost ? null : t.status === 'cloud' ? (
          <IconBtn title={tx('row.download')} onClick={() => download(t.id)} className="hidden sm:grid">
            <CloudDownload size={16} strokeWidth={1.6} />
          </IconBtn>
        ) : (
          <span className="hidden h-9 w-9 sm:block" />
        )}
        {extra}
        {isHost && (
          <IconBtn title={tx('common.delete')} onClick={() => askDelete(t.id)}>
            <Trash size={16} strokeWidth={1.6} />
          </IconBtn>
        )}
        <span ref={moreRef}>
          <IconBtn
            title={tx('common.more')}
            active={!!menu}
            onClick={() => setMenu(menu ? null : menuPosition(moreRef.current!))}
          >
            <Ellipsis size={18} strokeWidth={1.6} />
          </IconBtn>
        </span>
        {menu && <TrackMenu t={t} anchor={moreRef.current} style={menu} onClose={() => setMenu(null)} />}
      </div>
    </div>
  )
}

// Оптимизированное сравнение props для мемоизации
// Строка перерисовывается, когда поменялось хоть что-то, что она показывает или чем пользуется: сам трек (новый объект —
// новый номер, название, обложка, лайк), место в списке, номер, очередь и перетаскивание. Раньше сверялись только
// лайк и статус — после переноса номера у части строк оставались старый номер и старое «перетаскивание» (по старому
// списку): строки съезжали, и следующий перенос не срабатывал. Список, очередь и перетаскивание Library держит
// одними и теми же, пока они не поменялись, — поэтому лишних перерисовок нет
export const TrackRow = memo(
  TrackRowComponent,
  (prev, next) =>
    prev.t === next.t &&
    prev.i === next.i &&
    prev.no === next.no &&
    prev.reorder === next.reorder &&
    prev.queue === next.queue &&
    prev.source === next.source,
)

/** Плашка над списком, когда что-то выделено */
export function SelectionBar() {
  const { selected, clearSelection, openPicker, downloadMany, tracks } = usePick('selected', 'clearSelection', 'openPicker', 'downloadMany', 'tracks')
  if (!selected.length) return null
  const cloud = tracks.filter((t) => selected.includes(t.id) && t.status === 'cloud').length

  return (
    <div className="widget sticky top-0 z-10 mb-3 flex items-center gap-2 rounded-full py-2 ps-5 pe-2 shadow-xl">
      <span className="flex-1 text-sm">
        {tx('row.selected')} <span className="font-mono">{selected.length}</span>
        <span className="ms-3 hidden text-xs text-muted sm:inline">{tx('row.dragHint')}</span>
      </span>
      <button onClick={() => openPicker(selected)} className="flex items-center gap-2 rounded-full bg-sel px-4 py-2 text-sm text-on-sel">
        <ListPlus size={15} /> {tx('row.toPlaylist')}
      </button>
      {!isHost && cloud > 0 && (
        <button onClick={() => { downloadMany(selected); clearSelection() }} className="flex items-center gap-2 rounded-full border border-line px-4 py-2 text-sm hover:border-fg">
          <CloudDownload size={15} /> {tx('row.downloadN', { n: cloud })}
        </button>
      )}
      <IconBtn title={tx('row.deselect')} onClick={clearSelection}>
        <X size={17} />
      </IconBtn>
    </div>
  )
}
