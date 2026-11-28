import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { startServer, type TestServer } from './helpers.ts'

// Telegram: без сети — только настройки и проверки до входа (сам вход и импорт ходят в Telegram)
describe('Telegram', () => {
  let s: TestServer
  before(async () => {
    s = await startServer()
  })
  after(() => s.close())

  test('статус, ключи приложения и отказ без входа', async () => {
    assert.deepEqual((await s.app.inject('/api/integrations/telegram')).json(), { configured: false, connected: false, imported: 0 })
    // кривые ключи не сохраняются
    const bad = await s.app.inject({ method: 'PUT', url: '/api/integrations/telegram/config', payload: { apiId: 'abc', apiHash: 'x' } })
    assert.equal(bad.statusCode, 400)
    const ok = await s.app.inject({ method: 'PUT', url: '/api/integrations/telegram/config', payload: { apiId: '12345', apiHash: 'A'.repeat(32) } })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.json().configured, true)
    assert.equal(ok.json().connected, false)
    // без входа забрать музыку нельзя, код без начатого входа — тоже
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/integrations/telegram/import' })).statusCode, 400)
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/integrations/telegram/signin', payload: { code: '12345' } })).statusCode, 400)
    // «Отключить» без входа — просто ничего не делает, ключи остаются
    assert.equal((await s.app.inject({ method: 'DELETE', url: '/api/integrations/telegram' })).statusCode, 204)
    assert.equal((await s.app.inject('/api/integrations/telegram')).json().configured, true)
    // другие интеграции на месте: /:service не перехватывает telegram
    assert.equal((await s.app.inject('/api/integrations')).statusCode, 200)
  })
})
