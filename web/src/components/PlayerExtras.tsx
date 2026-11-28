import { Check, Moon, SlidersHorizontal, Volume1, Volume2, VolumeX, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { t, tn } from '../i18n'
import { fmtTime } from '../lib/format'
import { EQ_BANDS, EQ_PRESETS, QUALITY, usePick } from '../store'
import { cx, IconBtn, Toggle } from './ui'

/** Всплывашка над кнопкой плеера. Закрывается кликом мимо и Escape */
function Popover({ open, onClose, children, className }: { open: boolean; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      // клик по самой кнопке-якорю обрабатывает она сама
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div ref={ref} className={cx('widget absolute end-0 bottom-full z-40 mb-4 p-5 shadow-2xl ring-1 ring-line', className)}>
      {children}
    </div>
  )
}

function PanelHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <span className="text-lg font-medium">{title}</span>
      <IconBtn title={t('common.close')} onClick={onClose} className="bg-card-3">
        <X size={16} />
      </IconBtn>
    </div>
  )
}

/** Настройки звука: качество + эквалайзер */
export function SoundButton() {
  const [open, setOpen] = useState(false)
  const { settings, setSetting, setEq, setEqGains } = usePick('settings', 'setSetting', 'setEq', 'setEqGains')
  const close = () => setOpen(false)

  return (
    <div className="relative">
      <IconBtn title={t('sound.title')} active={open || settings.eq} onClick={() => setOpen(!open)}>
        <SlidersHorizontal size={17} strokeWidth={1.6} />
      </IconBtn>
      <Popover open={open} onClose={close} className="w-[340px]">
        <PanelHead title={t('sound.title')} onClose={close} />

        <div className="-mx-2 flex flex-col">
          {QUALITY.map((q) => (
            <button
              key={q}
              onClick={() => setSetting('quality', q)}
              className="flex items-center gap-3 rounded-2xl px-2 py-2.5 text-start transition-colors hover:bg-card-2"
            >
              <span className="min-w-0 flex-1">
                <span className={cx('block text-[15px]', settings.quality === q && 'font-medium')}>{t(`quality.${q}`)}</span>
                <span className="block text-xs text-muted">{t(`quality.${q}.hint`)}</span>
              </span>
              {settings.quality === q && <Check size={18} className="shrink-0" />}
            </button>
          ))}
        </div>
        <div className="label mt-1 text-muted">{t('sound.note')}</div>

        <div className="my-4 h-px bg-line" />

        <div className="flex items-center justify-between">
          <span className="text-[15px]">{t('sound.eq')}</span>
          <Toggle on={settings.eq} onChange={setEq} />
        </div>

        {settings.eq && (
          <div className="mt-4">
            <div className="mb-4 flex flex-wrap gap-1.5">
              {EQ_PRESETS.map((p) => {
                const active = p.gains.every((g, i) => g === settings.eqGains[i])
                return (
                  <button
                    key={p.id}
                    onClick={() => setEqGains([...p.gains])}
                    className={cx(
                      'rounded-full px-3 py-1 text-xs transition-colors',
                      active ? 'bg-sel text-on-sel' : 'bg-card-3 text-muted hover:text-fg',
                    )}
                  >
                    {t(`eq.${p.id}`)}
                  </button>
                )
              })}
            </div>
            {/* частоты слева направо при любом направлении письма */}
            <div dir="ltr" className="flex justify-between px-1">
              {EQ_BANDS.map((f, i) => (
                <EqBand
                  key={f}
                  label={f >= 1000 ? `${f / 1000}k` : String(f)}
                  value={settings.eqGains[i]}
                  onChange={(v) => setEqGains(settings.eqGains.map((g, j) => (j === i ? v : g)))}
                />
              ))}
            </div>
          </div>
        )}
      </Popover>
    </div>
  )
}

const EQ_MAX = 12

/** Вертикальный ползунок полосы: −12…+12 дБ, заливка от середины */
function EqBand({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const setAt = (y: number) => {
    const r = ref.current!.getBoundingClientRect()
    const v = (1 - (y - r.top) / r.height) * EQ_MAX * 2 - EQ_MAX
    onChange(Math.round(Math.max(-EQ_MAX, Math.min(EQ_MAX, v))))
  }
  const pos = ((value + EQ_MAX) / (EQ_MAX * 2)) * 100 // от низа

  return (
    <div className="flex flex-col items-center gap-2">
      <span className="font-mono text-[10px] text-muted">{value > 0 ? `+${value}` : value}</span>
      <div
        ref={ref}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          setAt(e.clientY)
        }}
        onPointerMove={(e) => e.buttons === 1 && setAt(e.clientY)}
        onDoubleClick={() => onChange(0)}
        title={t('sound.eqReset')}
        className="relative h-28 w-8 cursor-pointer touch-none"
      >
        <div className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-dot-off" />
        <div className="absolute top-1/2 left-1/2 h-px w-3 -translate-x-1/2 bg-muted" />
        <div
          className="absolute left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-fg"
          style={{ bottom: `${Math.min(pos, 50)}%`, height: `${Math.abs(pos - 50)}%` }}
        />
        <span className="absolute left-1/2 h-3.5 w-3.5 -translate-x-1/2 translate-y-1/2 rounded-full bg-fg" style={{ bottom: `${pos}%` }} />
      </div>
      <span className="font-mono text-[10px] text-muted">{label}</span>
    </div>
  )
}

export const SLEEP_OPTIONS = [15, 30, 45, 60, 90]

/** Таймер сна: через N минут или после текущего трека */
export function SleepButton() {
  const [open, setOpen] = useState(false)
  const { sleepAt, sleepEndOfTrack, setSleep } = usePick('sleepAt', 'sleepEndOfTrack', 'setSleep')
  const close = () => setOpen(false)
  const active = !!sleepAt || sleepEndOfTrack
  // пересчитывается каждые полсекунды: стор тикает и перерисовывает плеер
  const left = sleepAt ? Math.max(0, (sleepAt - Date.now()) / 1000) : 0

  const pick = (v: number | 'track' | null) => {
    setSleep(v)
    close()
  }

  return (
    <div className="relative">
      <button
        title={t('sleep.title')}
        onClick={() => setOpen(!open)}
        className={cx(
          'flex h-9 items-center gap-1.5 rounded-full px-2.5 transition-colors hover:bg-card-3',
          active || open ? 'text-red' : 'text-fg',
        )}
      >
        <Moon size={16} strokeWidth={1.6} fill={active ? 'currentColor' : 'none'} />
        {sleepAt && <span className="font-mono text-[11px]">{fmtTime(left)}</span>}
        {sleepEndOfTrack && <span className="font-mono text-[11px]">{t('sleep.trackShort')}</span>}
      </button>
      <Popover open={open} onClose={close} className="w-72">
        <PanelHead title={t('sleep.title')} onClose={close} />
        {active && (
          <div className="mb-3 rounded-2xl bg-card-2 px-4 py-3">
            <div className="label text-muted">{t('sleep.stopIn')}</div>
            <div className="font-dot text-3xl font-bold">{sleepAt ? fmtTime(left) : t('sleep.afterTrack')}</div>
          </div>
        )}
        <div className="-mx-2 flex flex-col">
          {SLEEP_OPTIONS.map((m) => (
            <button key={m} onClick={() => pick(m)} className="rounded-2xl px-2 py-2.5 text-start text-[15px] transition-colors hover:bg-card-2">
              {m < 60 ? tn('sleep.minutes', m) : m === 60 ? t('sleep.hour') : t('sleep.hourHalf')}
            </button>
          ))}
          <button
            onClick={() => pick('track')}
            className="flex items-center justify-between rounded-2xl px-2 py-2.5 text-start text-[15px] transition-colors hover:bg-card-2"
          >
            {t('sleep.endOfTrack')}
            {sleepEndOfTrack && <Check size={18} />}
          </button>
          {active && (
            <button onClick={() => pick(null)} className="rounded-2xl px-2 py-2.5 text-start text-[15px] text-red transition-colors hover:bg-card-2">
              {t('sleep.off')}
            </button>
          )}
        </div>
        <div className="label mt-2 text-muted">{t('sleep.fade')}</div>
      </Popover>
    </div>
  )
}

/** Громкость: только значок, полоса выезжает при наведении */
/**
 * Громкость: значок в плеере, при наведении над ним выдвигается вверх панель с вертикальным ползунком.
 * Клик по значку — выключить звук или вернуть прежнюю громкость, колесо мыши — шаг 5
 */
export function VolumeControl() {
  const { volume, setVolume } = usePick('volume', 'setVolume')
  const [hover, setHover] = useState(false)
  const [drag, setDrag] = useState(false)
  const lastVolume = useRef(70)
  const track = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  // на сколько поднять панель: от значка до верхнего края плеера + зазор — чтобы она висела над плеером, а не налезала на него
  const [lift, setLift] = useState(36)
  const open = hover || drag
  const measure = () => {
    const el = box.current
    const bar = el?.closest('.widget')
    if (el && bar) setLift(Math.max(12, el.getBoundingClientRect().top - bar.getBoundingClientRect().top + 10))
  }

  // ползунок вертикальный: снизу 0, сверху 100
  const setFromY = (clientY: number) => {
    const r = track.current?.getBoundingClientRect()
    if (!r) return
    setVolume(Math.round(Math.max(0, Math.min(1, (r.bottom - clientY) / r.height)) * 100))
  }

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => setFromY(e.clientY)
    const up = () => setDrag(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [drag])

  const Icon = volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2

  return (
    <div
      ref={box}
      className="relative flex items-center"
      onMouseEnter={() => {
        measure()
        setHover(true)
      }}
      onMouseLeave={() => setHover(false)}
      onWheel={(e) => setVolume(Math.max(0, Math.min(100, volume + (e.deltaY < 0 ? 5 : -5))))}
    >
      {/* отступ снизу — прозрачный «мостик» от значка до панели: курсор не теряет наведение по пути вверх */}
      <div
        style={{ paddingBottom: lift }}
        className={cx(
          'absolute bottom-full left-1/2 z-40 -translate-x-1/2 transition-[opacity,transform] duration-200 ease-out',
          open ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
        )}
      >
        <div className="widget flex w-12 flex-col items-center gap-3 rounded-full py-4 shadow-2xl ring-1 ring-line">
          <span className="font-mono text-[11px] text-muted">{volume}</span>
          <div
            ref={track}
            role="slider"
            aria-label={t('volume.label')}
            aria-orientation="vertical"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={volume}
            tabIndex={0}
            onPointerDown={(e) => {
              setDrag(true)
              setFromY(e.clientY)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp' || e.key === 'ArrowRight') setVolume(Math.min(100, volume + 5))
              if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') setVolume(Math.max(0, volume - 5))
            }}
            className="relative h-28 w-6 cursor-pointer touch-none"
          >
            <span className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 rounded-full bg-card-3" />
            <span className="absolute bottom-0 left-1/2 w-1 -translate-x-1/2 rounded-full bg-fg" style={{ height: `${volume}%` }} />
            <span
              className="absolute left-1/2 h-3 w-3 -translate-x-1/2 translate-y-1/2 rounded-full bg-fg shadow"
              style={{ bottom: `${volume}%` }}
            />
          </div>
        </div>
      </div>
      <IconBtn
        title={volume ? t('volume.mute') : t('volume.unmute')}
        onClick={() => {
          if (volume) {
            lastVolume.current = volume
            setVolume(0)
          } else setVolume(lastVolume.current || 70)
        }}
        className={cx(open && 'bg-card-3')}
      >
        <Icon size={17} strokeWidth={1.6} />
      </IconBtn>
    </div>
  )
}
