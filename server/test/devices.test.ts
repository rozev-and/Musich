import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { Device, Play, Track } from '../src/library.ts'
import { makeWav, multipart, startServer, type TestServer } from './helpers.ts'

describe('устройство узнаётся, а не заводится заново', () => {
  let s: TestServer
  const register = async (payload: Record<string, string>) => {
    const res = await s.app.inject({ method: 'POST', url: '/api/devices', payload })
    assert.equal(res.statusCode, 201, res.body)
    return res.json() as Device
  }
  const list = async () => (await s.app.inject('/api/devices')).json() as Device[]

  before(async () => {
    s = await startServer()
  })
  after(() => s.close())

  test('старые копии без номера сливаются в одну при первом входе с номером', async () => {
    // так телефон плодил записи: каждая установка — новая
    await register({ name: 'Nothing A024', kind: 'phone' })
    await register({ name: 'Nothing A024', kind: 'phone' })
    const last = await register({ name: 'Nothing A024', kind: 'phone' })
    await register({ name: 'Pixel 8', kind: 'phone' })
    assert.equal((await list()).length, 4)

    const dev = await register({ name: 'Nothing A024', kind: 'phone', hwId: 'android-1234' })
    assert.equal(dev.id, last.id) // осталась самая свежая
    const names = (await list()).map((d) => d.name).sort()
    assert.deepEqual(names, ['Nothing A024', 'Pixel 8']) // чужой телефон не тронут
  })

  test('переустановка и повторный вход — та же запись', async () => {
    const a = await register({ name: 'Nothing A024', kind: 'phone', hwId: 'android-1234' })
    const b = await register({ name: 'Nothing Phone', kind: 'phone', hwId: 'android-1234' })
    assert.equal(a.id, b.id)
    assert.equal(b.name, 'Nothing Phone') // имя обновилось
    // без номера, но с запомненным id — тоже узнаём
    const c = await register({ name: 'Nothing Phone', kind: 'phone', id: a.id })
    assert.equal(c.id, a.id)
    assert.equal((await list()).length, 2)
  })

  test('чужой id с другим номером не забирается', async () => {
    const mine = (await list()).find((d) => d.name === 'Nothing Phone')!
    const other = await register({ name: 'Nothing Phone', kind: 'phone', hwId: 'android-9999', id: mine.id })
    assert.notEqual(other.id, mine.id)
    assert.equal((await list()).length, 3)
  })
})

describe('история: одно прослушивание не записывается дважды', () => {
  let s: TestServer
  let track: Track
  before(async () => {
    s = await startServer()
    track = (await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Band - Song.wav', makeWav(70, { title: 'Song', artist: 'Band' })) })).json()
  })
  after(() => s.close())

  test('повтор с тем же временем пропускается, другое время — новое прослушивание', async () => {
    const at = new Date(Date.now() - 60_000).toISOString()
    const play = (when: string) => s.app.inject({ method: 'POST', url: '/api/plays', payload: { trackId: track.id, at: when } })
    assert.equal((await play(at)).statusCode, 201)
    const again = await play(at)
    assert.equal((again.json() as Play).playedAt, at)
    await play(new Date(Date.now() - 30_000).toISOString())
    const plays = (await s.app.inject('/api/plays')).json() as Play[]
    assert.equal(plays.filter((p) => p.trackId === track.id).length, 2)
  })
})
