import { Download, ExternalLink, RefreshCw, TriangleAlert, Unlink, X } from 'lucide-react'
import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { fmtAgo, t } from '../i18n'
import { api } from '../lib/api'
import { usePick } from '../store'
import { PlayerIcon } from './BrandIcons'
import { Modal } from './Dialogs'
import { cx, IconBtn } from './ui'

/**
 * Telegram в «Интеграциях»: музыка из профиля аккаунта — в библиотеку, файлами (сервер: server/src/telegram.ts).
 * Вход — аккаунтом: свои api_id и api_hash с my.telegram.org → номер → код из Telegram → облачный пароль, если есть
 */

interface TelegramStatus {
  configured: boolean
  connected: boolean
  account?: string
  syncedAt?: string
  imported: number
  running?: { done: number; total: number; added: number; failed: number }
  error?: string
}

const pill = 'rounded-full px-3 py-1.5 text-xs transition-opacity disabled:opacity-40'
const input = 'w-full rounded-2xl bg-card-3 px-3.5 py-2.5 text-sm outline-none placeholder:text-muted focus:ring-1 focus:ring-fg'

/** Плитка Telegram — рядом с плитками плееров */
export function TelegramTile() {
  const { toast } = usePick('toast')
  const [st, setSt] = useState<TelegramStatus | null>(null)
  const [open, setOpen] = useState(false)
  const load = useCallback(() => api<TelegramStatus>('/integrations/telegram').then(setSt, () => {}), [])
  useEffect(() => {
    void load()
  }, [load])

  // пока забирает — смотрим ход раз в 2 секунды; закончил — говорим, сколько нового
  const running = !!st?.running
  useEffect(() => {
    if (!running) return
    const id = setInterval(async () => {
      const next = await api<TelegramStatus>('/integrations/telegram').catch(() => null)
      if (!next) return
      if (!next.running && st?.running) {
        const r = st.running
        toast(next.error ?? t('tg.done', { added: r.added, total: r.total }), next.error ? 'error' : 'ok')
      }
      setSt(next)
    }, 2000)
    return () => clearInterval(id)
  }, [running, st, toast])

  const pull = async () => {
    try {
      setSt(await api<TelegramStatus>('/integrations/telegram/import', { method: 'POST' }))
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const disconnect = async () => {
    await api('/integrations/telegram', { method: 'DELETE' }).catch(() => {})
    void load()
  }

  const r = st?.running
  return (
    <>
      <div className={cx('flex min-w-0 flex-col gap-2 rounded-2xl p-3', st?.connected ? 'bg-card-2' : 'bg-card-2/50 ring-1 ring-line')}>
        <div className="flex items-center gap-2.5">
          <PlayerIcon id="telegram" size={28} />
          <div className="min-w-0 flex-1 truncate text-sm font-medium">Telegram</div>
        </div>
        <div className="min-h-8 text-[11px] leading-snug text-muted">
          {st?.connected ? (
            <>
              <div className="truncate text-fg/80">{st.account}</div>
              {r ? (
                <div className="truncate">{t('tg.running', { done: r.done, total: r.total || '…' })}</div>
              ) : (
                <>
                  <div className="truncate">{t('tg.imported', { n: st.imported })}</div>
                  {st.syncedAt && <div className="truncate">{fmtAgo(Date.parse(st.syncedAt))}</div>}
                </>
              )}
            </>
          ) : (
            t('tg.hint')
          )}
          {st?.error && <div className="truncate text-red">{st.error}</div>}
        </div>
        {st?.connected ? (
          <div className="mt-auto flex items-center gap-1">
            <button onClick={() => void pull()} disabled={!!r} className={cx(pill, 'flex flex-1 items-center justify-center gap-1.5 bg-sel px-3 text-on-sel')}>
              {r ? <RefreshCw size={12} className="animate-spin" /> : <Download size={12} />}
              {t('tg.import')}
            </button>
            <IconBtn title={t('int.disconnect')} onClick={() => void disconnect()} className="h-8 w-8 text-muted hover:text-red">
              <Unlink size={14} />
            </IconBtn>
          </div>
        ) : (
          <button onClick={() => setOpen(true)} className={cx(pill, 'mt-auto bg-card-3 hover:bg-card-2')}>
            {t('acc.connect')}
          </button>
        )}
      </div>
      {open && st && (
        <TelegramDialog
          configured={st.configured}
          onClose={() => setOpen(false)}
          onConnected={(account) => {
            setOpen(false)
            toast(t('int.connected', { name: account }), 'ok')
            void load()
          }}
        />
      )}
    </>
  )
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-2.5 text-sm">
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-card-3 font-mono text-[11px]">{n}</span>
      <span className="min-w-0 leading-snug">{children}</span>
    </li>
  )
}

type Stage = 'keys' | 'phone' | 'code' | 'password'

function TelegramDialog({ configured, onClose, onConnected }: { configured: boolean; onClose: () => void; onConnected: (account: string) => void }) {
  const { toast } = usePick('toast')
  const [stage, setStage] = useState<Stage>(configured ? 'phone' : 'keys')
  const [apiId, setApiId] = useState('')
  const [apiHash, setApiHash] = useState('')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const step = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
    setBusy(false)
  }
  const saveKeys = () =>
    step(async () => {
      await api('/integrations/telegram/config', { method: 'PUT', body: { apiId: apiId.trim(), apiHash: apiHash.trim() } })
      setStage('phone')
    })
  const sendCode = () =>
    step(async () => {
      await api('/integrations/telegram/code', { method: 'POST', body: { phone } })
      setStage('code')
    })
  const signIn = () =>
    step(async () => {
      const r = await api<{ password?: true; account?: string }>('/integrations/telegram/signin', { method: 'POST', body: { code } })
      if (r.password) setStage('password')
      else onConnected(r.account ?? 'Telegram')
    })
  const checkPassword = () =>
    step(async () => {
      const r = await api<{ account: string }>('/integrations/telegram/password', { method: 'POST', body: { password } })
      onConnected(r.account)
    })

  const button = (label: string, onClick: () => void, ready: boolean) => (
    <button onClick={onClick} disabled={!ready || busy} className={cx(pill, 'mt-3 w-full bg-sel py-2.5 text-sm text-on-sel')}>
      {busy ? <RefreshCw size={14} className="mx-auto animate-spin" /> : label}
    </button>
  )
  const enter = (fn: () => void, ready: boolean) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' && ready && !busy) fn()
  }

  return (
    <Modal onClose={onClose} wide>
      <div className="mb-4 flex items-start justify-between">
        <span className="flex items-center gap-2.5 text-lg font-medium">
          <PlayerIcon id="telegram" size={26} /> {t('tg.title')}
        </span>
        <IconBtn title={t('common.close')} onClick={onClose} className="-mt-2 -me-2">
          <X size={18} />
        </IconBtn>
      </div>
      <p className="mb-4 flex gap-2 rounded-2xl bg-card-3 px-3.5 py-2.5 text-xs text-muted">
        <TriangleAlert size={14} className="mt-px shrink-0 text-red" />
        {t('tg.warn')}
      </p>

      {stage === 'keys' && (
        <>
          <ol className="mb-3 flex flex-col gap-2">
            <Step n={1}>
              {t('tg.s1')}{' '}
              <a href="https://my.telegram.org/apps" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
                my.telegram.org <ExternalLink size={12} />
              </a>
            </Step>
            <Step n={2}>{t('tg.s2')}</Step>
          </ol>
          <div className="flex flex-col gap-2">
            <input value={apiId} onChange={(e) => setApiId(e.target.value)} placeholder="api_id" inputMode="numeric" className={input} />
            <input value={apiHash} onChange={(e) => setApiHash(e.target.value)} onKeyDown={enter(saveKeys, !!apiId && !!apiHash)} placeholder="api_hash" className={cx(input, 'font-mono')} />
          </div>
          {button(t('tg.next'), saveKeys, !!apiId.trim() && !!apiHash.trim())}
        </>
      )}
      {stage === 'phone' && (
        <>
          <label className="mb-1.5 block text-xs text-muted">{t('tg.phone')}</label>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={enter(sendCode, !!phone)} placeholder="+7 999 123-45-67" inputMode="tel" autoComplete="tel" autoFocus className={input} />
          {button(t('tg.sendCode'), sendCode, !!phone.trim())}
          {configured && (
            <button onClick={() => setStage('keys')} className="mt-2 w-full text-center text-xs text-muted hover:text-fg">
              {t('tg.otherKeys')}
            </button>
          )}
        </>
      )}
      {stage === 'code' && (
        <>
          <label className="mb-1.5 block text-xs text-muted">{t('tg.codeHint')}</label>
          <input value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={enter(signIn, !!code)} placeholder="12345" inputMode="numeric" autoComplete="one-time-code" autoFocus className={cx(input, 'font-mono tracking-widest')} />
          {button(t('tg.signIn'), signIn, !!code.trim())}
        </>
      )}
      {stage === 'password' && (
        <>
          <label className="mb-1.5 block text-xs text-muted">{t('tg.password')}</label>
          <input value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={enter(checkPassword, !!password)} type="password" autoComplete="current-password" autoFocus className={input} />
          {button(t('tg.signIn'), checkPassword, !!password)}
        </>
      )}
    </Modal>
  )
}
