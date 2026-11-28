import { Check, Copy, Download, ExternalLink, Plus, RefreshCw, Search, TriangleAlert, Unlink, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { fmtAgo, t, tn, type Key } from '../i18n'
import { api, getApiBase, mediaUrl, type CompareResult, type IntegrationStatus } from '../lib/api'
import { usePick } from '../store'
import { PlayerIcon } from './BrandIcons'
import { TelegramTile } from './TelegramIntegration'
import { Modal } from './Dialogs'
import { cx, IconBtn } from './ui'

type ServiceId = 'vk' | 'yandex' | 'spotify' | 'youtube'
type Live = ServiceId

// Музыкальные сервисы. В интерфейсе — «плееры» по цвету (Зелёный, Красный, Синий, Жёлтый) со своими значками:
// чужие названия и логотипы на виду не держим (товарные знаки); настоящие имена — только в инструкциях, где без них никак.
// Spotify и YouTube Music — официальный вход; Яндекс — неофициальный API или открытые ссылки; VK — список со страницы vk.com
export const SERVICES: { id: ServiceId; name: Key; color: string }[] = [
  { id: 'spotify', name: 'svc.spotify', color: '#1ed760' },
  { id: 'youtube', name: 'svc.youtube', color: '#ff0000' },
  { id: 'vk', name: 'svc.vk', color: '#0077ff' },
  { id: 'yandex', name: 'svc.yandex', color: '#ffcc00' },
]

const pill = 'rounded-full px-3 py-1.5 text-xs transition-opacity disabled:opacity-40'
const input = 'w-full rounded-2xl bg-card-3 px-3.5 py-2.5 text-sm outline-none placeholder:text-muted focus:ring-1 focus:ring-fg'

export function Logo({ s, size }: { s: (typeof SERVICES)[number]; size?: number }) {
  return <PlayerIcon id={s.id} size={size} />
}

/**
 * Интеграции: забрать из сервиса лайки и плейлисты и сравнить с библиотекой — что уже есть, чего не хватает.
 * Только чтение и сравнение, ничего не качаем
 */
export function Integrations({ section }: { section: (title: string, children: ReactNode) => ReactNode }) {
  const { toast, loadRemote } = usePick('toast', 'loadRemote')
  const [status, setStatus] = useState<IntegrationStatus[]>([])
  const [connecting, setConnecting] = useState<Live | null>(null)
  const [comparing, setComparing] = useState<Live | null>(null)
  const [busy, setBusy] = useState<Live | null>(null)

  // статусы — здесь, а плейлисты сервисов в сайдбаре — заодно освежаем
  const load = useCallback(() => {
    void loadRemote()
    return api<IntegrationStatus[]>('/integrations').then(setStatus, () => {})
  }, [loadRemote])
  useEffect(() => {
    void load()
  }, [load])

  const sync = async (s: Live) => {
    setBusy(s)
    try {
      await api(`/integrations/${s}/sync`, { method: 'POST' })
      toast(t('int.synced'), 'ok')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
    setBusy(null)
    void load()
  }
  const disconnect = async (s: Live) => {
    await api(`/integrations/${s}`, { method: 'DELETE' }).catch(() => {})
    void load()
  }

  return (
    <>
      {section(
        t('acc.integrations'),
        <>
          <p className="-mt-1 text-xs text-muted">{t('acc.integrationsHint')}</p>
          {/* плитками: логотип и название сверху, статус, внизу — действия */}
          <div className="grid grid-cols-2 gap-2">
            {SERVICES.map((s) => {
              const st = status.find((x) => x.service === s.id)
              return (
                <div key={s.id} className={cx('flex min-w-0 flex-col gap-2 rounded-2xl p-3', st?.connected ? 'bg-card-2' : 'bg-card-2/50 ring-1 ring-line')}>
                  <div className="flex items-center gap-2.5">
                    <Logo s={s} size={28} />
                    <div className="min-w-0 flex-1 truncate text-sm font-medium">{t(s.name)}</div>
                  </div>
                  <div className="min-h-8 text-[11px] leading-snug text-muted">
                    {st?.connected ? (
                      <>
                        <div className="truncate text-fg/80">{st.account}</div>
                        {st.total !== undefined && <div className="truncate">{t('int.missingOf', { n: st.missing ?? 0, total: st.total })}</div>}
                        {st.syncedAt && <div className="truncate">{fmtAgo(Date.parse(st.syncedAt))}</div>}
                      </>
                    ) : (
                      t('scr.off')
                    )}
                    {st?.error && <div className="truncate text-red">{st.error}</div>}
                  </div>
                  {st?.connected ? (
                    <div className="mt-auto flex items-center gap-1">
                      <button onClick={() => setComparing(s.id)} disabled={!st.syncedAt} className={cx(pill, 'flex-1 bg-sel px-3 text-on-sel')}>
                        {t('int.compare')}
                      </button>
                      {/* Яндекс и VK: ещё ссылка, вход или список */}
                      {(s.id === 'yandex' || s.id === 'vk') && (
                        <IconBtn title={t('int.addMore')} onClick={() => setConnecting(s.id)} className="h-8 w-8 text-muted">
                          <Plus size={15} />
                        </IconBtn>
                      )}
                      {st.canSync && (
                        <IconBtn title={t('int.refresh')} onClick={() => void sync(s.id)} className="h-8 w-8 text-muted">
                          <RefreshCw size={14} className={cx(busy === s.id && 'animate-spin')} />
                        </IconBtn>
                      )}
                      <IconBtn title={t('int.disconnect')} onClick={() => void disconnect(s.id as Live)} className="h-8 w-8 text-muted hover:text-red">
                        <Unlink size={14} />
                      </IconBtn>
                    </div>
                  ) : (
                    <button onClick={() => setConnecting(s.id as Live)} className={cx(pill, 'mt-auto bg-card-3 hover:bg-card-2')}>
                      {t('acc.connect')}
                    </button>
                  )}
                </div>
              )
            })}
            {/* Telegram — не список для сравнения, а музыка файлами: своя плитка */}
            <TelegramTile />
          </div>
        </>,
      )}
      {(connecting === 'yandex' || connecting === 'vk') && (
        <ListDialog
          service={connecting}
          onClose={() => setConnecting(null)}
          onConnected={() => {
            setConnecting(null)
            void load()
          }}
        />
      )}
      {(connecting === 'spotify' || connecting === 'youtube') && (
        <ConnectDialog
          service={connecting}
          configured={!!status.find((x) => x.service === connecting)?.configured}
          onClose={() => setConnecting(null)}
          onConnected={() => {
            setConnecting(null)
            void load()
          }}
        />
      )}
      {comparing && <CompareDialog service={comparing} onClose={() => setComparing(null)} />}
    </>
  )
}

/** Адрес возврата из Spotify: Spotify пускает http только на 127.0.0.1, не на localhost */
const spotifyRedirect = () => `${location.origin.replace('//localhost', '//127.0.0.1')}/api/integrations/spotify/callback`

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-2.5 text-sm">
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-card-3 font-mono text-[11px]">{n}</span>
      <span className="min-w-0 leading-snug">{children}</span>
    </li>
  )
}

/** Подключение: пошаговая инструкция, как завести своё приложение в сервисе, поле для ключа и вход */
function ConnectDialog({ service, configured, onClose, onConnected }: { service: 'spotify' | 'youtube'; configured: boolean; onClose: () => void; onConnected: () => void }) {
  const { toast } = usePick('toast')
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [code, setCode] = useState<{ userCode: string; verificationUrl: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const redirect = spotifyRedirect()
  // Spotify не примет http на чужой адрес — только 127.0.0.1 или https
  const badRedirect = service === 'spotify' && !/^https:|^http:\/\/(127\.0\.0\.1|\[::1\])[:/]/.test(redirect)

  // YouTube: ждём, пока человек введёт код на google.com/device
  useEffect(() => {
    if (!code) return
    const id = setInterval(async () => {
      const st = await api<IntegrationStatus[]>('/integrations').catch(() => [])
      const yt = st.find((x) => x.service === 'youtube')
      if (yt?.connected) {
        toast(t('int.connected', { name: t('svc.youtube') }), 'ok')
        onConnected()
      } else if (yt?.error) toast(yt.error, 'error')
    }, 3000)
    return () => clearInterval(id)
  }, [code, toast, onConnected])

  const copy = (text: string) => navigator.clipboard?.writeText(text).then(() => toast(t('acc.copied'), 'ok'))

  const go = async () => {
    setBusy(true)
    try {
      if (clientId.trim()) await api(`/integrations/${service}/config`, { method: 'PUT', body: { clientId: clientId.trim(), ...(service === 'youtube' ? { clientSecret: secret.trim() } : {}) } })
      if (service === 'spotify') {
        const { url } = await api<{ url: string }>('/integrations/spotify/start', { method: 'POST', body: { redirectUri: redirect, origin: location.origin } })
        location.href = url // Spotify вернёт обратно на наш адрес
        return
      }
      setCode(await api<{ userCode: string; verificationUrl: string }>('/integrations/youtube/start', { method: 'POST' }))
    } catch (e) {
      toast((e as Error).message, 'error')
    }
    setBusy(false)
  }

  const ready = service === 'spotify' ? !!clientId.trim() || configured : (!!clientId.trim() && !!secret.trim()) || configured

  return (
    <Modal onClose={onClose} wide>
      <div className="mb-4 flex items-start justify-between">
        <span className="text-lg font-medium">{t(service === 'spotify' ? 'int.spotifyTitle' : 'int.youtubeTitle')}</span>
        <IconBtn title={t('common.close')} onClick={onClose} className="-mt-2 -me-2">
          <X size={18} />
        </IconBtn>
      </div>
      <p className="mb-4 text-xs text-muted">{t('int.why')}</p>

      {code ? (
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <div className="text-sm text-muted">{t('int.enterCode')}</div>
          <button onClick={() => copy(code.userCode)} className="font-mono text-4xl tracking-widest" title={t('acc.copy')}>
            {code.userCode}
          </button>
          <a href={code.verificationUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-full bg-sel px-4 py-2 text-sm text-on-sel">
            {code.verificationUrl.replace(/^https?:\/\//, '')} <ExternalLink size={14} />
          </a>
          <div className="flex items-center gap-2 text-xs text-muted">
            <RefreshCw size={12} className="animate-spin" /> {t('int.waiting')}
          </div>
        </div>
      ) : (
        <>
          <ol className="mb-4 flex flex-col gap-2">
            {service === 'spotify' ? (
              <>
                <Step n={1}>
                  {t('int.sp1')}{' '}
                  <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer" className="underline">
                    developer.spotify.com/dashboard
                  </a>
                </Step>
                <Step n={2}>
                  {t('int.sp2')}
                  <span className="mt-1 flex items-center gap-2 rounded-xl bg-card-3 px-3 py-1.5 font-mono text-xs break-all">
                    <span className="min-w-0 flex-1">{redirect}</span>
                    <IconBtn title={t('acc.copy')} onClick={() => copy(redirect)} className="h-7 w-7 shrink-0">
                      <Copy size={13} />
                    </IconBtn>
                  </span>
                </Step>
                <Step n={3}>{t('int.sp3')}</Step>
                <Step n={4}>{t('int.sp4')}</Step>
              </>
            ) : (
              <>
                <Step n={1}>
                  {t('int.yt1')}{' '}
                  <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noreferrer" className="underline">
                    console.cloud.google.com
                  </a>
                </Step>
                <Step n={2}>{t('int.yt2')}</Step>
                <Step n={3}>{t('int.yt3')}</Step>
                <Step n={4}>{t('int.yt4')}</Step>
              </>
            )}
          </ol>
          {badRedirect && <p className="mb-3 rounded-xl bg-red/10 p-2.5 text-xs text-fg">{t('int.spHttps')}</p>}
          <div className="flex flex-col gap-2">
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={configured ? t('int.keySaved') : 'Client ID'} className={cx(input, 'font-mono')} />
            {service === 'youtube' && (
              <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={configured ? t('int.keySaved') : 'Client secret'} className={cx(input, 'font-mono')} />
            )}
          </div>
          <div className="mt-4 flex gap-2">
            <button onClick={onClose} className="flex-1 rounded-full py-3 text-sm text-muted hover:text-fg">
              {t('common.cancel')}
            </button>
            <button onClick={() => void go()} disabled={!ready || busy} className="flex-1 rounded-full bg-sel py-3 text-sm text-on-sel disabled:opacity-40">
              {t(service === 'spotify' ? 'int.signInSpotify' : 'int.getCode')}
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

/** Сравнение: что из сервиса уже есть в библиотеке, чего нет; фильтр по источнику и поиск, список недостающего — скопировать */
function CompareDialog({ service, onClose }: { service: Live; onClose: () => void }) {
  const { toast, play } = usePick('toast', 'play')
  const [data, setData] = useState<CompareResult | null>(null)
  const [tab, setTab] = useState<'missing' | 'have'>('missing')
  const [source, setSource] = useState<string>('') // '' — всё, '♥' — лайки, иначе имя плейлиста
  const [q, setQ] = useState('')
  useEffect(() => {
    api<CompareResult>(`/integrations/${service}/compare`).then(setData, (e: Error) => toast(e.message, 'error'))
  }, [service, toast])

  const inSource = useMemo(
    () => (data?.tracks ?? []).filter((x) => !source || (source === '♥' ? x.liked : x.lists.includes(source))),
    [data, source],
  )
  const missing = inSource.filter((x) => !x.localId)
  const have = inSource.filter((x) => x.localId)
  const needle = q.trim().toLowerCase()
  const shown = (tab === 'missing' ? missing : have).filter((x) => !needle || `${x.artists.join(' ')} ${x.title}`.toLowerCase().includes(needle))

  const copyMissing = () =>
    navigator.clipboard?.writeText(missing.map((x) => `${x.artists.join(', ')} - ${x.title}`).join('\n')).then(() => toast(t('int.copiedList', { n: missing.length }), 'ok'))

  return (
    <Modal onClose={onClose} wide>
      <div className="mb-3 flex items-start justify-between">
        <span className="text-lg font-medium">{t('int.compareTitle', { name: t(SERVICES.find((x) => x.id === service)!.name) })}</span>
        <IconBtn title={t('common.close')} onClick={onClose} className="-mt-2 -me-2">
          <X size={18} />
        </IconBtn>
      </div>
      {!data ? (
        <div className="py-10 text-center text-sm text-muted">…</div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {(['missing', 'have'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={cx('rounded-full px-4 py-2 text-sm transition-colors', tab === k ? 'bg-sel text-on-sel' : 'bg-card-3 text-muted hover:text-fg')}
              >
                {t(k === 'missing' ? 'int.missing' : 'int.have')} <span className="font-mono text-xs opacity-70">{k === 'missing' ? missing.length : have.length}</span>
              </button>
            ))}
            <select value={source} onChange={(e) => setSource(e.target.value)} className="ms-auto max-w-56 rounded-full bg-card-3 px-3 py-2 text-xs outline-none">
              <option value="">{t('int.allSources')}</option>
              <option value="♥">{t('int.liked')}</option>
              {data.lists.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <label className="mb-2 flex items-center gap-2 rounded-full bg-card-3 px-4 py-2">
            <Search size={14} className="text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('int.search')} className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" />
          </label>
          <div className="-mx-2 max-h-[50vh] overflow-y-auto">
            {shown.length === 0 && <div className="py-8 text-center text-sm text-muted">{t(tab === 'missing' ? 'int.allHere' : 'int.noneHere')}</div>}
            {shown.map((x) => (
              <button
                key={x.id}
                disabled={!x.localId}
                onClick={() => x.localId && play(x.localId)}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-start enabled:hover:bg-card-2"
              >
                {x.localId ? <Check size={14} className="shrink-0 text-green" /> : <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">
                    {x.artists.join(', ')} — {x.title}
                  </div>
                  <div className="truncate text-[11px] text-muted">{[x.liked ? t('int.liked') : '', ...x.lists].filter(Boolean).join(' · ')}</div>
                </div>
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>{tn('n.tracks', inSource.length)}</span>
            {tab === 'missing' && missing.length > 0 && (
              <button onClick={() => void copyMissing()} className="flex items-center gap-1.5 rounded-full bg-card-3 px-3 py-1.5 text-fg hover:bg-card-2">
                <Copy size={13} /> {t('int.copyMissing')}
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}

// ---------- Яндекс Музыка и VK: способы на выбор ----------

const YANDEX_LOGIN = 'https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d'

type Way = 'account' | 'public' | 'paste'

/** Яндекс: аккаунт (неофициально) · открытый профиль или плейлист · вставить список. VK: расширение браузера */
function ListDialog({ service, onClose, onConnected }: { service: 'yandex' | 'vk'; onClose: () => void; onConnected: () => void }) {
  const ways: Way[] = ['account', 'public', 'paste']
  const [way, setWay] = useState<Way>(ways[0])
  return (
    <Modal onClose={onClose} wide>
      <div className="mb-3 flex items-start justify-between">
        <span className="text-lg font-medium">{t(service === 'yandex' ? 'int.yandexTitle' : 'int.vkTitle')}</span>
        <IconBtn title={t('common.close')} onClick={onClose} className="-mt-2 -me-2">
          <X size={18} />
        </IconBtn>
      </div>
      {service === 'vk' && <p className="mb-3 text-xs leading-relaxed text-muted">{t('int.vkWhy')}</p>}
      {service === 'vk' && <VkExtension onConnected={onConnected} />}
      {service === 'yandex' && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {ways.map((w) => (
            <button
              key={w}
              onClick={() => setWay(w)}
              className={cx('rounded-full px-4 py-2 text-sm transition-colors', way === w ? 'bg-sel text-on-sel' : 'bg-card-3 text-muted hover:text-fg')}
            >
              {t(`int.way.${w}` as Key)}
            </button>
          ))}
        </div>
      )}
      {service === 'yandex' && way === 'account' && <YandexAccount onConnected={onConnected} />}
      {service === 'yandex' && way === 'public' && <YandexPublic onConnected={onConnected} />}
      {service === 'yandex' && way === 'paste' && <PasteList service={service} onConnected={onConnected} />}
    </Modal>
  )
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 flex gap-3 rounded-2xl bg-red/10 p-3 text-xs leading-relaxed text-fg">
      <TriangleAlert size={16} className="mt-px shrink-0 text-red" />
      <span>{children}</span>
    </div>
  )
}

/** Яндекс по аккаунту: вход на странице Яндекса, в адресной строке появляется токен — вставить сюда */
function YandexAccount({ onConnected }: { onConnected: () => void }) {
  const { toast } = usePick('toast')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      await api('/integrations/yandex/token', { method: 'POST', body: { token: value } })
      toast(t('int.connected', { name: t('svc.yandex') }), 'ok')
      onConnected()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
    setBusy(false)
  }
  return (
    <>
      <Warning>{t('int.yaWarn')}</Warning>
      <ol className="mb-4 flex flex-col gap-2">
        <Step n={1}>
          {t('int.ya1')}{' '}
          <a href={YANDEX_LOGIN} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
            {t('int.yaOpen')} <ExternalLink size={12} />
          </a>
        </Step>
        <Step n={2}>{t('int.ya2')}</Step>
        <Step n={3}>{t('int.ya3')}</Step>
      </ol>
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://music.yandex.ru/#access_token=…" className={cx(input, 'font-mono')} />
      <button onClick={() => void go()} disabled={!value.trim() || busy} className="mt-4 w-full rounded-full bg-sel py-3 text-sm text-on-sel disabled:opacity-40">
        {t('acc.connect')}
      </button>
    </>
  )
}

/** Яндекс без входа: открытый профиль (лайки и открытые плейлисты) или один плейлист по ссылке */
function YandexPublic({ onConnected }: { onConnected: () => void }) {
  const { toast } = usePick('toast')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      await api('/integrations/yandex/public', { method: 'POST', body: { link: value } })
      toast(t('int.synced'), 'ok')
      onConnected()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
    setBusy(false)
  }
  return (
    <>
      <p className="mb-3 text-sm leading-relaxed">{t('int.yaPublic')}</p>
      <p className="mb-4 text-xs leading-relaxed text-muted">{t('int.yaPublicHint')}</p>
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://music.yandex.ru/playlists/…" className={cx(input, 'font-mono')} />
      <button onClick={() => void go()} disabled={!value.trim() || busy} className="mt-4 flex w-full items-center justify-center gap-2 rounded-full bg-sel py-3 text-sm text-on-sel disabled:opacity-40">
        {busy && <RefreshCw size={14} className="animate-spin" />} {t('int.yaAdd')}
      </button>
    </>
  )
}

type Browser = 'chromium' | 'firefox'

/**
 * VK: расширение браузера MUSICH ← VK. Скачивается уже готовым — адрес этого сервера и свой ключ внутри, связывать
 * ничего не нужно. Ставится в браузер, где ты вошёл в VK, и само забирает «Мою музыку» с vk.com
 */
function VkExtension({ onConnected }: { onConnected: () => void }) {
  const { loadTokens } = usePick('loadTokens')
  const [browser, setBrowser] = useState<Browser>(/firefox/i.test(navigator.userAgent) ? 'firefox' : 'chromium')
  const download = () => {
    const a = document.createElement('a')
    a.href = `${mediaUrl('/integrations/vk/extension')}&origin=${encodeURIComponent(getApiBase() || location.origin)}`
    a.download = 'musich-vk.zip'
    a.click()
    // ключ расширения — новый вход: пусть сразу появится в «Устройствах»
    setTimeout(() => void loadTokens(), 1500)
  }
  const code = (s: string) => <code className="rounded bg-card-3 px-1.5 py-0.5 font-mono text-[12px]">{s}</code>
  return (
    <>
      <p className="mb-4 text-sm leading-relaxed">{t('int.vkWhy')}</p>
      <button onClick={download} className="mb-5 flex w-full items-center justify-center gap-2 rounded-full bg-sel py-3 text-sm text-on-sel">
        <Download size={15} /> {t('int.extDownload')}
      </button>
      <div className="mb-3 flex gap-1.5">
        {(['chromium', 'firefox'] as const).map((b) => (
          <button
            key={b}
            onClick={() => setBrowser(b)}
            className={cx('rounded-full px-4 py-2 text-sm transition-colors', browser === b ? 'bg-sel text-on-sel' : 'bg-card-3 text-muted hover:text-fg')}
          >
            {t(b === 'chromium' ? 'int.extChromium' : 'int.extFirefox')}
          </button>
        ))}
      </div>
      {browser === 'chromium' ? (
        <ol className="mb-4 flex flex-col gap-2">
          <Step n={1}>{t('int.extC1')}</Step>
          <Step n={2}>
            {t('int.extC2')} {code('chrome://extensions')} · {code('browser://extensions')}
          </Step>
          <Step n={3}>{t('int.extC3')}</Step>
          <Step n={4}>{t('int.extOpenVk')}</Step>
        </ol>
      ) : (
        <ol className="mb-4 flex flex-col gap-2">
          <Step n={1}>
            {t('int.extF1')} {code('about:debugging#/runtime/this-firefox')}
          </Step>
          <Step n={2}>{t('int.extF2')}</Step>
          <Step n={3}>{t('int.extOpenVk')}</Step>
        </ol>
      )}
      {browser === 'firefox' && <Warning>{t('int.extFirefoxNote')}</Warning>}
      <p className="text-xs leading-relaxed text-muted">{t('int.extAfter')}</p>
      <p className="mt-2 text-xs leading-relaxed text-muted">{t('int.vkTokenNote')}</p>
      <button onClick={onConnected} className="mt-4 w-full rounded-full bg-card-3 py-2.5 text-sm hover:bg-card-2">
        {t('int.vkDone')}
      </button>
    </>
  )
}

/** Строка «Исполнитель - Название» (подойдёт « - », « — », табуляция; номер в начале уберём) */
function parseLine(l: string) {
  const s = l.replace(/^\s*\d+[.)]\s*/, '').trim()
  const m = s.split(/\s+[-–—]\s+|\t/)
  return m.length >= 2 ? { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() } : { artist: '', title: s }
}

/** Вставить список текстом: по строке на трек */
function PasteList({ service, onConnected }: { service: 'yandex' | 'vk'; onConnected: () => void }) {
  const { toast } = usePick('toast')
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const rows = useMemo(() => text.split(/\r?\n/).map(parseLine).filter((r) => r.title), [text])
  const go = async () => {
    try {
      await api(`/integrations/${service}/import`, { method: 'POST', body: { list: name.trim() || t('int.pastedName'), tracks: rows } })
      toast(t('int.synced'), 'ok')
      onConnected()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  return (
    <>
      <p className="mb-3 text-xs leading-relaxed text-muted">{t('int.pasteHint')}</p>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('int.pastedName')} className={cx(input, 'mb-2')} />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder={'Кино - Кончится лето\nRihanna - Diamonds'}
        className={cx(input, 'resize-y font-mono text-xs')}
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-xs text-muted">{tn('n.tracks', rows.length)}</span>
        <button onClick={() => void go()} disabled={!rows.length} className={cx(pill, 'bg-sel px-5 py-2.5 text-sm text-on-sel')}>
          {t('int.pasteGo')}
        </button>
      </div>
    </>
  )
}
