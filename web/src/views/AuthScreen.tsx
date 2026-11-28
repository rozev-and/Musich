import { ArrowLeft, ArrowRight, Eye, EyeOff, RefreshCw, Server, Smartphone, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Logo } from '../components/Nav'
import { cx } from '../components/ui'
import { t, type Key } from '../i18n'
import { isHost } from '../mode'
import type { FoundServer } from '../lib/discovery'
import { getApiBase } from '../lib/api'
import { LOGIN_RE, MIN_PASSWORD, usePick, useStore, type AuthForm, type AuthMode, type ServerCheck } from '../store'

const input = 'w-full rounded-2xl bg-card-3 px-4 py-3 text-[15px] outline-none placeholder:text-muted focus:ring-1 focus:ring-fg'

/** Как входим: логином и паролем или кодом с уже подключённого устройства — переключатель сверху окна */
type How = 'password' | 'code'
function HowSwitch({ how, onChange }: { how: How; onChange: (h: How) => void }) {
  return (
    <div className="flex rounded-full bg-card-3 p-1">
      {(['password', 'code'] as const).map((h) => (
        <button
          key={h}
          type="button"
          onClick={() => onChange(h)}
          className={cx('flex-1 rounded-full px-3 py-1.5 text-sm transition-colors', how === h ? 'bg-sel text-on-sel' : 'text-muted hover:text-fg')}
        >
          {h === 'password' ? t('auth.howPassword') : t('auth.howCode')}
        </button>
      ))}
    </div>
  )
}

/** Код подключения: 6 цифр крупно; подсказка, где его взять */
function CodeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <>
      <input
        autoFocus
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder={t('auth.codePh')}
        aria-label={t('auth.codePh')}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        className={cx(input, 'text-center font-mono text-2xl tracking-[0.4em]')}
      />
      <p className="-mt-1 text-xs text-muted">{t('auth.codeHint')}</p>
    </>
  )
}

// Новый аккаунт (первый запуск, регистрация) — с именем и паролем дважды; вход и «придумайте логин» — логин и пароль
const creates = (mode: AuthMode) => mode === 'setup' || mode === 'register'

/** Поля входа: логин, имя, пароль, повтор — что нужно для режима. Подсказка и «можно отправлять» считаются здесь же */
function useAuthFields(mode: AuthMode) {
  const [login, setLogin] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [show, setShow] = useState(false)
  const creating = creates(mode)
  const okLogin = LOGIN_RE.test(login.trim())
  const hint =
    login.trim() && !okLogin
      ? t('auth.loginRule')
      : creating && password && password.length < MIN_PASSWORD
        ? t('acc.passShort')
        : creating && repeat && repeat !== password
          ? t('acc.passMismatch')
          : ''
  const ready = okLogin && (creating ? password.length >= MIN_PASSWORD && password === repeat : !!password)
  const form = (): AuthForm => ({ mode, login: login.trim(), password, ...(creating ? { name: name.trim() } : {}) })

  const fields = (
    <>
      <input
        autoFocus={isHost}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        dir="ltr"
        maxLength={32}
        autoComplete={creating || mode === 'claim' ? 'off' : 'username'}
        placeholder={mode === 'claim' ? t('auth.newLoginPh') : t('auth.loginPh')}
        aria-label={t('auth.loginPh')}
        value={login}
        onChange={(e) => setLogin(e.target.value)}
        className={cx(input, 'text-start')}
      />
      {creating && <input maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('acc.namePh')} aria-label={t('acc.name')} className={input} />}
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          autoComplete={creating ? 'new-password' : 'current-password'}
          placeholder={mode === 'claim' ? t('auth.currentPass') : t('auth.password')}
          aria-label={t('auth.password')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={cx(input, 'pe-12')}
        />
        <button type="button" onClick={() => setShow(!show)} aria-label={show ? t('acc.hide') : t('acc.show')} className="absolute inset-y-0 end-0 grid w-12 place-items-center text-muted">
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      {creating && (
        <input
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          placeholder={t('auth.repeat')}
          aria-label={t('auth.repeat')}
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          className={input}
        />
      )}
    </>
  )
  return { fields, hint, ready, form }
}

// Заголовок и подсказка формы по режиму
const AUTH_TEXT: Record<AuthMode, { title: Key; hint: Key; go: Key }> = {
  setup: { title: 'auth.ownerTitle', hint: 'auth.ownerHint', go: 'auth.start' },
  login: { title: 'auth.loginTitle', hint: 'auth.loginHintUser', go: 'auth.login' },
  register: { title: 'auth.regTitle', hint: 'auth.regHint', go: 'auth.register' },
  claim: { title: 'auth.claimTitle', hint: 'auth.claimHint', go: 'auth.claimGo' },
}

/** «Войти / Регистрация» — переключатель над формой, если сервер разрешает регистрацию */
function ModeSwitch({ mode, onChange }: { mode: AuthMode; onChange: (register: boolean) => void }) {
  return (
    <div className="flex rounded-full bg-card-3 p-1">
      {([false, true] as const).map((reg) => (
        <button
          key={String(reg)}
          type="button"
          onClick={() => onChange(reg)}
          className={cx('flex-1 rounded-full px-3 py-1.5 text-sm transition-colors', (mode === 'register') === reg ? 'bg-sel text-on-sel' : 'text-muted hover:text-fg')}
        >
          {reg ? t('auth.regTitle') : t('auth.login')}
        </button>
      ))}
    </div>
  )
}

/** Сервер не отвечает: сами пробуем снова раз в 5 секунд, можно и кнопкой */
export function OfflineScreen() {
  const initConn = useStore((s) => s.initConn)
  const changeServer = useStore((s) => s.changeServer)
  useEffect(() => {
    const id = setInterval(initConn, 5000)
    return () => clearInterval(id)
  }, [initConn])
  return (
    <div className="grid h-full place-items-center overflow-y-auto p-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Logo className="self-center" />
        <SoloStart />
        <div className="widget flex flex-col gap-4 p-6">
          <div className="flex items-center gap-2">
            <span className="blink h-2 w-2 rounded-full bg-red" />
            <span className="label text-muted">{t('auth.server')}</span>
          </div>
          <div>
            <h1 className="text-2xl font-medium">{t('off.title')}</h1>
            <p className="mt-1 text-sm text-muted">{t('off.hint')}</p>
          </div>
          <div className="flex items-center justify-between gap-3">
            {/* в приложении адрес мог смениться (другая сеть, другой сервер) */}
            {!isHost ? (
              <button onClick={changeServer} className="flex items-center gap-1.5 text-sm text-muted hover:text-fg">
                <Server size={15} /> {t('dev.otherServer')}
              </button>
            ) : (
              <span />
            )}
            <button
              onClick={initConn}
              className="flex items-center gap-2 rounded-full bg-sel px-6 py-2.5 text-sm text-on-sel transition-transform active:scale-95"
            >
              <RefreshCw size={15} /> {t('off.retry')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Приложение: свой сервер — одной формой: адрес (домен или IP в сети), логин, пароль. Пока вводишь адрес, проверяем,
 * что там: новый сервер (создаём владельца: логин, имя, пароль с повтором), настроенный (вход; если разрешено —
 * и регистрация) или обновлённый, где владельцу нужно придумать логин. Найденные в домашней сети — кнопками,
 * нажал — адрес подставился. Вход кодом с другого устройства — ссылкой под формой
 */
export function ConnectScreen() {
  const { checkServer, signInServer, pairServer } = usePick('checkServer', 'signInServer', 'pairServer')
  const [address, setAddress] = useState('')
  const [totp, setTotp] = useState('')
  const [needTotp, setNeedTotp] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [found, setFound] = useState<FoundServer[] | null>(null)
  // что по адресу: null — ещё не знаем, false — не отвечает
  const [server, setServer] = useState<ServerCheck | false | null>(null)
  // регистрация вместо входа; у сервера без логина владельца — обычный вход вместо «придумайте логин»
  const [alt, setAlt] = useState(false)
  const [how, setHow] = useState<How>('password')
  const [code, setCode] = useState('')
  const mode: AuthMode = !server ? 'login' : !server.setupDone ? 'setup' : server.ownerNeedsLogin ? (alt ? 'login' : 'claim') : alt && server.registration ? 'register' : 'login'
  const { fields, hint, ready: filled, form } = useAuthFields(mode)

  const search = async () => {
    setFound(null)
    const { findServers } = await import('../lib/discovery')
    setFound(await findServers())
  }
  useEffect(() => {
    void search()
  }, [])
  // адрес — проверяем, когда перестали печатать
  useEffect(() => {
    setServer(null)
    setAlt(false) // другой сервер — снова обычный вход
    if (!address.trim()) return
    let live = true
    const id = setTimeout(() => void checkServer(address).then((r) => live && setServer(r ?? false)), 600)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [address, checkServer])

  const isNew = mode === 'setup'
  // код есть только у настроенного сервера, где у владельца уже есть логин
  const canCode = !!server && server.setupDone && !server.ownerNeedsLogin
  const byCode = canCode && how === 'code'
  const ready = byCode ? code.length === 6 : !!server && filled

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    setError('')
    const err = byCode ? await pairServer(address, code) : await signInServer(address, { ...form(), code: totp })
    setBusy(false)
    // пароль верный, нужен код из приложения-аутентификатора — показываем поле кода
    if (err === t('auth.totpNeed')) setNeedTotp(true)
    else if (err) setError(err)
  }
  const pick = (h: How) => {
    setHow(h)
    setError('')
  }

  return (
    <div className="grid h-full place-items-center overflow-y-auto p-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Logo className="self-center" />
        <SoloStart />
        <form
          className="widget flex flex-col gap-4 p-6"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="flex items-center gap-2">
            <span className={cx('h-2 w-2 rounded-full', server ? 'bg-fg' : 'blink bg-red')} />
            <span className="label text-muted">{t('auth.server')}</span>
          </div>
          <div>
            <h1 className="text-2xl font-medium">{t('dev.ownServer')}</h1>
            <p className="mt-1 text-sm text-muted">{t('dev.ownServerHintUser')}</p>
          </div>

          {/* найденные в домашней сети: нажал — адрес подставился */}
          {found === null && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <RefreshCw size={14} className="animate-spin" /> {t('dev.lookingLan')}
            </div>
          )}
          {found?.map((s) => (
            <button
              key={s.node}
              type="button"
              onClick={() => setAddress(s.url)}
              className={cx(
                'flex items-center gap-3 rounded-2xl px-4 py-3 text-start transition-colors',
                address === s.url ? 'bg-sel text-on-sel' : 'bg-card-3 hover:bg-card-2',
              )}
            >
              <Server size={18} strokeWidth={1.6} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{s.name}</span>
                <span dir="ltr" className="block truncate font-mono text-xs opacity-70">
                  {s.url.replace(/^https?:\/\//, '')}
                </span>
              </span>
            </button>
          ))}
          {found?.length === 0 && (
            <button type="button" onClick={() => void search()} className="flex items-center gap-1.5 self-start text-xs text-muted hover:text-fg">
              <RefreshCw size={13} /> {t('dev.searchAgain')}
            </button>
          )}

          <input
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            dir="ltr"
            placeholder={t('dev.domainPh')}
            aria-label={t('dev.domainPh')}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className={cx(input, 'font-mono')}
          />
          {address.trim() && (
            <div className="-mt-2 text-xs text-muted">
              {server === null
                ? t('dev.checking')
                : server === false
                  ? t('dev.noAnswer')
                  : isNew
                    ? t('dev.newServerUser')
                    : server.ownerNeedsLogin
                      ? t('dev.claimServer')
                      : t('dev.knownServerUser')}
            </div>
          )}

          {server && (
            <>
              {canCode && <HowSwitch how={how} onChange={pick} />}
              {byCode ? (
                <CodeField value={code} onChange={setCode} />
              ) : (
                <>
              {/* «Войти / Регистрация» — только если владелец открыл регистрацию */}
              {server.setupDone && server.registration && !server.ownerNeedsLogin && <ModeSwitch mode={mode} onChange={setAlt} />}
              {mode === 'claim' && <p className="text-xs text-muted">{t('auth.claimHint')}</p>}
              {fields}
              {needTotp && <TotpField value={totp} onChange={setTotp} />}
              {isNew && <div className="text-xs text-muted">{t('auth.ownerNoteUser')}</div>}
              {/* после обновления сервера: уже есть свой логин (вы не владелец) — обычный вход */}
              {server.ownerNeedsLogin && (
                <button type="button" onClick={() => setAlt(!alt)} className="self-start text-xs text-muted underline-offset-4 hover:text-fg hover:underline">
                  {alt ? t('auth.toClaim') : t('auth.otherLogin')}
                </button>
              )}
                </>
              )}
            </>
          )}
          {(error || (!byCode && hint)) && <div className="text-xs text-red">{error || hint}</div>}

          <div className="flex items-center justify-end gap-3">
            <button
              type="submit"
              disabled={!ready || busy}
              className="flex items-center gap-2 rounded-full bg-sel px-6 py-2.5 text-sm text-on-sel transition-transform active:scale-95 disabled:opacity-40"
            >
              {busy ? t('dev.searching') : byCode ? t('auth.login') : t(AUTH_TEXT[mode].go)} <ArrowRight size={15} className="rtl:rotate-180" />
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/**
 * «Начать без сервера» — на всех первых экранах телефона (подключение, вход, «сервер не отвечает»): сервер мог
 * остаться от прошлой установки или быть недоступен, а пользоваться приложением можно и без него
 */
export function SoloStart() {
  const { binding, openProfileSetup } = usePick('binding', 'openProfileSetup')
  if (isHost || binding) return null
  return (
    <button onClick={openProfileSetup} className="widget flex items-center gap-4 p-5 text-start transition-transform active:scale-[.98]">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-sel text-on-sel">
        <Smartphone size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium">{t('solo.start')}</span>
        <span className="block text-xs text-muted">{t('solo.startHint')}</span>
      </span>
      <ArrowRight size={16} className="shrink-0 rtl:rotate-180" />
    </button>
  )
}

/** «Начать без сервера»: только имя. Пароля нет — телефон и так под блокировкой; PIN можно включить в настройках */
export function ProfileScreen() {
  const { startStandalone, backToConnect } = usePick('startStandalone', 'backToConnect')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const ready = !!name.trim()
  return (
    <div className="grid h-full place-items-center overflow-y-auto p-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Logo className="self-center" />
        <form
          className="widget flex flex-col gap-4 p-6"
          onSubmit={(e) => {
            e.preventDefault()
            if (!ready || busy) return
            setBusy(true)
            void startStandalone(name)
          }}
        >
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-red" />
            <span className="label text-muted">{t('solo.label')}</span>
          </div>
          <div>
            <h1 className="text-2xl font-medium">{t('solo.nameTitle')}</h1>
            <p className="mt-1 text-sm text-muted">{t('solo.nameHint')}</p>
          </div>
          <input autoFocus maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('acc.namePh')} className={input} />
          <div className="flex items-center justify-between gap-3">
            <button type="button" onClick={backToConnect} className="flex items-center gap-1.5 text-sm text-muted hover:text-fg">
              <ArrowLeft size={15} className="rtl:rotate-180" /> {t('common.back')}
            </button>
            <button
              type="submit"
              disabled={!ready || busy}
              className="flex items-center gap-2 rounded-full bg-sel px-6 py-2.5 text-sm text-on-sel transition-transform active:scale-95 disabled:opacity-40"
            >
              {t('solo.go')} <ArrowRight size={15} className="rtl:rotate-180" />
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/** Привязка из автономного режима: на всех экранах подключения и входа — «Назад, без сервера» */
export function BindingBack() {
  const { binding, cancelBinding } = usePick('binding', 'cancelBinding')
  if (!binding) return null
  return (
    <button
      onClick={() => void cancelBinding()}
      className="fixed start-3 z-50 flex items-center gap-1.5 rounded-full bg-card px-4 py-2 text-sm text-fg"
      style={{ top: 'calc(0.75rem + var(--safe-top))' }}
    >
      <ArrowLeft size={15} className="rtl:rotate-180" /> {t('solo.back')}
    </button>
  )
}

/** Код подключения из QR: адрес вида …/?pair=123456 — забираем и убираем из строки адреса */
function takePairCode(): string {
  try {
    const url = new URL(location.href)
    const code = url.searchParams.get('pair') ?? ''
    if (code) {
      url.searchParams.delete('pair')
      history.replaceState(null, '', url.pathname + url.search + url.hash)
    }
    return code.replace(/\D/g, '').slice(0, 6)
  } catch {
    return ''
  }
}
// забираем один раз, при загрузке страницы: экран входа может показаться и пропасть, пока идёт проверка сервера,
// и при повторном показе кода в адресе уже не было бы (переход «Домен / Дома» открывал форму пароля)
let pairFromUrl = takePairCode()

/**
 * Первый запуск (аккаунт владельца), вход логином и паролем или кодом подключения, регистрация (если открыта),
 * «придумайте логин» владельцу после обновления. Показывается вместо всего интерфейса
 */
export function AuthScreen() {
  const { conn } = usePick('conn')
  // QR с кода подключения открыл MUSICH — сразу вход по коду
  const [fromQr] = useState(() => pairFromUrl)
  const [byCode, setByCode] = useState(!!fromQr)
  if (conn === 'login' && byCode) return <CodeLogin initial={fromQr} onPassword={() => setByCode(false)} />
  return <PasswordLogin onCode={() => setByCode(true)} />
}

/** Вход по коду: код из 6 цифр с подключённого устройства (Аккаунт → Устройства → «Подключить устройство») */
function CodeLogin({ initial, onPassword }: { initial: string; onPassword: () => void }) {
  const { codeSubmit } = usePick('codeSubmit')
  const [code, setCode] = useState(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const ready = code.length === 6

  const submit = async (value = code) => {
    if (value.length !== 6 || busy) return
    setBusy(true)
    setError('')
    pairFromUrl = '' // код одноразовый: попробовали — больше сам не подставляем
    const err = await codeSubmit(value)
    setBusy(false)
    if (err) setError(err)
  }
  // пришли по QR — код уже есть, входим сами
  useEffect(() => {
    if (initial.length === 6) void submit(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="grid h-full place-items-center overflow-y-auto p-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Logo className="self-center" />
        <SoloStart />
        <form
          className="widget flex flex-col gap-4 p-6"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-fg" />
            <span className="label text-muted">{t('auth.server')}</span>
          </div>
          <h1 className="text-2xl font-medium">{t('auth.login')}</h1>
          <HowSwitch how="code" onChange={(h) => h === 'password' && onPassword()} />
          <CodeField value={code} onChange={setCode} />
          {error && <div className="text-xs text-red">{error}</div>}
          <div className="flex items-center justify-end gap-3">
            <button
              type="submit"
              disabled={!ready || busy}
              className="flex items-center gap-2 rounded-full bg-sel px-6 py-2.5 text-sm text-on-sel transition-transform active:scale-95 disabled:opacity-40"
            >
              {t('auth.login')} <ArrowRight size={15} className="rtl:rotate-180" />
            </button>
          </div>
        </form>
        <div className="flex justify-center">
          <ServerLine />
        </div>
      </div>
    </div>
  )
}

/**
 * На телефоне: к какому серверу входим и «Другой сервер». Вышел из аккаунта, сервер переехал, хочешь другой —
 * без этого с экрана входа было не уйти (только переустановкой)
 */
function ServerLine() {
  const changeServer = useStore((s) => s.changeServer)
  if (isHost) return null
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-muted">
      <span dir="ltr" className="max-w-56 truncate font-mono text-xs">
        {getApiBase().replace(/^https?:\/\//, '')}
      </span>
      <button onClick={changeServer} className="flex items-center gap-1.5 underline-offset-4 hover:text-fg hover:underline">
        <Server size={15} /> {t('dev.otherServer')}
      </button>
    </div>
  )
}

function PasswordLogin({ onCode }: { onCode: () => void }) {
  const { conn, authSubmit, registration } = usePick('conn', 'authSubmit', 'registration')
  // на входе — регистрация (если открыта); на «придумайте логин» — обычный вход для тех, у кого логин уже есть
  const [alt, setAlt] = useState(false)
  const [totp, setTotp] = useState('')
  const [needTotp, setNeedTotp] = useState(false)
  const mode: AuthMode = conn === 'setup' ? 'setup' : conn === 'claim' ? (alt ? 'login' : 'claim') : alt && registration ? 'register' : 'login'
  const { fields, hint, ready, form } = useAuthFields(mode)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const text = AUTH_TEXT[mode]

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    setError('')
    const err = await authSubmit({ ...form(), code: totp })
    setBusy(false)
    if (err === t('auth.totpNeed')) setNeedTotp(true)
    else if (err) setError(err)
  }
  const switchTo = (v: boolean) => {
    setAlt(v)
    setError('')
  }

  return (
    <div className="grid h-full place-items-center overflow-y-auto p-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <Logo className="self-center" />
        <SoloStart />
        <form
          className="widget flex flex-col gap-4 p-6"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <div className="flex items-center gap-2">
            <span className={cx('h-2 w-2 rounded-full', mode === 'setup' || mode === 'claim' ? 'blink bg-red' : 'bg-fg')} />
            <span className="label text-muted">{mode === 'setup' ? t('auth.firstRun') : t('auth.server')}</span>
          </div>
          <div>
            <h1 className="text-2xl font-medium">{t(text.title)}</h1>
            <p className="mt-1 text-sm text-muted">{t(text.hint)}</p>
          </div>
          {conn === 'login' && !alt && <HowSwitch how="password" onChange={(h) => h === 'code' && onCode()} />}

          {fields}
          {needTotp && <TotpField value={totp} onChange={setTotp} />}

          {(error || hint) && <div className={cx('text-xs', error ? 'text-red' : 'text-muted')}>{error || hint}</div>}

          <div className="flex items-center justify-end gap-3">
            <button
              type="submit"
              disabled={!ready || busy}
              className="flex items-center gap-2 rounded-full bg-sel px-6 py-2.5 text-sm text-on-sel transition-transform active:scale-95 disabled:opacity-40"
            >
              {t(text.go)} <ArrowRight size={15} className="rtl:rotate-180" />
            </button>
          </div>
        </form>
        {mode === 'setup' && <p className="px-2 text-center text-xs text-muted">{t('auth.ownerNoteUser')}</p>}
        <div className="flex flex-col items-center gap-3">
          {conn === 'login' && registration && (
            <button onClick={() => switchTo(!alt)} className="flex items-center gap-1.5 text-sm text-muted underline-offset-4 hover:text-fg hover:underline">
              {alt ? t('auth.toLogin') : <><UserPlus size={15} /> {t('auth.regTitle')}</>}
            </button>
          )}
          <ServerLine />
          {/* после обновления сервера: свой логин уже есть (вы не владелец) — обычный вход */}
          {conn === 'claim' && (
            <button onClick={() => switchTo(!alt)} className="text-sm text-muted underline-offset-4 hover:text-fg hover:underline">
              {alt ? t('auth.toClaim') : t('auth.otherLogin')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Код из приложения-аутентификатора (или запасной код) — второй шаг входа */
function TotpField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <input
        autoFocus
        inputMode="numeric"
        autoComplete="one-time-code"
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, 20))}
        placeholder={t('auth.totpPh')}
        aria-label={t('auth.totpPh')}
        className={cx(input, 'text-center font-mono text-xl tracking-[0.3em]')}
      />
      <span className="text-xs text-muted">{t('auth.totpNeed')}</span>
    </div>
  )
}
