import { createHash, randomBytes } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { ZipFile } from 'yazl'
import { getUserSetting, setUserSetting } from './db.ts'
import { badRequest, HttpError } from './errors.ts'
import type { Library } from './library.ts'
import { artistSep } from './media.ts'

/**
 * Интеграции с музыкальными сервисами: забрать оттуда список треков (лайки и плейлисты) и сравнить
 * с библиотекой — что уже есть, чего нет. Только чтение и сравнение, ничего не качаем.
 * Spotify — вход через браузер (OAuth с PKCE, без секрета), YouTube Music — вход кодом на google.com/device.
 * Ключи приложений человек создаёт сам и вписывает в веб-морде: свой сервер — своё приложение в сервисе.
 * Яндекс Музыка — неофициальный API (тот же, что у приложения Яндекс Музыки): по токену или открытые профиль/плейлисты.
 * VK музыку сторонним программам не отдаёт — список присылает расширение браузера MUSICH ← VK (extension/vk) или вставляют текстом
 */
export type Service = 'spotify' | 'youtube' | 'yandex' | 'vk'
export const SERVICES: Service[] = ['spotify', 'youtube', 'yandex', 'vk']

const YM = 'https://api.music.yandex.net'
// приложение Яндекс Музыки — через его доступ читают все сторонние клиенты (официального API у Яндекса нет)
export const YANDEX_CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d'

/**
 * Ссылка на Яндекс Музыку → что забирать: плейлист по коду (новые ссылки «Поделиться»: playlists/<код>, у «Мне нравится» — lk.<код>),
 * users/<логин>/playlists/<номер>, профиль users/<логин> или просто логин
 */
function parseYandexLink(raw: string): { login?: string; kind?: string; uuid?: string } {
  const s = raw.trim()
  const byCode = s.match(/playlists\/((?:lk\.)?[0-9a-f]{8}-[0-9a-f-]{27,})/i)
  if (byCode) return { uuid: byCode[1].toLowerCase() }
  const m = s.match(/users\/([^/?#\s]+)(?:\/playlists\/(\d+))?/)
  if (m) return { login: decodeURIComponent(m[1]), ...(m[2] ? { kind: m[2] } : {}) }
  if (/^[\w.@-]+$/.test(s)) return { login: s }
  throw badRequest('Нужна ссылка на плейлист или профиль Яндекс Музыки (music.yandex.ru/playlists/… или music.yandex.ru/users/логин) или логин')
}

interface Conf {
  clientId?: string
  clientSecret?: string // только у Google
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  account?: string // как сервис называет владельца
  syncedAt?: string
  error?: string // последняя ошибка входа или обновления
  uid?: number // Яндекс: номер аккаунта (для запросов по токену)
  links?: string[] // Яндекс: открытые профили и плейлисты, которые забираем без входа
}

/** Трек, присланный расширением VK */
export interface PushedTrack {
  id?: string
  artist?: string
  title: string
  duration?: number
  cover?: string
}

/** Трек из сервиса */
export interface RemoteTrack {
  id: string
  title: string
  artists: string[]
  album?: string
  liked: boolean // в «Мне нравится» (Spotify — «Любимые треки», YouTube — «Понравившиеся» из музыки)
  lists: string[] // в каких плейлистах
  cover?: string // ссылка на обложку у сервиса — для тех, чего нет в библиотеке
  duration?: number // секунды
}

type Add = (id: string, title: string, artists: string[], album: string | undefined, list: string | null, extra?: { cover?: string; duration?: number }) => void

export interface IntegrationStatus {
  service: Service
  configured: boolean // ключ приложения вписан
  connected: boolean // вход выполнен
  canSync: boolean // список можно забрать заново с сервиса (VK — нет: его присылает расширение браузера)
  account?: string
  syncedAt?: string
  total?: number
  missing?: number
  error?: string
}

export interface CompareResult {
  total: number
  matched: number
  lists: string[]
  tracks: (RemoteTrack & { localId?: string })[]
}

const b64url = (b: Buffer) => b.toString('base64url')
// «Кино» и «КИНО», «ё» и «е», 𝕣𝕦𝕤 и rus, «feat. …» — для сравнения неважны
const fold = (s: string) => s.normalize('NFKC').toLowerCase().replace(/ё/g, 'е')
const squash = (s: string) => s.replace(/\s(feat|ft)\.?\s.*$/, '').replace(/[^\p{L}\p{N}]+/gu, '')
const unbracket = (s: string) => s.replace(/\s*[([{][^)\]}]*[)\]}]/g, ' ')
const norm = (s: string) => squash(unbracket(fold(s)))
// ключи названия: сначала со скобками как текстом («Волна (Remastered)» = «Волна Remastered»), потом без скобок
const titleKeys = (s: string) => [...new Set([squash(fold(s)), norm(s)])].filter(Boolean)

export class Integrations {
  private readonly lib: Library
  // начатые входы в Spotify: state → что нужно, чтобы закончить (живут только до перезапуска сервера)
  private readonly pending = new Map<string, { uid: string; verifier: string; redirectUri: string; origin: string; at: number }>()
  // ожидание входа в Google — у каждого пользователя своё
  private readonly youtubePolls = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(lib: Library) {
    this.lib = lib
  }

  stop() {
    for (const t of this.youtubePolls.values()) clearTimeout(t)
    this.youtubePolls.clear()
  }

  private conf(uid: string, s: Service): Conf {
    try {
      return JSON.parse(getUserSetting(this.lib.db, uid, `integration:${s}`) ?? '{}') as Conf
    } catch {
      return {}
    }
  }
  private save(uid: string, s: Service, patch: Partial<Conf>) {
    setUserSetting(this.lib.db, uid, `integration:${s}`, JSON.stringify({ ...this.conf(uid, s), ...patch }))
  }
  private snapshot(uid: string, s: Service): RemoteTrack[] {
    try {
      return JSON.parse(getUserSetting(this.lib.db, uid, `integration:${s}:tracks`) ?? '[]') as RemoteTrack[]
    } catch {
      return []
    }
  }

  status(uid: string): IntegrationStatus[] {
    return SERVICES.map((s) => {
      const c = this.conf(uid, s)
      const connected =
        s === 'yandex' ? !!c.accessToken || !!c.links?.length || !!c.syncedAt : s === 'vk' ? !!c.syncedAt : !!c.refreshToken
      const cmp = connected && c.syncedAt ? this.compare(uid, s) : undefined
      return {
        service: s,
        configured: s === 'yandex' || s === 'vk' || (!!c.clientId && (s !== 'youtube' || !!c.clientSecret)),
        connected,
        canSync: s !== 'vk' && connected,
        ...(c.account ? { account: c.account } : {}),
        ...(c.syncedAt ? { syncedAt: c.syncedAt } : {}),
        ...(cmp ? { total: cmp.total, missing: cmp.total - cmp.matched } : {}),
        ...(c.error ? { error: c.error } : {}),
      }
    })
  }

  /** Ключ приложения сервиса (Client ID; у Google ещё и секрет) */
  configure(uid: string, s: Service, clientId: string, clientSecret?: string) {
    if (!clientId.trim()) throw badRequest('Нужен Client ID')
    if (s === 'youtube' && !clientSecret?.trim()) throw badRequest('Для YouTube нужен и Client secret')
    this.save(uid, s, { clientId: clientId.trim(), ...(clientSecret ? { clientSecret: clientSecret.trim() } : {}), error: undefined })
  }

  /** Отключить: забыть вход и список треков (ключ приложения оставляем — войти снова проще) */
  disconnect(uid: string, s: Service) {
    if (s === 'yandex' || s === 'vk') {
      setUserSetting(this.lib.db, uid, `integration:${s}`, '{}')
      setUserSetting(this.lib.db, uid, `integration:${s}:tracks`, '[]')
      return
    }
    const c = this.conf(uid, s)
    setUserSetting(this.lib.db, uid, `integration:${s}`, JSON.stringify({ clientId: c.clientId, clientSecret: c.clientSecret }))
    setUserSetting(this.lib.db, uid, `integration:${s}:tracks`, '[]')
  }

  // ---------- Spotify: вход ----------

  /** Адрес входа в Spotify. redirectUri должен быть вписан в приложении Spotify; origin — куда вернуть человека */
  spotifyStart(uid: string, redirectUri: string, origin: string): { url: string } {
    const c = this.conf(uid, 'spotify')
    if (!c.clientId) throw badRequest('Сначала впишите Client ID')
    const verifier = b64url(randomBytes(48))
    const state = b64url(randomBytes(16))
    for (const [k, v] of this.pending) if (Date.now() - v.at > 15 * 60_000) this.pending.delete(k)
    this.pending.set(state, { uid, verifier, redirectUri, origin, at: Date.now() })
    const q = new URLSearchParams({
      client_id: c.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      code_challenge_method: 'S256',
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      scope: 'user-library-read playlist-read-private playlist-read-collaborative',
      state,
    })
    return { url: `https://accounts.spotify.com/authorize?${q}` }
  }

  /** Spotify вернул человека с кодом: меняем его на токены. Возвращает, куда отправить браузер */
  async spotifyCallback(code: string | undefined, state: string | undefined, error: string | undefined): Promise<string> {
    const p = state ? this.pending.get(state) : undefined
    if (!p) return '/?integration=spotify&error=state'
    this.pending.delete(state!)
    // возврат из Spotify приходит без нашего токена — чей это вход, помнит state
    const uid = p.uid
    const back = (err?: string) => `${p.origin}/?integration=spotify${err ? `&error=${encodeURIComponent(err)}` : ''}`
    if (error || !code) return back(error ?? 'denied')
    try {
      const c = this.conf(uid, 'spotify')
      const t = await this.form('https://accounts.spotify.com/api/token', {
        grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: c.clientId!, code_verifier: p.verifier,
      })
      this.save(uid, 'spotify', { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000, error: undefined })
      const me = await this.get(uid, 'spotify', 'https://api.spotify.com/v1/me')
      this.save(uid, 'spotify', { account: me.display_name || me.id })
      void this.sync(uid, 'spotify').catch(() => {})
      return back()
    } catch (e) {
      this.save(uid, 'spotify', { error: (e as Error).message })
      return back((e as Error).message)
    }
  }

  // ---------- YouTube: вход кодом ----------

  /** Начать вход в Google: код, который человек вводит на google.com/device; дальше сервер сам ждёт подтверждения */
  async youtubeStart(uid: string): Promise<{ userCode: string; verificationUrl: string; expiresIn: number }> {
    const c = this.conf(uid, 'youtube')
    if (!c.clientId || !c.clientSecret) throw badRequest('Сначала впишите Client ID и Client secret')
    const d = await this.form('https://oauth2.googleapis.com/device/code', {
      client_id: c.clientId, scope: 'https://www.googleapis.com/auth/youtube.readonly',
    })
    const prev = this.youtubePolls.get(uid)
    if (prev) clearTimeout(prev)
    const until = Date.now() + d.expires_in * 1000
    let interval = (d.interval ?? 5) * 1000
    const later = () => {
      const t = setTimeout(poll, interval)
      t.unref()
      this.youtubePolls.set(uid, t)
    }
    const poll = async () => {
      this.youtubePolls.delete(uid)
      if (Date.now() > until) return this.save(uid, 'youtube', { error: 'Код устарел — войдите снова' })
      try {
        const t = await this.form('https://oauth2.googleapis.com/token', {
          client_id: c.clientId!, client_secret: c.clientSecret!, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        })
        this.save(uid, 'youtube', { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000, error: undefined })
        const ch = await this.get(uid, 'youtube', 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true')
        this.save(uid, 'youtube', { account: ch.items?.[0]?.snippet?.title ?? 'YouTube' })
        void this.sync(uid, 'youtube').catch(() => {})
        return
      } catch (e) {
        const code = (e as HttpError & { oauth?: string }).oauth
        if (code === 'slow_down') interval += 5000
        else if (code !== 'authorization_pending') return this.save(uid, 'youtube', { error: (e as Error).message })
      }
      later()
    }
    later()
    return { userCode: d.user_code, verificationUrl: d.verification_url ?? d.verification_uri, expiresIn: d.expires_in }
  }

  // ---------- общее: запросы, токены ----------

  /** POST формой, ответ — JSON; ошибка OAuth (authorization_pending и т.п.) — в e.oauth */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async form(url: string, body: Record<string, string>): Promise<any> {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json().catch(() => ({}))
    if (!res.ok) {
      const e = new HttpError(502, 'integration', data.error_description || data.error || `Сервис ответил ${res.status}`) as HttpError & { oauth?: string }
      e.oauth = data.error
      throw e
    }
    return data
  }

  private async token(uid: string, s: Service): Promise<string> {
    const c = this.conf(uid, s)
    // токен Яндекса живёт около года и не обновляется — истёк, значит, войти заново
    if (s === 'yandex') {
      if (!c.accessToken) throw new HttpError(409, 'not_connected', 'Яндекс Музыка не подключена')
      return c.accessToken
    }
    if (!c.refreshToken) throw new HttpError(409, 'not_connected', 'Сервис не подключён')
    if (c.accessToken && (c.expiresAt ?? 0) - 60_000 > Date.now()) return c.accessToken
    const t =
      s === 'spotify'
        ? await this.form('https://accounts.spotify.com/api/token', { grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: c.clientId! })
        : await this.form('https://oauth2.googleapis.com/token', {
            grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: c.clientId!, client_secret: c.clientSecret!,
          })
    this.save(uid, s, { accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000, ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}) })
    return t.access_token
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async get(uid: string, s: Service, url: string): Promise<any> {
    // адреса приходят и из ответов сервисов (следующая страница) — ходим только на сайты самих сервисов,
    // чтобы сервер нельзя было заставить стучаться внутрь домашней сети
    const host = new URL(url).hostname
    if (!/(^|\.)(spotify\.com|googleapis\.com|youtube\.com|yandex\.(ru|net|com)|vk\.com|userapi\.com)$/.test(host)) throw new Error(`Неожиданный адрес сервиса: ${host}`)
    const auth = s === 'yandex' ? `OAuth ${await this.token(uid, s)}` : `Bearer ${await this.token(uid, s)}`
    const res = await fetch(url, { headers: { Authorization: auth } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new HttpError(502, 'integration', data.error?.message || data.error_description || `Сервис ответил ${res.status}`)
    return data
  }

  // ---------- список треков ----------

  /** Забрать из сервиса лайки и плейлисты и запомнить */
  async sync(uid: string, s: Service): Promise<IntegrationStatus> {
    if (s === 'vk') throw badRequest('Список VK присылает расширение браузера: «Забрать сейчас» — в нём')
    const tracks = new Map<string, RemoteTrack>()
    const add: Add = (id, title, artists, album, list, extra) => {
      if (!id || !title) return
      const t = tracks.get(id) ?? { id, title, artists, album, liked: false, lists: [], ...extra }
      if (list === null) t.liked = true
      else if (!t.lists.includes(list)) t.lists.push(list)
      tracks.set(id, t)
    }
    try {
      if (s === 'spotify') await this.syncSpotify(uid, add)
      else if (s === 'youtube') await this.syncYoutube(uid, add)
      else await this.syncYandex(uid, add)
    } catch (e) {
      this.save(uid, s, { error: (e as Error).message })
      throw e
    }
    setUserSetting(this.lib.db, uid, `integration:${s}:tracks`, JSON.stringify([...tracks.values()]))
    this.save(uid, s, { syncedAt: new Date().toISOString(), error: undefined })
    return this.status(uid).find((x) => x.service === s)!
  }

  private async syncSpotify(uid: string, add: Add) {
    type SpTrack = { id?: string; type?: string; name: string; artists: { name: string }[]; album?: { name: string; images?: { url: string; width?: number }[] }; duration_ms?: number }
    const take = (t: SpTrack | null, list: string | null) => {
      if (!t || t.type === 'episode' || !t.id) return
      // картинки от большой к маленькой — берём самую маленькую не меньше 64
      const img = [...(t.album?.images ?? [])].reverse().find((x) => (x.width ?? 300) >= 64)
      add(t.id, t.name, t.artists.map((a) => a.name), t.album?.name, list, { cover: img?.url, duration: t.duration_ms ? Math.round(t.duration_ms / 1000) : undefined })
    }
    for (let url: string | null = 'https://api.spotify.com/v1/me/tracks?limit=50'; url; ) {
      const r = await this.get(uid, 'spotify', url)
      for (const it of r.items ?? []) take(it.track, null)
      url = r.next
    }
    const lists: { id: string; name: string }[] = []
    for (let url: string | null = 'https://api.spotify.com/v1/me/playlists?limit=50'; url; ) {
      const r = await this.get(uid, 'spotify', url)
      for (const p of r.items ?? []) if (p) lists.push({ id: p.id, name: p.name })
      url = r.next
    }
    for (const p of lists) {
      try {
        for (let url: string | null = `https://api.spotify.com/v1/playlists/${p.id}/tracks?limit=100`; url; ) {
          const r = await this.get(uid, 'spotify', url)
          for (const it of r.items ?? []) take(it.track, p.name)
          url = r.next
        }
      } catch {
        /* чужой или закрытый плейлист Spotify не отдаёт — пропускаем */
      }
    }
  }

  private async syncYoutube(uid: string, add: Add) {
    const yt = 'https://www.googleapis.com/youtube/v3'
    // понравившиеся видео — только музыка (категория «Музыка» или автоканал «Исполнитель - Topic»)
    for (let page: string | undefined = ''; page !== undefined; ) {
      const r = await this.get(uid, 'youtube', `${yt}/videos?part=snippet&myRating=like&maxResults=50${page ? `&pageToken=${page}` : ''}`)
      for (const v of r.items ?? []) {
        const sn = v.snippet ?? {}
        if (sn.categoryId !== '10' && !String(sn.channelTitle ?? '').endsWith(' - Topic')) continue
        const p = parseYoutube(sn.title ?? '', sn.channelTitle ?? '')
        add(v.id, p.title, [p.artist], undefined, null, { cover: sn.thumbnails?.default?.url })
      }
      page = r.nextPageToken
    }
    const lists: { id: string; name: string }[] = []
    for (let page: string | undefined = ''; page !== undefined; ) {
      const r = await this.get(uid, 'youtube', `${yt}/playlists?part=snippet&mine=true&maxResults=50${page ? `&pageToken=${page}` : ''}`)
      for (const p of r.items ?? []) lists.push({ id: p.id, name: p.snippet?.title ?? p.id })
      page = r.nextPageToken
    }
    for (const l of lists) {
      for (let page: string | undefined = ''; page !== undefined; ) {
        const r = await this.get(uid, 'youtube', `${yt}/playlistItems?part=snippet&playlistId=${l.id}&maxResults=50${page ? `&pageToken=${page}` : ''}`)
        for (const it of r.items ?? []) {
          const sn = it.snippet ?? {}
          if (/^(deleted|private) video$/i.test(sn.title ?? '')) continue
          const p = parseYoutube(sn.title ?? '', sn.videoOwnerChannelTitle ?? '')
          add(sn.resourceId?.videoId ?? it.id, p.title, [p.artist], undefined, l.name)
        }
        page = r.nextPageToken
      }
    }
  }

  // ---------- Яндекс Музыка ----------

  /** Вход по токену: человек вставляет адрес страницы после входа (…#access_token=…) или сам токен */
  async yandexConnect(uid: string, input: string): Promise<IntegrationStatus> {
    const token = (input.match(/access_token=([^&\s]+)/)?.[1] ?? input).trim()
    if (!/^[\w.-]{20,}$/.test(token)) throw badRequest('Не похоже на токен: вставьте адрес из строки браузера целиком')
    const res = await fetch(`${YM}/account/status`, { headers: { Authorization: `OAuth ${token}` } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json().catch(() => ({}))
    const acc = data.result?.account
    if (!res.ok || !acc?.uid) throw new HttpError(400, 'integration', 'Яндекс не принял токен — войдите ещё раз')
    this.save(uid, 'yandex', { accessToken: token, uid: acc.uid, account: acc.login ?? acc.displayName ?? String(acc.uid), error: undefined })
    return this.sync(uid, 'yandex')
  }

  /** Открытый профиль или плейлист — забирать без входа (лайки профиля должны быть открыты в настройках приватности) */
  async yandexAddPublic(uid: string, link: string): Promise<IntegrationStatus> {
    const p = parseYandexLink(link)
    // плейлист по коду храним как «uuid:<код>», остальное — «логин» или «логин/номер»
    const key = p.uuid ? `uuid:${p.uuid}` : p.kind ? `${p.login}/${p.kind}` : p.login!
    const c = this.conf(uid, 'yandex')
    if (p.uuid) {
      // сразу проверяем, что плейлист открыт, — чтобы не сохранить ссылку, которая ничего не даст
      const pl = await this.ym(uid, `/playlist/${p.uuid}`, { auth: true }).catch(() => null)
      if (!pl?.tracks) throw badRequest('Плейлист не открылся: он закрыт или ссылка неверная. Закрытые плейлисты — через «Через аккаунт»')
      this.save(uid, 'yandex', { links: [...new Set([...(c.links ?? []), key])], ...(c.account ? {} : { account: pl.owner?.login ?? 'Яндекс' }) })
      return this.sync(uid, 'yandex')
    }
    this.save(uid, 'yandex', { links: [...new Set([...(c.links ?? []), key])], ...(c.account ? {} : { account: p.login }) })
    return this.sync(uid, 'yandex')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async ym(uid: string, path: string, opts: { auth?: boolean; form?: Record<string, string> } = {}): Promise<any> {
    const c = this.conf(uid, 'yandex')
    const headers: Record<string, string> = {}
    if (opts.auth && c.accessToken) headers.Authorization = `OAuth ${c.accessToken}`
    if (opts.form) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    const res = await fetch(`${YM}${path}`, { method: opts.form ? 'POST' : 'GET', headers, body: opts.form ? new URLSearchParams(opts.form) : undefined })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new HttpError(502, 'integration', data.error?.message || data.error?.name || `Яндекс ответил ${res.status}`)
    return data.result
  }

  private async syncYandex(uid: string, add: Add) {
    type YTrack = { id: string | number; title: string; version?: string; artists?: { name: string }[]; albums?: { title: string }[]; coverUri?: string; durationMs?: number }
    const take = (t: YTrack | undefined, list: string | null) => {
      if (!t?.title) return
      add(`ym:${t.id}`, t.version ? `${t.title} (${t.version})` : t.title, (t.artists ?? []).map((a) => a.name), t.albums?.[0]?.title, list, {
        cover: t.coverUri ? `https://${t.coverUri.replace('%%', '100x100')}` : undefined, // «avatars.yandex.net/…/%%» — размер вместо %%
        duration: t.durationMs ? Math.round(t.durationMs / 1000) : undefined,
      })
    }
    // у лайков только номера треков — подробности добираем пачками
    const likes = async (who: string | number, auth: boolean) => {
      const lib = await this.ym(uid, `/users/${encodeURIComponent(String(who))}/likes/tracks`, { auth })
      const ids: string[] = (lib?.library?.tracks ?? []).map((x: { id: string; albumId?: string }) => (x.albumId ? `${x.id}:${x.albumId}` : x.id))
      for (let i = 0; i < ids.length; i += 200) {
        const batch: YTrack[] = await this.ym(uid, '/tracks', { auth, form: { 'track-ids': ids.slice(i, i + 200).join(',') } })
        for (const t of batch ?? []) take(t, null)
      }
    }
    const playlist = async (who: string | number, kind: string | number, auth: boolean) => {
      const p = await this.ym(uid, `/users/${encodeURIComponent(String(who))}/playlists/${kind}`, { auth })
      for (const it of p?.tracks ?? []) take(it.track, p.title ?? String(kind))
    }
    const allPlaylists = async (who: string | number, auth: boolean) => {
      const lists: { kind: number }[] = await this.ym(uid, `/users/${encodeURIComponent(String(who))}/playlists/list`, { auth })
      for (const l of lists ?? []) {
        try {
          await playlist(who, l.kind, auth)
        } catch {
          /* закрытый или пропавший плейлист — пропускаем */
        }
      }
    }
    const c = this.conf(uid, 'yandex')
    if (c.accessToken && c.uid) {
      await likes(c.uid, true)
      await allPlaylists(c.uid, true)
    }
    for (const key of c.links ?? []) {
      // плейлист по коду (новая ссылка «Поделиться»); с токеном отдаст и закрытый
      if (key.startsWith('uuid:')) {
        const p = await this.ym(uid, `/playlist/${key.slice(5)}`, { auth: true })
        for (const it of p?.tracks ?? []) take(it.track, p.title ?? 'Яндекс')
        continue
      }
      const [login, kind] = key.split('/')
      if (kind) await playlist(login, kind, false)
      else {
        // лайки профиля могут быть закрыты — тогда только его открытые плейлисты
        await likes(login, false).catch(() => {})
        await allPlaylists(login, false)
      }
    }
  }

  // ---------- VK: список от расширения браузера ----------

  /**
   * Расширение MUSICH ← VK собрало «Мою музыку» (и, может, плейлисты) на vk.com — это и есть весь список VK целиком:
   * заменяем прежний
   */
  pushVk(uid: string, liked: PushedTrack[], lists: { name: string; tracks: PushedTrack[] }[]): IntegrationStatus {
    const tracks = new Map<string, RemoteTrack>()
    const put = (r: PushedTrack, list: string | null) => {
      const title = r.title?.trim()
      if (!title) return
      const artists = r.artist?.trim() ? [r.artist.trim()] : []
      const id = r.id ? `vk:${r.id}` : `imp:${norm(artists.join(' '))}|${norm(title)}`
      const t = tracks.get(id) ?? {
        id,
        title,
        artists,
        liked: false,
        lists: [],
        ...(r.cover?.startsWith('https://') ? { cover: r.cover } : {}),
        ...(r.duration ? { duration: Math.round(r.duration) } : {}),
      }
      if (list === null) t.liked = true
      else if (!t.lists.includes(list)) t.lists.push(list)
      tracks.set(id, t)
    }
    for (const r of liked) put(r, null)
    for (const l of lists) for (const r of l.tracks) put(r, l.name.trim() || 'VK')
    setUserSetting(this.lib.db, uid, 'integration:vk:tracks', JSON.stringify([...tracks.values()]))
    this.save(uid, 'vk', { syncedAt: new Date().toISOString(), error: undefined, account: this.conf(uid, 'vk').account ?? 'VK' })
    return this.status(uid).find((x) => x.service === 'vk')!
  }

  // ---------- присланный список (вставка текстом) ----------

  /** Список «исполнитель — название» под именем list: заменяет прежний список с тем же именем */
  importList(uid: string, s: Service, list: string, rows: { artist: string; title: string }[]): IntegrationStatus {
    const name = list.trim() || 'Список'
    const byId = new Map(this.snapshot(uid, s).map((t) => [t.id, { ...t, lists: t.lists.filter((l) => l !== name) }]))
    for (const r of rows) {
      const title = r.title?.trim()
      if (!title) continue
      const artists = r.artist?.trim() ? [r.artist.trim()] : []
      const id = `imp:${norm(artists.join(' '))}|${norm(title)}`
      const t = byId.get(id) ?? { id, title, artists, liked: false, lists: [] }
      if (!t.lists.includes(name)) t.lists.push(name)
      byId.set(id, t)
    }
    const tracks = [...byId.values()].filter((t) => t.liked || t.lists.length)
    setUserSetting(this.lib.db, uid, `integration:${s}:tracks`, JSON.stringify(tracks))
    this.save(uid, s, { syncedAt: new Date().toISOString(), error: undefined, ...(this.conf(uid, s).account ? {} : { account: name }) })
    return this.status(uid).find((x) => x.service === s)!
  }

  // ---------- сравнение ----------

  /** Что из сервиса уже есть в библиотеке (по исполнителю и названию), а чего нет */
  compare(uid: string, s: Service): CompareResult {
    const remote = this.snapshot(uid, s)
    const sep = artistSep(this.lib.prefs(uid).separators)
    const local = new Map<string, string>()
    for (const t of this.lib.listTracks(uid)) {
      for (const title of titleKeys(t.title)) for (const a of t.artist.split(sep)) if (!local.has(`${norm(a)}|${title}`)) local.set(`${norm(a)}|${title}`, t.id)
      // теги бывают кривые: «Артист - Название» целиком в названии
      const [left, ...rest] = t.title.split(/\s+[-–—]\s+/)
      if (rest.length) local.set(`${norm(left)}|${norm(rest.join(' '))}`, t.id)
    }
    let matched = 0
    const lists = new Set<string>()
    const tracks = remote.map((r) => {
      r.lists.forEach((l) => lists.add(l))
      const artists = r.artists.flatMap((a) => a.split(sep))
      const localId = titleKeys(r.title)
        .flatMap((title) => artists.map((a) => local.get(`${norm(a)}|${title}`)))
        .find(Boolean)
      if (localId) matched++
      return { ...r, ...(localId ? { localId } : {}) }
    })
    return { total: remote.length, matched, lists: [...lists], tracks }
  }
}

/** YouTube: «Исполнитель - Topic» → исполнитель; «Исполнитель - Название (Official Video)» → разбираем по дефису */
function parseYoutube(title: string, channel: string): { artist: string; title: string } {
  const clean = (s: string) =>
    s.replace(/\s*[([][^)\]]*(official|video|audio|lyric|клип|visuali[sz]er|mv|hd|hq|4k)[^)\]]*[)\]]/gi, '').trim()
  if (channel.endsWith(' - Topic')) return { artist: channel.slice(0, -' - Topic'.length), title: clean(title) }
  const parts = title.split(/\s+[-–—]\s+/)
  if (parts.length >= 2) return { artist: parts[0].trim(), title: clean(parts.slice(1).join(' - ')) }
  return { artist: channel.replace(/vevo$/i, '').trim(), title: clean(title) }
}

// папка расширения MUSICH ← VK: шаблон, в который при скачивании вписываются адрес сервера и ключ
const EXTENSION_DIR = new URL('../../extension/vk/', import.meta.url)

/** Расширение MUSICH ← VK архивом: в config.js — этот сервер и ключ, в manifest — разрешение ходить на этот сервер */
export async function vkExtensionZip(server: string, token: string): Promise<Buffer> {
  const zip = new ZipFile()
  // адрес для разрешений браузера — без порта: так понимают и Chrome, и Firefox
  const match = `${new URL(server).protocol}//${new URL(server).hostname}/*`
  for (const name of await readdir(EXTENSION_DIR)) {
    let text = await readFile(new URL(name, EXTENSION_DIR), 'utf8')
    if (name === 'config.js') text = text.replace('__SERVER__', server).replace('__TOKEN__', token)
    if (name === 'manifest.json') text = text.replace('__SERVER_MATCH__', match)
    zip.addBuffer(Buffer.from(text, 'utf8'), name)
  }
  zip.end()
  const parts: Buffer[] = []
  for await (const chunk of zip.outputStream) parts.push(chunk as Buffer)
  return Buffer.concat(parts)
}
