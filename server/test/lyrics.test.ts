import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { after, before, describe, test } from 'node:test'
import type { Track } from '../src/library.ts'
import { makeWav, multipart, startServer, type TestServer } from './helpers.ts'

// Текст песни: .lrc рядом с файлом, иначе null
describe('текст песни', () => {
  let s: TestServer
  before(async () => {
    s = await startServer()
  })
  after(() => s.close())

  test('нет текста — null; .lrc рядом — отдаётся как есть', async () => {
    const up = await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Ly - Song.wav', makeWav(4, { title: 'Song', artist: 'Ly' })) })
    const track = up.json() as Track
    assert.deepEqual((await s.app.inject(`/api/tracks/${track.id}/lyrics`)).json(), { lyrics: null })
    const tf = s.lib.trackFile(s.ownerId!, track.id)!
    await writeFile(tf.path.replace(/\.wav$/, '.lrc'), '﻿[00:01.00] Привет\n[00:02.50] Мир\n')
    assert.equal((await s.app.inject(`/api/tracks/${track.id}/lyrics`)).json().lyrics, '[00:01.00] Привет\n[00:02.50] Мир')
    assert.equal((await s.app.inject('/api/tracks/nope/lyrics')).statusCode, 404)
  })
})
