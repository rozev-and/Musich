import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import type { Track } from '../src/library.ts'
import { totpCode } from '../src/security.ts'
import { makeWav, multipart, PNG, startServer, TEST_LOGIN, TEST_PASSWORD, type TestServer } from './helpers.ts'

// Безопасность: заголовки, медиа-ключ вместо ключа входа в адресах, сброс входов, двухэтапный вход, бэкап с паролем
describe('безопасность', () => {
  let s: TestServer
  let track: Track
  before(async () => {
    s = await startServer()
    track = (await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Sec - One.wav', makeWav(9, { title: 'One', artist: 'Sec' })) })).json() as Track
    await s.app.inject({ method: 'PUT', url: `/api/covers/track/${track.id}`, payload: PNG, headers: { 'content-type': 'image/png' } })
  })
  after(() => s.close())

  const login = async (extra: Record<string, string> = {}) =>
    s.rawInject({ method: 'POST', url: '/api/auth/login', payload: { login: TEST_LOGIN, password: TEST_PASSWORD, ...extra } })

  test('заголовки безопасности на каждом ответе', async () => {
    const r = await s.rawInject('/api/health')
    assert.match(String(r.headers['content-security-policy']), /script-src 'self'/)
    assert.equal(r.headers['x-content-type-options'], 'nosniff')
    assert.equal(r.headers['x-frame-options'], 'DENY')
    assert.equal(r.headers['referrer-policy'], 'no-referrer')
  })

  test('большие ответы JSON сжимаются gzip, если клиент умеет; мелкие — нет', async () => {
    for (let i = 0; i < 8; i++) await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart(`Gz - Song ${i}.wav`, makeWav(20 + i, { title: `Song ${i}`, artist: 'Gz' })) })
    const plain = await s.app.inject('/api/changes?since=0')
    assert.ok(plain.body.length > 2048)
    assert.equal(plain.headers['content-encoding'], undefined)
    const gz = await s.app.inject({ url: '/api/changes?since=0', headers: { 'accept-encoding': 'gzip, deflate, br' } })
    assert.equal(gz.headers['content-encoding'], 'gzip')
    assert.deepEqual(JSON.parse(gunzipSync(gz.rawPayload).toString()), plain.json())
    const small = await s.app.inject({ url: '/api/health', headers: { 'accept-encoding': 'gzip' } })
    assert.equal(small.headers['content-encoding'], undefined)
  })

  test('медиа-ключ: открывает только файлы и обложки; «выйти везде» его отзывает', async () => {
    const { key } = (await s.app.inject('/api/auth/media-key')).json() as { key: string }
    assert.equal((await s.rawInject(`/api/tracks/${track.id}/file?mk=${key}`)).statusCode, 200)
    assert.equal((await s.rawInject(`/api/tracks/${track.id}/cover?mk=${key}`)).statusCode, 200)
    // на API данных — нет
    assert.equal((await s.rawInject(`/api/tracks?mk=${key}`)).statusCode, 401)
    assert.equal((await s.rawInject({ method: 'DELETE', url: `/api/tracks/${track.id}/file?mk=${key}` })).statusCode !== 204, true)
    // подделка
    assert.equal((await s.rawInject(`/api/tracks/${track.id}/file?mk=${key.slice(0, -2)}xx`)).statusCode, 401)
    // второй вход, потом «выйти везде» с первого: второй вход и медиа-ключ больше не действуют
    const other = (await login()).json().token as string
    const r = await s.app.inject({ method: 'POST', url: '/api/auth/logout-all' })
    assert.equal(r.statusCode, 200)
    assert.equal((await s.rawInject({ url: '/api/tracks', headers: { authorization: `Bearer ${other}` } })).statusCode, 401)
    assert.equal((await s.rawInject(`/api/tracks/${track.id}/file?mk=${key}`)).statusCode, 401)
    assert.equal((await s.app.inject('/api/tracks')).statusCode, 200) // свой вход остался
  })

  test('двухэтапный вход: без кода — «нужен код», с кодом и запасным кодом — пускает', async () => {
    const { secret } = (await s.app.inject({ method: 'POST', url: '/api/auth/2fa/setup' })).json() as { secret: string }
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/auth/2fa/enable', payload: { code: '000000' } })).statusCode, 400)
    const en = await s.app.inject({ method: 'POST', url: '/api/auth/2fa/enable', payload: { code: totpCode(secret) } })
    assert.equal(en.statusCode, 200, en.body)
    const { recovery } = en.json() as { recovery: string[] }
    assert.equal(recovery.length, 8)

    const noCode = await login()
    assert.equal(noCode.statusCode, 401)
    assert.equal(noCode.json().error, 'totp_required')
    assert.equal((await login({ code: '123456' })).json().error, 'totp_wrong')
    // следующий шаг (текущий код уже потрачен на включение)
    assert.equal((await login({ code: totpCode(secret, Date.now(), 1) })).statusCode, 200)
    // запасной код — один раз
    assert.equal((await login({ code: recovery[0] })).statusCode, 200)
    assert.equal((await login({ code: recovery[0] })).statusCode, 401)

    // выключить — только с паролем
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/auth/2fa/disable', payload: { password: 'wrong-password' } })).statusCode, 403)
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/auth/2fa/disable', payload: { password: TEST_PASSWORD } })).statusCode, 200)
    assert.equal((await login()).statusCode, 200)
  })

  test('бэкап с паролем зашифрован; при восстановлении нужен верный пароль', async () => {
    const r = await s.app.inject({ method: 'POST', url: '/api/backup', payload: { password: 'secret-pass' } })
    assert.equal(r.statusCode, 200)
    assert.equal(r.rawPayload.subarray(0, 10).toString(), 'MUSICHENC1')
    assert.ok(!r.rawPayload.includes(Buffer.from('SQLite format 3')))
    const form = (pw: string) => {
      const b = '----musich'
      const body = Buffer.concat([
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="password"\r\n\r\n${pw}\r\n`),
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="b.musich"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        r.rawPayload,
        Buffer.from(`\r\n--${b}--\r\n`),
      ])
      return { payload: body, headers: { 'content-type': `multipart/form-data; boundary=${b}` } }
    }
    const bad = await s.app.inject({ method: 'POST', url: '/api/backup/restore', ...form('wrong') })
    assert.equal(bad.statusCode, 400)
    assert.equal(bad.json().error, 'password_wrong')
  })
})
