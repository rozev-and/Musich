import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { Track } from '../src/library.ts'
import { setUserSetting } from '../src/db.ts'
import { loadPrefs } from '../src/prefs.ts'
import { makeWav, multipart, PNG, startServer, type TestServer } from './helpers.ts'

// Картинки — своя настройка, отдельно от правки тегов: «вшивать в файлы» или «только в MUSICH»
describe('картинки: вшивать в файлы или только в MUSICH', () => {
  let s: TestServer
  before(async () => {
    s = await startServer()
  })
  after(() => s.close())

  test('по умолчанию — в файлы; меняется отдельно от тегов', async () => {
    assert.equal((await s.app.inject('/api/prefs')).json().coverMode, 'file')
    const r = await s.app.inject({ method: 'PATCH', url: '/api/prefs', payload: { coverMode: 'overlay' } })
    assert.equal(r.statusCode, 200, r.body)
    const prefs = (await s.app.inject('/api/prefs')).json() as { coverMode: string; editMode: string }
    assert.equal(prefs.coverMode, 'overlay')
    assert.equal(prefs.editMode, 'file')
    assert.equal((await s.app.inject({ method: 'PATCH', url: '/api/prefs', payload: { coverMode: 'maybe' } })).statusCode, 400)
  })

  test('старые настройки без coverMode — картинки как теги', () => {
    const db = (s.lib as unknown as { db: Parameters<typeof loadPrefs>[0] }).db
    setUserSetting(db, 'legacy-user', 'prefs', JSON.stringify({ editMode: 'overlay' }))
    assert.equal(loadPrefs(db, 'legacy-user').coverMode, 'overlay')
    setUserSetting(db, 'legacy-user', 'prefs', JSON.stringify({ editMode: 'file' }))
    assert.equal(loadPrefs(db, 'legacy-user').coverMode, 'file')
  })

  test('«только в MUSICH»: обложка трека не трогает файл, теги при этом пишутся в файл', async () => {
    await s.app.inject({ method: 'PATCH', url: '/api/prefs', payload: { coverMode: 'overlay', editMode: 'file' } })
    const up = await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Cm - Song.wav', makeWav(5, { title: 'Song', artist: 'Cm', album: 'CmAlbum' })) })
    const track = up.json() as Track
    const put = await s.app.inject({ method: 'PUT', url: `/api/covers/track/${track.id}`, payload: PNG, headers: { 'content-type': 'image/png' } })
    assert.equal(put.statusCode, 204, put.body)
    const after = (await s.app.inject(`/api/tracks/${track.id}`)).json() as Track
    assert.equal(after.hash, track.hash) // файл тот же
    const cover = await s.app.inject(`/api/tracks/${track.id}/cover`)
    assert.equal(cover.headers['content-type'], 'image/png')
    assert.deepEqual(cover.rawPayload, PNG)
  })
})
