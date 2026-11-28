import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import { buildApp } from '../src/app.ts'
import { loadConfig, type Config } from '../src/config.ts'
import type { Library } from '../src/library.ts'

/**
 * Маленький валидный WAV (PCM 8 кГц, моно, 16 бит). seed меняет содержимое → другой sha256.
 * Теги — в RIFF LIST/INFO (INAM — название, IART — исполнитель, IPRD — альбом, ITRK — номер трека).
 * Номер по умолчанию seed + 1: файл без номера сервер переписывает (дописывает номер), и id меняется.
 * trackNo: null — файл без номера.
 */
export function makeWav(
  seed: number,
  tags: { title?: string; artist?: string; album?: string; trackNo?: number | null } = {},
  seconds = 1,
): Buffer {
  const rate = 8000
  const samples = rate * seconds
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin((i * (seed + 1) * 2 * Math.PI) / 80) * 8000), i * 2)

  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0, 'latin1')
  fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(1, 8) // PCM
  fmt.writeUInt16LE(1, 10) // моно
  fmt.writeUInt32LE(rate, 12)
  fmt.writeUInt32LE(rate * 2, 16)
  fmt.writeUInt16LE(2, 20)
  fmt.writeUInt16LE(16, 22)

  const info: Buffer[] = []
  const no = tags.trackNo === undefined ? seed + 1 : tags.trackNo
  for (const [id, v] of [['INAM', tags.title], ['IART', tags.artist], ['IPRD', tags.album], ['ITRK', no === null ? undefined : String(no)]] as const) {
    if (!v) continue
    let data = Buffer.from(`${v}\0`, 'utf8')
    const head = Buffer.alloc(8)
    head.write(id, 0, 'latin1')
    head.writeUInt32LE(data.length, 4)
    if (data.length % 2) data = Buffer.concat([data, Buffer.alloc(1)])
    info.push(head, data)
  }
  let list = Buffer.alloc(0)
  if (info.length) {
    const body = Buffer.concat([Buffer.from('INFO', 'latin1'), ...info])
    const head = Buffer.alloc(8)
    head.write('LIST', 0, 'latin1')
    head.writeUInt32LE(body.length, 4)
    list = Buffer.concat([head, body])
  }

  const dataHead = Buffer.alloc(8)
  dataHead.write('data', 0, 'latin1')
  dataHead.writeUInt32LE(pcm.length, 4)

  const riff = Buffer.alloc(12)
  riff.write('RIFF', 0, 'latin1')
  riff.writeUInt32LE(4 + fmt.length + list.length + dataHead.length + pcm.length, 4)
  riff.write('WAVE', 8, 'latin1')
  return Buffer.concat([riff, fmt, list, dataHead, pcm])
}

// 1×1 PNG
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

export function multipart(filename: string, data: Buffer, field = 'file') {
  const boundary = `----musich${Math.random().toString(16).slice(2)}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, data, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

export interface TestServer {
  app: FastifyInstance
  lib: Library
  cfg: Config
  root: string
  token?: string
  /** id владельца (после входа) */
  ownerId?: string
  /** Куда ложатся загрузки владельца: <MUSIC_DIR>/<логин> */
  uploads: string
  /** inject без автоматического токена — проверять 401 */
  rawInject: FastifyInstance['inject']
  startScan: (folders?: string[]) => Promise<void>
  close(): Promise<void>
}

export const TEST_PASSWORD = 'test-password'
export const TEST_LOGIN = 'tests'

/**
 * Сервер во временной папке. По умолчанию сразу создаёт владельца (логин tests) и подставляет его токен
 * во все app.inject без своего Authorization — так остальные тесты не думают о входе.
 * Токен — от входа с подписью «tests» (ею подписываются загрузки из браузера)
 */
export async function startServer(env: Record<string, string> = {}, opts: { login?: boolean } = {}): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), 'musich-test-'))
  const cfg = loadConfig({ MUSIC_DIR: join(root, 'music'), DATA_DIR: join(root, 'data'), SCAN_ON_START: 'false', ...env })
  const { app, lib, startScan } = await buildApp(cfg, { logger: false })
  await app.ready()
  const rawInject = app.inject.bind(app) as FastifyInstance['inject']
  let token: string | undefined
  let ownerId: string | undefined
  if (opts.login ?? true) {
    await rawInject({ method: 'POST', url: '/api/auth/setup', payload: { login: TEST_LOGIN, password: TEST_PASSWORD } })
    const res = await rawInject({ method: 'POST', url: '/api/auth/login', payload: { login: TEST_LOGIN, password: TEST_PASSWORD, name: 'tests' } })
    token = res.json().token as string
    ownerId = res.json().user.id as string
    await mkdir(join(cfg.musicDir, TEST_LOGIN), { recursive: true })
    const withToken = (o: InjectOptions | string): InjectOptions => {
      const req = typeof o === 'string' ? { url: o } : o
      const headers = (req.headers ?? {}) as Record<string, unknown>
      return 'authorization' in headers ? req : { ...req, headers: { ...headers, authorization: `Bearer ${token}` } }
    }
    ;(app as unknown as { inject: (o: InjectOptions | string) => unknown }).inject = (o) => rawInject(withToken(o))
  }
  return {
    app,
    lib,
    cfg,
    root,
    token,
    ownerId,
    uploads: join(cfg.musicDir, TEST_LOGIN),
    rawInject,
    startScan,
    async close() {
      await app.close()
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

export interface TestUser {
  id: string
  login: string
  token: string
  /** inject с токеном этого пользователя */
  inject: (o: InjectOptions | string) => Promise<LightMyRequestResponse>
}

/** Ещё один пользователь: владелец открывает регистрацию, пользователь регистрируется */
export async function addUser(s: TestServer, login: string, password = 'user-password'): Promise<TestUser> {
  await s.app.inject({ method: 'PATCH', url: '/api/server/settings', payload: { registration: true } })
  const res = await s.rawInject({ method: 'POST', url: '/api/auth/register', payload: { login, password, name: login } })
  if (res.statusCode !== 201) throw new Error(`регистрация ${login}: ${res.statusCode} ${res.body}`)
  const { token, user } = res.json() as { token: string; user: { id: string } }
  const inject = (o: InjectOptions | string) => {
    const req = typeof o === 'string' ? { url: o } : o
    return s.rawInject({ ...req, headers: { ...(req.headers ?? {}), authorization: `Bearer ${token}` } }) as Promise<LightMyRequestResponse>
  }
  return { id: user.id, login, token, inject }
}
