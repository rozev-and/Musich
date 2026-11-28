import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { startServer, type TestServer } from './helpers.ts'

// Порядок и фильтры «Треков» хранятся в настройках пользователя — одни на ПК и телефоне
describe('вид «Треков» — в настройках аккаунта', () => {
  let s: TestServer
  before(async () => {
    s = await startServer()
  })
  after(() => s.close())

  test('сохраняется, приходит обратно и не ломает остальные настройки', async () => {
    const view = { sort: 'number', desc: true, filter: 'liked', year: 2024, file: 'all' }
    const res = await s.app.inject({ method: 'PATCH', url: '/api/prefs', payload: { tracksView: view } })
    assert.equal(res.statusCode, 200, res.body)
    const prefs = (await s.app.inject('/api/prefs')).json() as { tracksView: unknown; trashDays: number }
    assert.deepEqual(prefs.tracksView, view)
    assert.equal(prefs.trashDays, 30)
    // «без года» и «все годы» тоже проходят
    for (const year of ['none', null]) {
      const r = await s.app.inject({ method: 'PATCH', url: '/api/prefs', payload: { tracksView: { ...view, year } } })
      assert.equal(r.statusCode, 200, r.body)
      // null не превращается в 0 (раньше так пропадала вся музыка за фильтром «0-й год»)
      assert.equal(((await s.app.inject('/api/prefs')).json() as { tracksView: { year: unknown } }).tracksView.year, year)
    }
  })

  test('мусор не принимается', async () => {
    const r = await s.app.inject({ method: 'PATCH', url: '/api/prefs', payload: { tracksView: { sort: 'random', desc: true, filter: 'all', year: null, file: 'all' } } })
    assert.equal(r.statusCode, 400)
  })
})
