import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import type { Playlist, Track } from '../src/library.ts'
import { makeWav, multipart, startServer, type TestServer } from './helpers.ts'

// Метка гибридных часов в формате журнала: «время/счётчик»
const hlc = (ms: number, c = 0) => `${new Date(ms).toISOString()}/${String(c).padStart(6, '0')}`

interface Ev {
  id: string
  node: string
  n: number
  hlc: string
  type: string
  key: string
  field: string
  value?: unknown
  base: string | null
}
const ev = (node: string, n: number, ms: number, type: string, key: string, field: string, value?: unknown): Ev => ({
  id: `${node}:${n}`,
  node,
  n,
  hlc: hlc(ms),
  type,
  key,
  field,
  value,
  base: null,
})

describe('приём событий других узлов (этап 2a)', () => {
  let s: TestServer
  let track: Track
  let server: string
  const phone = 'phone-test-node'
  const push = async (events: Ev[]) => {
    const res = await s.app.inject({ method: 'POST', url: '/api/sync/push', payload: { events } })
    assert.equal(res.statusCode, 200, res.body)
    return res.json() as { stored: number; applied: number; rejected: number; vector: Record<string, number> }
  }
  const getTrack = async () => (await s.app.inject(`/api/tracks/${track.id}`)).json() as Track
  const ownEvents = async () => ((await s.app.inject('/api/sync/hello')).json() as { vector: Record<string, number> }).vector[server] ?? 0

  before(async () => {
    s = await startServer()
    track = (await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Band - Song.wav', makeWav(70, { title: 'Song', artist: 'Band' })) })).json()
    server = ((await s.app.inject('/api/sync/hello')).json() as { node: string }).node
  })
  after(() => s.close())

  test('лайк с телефона применяется, повтор не дублируется, сервер не пишет его как своё', async () => {
    const mine = await ownEvents()
    const r = await push([ev(phone, 1, Date.now(), 'like.set', track.id, 'like', true)])
    assert.deepEqual([r.stored, r.applied, r.rejected], [1, 1, 0])
    assert.equal(r.vector[phone], 1)
    assert.equal((await getTrack()).liked, true)
    // чужое событие не стало своим: у сервера событий столько же
    assert.equal(await ownEvents(), mine)
    // то же событие ещё раз — пропускается
    const again = await push([ev(phone, 1, Date.now(), 'like.set', track.id, 'like', true)])
    assert.deepEqual([again.stored, again.rejected], [0, 0])
  })

  test('пропуск номера и метка из будущего не принимаются', async () => {
    const gap = await push([ev(phone, 5, Date.now(), 'like.set', track.id, 'like', false)])
    assert.deepEqual([gap.stored, gap.rejected], [0, 1])
    const future = await push([ev('phone-clock-broken', 1, Date.now() + 365 * 86_400_000, 'like.set', track.id, 'like', false)])
    assert.deepEqual([future.stored, future.rejected], [0, 1])
    assert.equal((await getTrack()).liked, true)
  })

  test('последняя метка побеждает: старое событие хранится, но не применяется', async () => {
    // на сервере сняли лайк сейчас — позже, чем «снять лайк» с телефона из прошлого
    await s.app.inject({ method: 'PUT', url: `/api/tracks/${track.id}/like`, payload: { liked: false } })
    const old = await push([ev(phone, 2, Date.now() - 86_400_000, 'like.set', track.id, 'like', true)])
    assert.deepEqual([old.stored, old.applied], [1, 0])
    assert.equal((await getTrack()).liked, false)
  })

  test('плейлист, правка названия и прослушивание с телефона', async () => {
    const pid = randomUUID()
    const now = Date.now() + 1000
    const r = await push([
      ev(phone, 3, now, 'playlist.create', pid, 'status', { name: 'С телефона', description: '' }),
      ev(phone, 4, now, 'playlist.add', pid, 'tracks', { track: track.id, after: null }),
      ev(phone, 5, now, 'track.set', track.id, 'title', 'Новое название'),
      ev(phone, 6, now, 'play', track.id, 'play', { at: new Date(now).toISOString(), source: 'Телефон' }),
    ])
    assert.deepEqual([r.stored, r.applied, r.rejected], [4, 4, 0])
    const p = ((await s.app.inject('/api/playlists')).json() as Playlist[]).find((x) => x.id === pid)
    assert.ok(p)
    assert.equal(p.name, 'С телефона')
    assert.deepEqual(p.trackIds, [track.id])
    assert.equal((await getTrack()).title, 'Новое название')
    const plays = (await s.app.inject('/api/plays')).json() as { trackId: string; source?: string }[]
    assert.ok(plays.some((x) => x.trackId === track.id && x.source === 'Телефон'))
  })

  test('принятые события отдаются другим узлам через pull', async () => {
    const res = (await s.app.inject({ method: 'POST', url: '/api/sync/pull', payload: { vector: {} } })).json() as { events: Ev[] }
    const fromPhone = res.events.filter((e) => e.node === phone).map((e) => e.n)
    assert.deepEqual(fromPhone, [1, 2, 3, 4, 5, 6])
  })
})
