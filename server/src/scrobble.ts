import { createHash } from 'node:crypto'
import type { Auth } from './auth.ts'
import { getUserSetting, setUserSetting, type Db } from './db.ts'
import { badRequest, HttpError } from './errors.ts'
import type { Library } from './library.ts'

/**
 * Прослушивания — на ListenBrainz и Last.fm («скробблинг»). Отправляет сервер: так уходят прослушивания со всех
 * устройств, в том числе накопленные без сети. Каждый пользователь подключает свой аккаунт сам (Настройки → История).
 * Ключи лежат на сервере в настройках пользователя и наружу (в GET) не отдаются.
 * Отправляем с момента подключения (старую историю не заливаем); треки короче 30 с не отправляем — так принято у обоих.
 * Раз в минуту берём новые прослушивания после «курсора» и шлём пачками до 50
 */
export type Service = 'listenbrainz' | 'lastfm'
type Fetch = typeof fetch

interface LbConf {
  token: string
  user: string
}
interface LfConf {
  apiKey: string
  secret: string
  session?: string // ключ сессии после подтверждения на сайте
  user?: string
  pending?: string // токен, который ждёт подтверждения
}
interface Conf {
  listenbrainz?: LbConf
  lastfm?: LfConf
}
interface State {
  cursor: string // played_at последнего отправленного
  sent: number
  lastSentAt?: string
  error?: string
}

const KEY = 'scrobble'
const stateKey = (s: Service) => `scrobble:${s}`
const LB = 'https://api.listenbrainz.org/1'
const LF = 'https://ws.audioscrobbler.com/2.0/'
const CLIENT = { media_player: 'MUSICH', submission_client: 'MUSICH', submission_client_version: '0.1.0' }

/** Подпись запроса Last.fm: параметры по алфавиту «имязначение» подряд + секрет, md5. format в подпись не входит */
export function lastfmSig(params: Record<string, string>, secret: string) {
  const base = Object.keys(params)
    .filter((k) => k !== 'format' && k !== 'callback')
    .sort()
    .map((k) => k + params[k])
    .join('')
  return createHash('md5').update(base + secret, 'utf8').digest('hex')
}

export class Scrobbler {
  private db: Db
  private lib: Library
  private auth: Auth
  private fetch: Fetch
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(db: Db, lib: Library, auth: Auth, fetchFn: Fetch = fetch) {
    this.db = db
    this.lib = lib
    this.auth = auth
    this.fetch = fetchFn
  }

  start(everyMs = 60_000) {
    this.timer = setInterval(() => void this.tick(), everyMs)
    this.timer.unref()
  }
  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private conf(uid: string): Conf {
    try {
      return JSON.parse(getUserSetting(this.db, uid, KEY) ?? '{}') as Conf
    } catch {
      return {}
    }
  }
  private saveConf(uid: string, c: Conf) {
    setUserSetting(this.db, uid, KEY, JSON.stringify(c))
  }
  private state(uid: string, s: Service): State {
    try {
      return JSON.parse(getUserSetting(this.db, uid, stateKey(s)) ?? 'null') ?? { cursor: new Date().toISOString(), sent: 0 }
    } catch {
      return { cursor: new Date().toISOString(), sent: 0 }
    }
  }
  private saveState(uid: string, s: Service, st: State) {
    setUserSetting(this.db, uid, stateKey(s), JSON.stringify(st))
  }

  /** Что видно в настройках: подключён ли, под каким именем, сколько отправлено, ошибка. Без ключей */
  status(uid: string) {
    const c = this.conf(uid)
    const one = (s: Service, user: string | undefined, connected: boolean, extra: object = {}) => {
      const st = connected ? this.state(uid, s) : undefined
      return { connected, user: user ?? null, sent: st?.sent ?? 0, lastSentAt: st?.lastSentAt ?? null, error: st?.error ?? null, ...extra }
    }
    return {
      listenbrainz: one('listenbrainz', c.listenbrainz?.user, !!c.listenbrainz),
      lastfm: one('lastfm', c.lastfm?.user, !!c.lastfm?.session, { waiting: !!c.lastfm?.pending && !c.lastfm?.session }),
    }
  }

  // ---------- подключение ----------

  /** ListenBrainz: токен со страницы профиля; проверяем и запоминаем имя */
  async connectListenBrainz(uid: string, token: string) {
    const t = token.trim()
    if (!t) throw badRequest('Нужен токен')
    const r = await this.fetch(`${LB}/validate-token`, { headers: { Authorization: `Token ${t}` } })
    const j = (await r.json().catch(() => ({}))) as { valid?: boolean; user_name?: string }
    if (!r.ok || !j.valid) throw new HttpError(400, 'bad_token', 'ListenBrainz не принял токен — проверь, что скопировал его целиком')
    this.saveConf(uid, { ...this.conf(uid), listenbrainz: { token: t, user: j.user_name ?? '' } })
    this.saveState(uid, 'listenbrainz', { cursor: new Date().toISOString(), sent: 0 })
    return this.status(uid)
  }

  /** Last.fm, шаг 1: ключ и секрет своего приложения Last.fm → токен и адрес, где его подтвердить */
  async startLastfm(uid: string, apiKey: string, secret: string) {
    const key = apiKey.trim()
    const sec = secret.trim()
    if (!/^[0-9a-f]{32}$/i.test(key) || !/^[0-9a-f]{32}$/i.test(sec)) throw badRequest('Ключ и секрет Last.fm — по 32 символа (0–9, a–f)')
    const params = { method: 'auth.getToken', api_key: key }
    const j = await this.lastfmCall({ ...params, api_sig: lastfmSig(params, sec), format: 'json' }, 'GET')
    const token = (j as { token?: string }).token
    if (!token) throw new HttpError(400, 'bad_key', 'Last.fm не принял ключ — проверь ключ и секрет')
    this.saveConf(uid, { ...this.conf(uid), lastfm: { apiKey: key, secret: sec, pending: token } })
    return { authUrl: `https://www.last.fm/api/auth/?api_key=${key}&token=${token}` }
  }

  /** Last.fm, шаг 2: человек нажал «Разрешить» на сайте — забираем ключ сессии */
  async finishLastfm(uid: string) {
    const c = this.conf(uid)
    const lf = c.lastfm
    if (!lf?.pending) throw badRequest('Сначала начни подключение Last.fm')
    const params = { method: 'auth.getSession', api_key: lf.apiKey, token: lf.pending }
    const j = (await this.lastfmCall({ ...params, api_sig: lastfmSig(params, lf.secret), format: 'json' }, 'GET')) as {
      session?: { key: string; name: string }
    }
    if (!j.session) throw new HttpError(400, 'not_confirmed', 'Last.fm ещё не подтвердил доступ — нажми «Разрешить» на открывшейся странице')
    this.saveConf(uid, { ...c, lastfm: { apiKey: lf.apiKey, secret: lf.secret, session: j.session.key, user: j.session.name } })
    this.saveState(uid, 'lastfm', { cursor: new Date().toISOString(), sent: 0 })
    return this.status(uid)
  }

  disconnect(uid: string, s: Service) {
    const c = this.conf(uid)
    delete c[s]
    this.saveConf(uid, c)
    return this.status(uid)
  }

  private async lastfmCall(params: Record<string, string>, method: 'GET' | 'POST') {
    const body = new URLSearchParams(params)
    const r = method === 'GET' ? await this.fetch(`${LF}?${body}`) : await this.fetch(LF, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    const j = (await r.json().catch(() => ({}))) as { error?: number; message?: string }
    if (j.error) throw new HttpError(400, 'lastfm', `Last.fm: ${j.message ?? j.error}`)
    return j
  }

  // ---------- отправка ----------

  /** Один круг: всем подключённым — новые прослушивания. Ошибка одного не мешает остальным */
  async tick() {
    if (this.running) return
    this.running = true
    try {
      for (const u of this.auth.listUsers()) {
        const c = this.conf(u.id)
        if (c.listenbrainz) await this.flush(u.id, 'listenbrainz', c)
        if (c.lastfm?.session) await this.flush(u.id, 'lastfm', c)
      }
    } finally {
      this.running = false
    }
  }

  private async flush(uid: string, s: Service, c: Conf) {
    const st = this.state(uid, s)
    const rows = this.db
      .prepare('SELECT track_id, played_at FROM plays WHERE user_id = ? AND played_at > ? ORDER BY played_at LIMIT 50')
      .all(uid, st.cursor) as { track_id: string; played_at: string }[]
    if (!rows.length) return
    const items = rows
      .map((r) => ({ at: r.played_at, t: this.lib.track(uid, r.track_id) }))
      .filter((x) => x.t && x.t.duration >= 30)
      .map((x) => ({ at: x.at, artist: x.t!.artist, title: x.t!.title, album: x.t!.album, duration: Math.round(x.t!.duration) }))
    try {
      if (items.length) {
        if (s === 'listenbrainz') await this.sendListenBrainz(c.listenbrainz!, items)
        else await this.sendLastfm(c.lastfm!, items)
      }
      this.saveState(uid, s, { cursor: rows[rows.length - 1].played_at, sent: st.sent + items.length, lastSentAt: new Date().toISOString() })
    } catch (e) {
      // сеть или сервис недоступен — курсор не двигаем, попробуем в следующий круг; ошибку показываем в настройках
      this.saveState(uid, s, { ...st, error: (e as Error).message })
      this.lib.log.warn({ service: s, err: (e as Error).message }, 'скробблинг: не отправилось')
    }
  }

  private async sendListenBrainz(conf: LbConf, items: { at: string; artist: string; title: string; album: string; duration: number }[]) {
    const payload = items.map((x) => ({
      listened_at: Math.floor(Date.parse(x.at) / 1000),
      track_metadata: {
        artist_name: x.artist,
        track_name: x.title,
        ...(x.album ? { release_name: x.album } : {}),
        additional_info: { duration_ms: x.duration * 1000, ...CLIENT },
      },
    }))
    const r = await this.fetch(`${LB}/submit-listens`, {
      method: 'POST',
      headers: { Authorization: `Token ${conf.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ listen_type: payload.length === 1 ? 'single' : 'import', payload }),
    })
    if (!r.ok) throw new Error(r.status === 401 ? 'ListenBrainz: токен больше не действует — подключи заново' : `ListenBrainz: ответ ${r.status}`)
  }

  private async sendLastfm(conf: LfConf, items: { at: string; artist: string; title: string; album: string; duration: number }[]) {
    const params: Record<string, string> = { method: 'track.scrobble', api_key: conf.apiKey, sk: conf.session! }
    items.forEach((x, i) => {
      params[`artist[${i}]`] = x.artist
      params[`track[${i}]`] = x.title
      params[`timestamp[${i}]`] = String(Math.floor(Date.parse(x.at) / 1000))
      params[`duration[${i}]`] = String(x.duration)
      if (x.album) params[`album[${i}]`] = x.album
    })
    await this.lastfmCall({ ...params, api_sig: lastfmSig(params, conf.secret), format: 'json' }, 'POST')
  }
}
