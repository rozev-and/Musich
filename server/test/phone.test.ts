import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import type { Track } from '../src/library.ts'
import { makeWav, multipart, startServer, type TestServer } from './helpers.ts'

// Как шлёт телефон (web/src/lib/node/journal.ts): «ISO/счётчик», id «узел:номер»
const hlc = (ms: number, c = 0) => `${new Date(ms).toISOString()}/${String(c).padStart(6, '0')}`

describe('автономный телефон привязали: его журнал становится общей библиотекой', () => {
  let s: TestServer
  let track: Track
  const node = `phone-${randomUUID()}`
  let n = 0
  const ev = (type: string, key: string, field: string, value?: unknown) => {
    n++
    return { id: `${node}:${n}`, node, n, hlc: hlc(Date.now() - 1000 + n, 0), type, key, field, value, base: null }
  }

  before(async () => {
    s = await startServer()
    // файл, добавленный на телефоне, ушёл на сервер первым — у трека серверный id
    track = (await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Band - Phone.wav', makeWav(70, { title: 'Phone', artist: 'Band' })) })).json()
  })
  after(() => s.close())

  test('лайк, свой плейлист и трек в нём — видны в /changes; повтор не дублирует', async () => {
    const pid = randomUUID()
    const events = [
      ev('like.set', track.id, 'like', true),
      ev('playlist.create', pid, 'status', { name: 'С телефона', description: '' }),
      ev('playlist.add', pid, 'tracks', { track: track.id, after: null }),
      ev('playlist.set', pid, 'name', 'В дорогу'),
    ]
    const r = await s.app.inject({ method: 'POST', url: '/api/sync/push', payload: { events } })
    assert.equal(r.statusCode, 200, r.body)
    const body = r.json() as { stored: number; rejected: number; vector: Record<string, number> }
    assert.equal(body.stored, 4)
    assert.equal(body.rejected, 0)
    assert.equal(body.vector[node], 4) // телефон убирает из журнала всё до этого номера

    const ch = (await s.app.inject('/api/changes?since=0')).json() as {
      tracks: { id: string; liked: boolean }[]
      playlists: { id: string; name: string; trackIds: string[]; deleted: boolean }[]
    }
    assert.equal(ch.tracks.find((x) => x.id === track.id)?.liked, true)
    const pl = ch.playlists.find((p) => p.id === pid)
    assert.ok(pl && !pl.deleted)
    assert.equal(pl.name, 'В дорогу')
    assert.deepEqual(pl.trackIds, [track.id])

    // связь оборвалась после записи — телефон шлёт то же ещё раз
    const again = (await s.app.inject({ method: 'POST', url: '/api/sync/push', payload: { events } })).json() as { stored: number; rejected: number }
    assert.deepEqual([again.stored, again.rejected], [0, 0])
  })

  test('новый узел после «сервер нас не помнит» начинает с 1', async () => {
    const fresh = `phone-${randomUUID()}`
    const e = { id: `${fresh}:1`, node: fresh, n: 1, hlc: hlc(Date.now()), type: 'like.set', key: track.id, field: 'like', value: false, base: null }
    const r = (await s.app.inject({ method: 'POST', url: '/api/sync/push', payload: { events: [e] } })).json() as { stored: number; vector: Record<string, number> }
    assert.equal(r.stored, 1)
    assert.equal(r.vector[fresh], 1)
  })
})
