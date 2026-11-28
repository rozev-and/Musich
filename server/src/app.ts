import { createHash, randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rm, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { Auth, userInfo, type UserRow } from './auth.ts'
import type { Config } from './config.ts'
import { openDb, getSetting, setSetting } from './db.ts'
import { badRequest, codeFor, forbidden, HttpError, notFound } from './errors.ts'
import { Library, TRACK_ID_RE, type CoverKind, type DeviceInfo, type DeviceKind } from './library.ts'
import { AUDIO_MIME, IMAGE_EXT, looksLikeImage, trackIdFromHash } from './media.ts'
import { parseRange } from './range.ts'
import { scanLibrary } from './scanner.ts'
import { PREFS_SCHEMA, type Prefs } from './prefs.ts'
import { startSchedule } from './schedule.ts'
import { Integrations, SERVICES, vkExtensionZip, type PushedTrack, type Service } from './integrations.ts'
import { Telegram } from './telegram.ts'
import { applyPendingRestore, exportZip, makeBackup, stageRestore } from './backup.ts'
import { Journal, type SyncEvent } from './journal.ts'
import { Attempts, PairCodes, tooMany } from './limits.ts'
import { thumbFile, thumbSize } from './thumbs.ts'
import { readLyrics } from './lyrics.ts'
import { transcoded, wantTranscode } from './transcode.ts'
import { Shares } from './shares.ts'
import { bumpEpoch, CSP, decryptFile, encryptFile, isEncrypted, MEDIA_ROUTES, mediaKey, totpCheck, totpDisable, totpEnable, totpEnabled, totpSetup, verifyMediaKey } from './security.ts'
import { Scrobbler, type Service as ScrobbleService } from './scrobble.ts'

declare module 'fastify' {
  interface FastifyRequest {
    tokenId?: string
    /** Кто вошёл (по токену) */
    user?: UserRow
    /**
     * От чьего имени запрос: обычно тот, кто вошёл; владелец с X-Musich-As (или ?as=) смотрит чужую библиотеку.
     * Все данные берутся по нему, права (только владелец) — по user
     */
    uid?: string
  }
}

/** Загрузка, которая идёт прямо сейчас */
interface Incoming {
  userId: string
  id: string
  fileName: string
  received: number
  total: number
  source?: string
  startedAt: string
}

// Без токена пускаем только сюда: проверка живости и вход
// возврат из Spotify после входа — браузер приходит со страницы Spotify без нашего токена, проверка по state
const PUBLIC_API = new Set([
  '/api/health', '/api/auth/status', '/api/auth/setup', '/api/auth/login', '/api/auth/claim', '/api/auth/register', '/api/sync/pair',
  '/api/integrations/spotify/callback',
])

export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.1.0'
  }
})()

const gzipAsync = promisify(gzip)
const COVER_MAX_BYTES = 5 * 1024 * 1024
const COVER_KINDS = new Set<string>(['track', 'album', 'artist'])

const trackIdsSchema = {
  type: 'array',
  items: { type: 'string', pattern: '^[0-9a-f]{16}$' },
  maxItems: 100000,
} as const

/** Файл с докачкой и перемоткой (Range). etag — метка версии файла: If-Range с другой меткой — отдаём целиком */
async function sendRanged(req: FastifyRequest, reply: FastifyReply, path: string, etag: string) {
  const size = (await stat(path)).size
  reply.header('Accept-Ranges', 'bytes').header('ETag', etag)
  const ifRange = req.headers['if-range']
  const range = ifRange && ifRange !== etag ? null : parseRange(req.headers.range, size)
  if (range === 'unsatisfiable') {
    return reply
      .code(416)
      .header('Content-Range', `bytes */${size}`)
      .header('Content-Type', 'application/json; charset=utf-8')
      .send({ error: 'range_not_satisfiable', message: `Неверный диапазон, размер файла ${size}` })
  }
  if (range) {
    return reply
      .code(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
      .header('Content-Length', range.end - range.start + 1)
      .send(createReadStream(path, { start: range.start, end: range.end }))
  }
  return reply.header('Content-Length', size).send(createReadStream(path))
}

function sendImage(reply: FastifyReply, img: { path: string; mime: string } | undefined, req?: FastifyRequest) {
  if (!img) throw notFound('Картинки нет')
  const st = statSync(img.path, { throwIfNoEntry: false })
  if (!st) throw notFound('Картинки нет')
  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`
  const versioned = !!(req?.query as { v?: string } | undefined)?.v
  reply.header('Content-Type', img.mime).header('ETag', etag).header('Cache-Control', versioned ? 'private, max-age=31536000, immutable' : 'private, no-cache')
  if (req?.headers['if-none-match'] === etag) return reply.code(304).send()
  return reply.send(createReadStream(img.path))
}

export interface Server {
  app: FastifyInstance
  lib: Library
  auth: Auth
  /** Скан в фоне (все папки или указанные); промис — чтобы тесты могли дождаться */
  startScan: (folders?: string[]) => Promise<void>
  /** Узел: id и имя — ими сервер объявляет себя в локальной сети */
  node: { id: string; name: () => string }
}

export async function buildApp(
  cfg: Config,
  // onRestart — пересобрать сервер с нуля (после того как принят бэкап базы); в тестах его нет
  opts: { logger?: FastifyServerOptions['logger']; onRestart?: () => void } = {},
): Promise<Server> {
  // за nginx адрес человека — в X-Forwarded-For; верим ему только от прокси на этой машине или в своей сети,
  // иначе лимит попыток входа считал бы всех за одного (адрес прокси)
  const app = Fastify({ logger: opts.logger ?? true, bodyLimit: 1024 * 1024, trustProxy: ['loopback'] })

  await mkdir(cfg.dataDir, { recursive: true })
  if (await applyPendingRestore(cfg.dataDir)) app.log.info('база заменена бэкапом; прежняя лежит рядом: musich.db.before-restore')
  const db = openDb(join(cfg.dataDir, 'musich.db'))
  const lib = new Library(cfg, db, app.log)
  await lib.init()
  // журнал событий: при первом запуске — из нынешней базы, дальше сырые изменения из триггеров превращаются в события
  // после каждого запроса и раз в пару секунд (скан, слежка за папками, фоновые задачи идут мимо запросов)
  const journal = new Journal(db, cfg.dataDir)
  journal.bootstrap()
  const flushJournal = () => {
    try {
      journal.flush()
    } catch (e) {
      app.log.error({ err: (e as Error).message }, 'журнал: не записался')
    }
  }
  const journalTimer = setInterval(flushJournal, 2000)
  app.addHook('onResponse', async () => flushJournal())
  app.addHook('onClose', async () => {
    clearInterval(journalTimer)
    flushJournal()
  })
  const auth = new Auth(db, cfg.token)
  const shares = new Shares(db, lib, auth)
  // прослушивания — на ListenBrainz / Last.fm (scrobble.ts); в тестах таймер не нужен
  const scrobbler = new Scrobbler(db, lib, auth)
  if (!process.env.NODE_TEST_CONTEXT) scrobbler.start()
  app.addHook('onClose', async () => scrobbler.stop())
  const incoming = new Map<string, Incoming>()
  app.addHook('onClose', async () => db.close())

  const startScan = (folders?: string[]) => {
    // до владельца музыку отдавать некому (скан всё равно пропустил бы каждый файл)
    if (!lib.ownerId()) return Promise.resolve()
    const started = Date.now()
    return scanLibrary(lib, folders).then(
      (res) => app.log.info({ ...res, folders: folders ?? 'все', ms: Date.now() - started }, 'скан завершён'),
      (e: Error) => app.log.error({ err: e.message }, 'скан упал'),
    )
  }
  const schedule = startSchedule(lib, startScan)
  app.addHook('onClose', async () => schedule.stop())
  const integrations = new Integrations(lib)
  app.addHook('onClose', async () => integrations.stop())
  const telegram = new Telegram(lib)
  app.addHook('onClose', async () => telegram.stop())

  // ---- сжатие ----
  // Ответы JSON сжимаем сами, без надежды на nginx: вся библиотека (/api/changes?since=0) — мегабайты текста,
  // в gzip — в 8–10 раз меньше. Мелкие ответы не трогаем: выигрыша нет
  app.addHook('onSend', async (req, reply, payload) => {
    if (typeof payload !== 'string' || payload.length < 2048 || reply.getHeader('Content-Encoding')) return payload
    if (!String(reply.getHeader('Content-Type') ?? '').includes('json')) return payload
    if (!/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) return payload
    reply.header('Content-Encoding', 'gzip')
    reply.header('Vary', 'Accept-Encoding')
    reply.removeHeader('Content-Length')
    return gzipAsync(payload, { level: 5 })
  })

  // ---- CORS ----
  // Приложение на телефоне открыто со своего адреса (http://localhost внутри Capacitor) и ходит к серверу по сети.
  // Пускаем любой адрес: доступ всё равно только по токену, куки сервер не использует. Хук — первым, до проверки входа:
  // предварительный запрос OPTIONS приходит без токена
  app.addHook('onRequest', async (req, reply) => {
    // безопасность — сам сервер, без надежды на чужой nginx: чужие скрипты и встраивание запрещены, тип файла не угадывать,
    // адрес страницы (в нём бывает медиа-ключ) другим сайтам не передавать; HSTS — только если пришли по https
    reply.header('Content-Security-Policy', CSP)
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Referrer-Policy', 'no-referrer')
    if (req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https') reply.header('Strict-Transport-Security', 'max-age=15552000')
    reply.header('Access-Control-Allow-Origin', '*')
    reply.header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, ETag')
    if (req.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
      reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, If-Range, X-Musich-Device, X-Musich-As')
      reply.header('Access-Control-Max-Age', '86400')
      // закладка со страницы vk.com шлёт список на сервер в локальной сети — Chrome спрашивает разрешение отдельно
      if (req.headers['access-control-request-private-network']) reply.header('Access-Control-Allow-Private-Network', 'true')
      return reply.code(204).send()
    }
  })

  // ---- ошибки в формате ApiError ----
  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : err.statusCode && err.statusCode >= 400 ? err.statusCode : 500
    const error = err instanceof HttpError ? err.error : codeFor(status)
    if (status >= 500) req.log.error(err)
    // ответ стороннего сервиса (Яндекс, VK, Spotify…) — свой, понятный текст: показываем его, а не «внутреннюю ошибку»
    const shown = status < 500 || (err instanceof HttpError && err.error === 'integration')
    return reply.code(status).send({ error, message: shown ? err.message : 'Внутренняя ошибка сервера' })
  })

  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split('?')[0]
    const isApi = path === '/api' || path.startsWith('/api/')
    // SPA: любой не-API путь без расширения отдаём как index.html
    if (cfg.staticDir && !isApi && (req.method === 'GET' || req.method === 'HEAD') && !/\.[^/]+$/.test(path)) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html')
    }
    return reply.code(404).send({ error: 'not_found', message: `Нет такого пути: ${req.method} ${path}` })
  })

  // ---- токен ----
  // ключ входа — только в заголовке: в адресе он оседал бы в журналах прокси и истории браузера.
  // <audio src> и <img src> ходят с медиа-ключом ?mk= (ниже) — он только читает файлы
  const tokenOf = (req: { headers: { authorization?: string } }) => {
    const h = req.headers.authorization
    const given = h?.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : undefined
    return given || undefined
  }

  app.addHook('onRequest', async (req, reply) => {
    // путь — как его понял маршрутизатор: он раскодирует %xx («/%61pi/...» — это /api/...), поэтому сверяем
    // шаблон найденного маршрута, а для ненайденных — раскодированный адрес. Иначе закодированный путь обходил вход
    const raw = req.url.split('?')[0]
    let decoded = raw
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      /* битая кодировка — маршрут всё равно не найдётся */
    }
    const path = req.routeOptions?.url ?? decoded
    const given = tokenOf(req)
    const v = given ? auth.verify(given) : undefined
    const user = v && auth.user(v.userId)
    if (v && user) {
      req.tokenId = v.tokenId
      req.user = user
      req.uid = user.id
    } else {
      // <audio>/<img>: вместо ключа входа — медиа-ключ (?mk=): только GET файлов, 14 дней, отзывается сменой пароля
      const mk = (req.query as Record<string, unknown>)?.mk
      if (typeof mk === 'string' && (req.method === 'GET' || req.method === 'HEAD') && MEDIA_ROUTES.some((r) => r.test(decoded))) {
        const uid = verifyMediaKey(db, mk)
        const mu = uid ? auth.user(uid) : undefined
        if (mu) {
          req.user = mu
          req.uid = mu.id
        }
      }
    }
    const api = [path, decoded, raw].some((p) => p === '/api' || p.startsWith('/api/') || p.toLowerCase().startsWith('/api'))
    if (!api) return
    if (req.user) {
      // просмотр чужой библиотеки: только владелец и только чтение. ?as= — для <img>/<audio>, которые не шлют заголовков
      const head = req.headers['x-musich-as']
      const as = (typeof head === 'string' && head) || (req.query as Record<string, unknown>)?.as
      if (typeof as === 'string' && as && !PUBLIC_API.has(path)) {
        if (req.user.role !== 'owner' && req.user.role !== 'admin') throw forbidden('Чужую библиотеку смотрит только владелец или администратор')
        if (req.method !== 'GET' && req.method !== 'HEAD') throw forbidden('Чужая библиотека — только для просмотра')
        if (!auth.user(as)) throw notFound('Пользователь не найден')
        req.uid = as
      }
      return
    }
    if (PUBLIC_API.has(path)) return
    // владельца ещё нет — веб-морда по этой ошибке покажет «создайте владельца»
    const fresh = !auth.ready && !cfg.token
    return reply
      .code(401)
      .header('WWW-Authenticate', 'Bearer')
      .send(fresh ? { error: 'setup_required', message: 'Сначала создайте владельца в веб-интерфейсе' } : { error: 'unauthorized', message: 'Нужно войти' })
  })

  // от чьего имени запрос (после проверки входа он есть всегда)
  const me = (req: FastifyRequest): string => {
    if (!req.uid) throw new HttpError(401, 'unauthorized', 'Нужно войти')
    return req.uid
  }
  /** Управление сервером: владелец и администраторы (остальным 403) */
  const ownerOnly = (req: FastifyRequest) => {
    if (req.user?.role !== 'owner' && req.user?.role !== 'admin') throw forbidden('Это может только владелец или администратор сервера')
  }
  /** Только сам владелец: роли и передача владения */
  const realOwnerOnly = (req: FastifyRequest) => {
    if (req.user?.role !== 'owner') throw forbidden('Это может только владелец сервера')
  }
  /** Администратор не трогает владельца и других администраторов — только владелец */
  const canManage = (req: FastifyRequest, target: { role: string }) => {
    if (req.user?.role !== 'owner' && target.role !== 'user') throw forbidden('Владельца и администраторов меняет только владелец')
  }

  await app.register(multipart)
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer', bodyLimit: COVER_MAX_BYTES }, (_req, body, done) =>
    done(null, body),
  )

  if (cfg.staticDir) {
    await app.register(fastifyStatic, { root: cfg.staticDir, prefix: '/', wildcard: true })
  }

  // ---- служебное ----

  // node и name — без входа: по ним приложение узнаёт свой сервер, когда тот сменил адрес
  // lan — адреса сервера в домашней сети: телефон дома ходит по ним напрямую, вне дома — по домену
  // Три источника: адрес, вписанный владельцем в «Настройках»; адреса, по которым сервер открывали дома (запоминаем
  // сами — в Docker с пробросом порта сервер не видит адрес машины); сетевые карты (Docker с network_mode: host, без Docker).
  // Чужой адрес в списке не страшен: телефон ходит по нему, только если там тот же сервер (id совпал)
  const ifaceUrls = () =>
    Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address) && !/^172\.(1[7-9]|2\d)\./.test(i.address))
      .map((i) => `http://${i!.address}:${cfg.port}`)
  const readList = (key: string) => {
    try {
      const v = JSON.parse(getSetting(db, key) ?? '[]') as unknown
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  let lanSeen = readList('lanSeen')
  const lanFound = () => [...new Set([...lanSeen, ...ifaceUrls()])]
  const lanUrls = () => {
    const manual = getSetting(db, 'lanManual')
    return [...new Set([...(manual ? [manual] : []), ...lanFound()])].slice(0, 8)
  }
  // По каким адресам сервер открывают: напрямую по домашнему (без прокси) — в lanSeen, последние 4, свежий первым;
  // через прокси по https-домену — в publicUrl. Переключатель «Домен / Дома» в вебе ведёт туда с кодом входа,
  // поэтому запоминаем только запросы тех, кто вошёл: чужой в той же сети не подсунет свой адрес (и не заберёт код)
  const LAN_HOST_RE = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[a-z0-9-]+\.local)(:\d{1,5})?$/
  const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d{1,5})?$/
  let publicUrl = getSetting(db, 'publicUrl') ?? null
  app.addHook('onResponse', async (req) => {
    if (!req.user) return
    const first = (v: unknown) => String(v ?? '').split(',')[0]!.trim().toLowerCase()
    if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers.forwarded) {
      const host = first(req.headers['x-forwarded-host'] ?? req.headers.host)
      if (first(req.headers['x-forwarded-proto']) !== 'https' || !DOMAIN_RE.test(host) || host.endsWith('.local')) return
      const url = `https://${host.replace(/:443$/, '')}`
      if (publicUrl === url) return
      publicUrl = url
      setSetting(db, 'publicUrl', url)
      return
    }
    const host = first(req.headers.host)
    if (!LAN_HOST_RE.test(host)) return
    const url = `http://${host}`
    if (lanSeen[0] === url) return
    lanSeen = [url, ...lanSeen.filter((u) => u !== url)].slice(0, 4)
    setSetting(db, 'lanSeen', JSON.stringify(lanSeen))
  })
  // public — https-адрес сервера через домен (если его открывали так): веб переключается между ним и домашним
  app.get('/api/health', async () => ({ ok: true, version: VERSION, node: journal.node, name: lib.serverName(), lan: lanUrls(), public: publicUrl }))

  // «Адрес в домашней сети» в настройках: что сервер нашёл сам и что вписал владелец
  app.get('/api/server/lan', async (req) => {
    ownerOnly(req)
    return { manual: getSetting(db, 'lanManual') ?? '', found: lanFound() }
  })
  app.put<{ Body: { manual: string } }>(
    '/api/server/lan',
    { schema: { body: { type: 'object', required: ['manual'], properties: { manual: { type: 'string', maxLength: 200 } } } } },
    async (req) => {
      ownerOnly(req)
      const raw = req.body.manual.trim().replace(/\/+$/, '')
      if (!raw) {
        db.prepare("DELETE FROM settings WHERE key = 'lanManual'").run()
        return { manual: '', found: lanFound() }
      }
      let u: URL
      try {
        u = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)
      } catch {
        throw badRequest('Адрес вида 192.168.1.50:2290')
      }
      if (!/^https?:$/.test(u.protocol) || u.pathname !== '/' || u.search || u.username) throw badRequest('Адрес вида 192.168.1.50:2290')
      // без порта — порт сервера (так обычно и пробрасывают)
      const url = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : u.protocol === 'http:' ? `:${cfg.port}` : ''}`
      setSetting(db, 'lanManual', url)
      return { manual: url, found: lanFound() }
    },
  )

  // ---- новая версия ----
  // раз в сутки — последний релиз MUSICH на GitHub (только номер версии, без данных о сервере). Выключается в
  // «Настройки → Сервер» (settings.updateCheck = off). Сравнивает версии вида 0.1.0
  let latest: { version: string; url: string; at: number } | null = null
  const newer = (a: string, b: string) => {
    const pa = a.replace(/^v/, '').split('.').map(Number)
    const pb = b.replace(/^v/, '').split('.').map(Number)
    for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
    return false
  }
  app.get('/api/server/update', async () => {
    const on = getSetting(db, 'updateCheck') !== 'off'
    if (on && (!latest || Date.now() - latest.at > 24 * 3600_000)) {
      try {
        const r = await fetch('https://api.github.com/repos/rozev-and/Musich/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MUSICH' }, signal: AbortSignal.timeout(5000) })
        const j = (await r.json()) as { tag_name?: string; html_url?: string }
        latest = { version: j.tag_name ?? VERSION, url: j.html_url ?? '', at: Date.now() }
      } catch {
        latest = { version: VERSION, url: '', at: Date.now() }
      }
    }
    return { current: VERSION, check: on, latest: on && latest && newer(latest.version, VERSION) ? { version: latest.version.replace(/^v/, ''), url: latest.url } : null }
  })
  app.put<{ Body: { check: boolean } }>('/api/server/update', { schema: { body: { type: 'object', required: ['check'], properties: { check: { type: 'boolean' } } } } }, async (req) => {
    ownerOnly(req)
    setSetting(db, 'updateCheck', req.body.check ? 'on' : 'off')
    return { check: req.body.check }
  })

  // ---- вход ----

  const passwordSchema = { type: 'string', minLength: 1, maxLength: 1000 } as const
  const loginProp = { type: 'string', maxLength: 100 } as const
  // подпись входа: имя устройства из запроса, иначе браузер
  const agentName = (req: { headers: Record<string, unknown> }) => String(req.headers['user-agent'] ?? '').slice(0, 120) || 'Браузер'
  const tokenName = (req: { body?: { name?: string }; headers: Record<string, unknown> }) => req.body?.name?.trim() || agentName(req)
  type LoginBody = { Body: { login?: string; password: string; name?: string } }
  type NewUserBody = { Body: { login: string; password: string; name?: string } }
  // login необязателен только для совместимости: старые приложения входили одним паролем владельца
  const loginSchema = {
    body: {
      type: 'object',
      required: ['password'],
      properties: { login: loginProp, password: passwordSchema, name: { type: 'string', maxLength: 200 }, code: { type: 'string', maxLength: 20 } },
    },
  }
  // setup и register: name — имя для показа (профиль), не подпись входа
  const newUserSchema = {
    body: {
      type: 'object',
      required: ['login', 'password'],
      properties: { login: loginProp, password: passwordSchema, name: { type: 'string', maxLength: 100 } },
    },
  }
  const signedIn = (r: { token: string; user: UserRow }) => ({ token: r.token, user: userInfo(r.user) })

  app.get('/api/auth/status', async (req) => ({
    setupDone: auth.ready,
    authenticated: !!req.user,
    registration: auth.registration,
    ownerNeedsLogin: auth.ownerNeedsLogin,
    ...(req.user ? { user: userInfo(req.user) } : {}),
  }))

  app.post<NewUserBody>('/api/auth/setup', { schema: newUserSchema }, async (req, reply) => {
    const r = await auth.setup(req.body.login, req.body.password, req.body.name?.trim() ?? '', agentName(req), (id) => lib.adoptOrphans(id))
    // музыка из MUSIC_DIR, которая ждала владельца
    if (cfg.scanOnStart) void startScan()
    return reply.code(201).send(signedIn(r))
  })

  // перебор пароля: с одного адреса 5 неверных за 15 минут — дальше 15 минут пауза
  const loginAttempts = new Attempts()
  const guard = (attempts: Attempts, key: string, reply: FastifyReply) => {
    const wait = attempts.wait(key)
    if (!wait) return
    reply.header('Retry-After', Math.ceil(wait / 1000))
    throw tooMany(wait)
  }
  // и по адресу, и по логину: с разных адресов (или за общим прокси) один логин всё равно не перебрать
  const byLogin = new Attempts()
  app.post<LoginBody>('/api/auth/login', { schema: loginSchema }, async (req, reply) => {
    const key = req.ip
    const who = String(req.body.login ?? '').toLowerCase()
    guard(loginAttempts, key, reply)
    guard(byLogin, who, reply)
    try {
      const r = await auth.login(req.body.login, req.body.password, tokenName(req), (u) => {
        if (!totpEnabled(db, u.id)) return
        const code = (req.body as { code?: string }).code
        if (!code) throw new HttpError(401, 'totp_required', 'Нужен код из приложения-аутентификатора')
        if (!totpCheck(db, u.id, code)) throw new HttpError(401, 'totp_wrong', 'Код не подошёл')
      })
      loginAttempts.ok(key)
      byLogin.ok(who)
      return signedIn(r)
    } catch (e) {
      // «нужен код» — не неудача: пароль верный, просто ещё не спросили код
      if (e instanceof HttpError && e.statusCode === 401 && e.error !== 'totp_required') {
        loginAttempts.fail(key)
        byLogin.fail(who)
      }
      throw e
    }
  })

  // владелец после обновления придумывает логин (пароль прежний)
  app.post<{ Body: { login: string; password: string } }>(
    '/api/auth/claim',
    { schema: { body: { type: 'object', required: ['login', 'password'], properties: { login: loginProp, password: passwordSchema } } } },
    async (req, reply) => {
      const key = req.ip
      guard(loginAttempts, key, reply)
      try {
        const r = await auth.claim(req.body.login, req.body.password, agentName(req))
        loginAttempts.ok(key)
        return signedIn(r)
      } catch (e) {
        if (e instanceof HttpError && e.statusCode === 401) loginAttempts.fail(key)
        throw e
      }
    },
  )

  // регистрация: не больше 30 с одного адреса за 15 минут (каждая — дорогой хэш пароля; семья за одним роутером пройдёт)
  const registerAttempts = new Attempts(30)
  app.post<NewUserBody>('/api/auth/register', { schema: newUserSchema }, async (req, reply) => {
    guard(registerAttempts, req.ip, reply)
    registerAttempts.fail(req.ip)
    const r = await auth.register(req.body.login, req.body.password, req.body.name?.trim() ?? '', agentName(req), (l) => lib.uploadDirFree(l))
    return reply.code(201).send(signedIn(r))
  })

  app.post('/api/auth/logout', async (req, reply) => {
    auth.revoke(req.user!.id, req.tokenId!)
    return reply.code(204).send()
  })

  app.put<{ Body: { current: string; password: string } }>(
    '/api/auth/password',
    { schema: { body: { type: 'object', required: ['current', 'password'], properties: { current: passwordSchema, password: passwordSchema } } } },
    async (req, reply) => {
      await auth.changePassword(req.user!.id, req.body.current, req.body.password, req.tokenId)
      bumpEpoch(db, req.user!.id)
      return reply.code(204).send()
    },
  )

  // токены устройств: создаются в веб-морде, вставляются в приложение на устройстве. Входы — свои у каждого
  app.get('/api/tokens', async (req) => auth.list(req.user!.id, req.tokenId))

  app.post<{ Body: { name: string } }>(
    '/api/tokens',
    { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 200 } } } } },
    async (req, reply) => reply.code(201).send(auth.create(req.user!.id, req.body.name.trim() || req.body.name)),
  )

  app.delete<{ Params: { id: string } }>('/api/tokens/:id', async (req, reply) => {
    auth.revoke(req.user!.id, req.params.id)
    return reply.code(204).send()
  })

  // ---- пользователи (только владелец) ----

  // общие плейлисты: кому можно отдать (все, кроме меня — только имя и логин), с кем поделился, что дали мне
  app.get('/api/users/directory', async (req) =>
    auth.listUsers().filter((u) => u.id !== me(req)).map((u) => ({ id: u.id, login: u.login, name: u.name })),
  )
  app.get<{ Params: { id: string } }>('/api/playlists/:id/shares', async (req) => ({ userIds: shares.list(me(req), req.params.id) }))
  app.put<{ Params: { id: string }; Body: { userIds: string[] } }>(
    '/api/playlists/:id/shares',
    { schema: { body: { type: 'object', required: ['userIds'], additionalProperties: false, properties: { userIds: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 100 } } } } } },
    async (req) => ({ userIds: shares.set(me(req), req.params.id, req.body.userIds) }),
  )
  app.get('/api/shared', async (req) => shares.sharedWith(me(req)))

  // ---- безопасность (security.ts) ----
  app.get('/api/auth/media-key', async (req) => mediaKey(db, me(req)))
  app.post('/api/auth/logout-all', async (req) => {
    const n = auth.logoutOthers(me(req), req.tokenId)
    bumpEpoch(db, me(req))
    return { revoked: n }
  })
  app.get('/api/auth/2fa', async (req) => ({ enabled: totpEnabled(db, me(req)) }))
  app.post('/api/auth/2fa/setup', async (req) => {
    if (totpEnabled(db, me(req))) throw badRequest('Двухэтапный вход уже включён')
    return totpSetup(db, me(req), req.user!.login ?? req.user!.name)
  })
  app.post<{ Body: { code: string } }>('/api/auth/2fa/enable', { schema: { body: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 20 } } } } }, async (req) => {
    const recovery = totpEnable(db, me(req), req.body.code)
    if (!recovery) throw new HttpError(400, 'totp_wrong', 'Код не подошёл — проверь время на телефоне и попробуй новый код')
    return { recovery }
  })
  app.post<{ Body: { password: string } }>('/api/auth/2fa/disable', { schema: { body: { type: 'object', required: ['password'], properties: { password: { type: 'string', maxLength: 500 } } } } }, async (req) => {
    if (!(await auth.passwordOk(me(req), req.body.password))) throw new HttpError(403, 'forbidden', 'Пароль неверный')
    totpDisable(db, me(req))
    return { enabled: false }
  })

  // скробблинг: статус, подключить ListenBrainz (токен), Last.fm (ключ+секрет → подтвердить на сайте → готово), отключить
  const str = { type: 'string', maxLength: 200 }
  app.get('/api/scrobble', async (req) => scrobbler.status(me(req)))
  app.put<{ Body: { token: string } }>('/api/scrobble/listenbrainz', { schema: { body: { type: 'object', required: ['token'], additionalProperties: false, properties: { token: str } } } }, async (req) =>
    scrobbler.connectListenBrainz(me(req), req.body.token),
  )
  app.post<{ Body: { apiKey: string; secret: string } }>(
    '/api/scrobble/lastfm/start',
    { schema: { body: { type: 'object', required: ['apiKey', 'secret'], additionalProperties: false, properties: { apiKey: str, secret: str } } } },
    async (req) => scrobbler.startLastfm(me(req), req.body.apiKey, req.body.secret),
  )
  app.post('/api/scrobble/lastfm/finish', async (req) => scrobbler.finishLastfm(me(req)))
  app.delete<{ Params: { service: string } }>('/api/scrobble/:service', async (req) => {
    const s = req.params.service as ScrobbleService
    if (s !== 'listenbrainz' && s !== 'lastfm') throw notFound('Нет такого сервиса')
    return scrobbler.disconnect(me(req), s)
  })
  app.post('/api/scrobble/now', async (req) => {
    await scrobbler.tick()
    return scrobbler.status(me(req))
  })

  app.get('/api/users', async (req) => {
    ownerOnly(req)
    return auth.listUsers().map((u) => ({ ...userInfo(u), createdAt: u.created_at, lastSeenAt: u.last_seen_at, ...lib.usage(u.id) }))
  })

  // новый пароль пользователю: все его входы сбрасываются
  app.put<{ Params: { id: string }; Body: { password: string } }>(
    '/api/users/:id/password',
    { schema: { body: { type: 'object', required: ['password'], properties: { password: passwordSchema } } } },
    async (req, reply) => {
      ownerOnly(req)
      const u = auth.user(req.params.id)
      if (!u) throw notFound('Пользователь не найден')
      if (u.id !== req.user!.id) canManage(req, u)
      await auth.resetPassword(req.params.id, req.body.password)
      bumpEpoch(db, req.params.id)
      return reply.code(204).send()
    },
  )

  // роль: администратор ⇄ пользователь (только владелец)
  app.put<{ Params: { id: string }; Body: { role: 'admin' | 'user' } }>(
    '/api/users/:id/role',
    { schema: { body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role: { enum: ['admin', 'user'] } } } } },
    async (req) => {
      realOwnerOnly(req)
      auth.setRole(req.params.id, req.body.role)
      return userInfo(auth.user(req.params.id)!)
    },
  )

  // передать владение (только владелец, с его паролем): он сам становится администратором
  app.post<{ Params: { id: string }; Body: { password: string } }>(
    '/api/users/:id/owner',
    { schema: { body: { type: 'object', required: ['password'], properties: { password: { type: 'string', maxLength: 200 } } } } },
    async (req) => {
      realOwnerOnly(req)
      if (!(await auth.passwordOk(req.user!.id, req.body.password))) throw new HttpError(401, 'wrong_password', 'Неверный пароль')
      auth.transferOwner(req.user!.id, req.params.id)
      lib.forgetOwner()
      return auth.listUsers().map((u) => ({ ...userInfo(u), createdAt: u.created_at, lastSeenAt: u.last_seen_at, ...lib.usage(u.id) }))
    },
  )

  // удалить пользователя вместе с его музыкой из папки загрузок
  app.delete<{ Params: { id: string } }>('/api/users/:id', async (req, reply) => {
    ownerOnly(req)
    const u = auth.user(req.params.id)
    if (!u) throw notFound('Пользователь не найден')
    if (u.id === req.user!.id || u.role === 'owner') throw forbidden('Себя удалить нельзя')
    canManage(req, u)
    await lib.deleteUserData(u.id)
    auth.removeUser(u.id)
    return reply.code(204).send()
  })

  // ---- настройки сервера (только владелец) ----

  app.get('/api/server/settings', async (req) => {
    ownerOnly(req)
    return { registration: auth.registration }
  })

  app.patch<{ Body: { registration?: boolean } }>(
    '/api/server/settings',
    { schema: { body: { type: 'object', additionalProperties: false, properties: { registration: { type: 'boolean' } } } } },
    async (req) => {
      ownerOnly(req)
      if (req.body?.registration !== undefined) auth.setRegistration(req.body.registration)
      return { registration: auth.registration }
    },
  )

  // ---- папки с музыкой ----

  const pathBody = { body: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } } } }
  const userIdProp = { type: 'string', minLength: 1, maxLength: 100 } as const
  // папка владельца или другого админа: админ её не трогает (только сам владелец)
  const folderGuard = (req: FastifyRequest, path: string) => {
    const f = lib.listFolders().find((x) => x.path === path)
    const owner = f?.userId ? auth.user(f.userId) : undefined
    if (owner && owner.id !== req.user!.id) canManage(req, owner)
  }
  const userExists = (id: string) => {
    if (!auth.user(id)) throw notFound('Пользователь не найден')
    return id
  }

  // владелец видит все папки (с хозяином в userId), остальные — только свои
  app.get('/api/folders', async (req) => lib.listFolders(lib.isAdmin(req.user!.id) ? undefined : me(req)))

  app.post<{ Body: { path: string; userId?: string } }>(
    '/api/folders',
    { schema: { body: { type: 'object', required: ['path'], properties: { path: pathBody.body.properties.path, userId: userIdProp } } } },
    async (req, reply) => {
      ownerOnly(req)
      const folder = await lib.addFolder(req.body.path, userExists(req.body.userId ?? req.user!.id))
      schedule.refresh()
      void startScan([folder.path])
      return reply.code(201).send({ ...folder, scanning: true })
    },
  )

  app.delete<{ Querystring: { path?: string } }>('/api/folders', async (req, reply) => {
    ownerOnly(req)
    if (!req.query.path) throw badRequest('Нужен ?path=')
    folderGuard(req, req.query.path)
    lib.removeFolder(req.query.path)
    schedule.refresh()
    return reply.code(204).send()
  })

  // папка переехала (Windows → Linux, другой диск): пути в базе переписываются, файлы и id — те же; потом проверочный скан
  app.post<{ Body: { from: string; to: string } }>(
    '/api/folders/move',
    { schema: { body: { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: { from: pathBody.body.properties.path, to: pathBody.body.properties.path } } } },
    async (req) => {
      ownerOnly(req)
      folderGuard(req, req.body.from)
      const r = await lib.moveFolder(req.body.from, req.body.to)
      schedule.refresh()
      void startScan([r.path])
      return { ...r, folders: lib.listFolders() }
    },
  )

  app.put<{ Body: { path: string } }>('/api/folders/uploads', { schema: pathBody }, async (req) => {
    ownerOnly(req)
    lib.setUploadFolder(req.body.path)
    return lib.listFolders()
  })

  // передать папку другому пользователю: её треки переезжают к нему (скан заводит их заново)
  app.put<{ Body: { path: string; userId: string } }>(
    '/api/folders/owner',
    { schema: { body: { type: 'object', required: ['path', 'userId'], properties: { path: pathBody.body.properties.path, userId: userIdProp } } } },
    async (req) => {
      ownerOnly(req)
      folderGuard(req, req.body.path)
      if (lib.setFolderOwner(req.body.path, userExists(req.body.userId))) void startScan([req.body.path])
      return lib.listFolders()
    },
  )

  // пересканировать всё; папки, которые уже сканируются, пропускаются
  app.post('/api/scan', async (req, reply) => {
    ownerOnly(req)
    void startScan()
    return reply.code(202).send(lib.listFolders().map((f) => ({ ...f, scanning: true })))
  })

  app.get<{ Querystring: { path?: string } }>('/api/fs', async (req) => {
    ownerOnly(req)
    return lib.browse(req.query.path ?? '')
  })

  // hwId — постоянный номер устройства, id — тот, что оно запомнило: по ним сервер узнаёт знакомое и не плодит копии
  app.post<{ Body: { name: string; kind: DeviceKind; hwId?: string; id?: string } }>(
    '/api/devices',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'kind'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            kind: { enum: ['desktop', 'laptop', 'phone'] },
            hwId: { type: 'string', minLength: 4, maxLength: 200 },
            id: { type: 'string', minLength: 1, maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => reply.code(201).send(lib.registerDevice(me(req), req.body.name.trim() || req.body.name, req.body.kind, req.body.hwId, req.body.id)),
  )

  app.get('/api/devices', async (req) => lib.listDevices(me(req)))

  // тело необязательное: старые клиенты шлют пустой запрос
  type SeenBody = { pendingUp?: number; pendingDown?: number; synced?: boolean; info?: DeviceInfo } | undefined
  const num = { type: 'number', minimum: 0 }
  const infoSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      client: { enum: ['app', 'web'] },
      version: { type: 'string', maxLength: 30 },
      tracks: { type: 'integer', minimum: 0 },
      bytes: num,
      free: num,
      total: num,
      route: { enum: ['home', 'domain', 'direct'] },
      playing: { type: 'string', maxLength: 300 },
    },
  }
  app.post<{ Params: { id: string }; Body: SeenBody }>(
    '/api/devices/:id/seen',
    {
      schema: {
        body: {
          type: ['object', 'null'],
          properties: { pendingUp: { type: 'integer', minimum: 0 }, pendingDown: { type: 'integer', minimum: 0 }, synced: { type: 'boolean' }, info: infoSchema },
        },
      },
    },
    async (req) => lib.deviceSeen(me(req), req.params.id, req.body ?? undefined),
  )

  // «Экосистема» (страница «Сервер»): сервер и все устройства с тем, что они о себе сообщили.
  // Владелец и админ видят всех пользователей, остальные — только себя
  app.get('/api/ecosystem', async (req) => {
    const uid = me(req)
    const all = req.user?.role === 'owner' || req.user?.role === 'admin'
    const users = (db.prepare('SELECT id, login, name, role FROM users ORDER BY created_at').all() as { id: string; login: string | null; name: string; role: string }[]).filter(
      (u) => all || u.id === uid,
    )
    const eco = lib.ecosystem(users.map((u) => u.id))
    const disk = await statfs(cfg.dataDir).then((s) => ({ free: s.bavail * s.bsize, total: s.blocks * s.bsize }), () => null)
    return {
      server: { version: VERSION, name: lib.serverName(), disk },
      users: eco.users.map((e) => {
        const u = users.find((x) => x.id === e.id)!
        return { ...e, login: u.login, name: u.name, role: u.role, me: u.id === uid }
      }),
    }
  })

  app.delete<{ Params: { id: string } }>('/api/devices/:id', async (req, reply) => {
    lib.deleteDevice(me(req), req.params.id)
    return reply.code(204).send()
  })

  // ---- сводка: главная и страница «Сервер» ----

  app.get('/api/stats', async (req) => {
    // место — на диске папки для загрузок: туда ляжет всё новое
    const disk = await statfs(lib.uploadFolder()).then(
      (s) => ({ total: s.blocks * s.bsize, free: s.bavail * s.bsize }),
      () => null,
    )
    return { ...lib.stats(me(req)), disk, version: VERSION }
  })

  app.get('/api/activity', async (req) => ({
    incoming: [...incoming.values()].filter((u) => u.userId === me(req)).map(({ userId: _u, ...u }) => ({ ...u, total: Math.max(u.total, u.received) })),
    recent: lib.recent(me(req)),
  }))

  // ---- профиль ----

  app.get('/api/profile', async (req) => lib.profile(me(req)))

  // общие настройки сервера: история, корзина, пересканирование, правила файлов и номеров
  // ---- бэкап и выгрузка музыки ----

  // снимок базы (с картинками внутри) — скачать файлом (веб берёт его fetch-ем с заголовком)
  // бэкап — это все пароли (хэши) и ключи интеграций всех: скачать и восстановить может только сам владелец
  app.get('/api/backup', async (req, reply) => {
    realOwnerOnly(req)
    const file = await makeBackup(db, cfg.dataDir)
    const name = `musich-backup-${new Date().toISOString().slice(0, 10)}.db`
    const stream = createReadStream(file)
    stream.on('close', () => void rm(file, { force: true }))
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', (await stat(file)).size)
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(stream)
  })

  // бэкап с паролем (по желанию): шифруется AES-256-GCM; пароль — в теле запроса, не в адресе
  app.post<{ Body: { password?: string } }>('/api/backup', { schema: { body: { type: 'object', properties: { password: { type: 'string', maxLength: 500 } } } } }, async (req, reply) => {
    realOwnerOnly(req)
    const plain = await makeBackup(db, cfg.dataDir)
    const pw = req.body?.password?.trim()
    let file = plain
    if (pw) {
      file = `${plain}.enc`
      await encryptFile(plain, file, pw)
      await rm(plain, { force: true })
    }
    const name = `musich-backup-${new Date().toISOString().slice(0, 10)}.${pw ? 'musich' : 'db'}`
    const stream = createReadStream(file)
    stream.on('close', () => void rm(file, { force: true }))
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', (await stat(file)).size)
      .header('Content-Disposition', `attachment; filename="${name}"`)
      .send(stream)
  })

  // вернуть бэкап: база подменяется при перезапуске — сервер перезапускается сам
  app.post('/api/backup/restore', async (req, reply) => {
    realOwnerOnly(req)
    if (!req.isMultipart()) throw new HttpError(415, 'unsupported_media_type', 'Нужен multipart/form-data с полем file')
    const part = await req.file({ limits: { fileSize: cfg.maxUploadBytes, files: 1 } })
    if (!part) throw badRequest('Нет файла в поле file')
    const tmp = join(cfg.dataDir, `restore-${randomUUID()}.upload`)
    try {
      await pipeline(part.file, createWriteStream(tmp))
      if (part.file.truncated) throw new HttpError(413, 'payload_too_large', 'Файл слишком большой')
      // зашифрованный бэкап — пароль приходит полем password перед файлом
      if (await isEncrypted(tmp)) {
        const pwField = (part.fields as Record<string, { value?: unknown } | undefined>).password
        const pw = typeof pwField?.value === 'string' ? pwField.value : ''
        if (!pw) throw new HttpError(400, 'password_required', 'Этот бэкап с паролем — введи пароль')
        await decryptFile(tmp, `${tmp}.dec`, pw).catch(() => {
          throw new HttpError(400, 'password_wrong', 'Пароль не подошёл или файл повреждён')
        })
        await stageRestore(`${tmp}.dec`, cfg.dataDir)
      } else await stageRestore(tmp, cfg.dataDir)
    } finally {
      await rm(tmp, { force: true })
      await rm(`${tmp}.dec`, { force: true })
    }
    app.log.info('бэкап принят — перезапускаюсь, чтобы поставить его вместо базы')
    reply.raw.once('finish', () => setTimeout(() => opts.onRestart?.(), 200))
    return reply.code(202).send({ restarting: true })
  })

  app.get<{ Querystring: { tracks?: string; albums?: string; playlists?: string; names?: string } }>('/api/export', async (req, reply) => {
    const q = req.query
    const playlists = q.playlists === 'copies' || q.playlists === 'm3u' ? q.playlists : 'none'
    let names = { tracks: 'Tracks', albums: 'Albums', playlists: 'Playlists', liked: 'Liked' }
    try {
      names = { ...names, ...(JSON.parse(q.names ?? '{}') as Partial<typeof names>) }
    } catch {
      /* имена по умолчанию */
    }
    const o = { tracks: q.tracks === '1', albums: q.albums === '1', playlists, names } as const
    if (!o.tracks && !o.albums && o.playlists === 'none') throw badRequest('Нечего выгружать: выберите треки, альбомы или плейлисты')
    const { stream, size } = await exportZip(lib, me(req), o)
    const name = `musich-${new Date().toISOString().slice(0, 10)}.zip`
    reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="${name}"`)
    if (size >= 0) reply.header('Content-Length', size)
    return reply.send(stream)
  })

  app.get('/api/prefs', async (req) => lib.prefs(me(req)))
  app.patch<{ Body: Partial<Prefs> }>('/api/prefs', { schema: { body: PREFS_SCHEMA } }, async (req) => lib.setPrefs(me(req), req.body))

  app.put<{ Body: { name?: string; email?: string; avatar?: string | null } }>(
    '/api/profile',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 100 },
            email: { type: 'string', maxLength: 200 },
            // картинку браузер ужимает до квадрата 400px, это десятки килобайт
            avatar: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^data:image/(jpeg|png|webp);base64,', maxLength: 700000 }] }, // null первым: иначе приведение типов делало из него строку
          },
        },
      },
    },
    async (req) => {
      auth.saveProfile(me(req), req.body ?? {})
      return lib.profile(me(req))
    },
  )

  // ---- треки ----

  app.get('/api/tracks', async (req) => lib.listTracks(me(req)))

  // трек по отпечатку файла (любому из его истории): чей это файл и есть ли он уже в хранилище.
  // HEAD fastify делает из GET сам — 200, если есть, 404, если нет
  app.get<{ Params: { id: string } }>('/api/tracks/by-hash/:id', async (req) => {
    const t = lib.getTrackByHash(me(req), req.params.id.toLowerCase())
    if (!t || t.status !== 'available') throw notFound('Такого файла в хранилище нет')
    return t
  })

  app.get<{ Params: { id: string } }>('/api/tracks/:id', async (req) => {
    const t = lib.track(me(req), req.params.id)
    if (!t) throw notFound('Трек не найден')
    return t
  })

  // Кто прислал: устройство (клиент синхронизации шлёт свой id) или вход из браузера
  const sourceOf = (req: FastifyRequest) => {
    const dev = req.headers['x-musich-device']
    return (typeof dev === 'string' && lib.device(me(req), dev)?.name) || auth.name(req.tokenId)
  }

  app.post('/api/tracks', async (req, reply) => {
    if (!req.isMultipart()) throw new HttpError(415, 'unsupported_media_type', 'Нужен multipart/form-data с полем file')
    const part = await req.file({ limits: { fileSize: cfg.maxUploadBytes, files: 1 } })
    if (!part) throw badRequest('Нет файла в поле file')
    const tmp = join(await lib.uploadTmpDir(me(req)), `${randomUUID()}.upload`)
    const hash = createHash('sha256')
    const source = sourceOf(req)
    // видно на странице «Сервер», пока идёт; размер — по Content-Length (с небольшим запасом на multipart)
    const live: Incoming = { userId: me(req), id: randomUUID(), fileName: part.filename, received: 0, total: Number(req.headers['content-length']) || 0, source, startedAt: new Date().toISOString() }
    incoming.set(live.id, live)
    try {
      await pipeline(
        part.file,
        new Transform({
          transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk)
            live.received += chunk.length
            cb(null, chunk)
          },
        }),
        createWriteStream(tmp),
      )
      if (part.file.truncated) throw new HttpError(413, 'payload_too_large', 'Файл слишком большой')
      const fileHash = trackIdFromHash(hash.digest('hex'))
      const { track, created } = await lib.ingestUpload(me(req), tmp, fileHash, part.filename || `${fileHash}`, source)
      return reply.code(created ? 201 : 200).send(track)
    } finally {
      incoming.delete(live.id)
      await rm(tmp, { force: true })
    }
  })

  app.get<{ Params: { id: string } }>('/api/tracks/:id/file', async (req, reply) => {
    const id = req.params.id
    const f = TRACK_ID_RE.test(id) ? lib.trackFile(me(req), id) : undefined
    if (!f) throw notFound('Файла трека нет')
    const t = lib.track(me(req), id)!
    // качество потока (?q=128|192|320): пережатая копия MP3 из кэша; ?warm=1 — подготовить заранее и сразу ответить
    const q = wantTranscode((req.query as { q?: string }).q, f, t.duration)
    if (q) {
      if ((req.query as { warm?: string }).warm) {
        void transcoded(cfg.dataDir, f.path, t.hash, q)
        return reply.code(204).send()
      }
      const tc = await transcoded(cfg.dataDir, f.path, t.hash, q)
      if (tc) {
        reply
          .header('Content-Type', 'audio/mpeg')
          .header('Cache-Control', 'private, max-age=31536000, immutable')
          .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(t.fileName.replace(/\.[^.]+$/, '.mp3'))}`)
        return sendRanged(req, reply, tc, `"${t.hash}-${q}"`)
      }
    }
    // id трека постоянный, а файл после прошивки тегов другой: метка — отпечаток файла. Адрес с ?v=<отпечаток>
    // можно кэшировать навсегда, без него — браузер перепроверяет (иначе играла бы старая версия)
    reply
      .header('Content-Type', AUDIO_MIME[f.format] ?? 'application/octet-stream')
      .header('Cache-Control', (req.query as { v?: string }).v === t.hash ? 'private, max-age=31536000, immutable' : 'private, no-cache')
      .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(t.fileName)}`)
    return sendRanged(req, reply, f.path, `"${t.hash}"`)
  })

  // ---- синхронизация узлов (docs/SYNC.md, этап 1: журнал и чтение; приём событий и подключение устройств — дальше) ----
  // журнал у каждого пользователя свой: узел-сервер один, векторы и события — того, кто вошёл
  app.get('/api/sync/hello', async (req) => {
    journal.flush()
    return { node: journal.node, name: lib.serverName(), kind: 'server', vector: journal.vector(me(req)) }
  })
  app.post<{ Body: { vector?: Record<string, number>; limit?: number } }>(
    '/api/sync/pull',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            vector: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
            limit: { type: 'integer', minimum: 1, maximum: 5000 },
          },
        },
      },
    },
    async (req) => {
      journal.flush()
      return journal.pull(me(req), req.body?.vector ?? {}, req.body?.limit ?? 1000)
    },
  )
  // приём событий других узлов (этап 2a): ответ — сколько принято и новый вектор, чтобы узел знал, с чего продолжать
  const eventSchema = {
    type: 'object',
    required: ['id', 'node', 'n', 'hlc', 'type', 'key', 'field'],
    properties: {
      id: { type: 'string', maxLength: 120 },
      node: { type: 'string', minLength: 1, maxLength: 64 },
      n: { type: 'integer', minimum: 1 },
      hlc: { type: 'string', maxLength: 40 },
      type: { type: 'string', maxLength: 40 },
      key: { type: 'string', maxLength: 300 },
      field: { type: 'string', maxLength: 40 },
      value: {},
      base: { type: ['string', 'null'], maxLength: 120 },
    },
  } as const
  app.post<{ Body: { events: SyncEvent[] } }>(
    '/api/sync/push',
    { schema: { body: { type: 'object', required: ['events'], properties: { events: { type: 'array', maxItems: 5000, items: eventSchema } } } } },
    async (req) => ({ ...journal.push(me(req), req.body.events), vector: journal.vector(me(req)) }),
  )
  // подключение устройства по коду: подключённое просит код (и показывает QR), новое меняет код на свой ключ
  const pairCodes = new PairCodes()
  const pairAttempts = new Attempts()
  app.post('/api/sync/codes', async (req) => pairCodes.create(req.user!.id))
  app.post<{ Body: { code: string; name?: string; kind?: string } }>(
    '/api/sync/pair',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', minLength: 6, maxLength: 20 }, name: { type: 'string', maxLength: 200 }, kind: { type: 'string', maxLength: 20 } },
        },
      },
    },
    async (req, reply) => {
      const key = req.ip
      guard(pairAttempts, key, reply)
      // устройство входит как тот, кто создал код
      const owner = pairCodes.take(req.body.code)
      if (!owner || !auth.user(owner)) {
        pairAttempts.fail(key)
        throw new HttpError(401, 'unauthorized', 'Код неверный или устарел')
      }
      pairAttempts.ok(key)
      const { token } = auth.create(owner, tokenName(req))
      return { key: token, node: journal.node, name: lib.serverName() }
    },
  )
  // файл трека или своей картинки по отпечатку (GET и HEAD, с Range)
  app.get<{ Params: { hash: string } }>('/api/sync/file/:hash', async (req, reply) => {
    const hash = req.params.hash
    if (!/^[0-9a-f]{16}$/.test(hash)) throw notFound('Файла с таким отпечатком здесь нет')
    const row = db
      .prepare("SELECT id FROM tracks WHERE user_id = ? AND hash = ? AND status = 'available' AND replaced_by IS NULL")
      .get(me(req), hash) as { id: string } | undefined
    const tf = row && lib.trackFile(me(req), row.id)
    if (tf) return sendRanged(req, reply.header('Content-Type', AUDIO_MIME[tf.format] ?? 'application/octet-stream'), tf.path, `"${hash}"`)
    const c = journal.coverFile(me(req), hash)
    if (c && existsSync(c.path)) return sendRanged(req, reply.header('Content-Type', c.mime), c.path, `"${hash}"`)
    throw notFound('Файла с таким отпечатком здесь нет')
  })

  // ?w=160 — маленькая копия для списков (см. thumbs.ts); без w — оригинал
  const sendCover = async (req: FastifyRequest, reply: FastifyReply, img: { path: string; mime: string } | undefined) => {
    const size = img && thumbSize((req.query as { w?: string } | undefined)?.w)
    const small = img && size ? await thumbFile(cfg.dataDir, img.path, size) : null
    return sendImage(reply, small ? { path: small, mime: 'image/webp' } : img, req)
  }
  app.get<{ Params: { id: string } }>('/api/tracks/:id/cover', async (req, reply) => sendCover(req, reply, lib.trackCover(me(req), req.params.id)))
  // текст песни: .lrc рядом с файлом или из тегов → { lyrics: строка LRC/обычный текст | null }
  app.get<{ Params: { id: string } }>('/api/tracks/:id/lyrics', async (req) => {
    const tf = lib.trackFile(me(req), req.params.id)
    if (!tf) throw notFound('Трек не найден')
    return { lyrics: await readLyrics(tf.path) }
  })

  app.delete<{ Params: { id: string } }>('/api/tracks/:id', async (req, reply) => {
    await lib.deleteTrack(me(req), req.params.id)
    return reply.code(204).send()
  })

  // громкость, которую клиент измерил сам (у трека нет ReplayGain)
  app.put<{ Params: { id: string }; Body: { gain: number } }>(
    '/api/tracks/:id/loudness',
    { schema: { body: { type: 'object', required: ['gain'], properties: { gain: { type: 'number', minimum: -30, maximum: 20 } } } } },
    async (req) => lib.setAutoGain(me(req), req.params.id, req.body.gain),
  )

  // своя обложка альбома — во все его файлы
  app.post<{ Body: { album: string } }>(
    '/api/albums/embed-cover',
    { schema: { body: { type: 'object', required: ['album'], properties: { album: { type: 'string', minLength: 1 } } } } },
    async (req) => lib.embedAlbumCover(me(req), req.body.album),
  )

  // ---- конфликты ----

  // ---- интеграции: списки треков из Spotify и YouTube Music — сравнить с библиотекой ----

  const service = (raw: string): Service => {
    if (!(SERVICES as string[]).includes(raw)) throw notFound('Такого сервиса нет')
    return raw as Service
  }
  app.get('/api/integrations', async (req) => integrations.status(me(req)))

  // Telegram: музыка профиля — в библиотеку файлами. Вход аккаунтом: api_id/api_hash → номер → код → пароль (если есть)
  const one = (name: string, max: number) => ({ schema: { body: { type: 'object', required: [name], properties: { [name]: { type: 'string', maxLength: max } } } } })
  app.get('/api/integrations/telegram', async (req) => telegram.status(me(req)))
  app.put<{ Body: { apiId: string; apiHash: string } }>(
    '/api/integrations/telegram/config',
    { schema: { body: { type: 'object', required: ['apiId', 'apiHash'], properties: { apiId: { type: 'string', maxLength: 20 }, apiHash: { type: 'string', maxLength: 64 } } } } },
    async (req) => {
      telegram.configure(me(req), req.body.apiId, req.body.apiHash)
      return telegram.status(me(req))
    },
  )
  app.post<{ Body: { phone: string } }>('/api/integrations/telegram/code', one('phone', 32), async (req) => telegram.sendCode(me(req), req.body.phone))
  app.post<{ Body: { code: string } }>('/api/integrations/telegram/signin', one('code', 16), async (req) => telegram.signIn(me(req), req.body.code))
  app.post<{ Body: { password: string } }>('/api/integrations/telegram/password', one('password', 256), async (req) => telegram.password(me(req), req.body.password))
  app.post('/api/integrations/telegram/import', async (req) => telegram.importProfile(me(req)))
  app.delete('/api/integrations/telegram', async (req, reply) => {
    await telegram.disconnect(me(req))
    return reply.code(204).send()
  })
  app.put<{ Params: { service: string }; Body: { clientId: string; clientSecret?: string } }>(
    '/api/integrations/:service/config',
    { schema: { body: { type: 'object', required: ['clientId'], properties: { clientId: { type: 'string', maxLength: 200 }, clientSecret: { type: 'string', maxLength: 200 } } } } },
    async (req) => {
      integrations.configure(me(req), service(req.params.service), req.body.clientId, req.body.clientSecret)
      return integrations.status(me(req))
    },
  )
  app.post<{ Body: { redirectUri: string; origin: string } }>(
    '/api/integrations/spotify/start',
    { schema: { body: { type: 'object', required: ['redirectUri', 'origin'], properties: { redirectUri: { type: 'string', maxLength: 500 }, origin: { type: 'string', maxLength: 500 } } } } },
    async (req) => integrations.spotifyStart(me(req), req.body.redirectUri, req.body.origin),
  )
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/integrations/spotify/callback', async (req, reply) =>
    reply.redirect(await integrations.spotifyCallback(req.query.code, req.query.state, req.query.error)),
  )
  app.post('/api/integrations/youtube/start', async (req) => integrations.youtubeStart(me(req)))
  app.post<{ Body: { token: string } }>(
    '/api/integrations/yandex/token',
    { schema: { body: { type: 'object', required: ['token'], properties: { token: { type: 'string', maxLength: 4000 } } } } },
    async (req) => integrations.yandexConnect(me(req), req.body.token),
  )
  // VK: расширение браузера присылает весь список целиком
  const pushed = {
    type: 'array',
    maxItems: 50000,
    items: {
      type: 'object',
      required: ['title'],
      properties: {
        id: { type: 'string', maxLength: 100 },
        artist: { type: 'string', maxLength: 500 },
        title: { type: 'string', maxLength: 500 },
        duration: { type: 'number' },
        cover: { type: 'string', maxLength: 2000 },
      },
    },
  }
  app.post<{ Body: { liked: PushedTrack[]; lists?: { name: string; tracks: PushedTrack[] }[] } }>(
    '/api/integrations/vk/push',
    {
      bodyLimit: 32 * 1024 * 1024,
      schema: {
        body: {
          type: 'object',
          required: ['liked'],
          properties: {
            liked: pushed,
            lists: { type: 'array', maxItems: 500, items: { type: 'object', required: ['name', 'tracks'], properties: { name: { type: 'string', maxLength: 300 }, tracks: pushed } } },
          },
        },
      },
    },
    async (req) => integrations.pushVk(me(req), req.body.liked, req.body.lists ?? []),
  )
  // само расширение: адрес этого сервера и свой ключ доступа вписаны в него — ставишь и всё, связывать ничего не нужно
  app.get<{ Querystring: { origin?: string } }>('/api/integrations/vk/extension', async (req, reply) => {
    let origin: URL
    try {
      origin = new URL(req.query.origin ?? '')
    } catch {
      throw badRequest('Нужен адрес сервера MUSICH (origin)')
    }
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') throw badRequest('Адрес сервера — только http или https')
    // ключ — того, кто вошёл (не того, чью библиотеку смотрит владелец)
    const { token } = auth.create(req.user!.id, 'Расширение VK → MUSICH')
    const zip = await vkExtensionZip(origin.origin, token)
    return reply.header('Content-Type', 'application/zip').header('Content-Disposition', 'attachment; filename="musich-vk.zip"').send(zip)
  })
  app.post<{ Body: { link: string } }>(
    '/api/integrations/yandex/public',
    { schema: { body: { type: 'object', required: ['link'], properties: { link: { type: 'string', maxLength: 1000 } } } } },
    async (req) => integrations.yandexAddPublic(me(req), req.body.link),
  )
  // список треков, вставленный текстом
  app.post<{ Params: { service: string }; Body: { list: string; tracks: { artist: string; title: string }[] } }>(
    '/api/integrations/:service/import',
    {
      bodyLimit: 16 * 1024 * 1024,
      schema: {
        body: {
          type: 'object', required: ['list', 'tracks'],
          properties: {
            list: { type: 'string', maxLength: 300 },
            tracks: { type: 'array', maxItems: 50000, items: { type: 'object', properties: { artist: { type: 'string', maxLength: 500 }, title: { type: 'string', maxLength: 500 } } } },
          },
        },
      },
    },
    async (req) => integrations.importList(me(req), service(req.params.service), req.body.list, req.body.tracks),
  )
  app.post<{ Params: { service: string } }>('/api/integrations/:service/sync', async (req) => integrations.sync(me(req), service(req.params.service)))
  app.get<{ Params: { service: string } }>('/api/integrations/:service/compare', async (req) => integrations.compare(me(req), service(req.params.service)))
  app.delete<{ Params: { service: string } }>('/api/integrations/:service', async (req, reply) => {
    integrations.disconnect(me(req), service(req.params.service))
    return reply.code(204).send()
  })

  app.get('/api/conflicts', async (req) => lib.listConflicts(me(req)))
  app.post<{ Params: { id: string }; Body: { action: 'restore' | 'discard' } }>(
    '/api/conflicts/:id',
    { schema: { body: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['restore', 'discard'] } } } } },
    async (req) => ({ track: (await lib.resolveConflict(me(req), req.params.id, req.body.action)) ?? null }),
  )
  app.post<{ Body: { key: string } }>(
    '/api/conflicts/duplicates/ignore',
    { schema: { body: { type: 'object', required: ['key'], properties: { key: { type: 'string', minLength: 1 } } } } },
    async (req, reply) => {
      lib.ignoreDuplicate(me(req), req.body.key)
      return reply.code(204).send()
    },
  )

  // правки «только в MUSICH» убрать — снова как в тегах файла
  app.delete<{ Params: { id: string } }>('/api/tracks/:id/overrides', async (req) => lib.resetOverrides(me(req), req.params.id))

  // ---- корзина ----

  app.get('/api/trash', async (req) => lib.listTrash(me(req)))
  app.post<{ Params: { id: string } }>('/api/trash/:id/restore', async (req) => lib.restoreTrash(me(req), req.params.id))
  app.delete<{ Params: { id: string } }>('/api/trash/:id', async (req, reply) => {
    await lib.purgeTrash(me(req), req.params.id)
    return reply.code(204).send()
  })
  app.delete('/api/trash', async (req, reply) => {
    await lib.purgeTrash(me(req))
    return reply.code(204).send()
  })

  app.put<{ Params: { id: string }; Body: { liked: boolean } }>(
    '/api/tracks/:id/like',
    { schema: { body: { type: 'object', required: ['liked'], properties: { liked: { type: 'boolean' } } } } },
    async (req) => lib.setLike(me(req), req.params.id, req.body.liked),
  )

  // Переименование: теги пишутся в файл, id трека меняется (это хэш файла) — в ответе и новый трек, и старый id
  type RenameBody = { title?: string; artist?: string; album?: string; year?: number }
  const tagProp = { type: 'string', minLength: 1, maxLength: 500 } as const
  app.patch<{ Params: { id: string }; Body: RenameBody }>(
    '/api/tracks/:id',
    {
      schema: {
        body: { type: 'object', minProperties: 1, additionalProperties: false, properties: { title: tagProp, artist: tagProp, album: tagProp, year: { type: 'integer', minimum: 0, maximum: 9999 } } },
      },
    },
    async (req) => {
      lib.availableTrack(me(req), req.params.id) // чужой трек — 404
      return lib.renameTrack(req.params.id, req.body)
    },
  )

  // Переименование артиста во всех его треках (теги в файлах, id у треков меняются)
  app.post<{ Body: { from: string; to: string } }>(
    '/api/artists/rename',
    { schema: { body: { type: 'object', required: ['from', 'to'], properties: { from: tagProp, to: tagProp } } } },
    async (req) => lib.renameArtist(me(req), req.body.from, req.body.to),
  )

  // Перенос трека на другой номер (тег «№»): треки между старым и новым номером сдвигаются, их файлы переписываются
  app.post<{ Params: { id: string }; Body: { number: number } }>(
    '/api/tracks/:id/number',
    { schema: { body: { type: 'object', required: ['number'], properties: { number: { type: 'integer', minimum: 1, maximum: 999999 } } } } },
    async (req) => lib.moveTrackNumber(me(req), req.params.id, req.body.number),
  )

  // Пронумеровать библиотеку подряд 1…N (закрыть дыры, развести одинаковые номера). Идёт в фоне
  app.post('/api/tracks/renumber', async (req, reply) => reply.code(202).send(lib.renumberAll(me(req))))

  // ---- история прослушиваний ----

  // at — когда слушали: телефон без сети копит прослушивания и досылает их потом со своим временем
  app.post<{ Body: { trackId: string; at?: string } }>(
    '/api/plays',
    {
      schema: {
        body: {
          type: 'object',
          required: ['trackId'],
          properties: { trackId: { type: 'string', pattern: '^[0-9a-f]{16}$' }, at: { type: 'string', format: 'date-time' } },
        },
      },
    },
    async (req, reply) => reply.code(201).send(lib.recordPlay(me(req), req.body.trackId, sourceOf(req), req.body.at)),
  )

  // история хранится 3 дня — отдаём её целиком
  app.get('/api/plays', async (req) => lib.listPlays(me(req)))

  // ---- плейлисты ----

  type PlaylistBody = { name?: string; description?: string; trackIds?: string[] }
  const playlistProps = {
    name: { type: 'string', minLength: 1, maxLength: 500 },
    description: { type: 'string', maxLength: 10000 },
    trackIds: trackIdsSchema,
  } as const

  app.get('/api/playlists', async (req) => lib.listPlaylists(me(req)))

  // порядок плейлистов: все id в нужном порядке
  app.put<{ Body: { ids: string[] } }>(
    '/api/playlists/order',
    { schema: { body: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string', maxLength: 64 }, maxItems: 10000 } } } } },
    async (req) => lib.reorderPlaylists(me(req), req.body.ids),
  )

  app.post<{ Body: PlaylistBody & { name: string } }>(
    '/api/playlists',
    { schema: { body: { type: 'object', required: ['name'], properties: playlistProps } } },
    async (req, reply) => reply.code(201).send(lib.createPlaylist(me(req), req.body)),
  )

  app.patch<{ Params: { id: string }; Body: PlaylistBody }>(
    '/api/playlists/:id',
    { schema: { body: { type: 'object', properties: playlistProps } } },
    async (req) => lib.updatePlaylist(me(req), req.params.id, req.body ?? {}),
  )

  app.delete<{ Params: { id: string } }>('/api/playlists/:id', async (req, reply) => {
    await lib.deletePlaylist(me(req), req.params.id)
    return reply.code(204).send()
  })

  // ---- картинки ----

  function imageBody(req: { headers: Record<string, unknown>; body: unknown }): { mime: string; data: Buffer } {
    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    const data = req.body
    if (!(mime in IMAGE_EXT) || !Buffer.isBuffer(data)) throw new HttpError(415, 'unsupported_media_type', 'Картинка: image/jpeg, image/png или image/webp')
    if (!data.length) throw badRequest('Пустое тело запроса')
    if (!looksLikeImage(mime, data)) throw badRequest(`Содержимое не похоже на ${mime}`)
    return { mime, data }
  }

  function coverKind(kind: string): CoverKind {
    if (!COVER_KINDS.has(kind)) throw badRequest('kind: track, album или artist')
    return kind as CoverKind
  }

  type CoverParams = { Params: { kind: string; key: string } }

  app.put<CoverParams>('/api/covers/:kind/:key', async (req, reply) => {
    const { mime, data } = imageBody(req)
    await lib.setCover(me(req), coverKind(req.params.kind), req.params.key, mime, data)
    return reply.code(204).send()
  })
  app.get<CoverParams>('/api/covers/:kind/:key', async (req, reply) => sendCover(req, reply, lib.cover(me(req), coverKind(req.params.kind), req.params.key)))
  app.delete<CoverParams>('/api/covers/:kind/:key', async (req, reply) => {
    await lib.deleteCover(me(req), coverKind(req.params.kind), req.params.key)
    return reply.code(204).send()
  })

  app.put<{ Params: { id: string } }>('/api/playlists/:id/cover', async (req, reply) => {
    const { mime, data } = imageBody(req)
    await lib.setCover(me(req), 'playlist', req.params.id, mime, data)
    return reply.code(204).send()
  })
  app.get<{ Params: { id: string } }>('/api/playlists/:id/cover', async (req, reply) => {
    lib.activePlaylist(me(req), req.params.id)
    return sendCover(req, reply, lib.cover(me(req), 'playlist', req.params.id))
  })
  app.delete<{ Params: { id: string } }>('/api/playlists/:id/cover', async (req, reply) => {
    await lib.deleteCover(me(req), 'playlist', req.params.id)
    return reply.code(204).send()
  })

  // ---- синхронизация ----

  app.get<{ Querystring: { since?: number } }>(
    '/api/changes',
    { schema: { querystring: { type: 'object', properties: { since: { type: 'integer', minimum: 0, default: 0 } } } } },
    async (req) => lib.changes(me(req), req.query.since ?? 0),
  )

  return { app, lib, auth, startScan, node: { id: journal.node, name: () => lib.serverName() } }
}
