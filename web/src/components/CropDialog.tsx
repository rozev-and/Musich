import { Minus, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { t } from '../i18n'
import { Modal } from './Dialogs'
import { cx } from './ui'

/**
 * Кадрирование картинки перед сохранением: квадрат (у артиста — круг), картинку двигаешь пальцем или мышью,
 * масштаб — ползунком, двумя пальцами или колесом. Готово — квадрат до 1000 px в JPEG (data:)
 */
const MAX_OUT = 1000

export function CropDialog({ blob, round, onDone, onCancel }: { blob: Blob; round?: boolean; onDone: (dataUrl: string) => void; onCancel: () => void }) {
  const [img, setImg] = useState<{ url: string; w: number; h: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const frame = Math.min(320, (typeof window !== 'undefined' ? window.innerWidth : 360) - 96)
  const [zoom, setZoom] = useState(1)
  const [off, setOff] = useState({ x: 0, y: 0 })
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ dist: number; zoom: number } | null>(null)

  useEffect(() => {
    const url = URL.createObjectURL(blob)
    const im = new Image()
    im.onload = () => {
      setImg({ url, w: im.naturalWidth, h: im.naturalHeight })
      const s = frame / Math.min(im.naturalWidth, im.naturalHeight)
      // по центру
      setOff({ x: (frame - im.naturalWidth * s) / 2, y: (frame - im.naturalHeight * s) / 2 })
    }
    im.onerror = () => setFailed(true)
    im.src = url
    return () => URL.revokeObjectURL(url)
  }, [blob, frame])

  useEffect(() => {
    if (failed) onCancel()
  }, [failed, onCancel])

  if (!img) return null
  const base = frame / Math.min(img.w, img.h)
  const scale = base * zoom
  // картинка всегда закрывает рамку целиком
  const clamp = (o: { x: number; y: number }, s = scale) => ({
    x: Math.min(0, Math.max(frame - img.w * s, o.x)),
    y: Math.min(0, Math.max(frame - img.h * s, o.y)),
  })
  // масштаб вокруг центра рамки
  const zoomTo = (z: number) => {
    const nz = Math.min(4, Math.max(1, z))
    const ns = base * nz
    const cx0 = (frame / 2 - off.x) / scale
    const cy0 = (frame / 2 - off.y) / scale
    setZoom(nz)
    setOff(clamp({ x: frame / 2 - cx0 * ns, y: frame / 2 - cy0 * ns }, ns))
  }

  const down = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom }
    }
  }
  const move = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()]
      zoomTo((pinch.current.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.current.dist)
      return
    }
    setOff((o) => clamp({ x: o.x + e.clientX - prev.x, y: o.y + e.clientY - prev.y }))
  }
  const up = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
  }

  const done = () => {
    const side = frame / scale // сколько пикселей картинки в рамке
    const out = Math.round(Math.min(MAX_OUT, side))
    const c = document.createElement('canvas')
    c.width = c.height = out
    const g = c.getContext('2d')!
    g.imageSmoothingQuality = 'high'
    const im = new Image()
    im.onload = () => {
      g.drawImage(im, -off.x / scale, -off.y / scale, side, side, 0, 0, out, out)
      onDone(c.toDataURL('image/jpeg', 0.88))
    }
    im.src = img.url
  }

  return (
    <Modal onClose={onCancel}>
      <div className="mb-1 text-lg font-medium">{t('crop.title')}</div>
      <p className="mb-4 text-xs text-muted">{t('crop.hint')}</p>
      <div className="flex justify-center">
        <div
          className={cx('relative touch-none select-none overflow-hidden bg-card-3 ring-1 ring-line', round ? 'rounded-full' : 'rounded-2xl')}
          style={{ width: frame, height: frame }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onWheel={(e) => zoomTo(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))}
        >
          <img
            src={img.url}
            alt=""
            draggable={false}
            className="pointer-events-none absolute top-0 left-0 max-w-none origin-top-left"
            style={{ width: img.w, height: img.h, transform: `translate(${off.x}px, ${off.y}px) scale(${scale})` }}
          />
        </div>
      </div>
      <div dir="ltr" className="mt-5 flex items-center gap-3">
        <button onClick={() => zoomTo(zoom / 1.2)} className="grid h-9 w-9 place-items-center rounded-full bg-card-3 text-muted" aria-label={t('crop.zoomOut')}>
          <Minus size={16} />
        </button>
        <input
          type="range"
          min={1}
          max={4}
          step={0.01}
          value={zoom}
          onChange={(e) => zoomTo(Number(e.target.value))}
          aria-label={t('crop.zoom')}
          className="min-w-0 flex-1 accent-[var(--red)]"
        />
        <button onClick={() => zoomTo(zoom * 1.2)} className="grid h-9 w-9 place-items-center rounded-full bg-card-3 text-muted" aria-label={t('crop.zoomIn')}>
          <Plus size={16} />
        </button>
      </div>
      <div className="mt-5 flex gap-2">
        <button onClick={onCancel} className="flex-1 rounded-full bg-card-3 py-3 text-sm">
          {t('common.cancel')}
        </button>
        <button onClick={done} className="flex-1 rounded-full bg-sel py-3 text-sm text-on-sel">
          {t('common.done')}
        </button>
      </div>
    </Modal>
  )
}
