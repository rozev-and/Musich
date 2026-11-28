import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { makeWav, multipart, startServer, type TestServer } from './helpers.ts'

// «Экосистема» на странице «Сервер»: устройства сообщают о себе при отметке, сервер собирает всё в один ответ
describe('экосистема', () => {
  let s: TestServer
  before(async () => {
    s = await startServer()
    await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Eco - One.wav', makeWav(5, { title: 'One', artist: 'Eco' })) })
  })
  after(() => s.close())

  test('отметка со сведениями — видна в /api/ecosystem вместе с треками на сервере', async () => {
    const dev = (await s.app.inject({ method: 'POST', url: '/api/devices', payload: { name: 'Pixel', kind: 'phone', hwId: 'hw-eco-1' } })).json() as { id: string }
    const info = { client: 'app', version: '0.1.0', tracks: 12, bytes: 120_000_000, free: 5e9, total: 64e9, route: 'home', playing: 'Eco — One' }
    const seen = await s.app.inject({ method: 'POST', url: `/api/devices/${dev.id}/seen`, payload: { pendingUp: 1, pendingDown: 2, info } })
    assert.equal(seen.statusCode, 200)
    const eco = (await s.app.inject('/api/ecosystem')).json() as {
      server: { version: string; disk: { free: number; total: number } | null }
      users: { me: boolean; tracks: number; devices: { id: string; pendingDown: number; info?: typeof info }[] }[]
    }
    assert.ok(eco.server.version)
    const mine = eco.users.find((u) => u.me)!
    assert.equal(mine.tracks, 1)
    const d = mine.devices.find((x) => x.id === dev.id)!
    assert.equal(d.pendingDown, 2)
    assert.deepEqual(d.info, info)
  })

  test('мусор в сведениях не принимается, лишние поля не сохраняются', async () => {
    const dev = (await s.app.inject({ method: 'POST', url: '/api/devices', payload: { name: 'Web', kind: 'desktop', hwId: 'hw-eco-2' } })).json() as { id: string }
    const bad = await s.app.inject({ method: 'POST', url: `/api/devices/${dev.id}/seen`, payload: { info: { route: 'mars' } } })
    assert.equal(bad.statusCode, 400)
    const extra = await s.app.inject({ method: 'POST', url: `/api/devices/${dev.id}/seen`, payload: { info: { client: 'web', secret: 'x' } } })
    assert.equal(extra.statusCode, 200)
    assert.deepEqual(extra.json().info, { client: 'web' })
  })
})
