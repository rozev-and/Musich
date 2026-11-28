// Фейковый сервер MUSICH в памяти: ровно та часть docs/API.md, которой пользуется musich-sync,
// плюс управляемые сбои (обрыв соединения, 500, обрыв посреди файла).
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import type { Track } from '../src/api.js'

type FaultKind = 'reset' | '500' | 'cut'
interface Fault {
  method: string
  path: RegExp
  kind: FaultKind
  times: number
}

export interface LoggedRequest {
  method: string
  path: string
  range?: string
}

export class FakeServer {
  readonly tracks = new Map<string, { track: Track; data?: Buffer }>()
  readonly devices = new Map<string, { id: string; name: string; kind: string; lastSeenAt: string }>()
  readonly requests: LoggedRequest[] = []
  private faults: Fault[] = []
  private seq = 0
  private server = http.createServer((req, res) => void this.handle(req, res))
  url = ''

  constructor(readonly token?: string) {}

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    const { port } = this.server.address() as AddressInfo
    this.url = `http://127.0.0.1:${port}`
    return this
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((r) => this.server.close(() => r()))
  }

  /** Следующие `times` запросов method+path сломать. */
  fail(method: string, pathRe: RegExp, kind: FaultKind, times = 1): void {
    this.faults.push({ method, path: pathRe, kind, times })
  }

  clearFaults(): void {
    this.faults = []
  }

  count(method: string, pathRe: RegExp): number {
    return this.requests.filter((r) => r.method === method && pathRe.test(r.path)).length
  }

  /** Трек «с другого устройства». Артист и название берём из «Артист - Название.ext». */
  addTrack(fileName: string, data: Buffer): Track {
    return this.store(fileName, data).track
  }

  /** То, что делает DELETE /tracks/:id: надгробие + удаление файла. */
  tombstone(id: string): void {
    const entry = this.tracks.get(id)
    if (!entry) throw new Error(`нет трека ${id}`)
    entry.track = { ...entry.track, status: 'deleted', seq: ++this.seq }
    delete entry.data
  }

  private store(fileName: string, data: Buffer): { track: Track; created: boolean } {
    const id = createHash('sha256').update(data).digest('hex').slice(0, 16)
    const existing = this.tracks.get(id)
    if (existing?.track.status === 'available') return { track: existing.track, created: false }
    // Не path.parse: в «AC/DC - …» слэш — часть имени артиста, а не папка.
    const dot = fileName.lastIndexOf('.')
    const name = dot > 0 ? fileName.slice(0, dot) : fileName
    const ext = dot > 0 ? fileName.slice(dot) : ''
    const [artist, title] = name.includes(' - ') ? name.split(' - ', 2) : ['', name]
    const track: Track = {
      id,
      title: title ?? name,
      artist: artist ?? '',
      album: title ?? name,
      duration: 180,
      size: data.length,
      format: ext.slice(1).toLowerCase(),
      fileName,
      hasCover: false,
      liked: false,
      addedAt: new Date().toISOString(),
      status: 'available',
      seq: ++this.seq,
    }
    this.tracks.set(id, { track, data })
    return { track, created: true }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x')
    const method = req.method ?? 'GET'
    this.requests.push({ method, path: url.pathname, range: req.headers.range })

    const fault = this.faults.find((f) => f.method === method && f.path.test(url.pathname) && f.times > 0)
    if (fault) {
      fault.times--
      if (fault.kind === 'reset') return void req.socket.destroy()
      if (fault.kind === '500') return this.send(res, 500, { error: 'internal', message: 'fake failure' })
    }

    const send = (status: number, body?: unknown) => this.send(res, status, body)
    if (this.token && url.pathname !== '/api/health' && req.headers.authorization !== `Bearer ${this.token}`) {
      return send(401, { error: 'unauthorized', message: 'bad token' })
    }

    const p = url.pathname
    let m: RegExpMatchArray | null
    if (method === 'GET' && p === '/api/health') return send(200, { ok: true, version: 'fake' })

    if (method === 'POST' && p === '/api/devices') {
      const body = JSON.parse((await readBody(req)).toString('utf8')) as { name: string; kind: string }
      const device = { id: randomUUID(), name: body.name, kind: body.kind, lastSeenAt: new Date().toISOString() }
      this.devices.set(device.id, device)
      return send(201, device)
    }
    if (method === 'POST' && (m = p.match(/^\/api\/devices\/([^/]+)\/seen$/))) {
      const device = this.devices.get(decodeURIComponent(m[1]!))
      if (!device) return send(404, { error: 'not_found', message: 'no device' })
      device.lastSeenAt = new Date().toISOString()
      return send(204)
    }

    if (method === 'HEAD' && (m = p.match(/^\/api\/tracks\/by-hash\/([^/]+)$/))) {
      res.statusCode = this.tracks.get(m[1]!)?.track.status === 'available' ? 200 : 404
      return void res.end()
    }
    if (method === 'POST' && p === '/api/tracks') {
      const body = await readBody(req)
      const form = await new Request('http://x/', {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] ?? '' },
        body: new Uint8Array(body),
      }).formData()
      const file = form.get('file')
      if (!(file instanceof Blob)) return send(400, { error: 'bad_request', message: 'no file field' })
      const name = (file as File).name || 'upload.bin'
      const { track, created } = this.store(name, Buffer.from(await file.arrayBuffer()))
      return send(created ? 201 : 200, track)
    }
    if (method === 'GET' && (m = p.match(/^\/api\/tracks\/([^/]+)$/))) {
      const entry = this.tracks.get(m[1]!)
      return entry ? send(200, entry.track) : send(404, { error: 'not_found', message: 'no track' })
    }
    if (method === 'DELETE' && (m = p.match(/^\/api\/tracks\/([^/]+)$/))) {
      const entry = this.tracks.get(m[1]!)
      if (!entry || entry.track.status === 'deleted') return send(404, { error: 'not_found', message: 'no track' })
      this.tombstone(m[1]!)
      return send(204)
    }
    if (method === 'GET' && (m = p.match(/^\/api\/tracks\/([^/]+)\/file$/))) {
      const data = this.tracks.get(m[1]!)?.data
      if (!data) return send(404, { error: 'not_found', message: 'no file' })
      return this.sendFile(req, res, data, fault?.kind === 'cut')
    }
    if (method === 'GET' && p === '/api/changes') {
      const since = Number(url.searchParams.get('since') ?? 0)
      const tracks = [...this.tracks.values()].map((e) => e.track).filter((t) => t.seq > since)
      const cursor = tracks.reduce((max, t) => Math.max(max, t.seq), since)
      return send(200, { cursor, tracks, playlists: [], covers: [] })
    }
    return send(404, { error: 'not_found', message: `${method} ${p}` })
  }

  private sendFile(req: http.IncomingMessage, res: http.ServerResponse, data: Buffer, cut: boolean): void {
    let start = 0
    let end = data.length - 1
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/)
    if (range) {
      start = Number(range[1])
      if (range[2]) end = Math.min(Number(range[2]), end)
      if (start > end) {
        res.writeHead(416, { 'content-range': `bytes */${data.length}` })
        return void res.end()
      }
    }
    const chunk = data.subarray(start, end + 1)
    res.writeHead(range ? 206 : 200, {
      'content-type': 'audio/mpeg',
      'content-length': chunk.length,
      'accept-ranges': 'bytes',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${data.length}` } : {}),
    })
    if (cut) {
      // Отдаём половину и рвём соединение — как пропавший Wi-Fi.
      // Пауза перед обрывом — чтобы клиент успел записать полученное (ошибка веб-потока выбрасывает очередь).
      res.write(chunk.subarray(0, Math.floor(chunk.length / 2)), () => setTimeout(() => res.socket?.destroy(), 150))
      return
    }
    res.end(chunk)
  }

  private send(res: http.ServerResponse, status: number, body?: unknown): void {
    if (body === undefined) {
      res.statusCode = status
      return void res.end()
    }
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
