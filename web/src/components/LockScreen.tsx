import { Delete } from 'lucide-react'
import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { pinLength } from '../lib/pin'
import { useStore } from '../store'
import { Logo } from './Nav'
import { cx } from './ui'

/** Экран PIN-кода: при запуске и при возвращении из фона (больше 30 с). Точки — сколько цифр набрано */
export function LockScreen() {
  const unlock = useStore((s) => s.unlock)
  const [pin, setPin] = useState('')
  const [wrong, setWrong] = useState(false)
  const len = pinLength()

  useEffect(() => {
    if (pin.length !== len) return
    void unlock(pin).then((ok) => {
      if (ok) return
      setWrong(true)
      setPin('')
      setTimeout(() => setWrong(false), 600)
    })
  }, [pin, len, unlock])

  const press = (d: string) => setPin((p) => (p.length < len ? p + d : p))
  // widget-text: внутри page-layer текст на блоке — цветом блока, а не страницы
  const key = 'widget-text grid h-16 w-16 place-items-center rounded-full bg-card text-2xl text-fg transition-transform active:scale-90'

  return (
    <div className="page-layer fixed inset-0 z-[100] flex flex-col items-center justify-center gap-10 p-6" style={{ paddingTop: 'var(--safe-top)' }}>
      <Logo />
      <div className="flex flex-col items-center gap-4">
        <span className="text-sm text-ink-muted">{wrong ? t('pin.wrong') : t('pin.enter')}</span>
        <div className={cx('flex gap-3', wrong && 'animate-pulse')}>
          {Array.from({ length: len }, (_, i) => (
            <span key={i} className={cx('h-3.5 w-3.5 rounded-full', i < pin.length ? 'bg-ink' : 'bg-ink/20', wrong && 'bg-red')} />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} onClick={() => press(d)} className={key}>
            <span className="font-dot font-black">{d}</span>
          </button>
        ))}
        <span />
        <button onClick={() => press('0')} className={key}>
          <span className="font-dot font-black">0</span>
        </button>
        <button onClick={() => setPin((p) => p.slice(0, -1))} aria-label={t('pin.erase')} className="grid h-16 w-16 place-items-center rounded-full text-ink-muted">
          <Delete size={22} />
        </button>
      </div>
    </div>
  )
}
