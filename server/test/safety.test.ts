import assert from 'node:assert/strict'
import { rename } from 'node:fs/promises'
import { after, before, describe, test } from 'node:test'
import type { Track } from '../src/library.ts'
import { makeWav, multipart, startServer, type TestServer } from './helpers.ts'

// Критичное из аудита 2026-11-26: обход входа закодированным путём и скан, который хоронил треки
describe('безопасность и скан', () => {
  let s: TestServer
  before(async () => {
    s = await startServer()
  })
  after(() => s.close())

  test('закодированный путь /%61pi/... без токена — 401', async () => {
    for (const url of ['/%61pi/tracks', '/%61pi/users/directory', '/%61pi/prefs', '/%2561pi/tracks']) {
      const r = await s.rawInject(url)
      assert.ok(r.statusCode === 401 || r.statusCode === 404, `${url} → ${r.statusCode}`)
    }
    const up = await s.rawInject({ method: 'POST', url: '/%61pi/tracks', ...multipart('X - Y.wav', makeWav(2, { title: 'Y', artist: 'X' })) })
    assert.equal(up.statusCode, 401)
  })

  test('папка недоступна при скане — треки не хоронятся', async () => {
    const t = (await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Safe - One.wav', makeWav(3, { title: 'One', artist: 'Safe' })) })).json() as Track
    const folder = s.lib.folderPaths()[0]
    await rename(folder, `${folder}-away`)
    try {
      await s.startScan()
    } finally {
      await rename(`${folder}-away`, folder)
    }
    const got = await s.app.inject(`/api/tracks/${t.id}`)
    assert.equal(got.statusCode, 200)
    assert.equal((got.json() as Track).status, 'available')
  })
})
