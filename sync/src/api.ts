// HTTP-клиент к серверу MUSICH (docs/API.md) с повторами при сетевых ошибках.
import { createWriteStream, promises as fs, openAsBlob } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeWebStream } from 'node:stream/web'
import type { DeviceKind } from './store.js'
import type { Log } from './log.js'

export type TrackStatus = 'available' | 'deleted'

export interface Track {
  id: string
  hash?: string // отпечаток файла (меняется при прошивке тегов на сервере; id — нет)
  title: string
  artist: string
  album: string
  year?: number
  duration: number
  size: number
  format: string
  fileName: string
  hasCover: boolean
  liked: boolean
  likedAt?: string
  addedAt: string
  status: TrackStatus
  seq: number
}

export interface Changes {
  cursor: number
  tracks: Track[]
  playlists: unknown[]
  covers: unknown[]
}

export interface Device {
  id: string
  name: string
  kind: DeviceKind
  lastSeenAt: string
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly body: string,
  ) {
    let detail = body
    try {
      const parsed = JSON.parse(body) as { error?: string; message?: string }
      detail = parsed.message || parsed.error || body
    } catch {
      // не JSON — оставляем как есть
    }
    super(`${method} ${url} → ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    this.name = 'HttpError'
  }

  get retryable(): boolean {
    return this.status >= 500 || this.status === 408 || this.status === 429
  }
}

// Ошибки локального диска повторять бессмысленно.
const LOCAL_FS_CODES = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EISDIR', 'ENOTDIR', 'EEXIST', 'ENAMETOOLONG'])

export function isRetryable(e: unknown): boolean {
  if (e instanceof HttpError) return e.retryable
  if (e instanceof IntegrityError) return false
  const code = (e as NodeJS.ErrnoException | undefined)?.code
  return !(code && LOCAL_FS_CODES.has(code))
}

export class IntegrityError extends Error {
  override name = 'IntegrityError'
}

/** Короткое описание ошибки fetch: у undici настоящая причина лежит в cause. */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const cause = (e as { cause?: unknown }).cause
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code
    return `${e.message} (${code ?? cause.message})`
  }
  return e.message
}

export interface ApiOptions {
  server: string
  token?: string
  /** id этого устройства на сервере: по нему сервер подписывает, откуда пришёл трек */
  deviceId?: string
  retries: number
  retryDelayMs: number
  log: Log
  /** Таймаут на один JSON-запрос, мс. */
  timeoutMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Api {
  private readonly base: string

  constructor(private readonly opts: ApiOptions) {
    this.base = opts.server.replace(/\/+$/, '') + '/api'
  }

  /** Повторяет fn при сетевых ошибках и 5xx/408/429 с экспоненциальной паузой. */
  async retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const { retries, retryDelayMs, log } = this.opts
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn()
      } catch (e) {
        if (attempt >= retries || !isRetryable(e)) throw e
        const delay = Math.min(retryDelayMs * 2 ** attempt, 30_000) * (0.75 + Math.random() * 0.5)
        log.warn(`${label}: ${describeError(e)}; повтор ${attempt + 1}/${retries} через ${Math.round(delay)} мс`)
        await sleep(delay)
      }
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra }
    if (this.opts.token) h.authorization = `Bearer ${this.opts.token}`
    if (this.opts.deviceId) h['x-musich-device'] = this.opts.deviceId
    return h
  }

  private async request(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
    const url = this.base + path
    const res = await fetch(url, {
      method,
      body: init.body,
      headers: this.headers(init.headers),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
    })
    return { url, res }
  }

  private async json<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> {
    return this.retry(`${method} ${path}`, async () => {
      const { url, res } = await this.request(method, path, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
      })
      const text = await res.text()
      if (!res.ok && !okStatuses.includes(res.status)) throw new HttpError(res.status, method, url, text)
      return (text ? JSON.parse(text) : undefined) as T
    })
  }

  health(): Promise<{ ok: boolean; version?: string }> {
    return this.json('GET', '/health')
  }

  registerDevice(name: string, kind: DeviceKind): Promise<Device> {
    return this.json('POST', '/devices', { name, kind })
  }

  async seen(deviceId: string): Promise<void> {
    await this.json('POST', `/devices/${encodeURIComponent(deviceId)}/seen`)
  }

  changes(since: number): Promise<Changes> {
    return this.json('GET', `/changes?since=${since}`)
  }

  /** GET /tracks/:id, undefined если 404. */
  async getTrack(id: string): Promise<Track | undefined> {
    try {
      return await this.json<Track>('GET', `/tracks/${encodeURIComponent(id)}`)
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return undefined
      throw e
    }
  }

  /** GET /tracks/by-hash/:hash — чей это файл (по любому отпечатку из истории трека); нет — undefined. */
  async trackByHash(hash: string): Promise<Track | undefined> {
    try {
      return await this.json<Track>('GET', `/tracks/by-hash/${encodeURIComponent(hash)}`)
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return undefined
      throw e
    }
  }

  /** HEAD /tracks/by-hash/:id — есть ли уже такой трек в хранилище. */
  hasTrack(id: string): Promise<boolean> {
    const path = `/tracks/by-hash/${encodeURIComponent(id)}`
    return this.retry(`HEAD ${path}`, async () => {
      const { url, res } = await this.request('HEAD', path)
      await res.body?.cancel()
      if (res.status === 200 || res.status === 204) return true
      if (res.status === 404) return false
      throw new HttpError(res.status, 'HEAD', url, '')
    })
  }

  /** POST /tracks multipart, поле file. Файл читается с диска потоком, а не целиком в память. */
  uploadTrack(filePath: string, fileName: string): Promise<{ track: Track; created: boolean }> {
    return this.retry(`POST /tracks ${fileName}`, async () => {
      const form = new FormData()
      form.append('file', await openAsBlob(filePath), fileName)
      const { url, res } = await this.request('POST', '/tracks', { body: form })
      const text = await res.text()
      if (!res.ok) throw new HttpError(res.status, 'POST', url, text)
      return { track: JSON.parse(text) as Track, created: res.status === 201 }
    })
  }

  async deleteTrack(id: string): Promise<void> {
    await this.json('DELETE', `/tracks/${encodeURIComponent(id)}`, undefined, [404])
  }

  /**
   * GET /tracks/:id/file в файл dest. Если после обрыва dest уже частично скачан —
   * докачивает с помощью Range, сервер отвечает 206.
   */
  download(id: string, dest: string): Promise<void> {
    const path = `/tracks/${encodeURIComponent(id)}/file`
    return this.retry(`GET ${path}`, async () => {
      const have = await fs.stat(dest).then((s) => s.size, () => 0)
      const url = this.base + path
      const res = await fetch(url, { headers: this.headers(have > 0 ? { range: `bytes=${have}-` } : {}) })
      if (res.status === 416) {
        // Частичный файл не сходится с серверным — начинаем заново.
        await res.body?.cancel()
        await fs.rm(dest, { force: true })
        throw new HttpError(503, 'GET', url, 'range not satisfiable, restarting download')
      }
      if (!res.ok) throw new HttpError(res.status, 'GET', url, await res.text())
      if (!res.body) throw new Error(`GET ${url}: пустое тело`)
      const append = res.status === 206 && have > 0
      await pipeline(
        Readable.fromWeb(res.body as unknown as NodeWebStream<Uint8Array>),
        createWriteStream(dest, { flags: append ? 'a' : 'w' }),
      )
    })
  }
}
