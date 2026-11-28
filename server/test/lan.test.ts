import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { startServer, type TestServer } from './helpers.ts'

// Дома — напрямую, вне дома — по домену: откуда сервер берёт свои домашние адреса для /api/health
describe('адрес в домашней сети', () => {
  let s: TestServer
  before(async () => {
    s = await startServer()
  })
  after(() => s.close())

  const lan = async () => ((await s.rawInject('/api/health')).json() as { lan: string[] }).lan

  test('открыли по домашнему адресу — сервер его запомнил; через прокси и по домену — нет; без входа — нет', async () => {
    await s.rawInject({ url: '/api/health', headers: { host: '192.168.1.66:2290' } })
    assert.ok(!(await lan()).includes('http://192.168.1.66:2290'))
    await s.app.inject({ url: '/api/health', headers: { host: '192.168.1.50:2290' } })
    assert.equal((await lan())[0], 'http://192.168.1.50:2290')
    await s.app.inject({ url: '/api/health', headers: { host: '192.168.1.77:2290', 'x-forwarded-for': '1.2.3.4' } })
    await s.app.inject({ url: '/api/health', headers: { host: 'music.example.com' } })
    const l = await lan()
    assert.ok(!l.includes('http://192.168.1.77:2290'))
    assert.ok(!l.some((u) => u.includes('example.com')))
  })

  test('домен запоминается по https-запросам через прокси от вошедших', async () => {
    const pub = async () => ((await s.rawInject('/api/health')).json() as { public: string | null }).public
    await s.rawInject({ url: '/api/health', headers: { host: 'evil.example.com', 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' } })
    assert.equal(await pub(), null)
    await s.app.inject({ url: '/api/health', headers: { host: 'music.example.com', 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'http' } })
    assert.equal(await pub(), null)
    await s.app.inject({ url: '/api/health', headers: { host: 'music.example.com', 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' } })
    assert.equal(await pub(), 'https://music.example.com')
  })

  test('адрес из настроек — первым; без порта — порт сервера; мусор не принимается; пустой — сброс', async () => {
    const put = (manual: string) => s.app.inject({ method: 'PUT', url: '/api/server/lan', payload: { manual } })
    const r = await put('10.0.0.5')
    assert.equal(r.statusCode, 200)
    assert.equal(r.json().manual, 'http://10.0.0.5:2290')
    assert.equal((await lan())[0], 'http://10.0.0.5:2290')
    assert.equal((await put('http://10.0.0.5/path')).statusCode, 400)
    assert.equal((await put('a b c')).statusCode, 400)
    const got = (await s.app.inject('/api/server/lan')).json() as { manual: string; found: string[] }
    assert.equal(got.manual, 'http://10.0.0.5:2290')
    assert.ok(got.found.includes('http://192.168.1.50:2290'))
    await put('')
    assert.notEqual((await lan())[0], 'http://10.0.0.5:2290')
  })
})
