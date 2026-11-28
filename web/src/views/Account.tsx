import { Copy, Eye, EyeOff, ImagePlus, KeyRound, Laptop, LogOut, QrCode, RefreshCw, Server, X } from 'lucide-react'
import { encode } from 'uqr'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Avatar } from '../components/Avatar'
import { EditableCover } from '../components/CoverEditor'
import { Modal } from '../components/Dialogs'
import { cx, IconBtn } from '../components/ui'
import { fmtAgo, t } from '../i18n'
import { api, getApiBase, setMediaKey } from '../lib/api'
import { toCoverDataUrl } from '../lib/covers'
import { isHost } from '../mode'
import { usePick, useStore } from '../store'
import { PageTitle } from './Library'
import { Integrations } from '../components/Integrations'
import { ScrobbleRows } from './Settings'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD = 8

function Section({ title, children, className, action }: { title: string; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section className={`widget flex flex-col gap-3 p-5 ${className ?? ''}`}>
      <div className="flex min-h-5 items-center justify-between gap-3">
        <span className="label text-muted">{title}</span>
        {action}
      </div>
      {children}
    </section>
  )
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  )
}

const input = 'w-full rounded-2xl bg-card-3 px-3.5 py-2.5 text-sm outline-none placeholder:text-muted focus:ring-1 focus:ring-fg'
const pill = 'rounded-full px-4 py-2 text-sm transition-opacity disabled:opacity-40'

export function AccountPage() {
  const online = useStore((s) => s.conn === 'online')
  // в просмотре чужой библиотеки входы пришли бы чужие — список прячем
  const viewing = useStore((s) => !!s.viewAs)
  return (
    <div>
      <PageTitle>{t('nav.account')}</PageTitle>
      {/* слева профиль (с паролем и выходом), справа — где выполнен вход; интеграции — своим разделом в меню */}
      <div className="grid items-start gap-3 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <Profile />
          {/* телефон без сервера: привязать — отсюда же, а не только из «Настроек» */}
          <BindServer />
          {online && !viewing && <Security />}
          {/* интеграции: сервисы с плейлистами (Яндекс, VK, Spotify, YouTube) и сайты статистики (ListenBrainz, Last.fm) */}
          {online && !viewing && (
            <>
              <Integrations section={(title, children) => <Section title={title}>{children}</Section>} />
            </>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          {online && !viewing && <Devices />}
          {/* сайты статистики — справа, под входами */}
          {online && !viewing && (
            <Section title={t('scr.section')}>
              <ScrobbleRows bare />
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}



/** Без сервера (всё на телефоне): привязать свой ПК или сервер — библиотеки объединятся */
function BindServer() {
  const { standalone, startBinding } = usePick('standalone', 'startBinding')
  if (isHost || !standalone) return null
  return (
    <Section title={t('solo.noServer')}>
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted">{t('solo.bindHint')}</p>
        <button onClick={startBinding} className={cx(pill, 'flex items-center gap-1.5 bg-sel text-on-sel')}>
          <Server size={14} /> {t('solo.bind')}
        </button>
      </div>
    </Section>
  )
}

/** Фото, имя, почта; внизу — сменить пароль и выйти */
function Profile() {
  const { account, saveAccount, toast, logout, standalone, me } = usePick('account', 'saveAccount', 'toast', 'logout', 'standalone', 'me')
  // логин не меняется: из профиля, а если там нет — из того, кто вошёл
  const login = account.login || me?.login || ''
  const online = useStore((s) => s.conn === 'online')
  const [name, setName] = useState(account.name)
  const [email, setEmail] = useState(account.email)
  const [passOpen, setPassOpen] = useState(false)
  const [leaving, setLeaving] = useState(false) // окно «Выйти из аккаунта?»
  const file = useRef<HTMLInputElement>(null)

  const nameError = !name.trim() ? t('acc.nameEmpty') : ''
  const emailError = email.trim() && !EMAIL.test(email.trim()) ? t('acc.emailBad') : ''
  const dirty = name.trim() !== account.name || email.trim() !== account.email

  const pickPhoto = async (f?: File | null) => {
    if (!f) return
    try {
      saveAccount({ avatar: await toCoverDataUrl(f, 400) })
    } catch {
      toast(t('toast.notImage'), 'error')
    }
  }

  return (
    <Section
      title={t('acc.profile')}
      action={
        // выход — маленькой иконкой в углу, с подтверждением. Без сервера выходить неоткуда: профиль — сам телефон
        standalone ? undefined : (
          <IconBtn title={t('acc.logout')} onClick={() => setLeaving(true)} className="-my-2 -me-2 h-8 w-8 text-muted hover:text-red">
            <LogOut size={15} />
          </IconBtn>
        )
      }
    >
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="flex flex-col items-center gap-2">
          <EditableCover rounded="rounded-full" onEdit={() => file.current?.click()}>
            {/* без фото — первая буква имени точками; меняется прямо по мере ввода */}
            <Avatar name={name || account.name} src={account.avatar} size={80} />
          </EditableCover>
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => pickPhoto(e.target.files?.[0])} />
          <button onClick={() => file.current?.click()} className="flex items-center gap-1.5 text-xs hover:underline">
            <ImagePlus size={13} /> {t('acc.uploadPhoto')}
          </button>
          {account.avatar && (
            <button onClick={() => saveAccount({ avatar: undefined })} className="text-xs text-muted hover:text-fg">
              {t('acc.removePhoto')}
            </button>
          )}
        </div>

        <form
          className="flex min-w-0 flex-1 flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (nameError || emailError || !dirty) return
            saveAccount({ name: name.trim(), email: email.trim() })
            toast(t('acc.saved'), 'ok')
          }}
        >
          {!standalone && login && (
            <Field label={t('acc.login')} hint={t('acc.loginHint')}>
              <div dir="ltr" className={cx(input, 'text-start font-mono text-muted select-all')}>
                {login}
              </div>
            </Field>
          )}
          <Field label={t('acc.name')} hint={nameError || undefined}>
            <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder={t('acc.namePh')} className={input} />
          </Field>
          <Field label={t('acc.email')} hint={emailError || undefined}>
            <input
              type="email"
              dir="ltr"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className={cx(input, 'text-start')}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={!dirty || !!nameError || !!emailError} className={cx(pill, 'bg-sel text-on-sel')}>
              {t('common.save')}
            </button>
            {/* пароль — у сервера; без него пароля нет (PIN — в настройках) */}
            {!standalone && (
              <button type="button" onClick={() => setPassOpen(true)} className={cx(pill, 'flex items-center gap-1.5 bg-card-3 hover:bg-card-2')}>
                <KeyRound size={14} /> {t('acc.passChange')}
              </button>
            )}
          </div>
        </form>
      </div>
      {passOpen && <PasswordDialog onClose={() => setPassOpen(false)} />}
      {leaving && (
        <Modal onClose={() => setLeaving(false)}>
          <div className="mb-2 text-lg font-medium">{t('acc.logoutAsk')}</div>
          <p className="mb-5 text-sm text-muted">
            {t('acc.logoutHint')} · {t(me?.role === 'admin' ? 'users.admin' : (me ? me.role === 'owner' : isHost) ? 'acc.owner' : 'acc.member')}
          </p>
          <div className="flex gap-2">
            <button onClick={() => setLeaving(false)} className="flex-1 rounded-full py-3 text-sm text-muted hover:text-fg">
              {t('common.cancel')}
            </button>
            <button
              onClick={() => {
                setLeaving(false)
                if (online) logout()
                else toast(t('acc.soon'))
              }}
              className="flex flex-1 items-center justify-center gap-2 rounded-full bg-red py-3 text-sm text-on-red"
            >
              <LogOut size={15} /> {t('acc.logout')}
            </button>
          </div>
        </Modal>
      )}
    </Section>
  )
}

/** Смена пароля — в окне, чтобы не занимать место на странице */
function PasswordDialog({ onClose }: { onClose: () => void }) {
  const { toast, changePassword } = usePick('toast', 'changePassword')
  const online = useStore((s) => s.conn === 'online')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [show, setShow] = useState(false)

  const error =
    next && next.length < MIN_PASSWORD ? t('acc.passShort') : repeat && next !== repeat ? t('acc.passMismatch') : ''
  const ready = current && next.length >= MIN_PASSWORD && next === repeat
  const type = show ? 'text' : 'password'

  return (
    <Modal onClose={onClose}>
      <div className="mb-4 flex items-start justify-between">
        <span className="label text-muted">{t('acc.password')}</span>
        <IconBtn title={t('common.close')} onClick={onClose} className="-mt-2 -me-2">
          <X size={18} />
        </IconBtn>
      </div>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!ready) return
          if (online) {
            if (!(await changePassword(current, next))) return
          } else toast(t('acc.passChanged'), 'ok')
          onClose()
        }}
      >
        <Field label={t('acc.current')}>
          <input type={type} autoFocus autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={input} />
        </Field>
        <Field label={t('acc.new')} hint={t('acc.passHint')}>
          <input type={type} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} className={input} />
        </Field>
        <Field label={t('acc.repeat')}>
          <input type={type} autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} className={input} />
        </Field>
        {error && <div className="text-xs text-red">{error}</div>}
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <button type="submit" disabled={!ready} className={cx(pill, 'bg-sel text-on-sel')}>
            {t('acc.passChange')}
          </button>
          <button type="button" onClick={() => setShow(!show)} className="flex items-center gap-1.5 text-sm text-muted hover:text-fg">
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
            {show ? t('acc.hide') : t('acc.show')}
          </button>
        </div>
        {!online && <p className="text-xs text-muted">{t('acc.soon')}</p>}
      </form>
    </Modal>
  )
}

/** Токен для нового устройства: показать один раз и скопировать */
/** Ключ для программы musich-sync на ПК: она входит по ключу, а не по паролю. Телефон и расширение VK получают ключ сами */
function NewTokenDialog({ onClose }: { onClose: () => void }) {
  const { tokens, createToken, toast } = usePick('tokens', 'createToken', 'toast')
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState<{ id: string; name: string; token: string } | null>(null)
  // только что созданный токен успели отозвать — показывать его уже незачем
  const shown = fresh && tokens.some((tk) => tk.id === fresh.id) ? fresh : null

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast(t('acc.copied'), 'ok')
    } catch {
      toast(t('acc.copyFail'), 'error')
    }
  }

  return (
    <Modal onClose={onClose} wide>
      <div className="mb-2 flex items-start justify-between">
        <span className="text-lg font-medium">{t('acc.newToken')}</span>
        <IconBtn title={t('common.close')} onClick={onClose} className="-mt-2 -me-2">
          <X size={18} />
        </IconBtn>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-muted">{t('acc.newTokenHint')}</p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          const n = name.trim()
          if (!n) return
          const created = await createToken(n)
          if (created) {
            setFresh(created)
            setName('')
          }
        }}
      >
        <input
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('acc.tokenName')}
          className={cx(input, 'min-w-0 flex-1')}
        />
        <button type="submit" disabled={!name.trim()} className={cx(pill, 'bg-sel text-on-sel')}>
          {t('acc.create')}
        </button>
      </form>
      {shown && (
        <div className="mt-3 flex flex-col gap-2 rounded-2xl border border-fg/20 p-3">
          <div className="label text-muted">{shown.name}</div>
          <div className="flex items-center gap-2">
            <code dir="ltr" className="min-w-0 flex-1 break-all font-mono text-xs select-all">{shown.token}</code>
            <IconBtn title={t('acc.copy')} onClick={() => copy(shown.token)}>
              <Copy size={16} />
            </IconBtn>
          </div>
          <div className="flex items-center gap-2 text-xs text-red">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red" />
            {t('acc.tokenOnce')}
          </div>
        </div>
      )}
    </Modal>
  )
}

/** QR рисуем сами из матрицы uqr: цвет — текущий текст, фон — белый (камеры плохо читают светлый QR на тёмном) */
function Qr({ text, size = 200 }: { text: string; size?: number }) {
  const { data } = encode(text, { ecc: 'M', border: 2 })
  const n = data.length
  const path = data.flatMap((row, y) => row.map((on, x) => (on ? `M${x} ${y}h1v1h-1z` : ''))).join('')
  return (
    <svg viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges" className="rounded-xl bg-white">
      <path d={path} fill="#000" />
    </svg>
  )
}

/**
 * Подключить устройство: одноразовый код из 6 цифр и QR с адресом этого сервера. На другом устройстве —
 * «Войти по коду» (или навести камеру телефона на QR). Код живёт 10 минут и срабатывает один раз
 */
function PairDialog({ onClose }: { onClose: () => void }) {
  const { toast, loadTokens } = usePick('toast', 'loadTokens')
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null)
  const [left, setLeft] = useState(0)
  const origin = getApiBase() || location.origin
  // localhost и 127.0.0.1 другое устройство не найдёт — QR с таким адресом бесполезен
  const local = /^https?:\/\/(localhost|127\.|\[::1\])/.test(origin)

  const fresh = async () => {
    try {
      setCode(await api<{ code: string; expiresAt: string }>('/sync/codes', { method: 'POST' }))
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  useEffect(() => {
    void fresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!code) return
    const tick = () => setLeft(Math.max(0, Date.parse(code.expiresAt) - Date.now()))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [code])
  // закрыли окно — возможно, устройство уже подключилось: освежаем список
  const close = () => {
    void loadTokens()
    onClose()
  }

  const expired = !!code && left === 0
  const mmss = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`
  return (
    <Modal onClose={close}>
      <div className="mb-2 flex items-start justify-between">
        <span className="text-lg font-medium">{t('acc.pairTitle')}</span>
        <IconBtn title={t('common.close')} onClick={close} className="-mt-2 -me-2">
          <X size={18} />
        </IconBtn>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-muted">{t('acc.pairHint')}</p>
      {code && (
        <div className={cx('flex flex-col items-center gap-4', expired && 'opacity-40')}>
          {!local && <Qr text={`${origin}/?pair=${code.code}`} />}
          <div dir="ltr" className="font-mono text-4xl tracking-[0.3em]">
            {code.code.slice(0, 3)} {code.code.slice(3)}
          </div>
        </div>
      )}
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-xs text-muted">{expired ? t('acc.pairExpired') : code ? t('acc.pairLeft', { time: mmss }) : ''}</span>
        <button onClick={() => void fresh()} className="flex items-center gap-1.5 rounded-full bg-card-3 px-4 py-2 text-sm hover:bg-card-2">
          <RefreshCw size={14} /> {t('acc.pairNew')}
        </button>
      </div>
      {local && <p className="mt-4 text-xs leading-relaxed text-muted">{t('acc.pairLocal')}</p>}
    </Modal>
  )
}

/** Где выполнен вход: компактный список, свой вход — «Выйти», чужой — отозвать */
function Devices() {
  const { tokens, loadTokens, revokeToken, logout } = usePick('tokens', 'loadTokens', 'revokeToken', 'logout')
  const [keyOpen, setKeyOpen] = useState(false)
  const [pairOpen, setPairOpen] = useState(false)

  useEffect(() => {
    loadTokens()
  }, [loadTokens])

  return (
    <Section
      title={t('acc.devices')}
      action={
        <div className="flex items-center gap-4">
          <button onClick={() => setKeyOpen(true)} className="flex items-center gap-1.5 text-xs text-muted hover:text-fg">
            <KeyRound size={13} /> {t('acc.syncKey')}
          </button>
          <button onClick={() => setPairOpen(true)} className="flex items-center gap-1.5 rounded-full bg-sel px-3 py-1.5 text-xs text-on-sel">
            <QrCode size={13} /> {t('acc.pair')}
          </button>
        </div>
      }
    >
      {keyOpen && <NewTokenDialog onClose={() => setKeyOpen(false)} />}
      {pairOpen && <PairDialog onClose={() => setPairOpen(false)} />}
      <p className="-mt-1 text-xs text-muted">{t('acc.devicesHint')}</p>
      <div className="-mx-1 flex max-h-[24rem] flex-col overflow-y-auto">
        {tokens.map((tk) => (
          <div key={tk.id} className="flex items-center gap-2.5 border-b border-line px-1 py-1.5 last:border-0">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-card-3">
              <Laptop size={13} strokeWidth={1.6} />
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm">
                {tk.name}
                {tk.current && <span className="text-muted"> · {t('acc.thisBrowser')}</span>}
              </div>
              <div className="text-[11px] text-muted">{t('acc.lastUsed', { ago: fmtAgo(Date.parse(tk.lastUsedAt)) })}</div>
            </div>
            <IconBtn title={tk.current ? t('acc.logout') : t('acc.revoke')} onClick={() => (tk.current ? logout() : revokeToken(tk.id))} className="h-8 w-8 text-muted">
              {tk.current ? <LogOut size={14} /> : <X size={15} />}
            </IconBtn>
          </div>
        ))}
      </div>
    </Section>
  )
}

/** Защита: двухэтапный вход (код из приложения-аутентификатора) и «выйти на всех других устройствах» */
function Security() {
  const toast = useStore((s) => s.toast)
  const [on, setOn] = useState<boolean | null>(null)
  const [dialog, setDialog] = useState<'enable' | 'disable' | null>(null)
  useEffect(() => {
    api<{ enabled: boolean }>('/auth/2fa').then((r) => setOn(r.enabled), () => setOn(null))
  }, [dialog])
  const logoutAll = async () => {
    if (!confirm(t('sec.logoutAllAsk'))) return
    try {
      const r = await api<{ revoked: number }>('/auth/logout-all', { method: 'POST' })
      // медиа-ключи тоже сброшены — берём новый, обложки и звук перезагрузятся
      setMediaKey(null)
      toast(t('sec.loggedOut', { n: r.revoked }), 'ok')
      void useStore.getState().initConn()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  return (
    <Section title={t('sec.title')}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[15px]">{t('sec.totp')}</div>
          <div className="text-xs text-muted">{on ? t('sec.totpOn') : t('sec.totpOff')}</div>
        </div>
        {on !== null && (
          <button onClick={() => setDialog(on ? 'disable' : 'enable')} className={cx(pill, on ? 'bg-card-3 text-red' : 'bg-sel text-on-sel')}>
            {on ? t('sec.totpDisable') : t('sec.totpEnable')}
          </button>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-line pt-3">
        <div className="min-w-0 flex-1">
          <div className="text-[15px]">{t('sec.logoutAll')}</div>
          <div className="text-xs text-muted">{t('sec.logoutAllHint')}</div>
        </div>
        <button onClick={() => void logoutAll()} className={cx(pill, 'bg-card-3')}>
          <LogOut size={14} className="me-1.5 inline" />
          {t('sec.logoutAllGo')}
        </button>
      </div>
      {dialog === 'enable' && <TotpEnable onClose={() => setDialog(null)} />}
      {dialog === 'disable' && <TotpDisable onClose={() => setDialog(null)} />}
    </Section>
  )
}

function TotpEnable({ onClose }: { onClose: () => void }) {
  const toast = useStore((s) => s.toast)
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null)
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState<string[] | null>(null)
  useEffect(() => {
    api<{ secret: string; uri: string }>('/auth/2fa/setup', { method: 'POST' }).then(setSetup, (e: Error) => {
      toast(e.message, 'error')
      onClose()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const enable = async () => {
    try {
      setRecovery((await api<{ recovery: string[] }>('/auth/2fa/enable', { method: 'POST', body: { code } })).recovery)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  return (
    <Modal onClose={recovery ? onClose : onClose}>
      <div className="mb-1 text-lg font-medium">{t('sec.totp')}</div>
      {recovery ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted">{t('sec.recoveryHint')}</p>
          <div className="grid grid-cols-2 gap-1.5 rounded-2xl bg-card-3 p-3 font-mono text-sm">
            {recovery.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <button onClick={() => void navigator.clipboard?.writeText(recovery.join('\n')).then(() => toast(t('acc.copied'), 'ok'))} className={cx(pill, 'bg-card-3')}>
            <Copy size={14} className="me-1.5 inline" />
            {t('acc.copy')}
          </button>
          <button onClick={onClose} className={cx(pill, 'bg-sel py-3 text-on-sel')}>
            {t('common.done')}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted">{t('sec.totpScan')}</p>
          {setup && (
            <>
              <div className="self-center rounded-2xl bg-white p-3">
                <Qr text={setup.uri} size={180} />
              </div>
              <p className="text-xs text-muted">{t('sec.totpSecret')}</p>
              <code className="break-all rounded-xl bg-card-3 px-3 py-2 text-center font-mono text-sm">{setup.secret}</code>
            </>
          )}
          <input
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder={t('auth.totpPh')}
            className={cx(input, 'text-center font-mono text-xl tracking-[0.3em]')}
          />
          <div className="flex gap-2">
            <button onClick={onClose} className={cx(pill, 'flex-1 bg-card-3 py-3')}>
              {t('common.cancel')}
            </button>
            <button onClick={() => void enable()} disabled={code.length !== 6} className={cx(pill, 'flex-1 bg-sel py-3 text-on-sel')}>
              {t('sec.totpEnable')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function TotpDisable({ onClose }: { onClose: () => void }) {
  const toast = useStore((s) => s.toast)
  const [pw, setPw] = useState('')
  const off = async () => {
    try {
      await api('/auth/2fa/disable', { method: 'POST', body: { password: pw } })
      toast(t('sec.totpOffDone'), 'ok')
      onClose()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  return (
    <Modal onClose={onClose}>
      <div className="mb-1 text-lg font-medium">{t('sec.totpDisable')}</div>
      <p className="mb-3 text-sm text-muted">{t('sec.totpDisableHint')}</p>
      <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t('auth.password')} autoComplete="current-password" className={input} />
      <div className="mt-4 flex gap-2">
        <button onClick={onClose} className={cx(pill, 'flex-1 bg-card-3 py-3')}>
          {t('common.cancel')}
        </button>
        <button onClick={() => void off()} disabled={!pw} className={cx(pill, 'flex-1 bg-card-3 py-3 text-red')}>
          {t('sec.totpDisable')}
        </button>
      </div>
    </Modal>
  )
}
