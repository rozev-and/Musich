import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { Playlist, Track } from '../src/library.ts'
import { addUser, makeWav, multipart, startServer, type TestServer, type TestUser } from './helpers.ts'

// Общие плейлисты: хозяин делится, получатель видит список и что из него есть у него
describe('общие плейлисты', () => {
  let s: TestServer
  let bob: TestUser
  before(async () => {
    s = await startServer()
    bob = await addUser(s, 'bob')
  })
  after(() => s.close())

  test('поделиться → получатель видит; совпадения по «артист — название»', async () => {
    const a = (await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Sh - One.wav', makeWav(3, { title: 'One', artist: 'Sh' })) })).json() as Track
    const b = (await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Sh - Two.wav', makeWav(4, { title: 'Two', artist: 'Sh' })) })).json() as Track
    const pl = (await s.app.inject({ method: 'POST', url: '/api/playlists', payload: { name: 'Mix', trackIds: [a.id, b.id] } })).json() as Playlist
    // у bob есть только «Sh — Two», своим файлом
    const bt = (await bob.inject({ method: 'POST', url: '/api/tracks', ...multipart('two.wav', makeWav(5, { title: 'Two', artist: 'SH' })) })).json() as Track

    const dir = (await s.app.inject('/api/users/directory')).json() as { id: string }[]
    assert.ok(dir.some((u) => u.id === bob.id))
    const put = await s.app.inject({ method: 'PUT', url: `/api/playlists/${pl.id}/shares`, payload: { userIds: [bob.id] } })
    assert.deepEqual(put.json(), { userIds: [bob.id] })
    assert.deepEqual((await s.app.inject(`/api/playlists/${pl.id}/shares`)).json(), { userIds: [bob.id] })

    const got = (await bob.inject('/api/shared')).json() as { name: string; items: { title: string; trackId?: string }[] }[]
    assert.equal(got.length, 1)
    assert.equal(got[0].name, 'Mix')
    assert.deepEqual(got[0].items.map((x) => [x.title, x.trackId]), [['One', undefined], ['Two', bt.id]])
    // у хозяина «со мной поделились» пусто; чужой плейлист bob делить не может
    assert.deepEqual((await s.app.inject('/api/shared')).json(), [])
    assert.equal((await bob.inject({ method: 'PUT', url: `/api/playlists/${pl.id}/shares`, payload: { userIds: [] } })).statusCode, 404)
    // убрал — больше не видно
    await s.app.inject({ method: 'PUT', url: `/api/playlists/${pl.id}/shares`, payload: { userIds: [] } })
    assert.deepEqual((await bob.inject('/api/shared')).json(), [])
  })
})
