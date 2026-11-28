import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { Track } from '../src/library.ts'
import { hasFfmpeg, wantTranscode } from '../src/transcode.ts'
import { makeWav, multipart, startServer, type TestServer } from './helpers.ts'

// Качество потока: ?q=128|192|320 — пережатая копия MP3 (если есть ffmpeg и это выгодно), иначе оригинал
describe('качество потока', () => {
  let s: TestServer
  let track: Track
  before(async () => {
    s = await startServer()
    track = (await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Tc - Song.wav', makeWav(4, { title: 'Song', artist: 'Tc' }, 3)) })).json() as Track
  })
  after(() => s.close())

  test('когда пережимать: без потерь — всегда, сжатое — только если битрейт заметно выше', () => {
    assert.equal(wantTranscode('128', { format: 'flac', size: 1 }, 1), 128)
    assert.equal(wantTranscode('128', { format: 'mp3', size: 320_000 / 8 * 100 }, 100), 128) // 320 кбит/с
    assert.equal(wantTranscode('320', { format: 'mp3', size: 320_000 / 8 * 100 }, 100), undefined)
    assert.equal(wantTranscode('999', { format: 'flac', size: 1 }, 1), undefined)
    assert.equal(wantTranscode(undefined, { format: 'flac', size: 1 }, 1), undefined)
  })

  test('?q=128 — MP3 с перемоткой; неизвестное качество — оригинал; warm — 204', async (t) => {
    if (!(await hasFfmpeg())) return t.skip('ffmpeg не установлен')
    const r = await s.app.inject(`/api/tracks/${track.id}/file?q=128`)
    assert.equal(r.statusCode, 200)
    assert.equal(r.headers['content-type'], 'audio/mpeg')
    assert.equal(r.headers['accept-ranges'], 'bytes')
    const head = r.rawPayload.subarray(0, 3)
    assert.ok(head.toString() === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0), 'это MP3')
    const part = await s.app.inject({ url: `/api/tracks/${track.id}/file?q=128`, headers: { range: 'bytes=0-99' } })
    assert.equal(part.statusCode, 206)
    assert.equal(part.rawPayload.length, 100)
    const orig = await s.app.inject(`/api/tracks/${track.id}/file?q=999`)
    assert.match(String(orig.headers['content-type']), /wav/)
    assert.equal((await s.app.inject(`/api/tracks/${track.id}/file?q=192&warm=1`)).statusCode, 204)
  })
})
