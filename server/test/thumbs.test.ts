import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import sharp from 'sharp'
import { startServer, type TestServer } from './helpers.ts'

// Маленькие обложки для списков: ?w=160 → квадрат 160 в webp; без w или больше всех размеров — оригинал
describe('миниатюры обложек', () => {
  let s: TestServer
  let big: Buffer
  before(async () => {
    s = await startServer()
    big = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#c03' } }).png().toBuffer()
    const put = await s.app.inject({ method: 'PUT', url: '/api/covers/artist/Thumb', payload: big, headers: { 'content-type': 'image/png' } })
    assert.equal(put.statusCode, 204, put.body)
  })
  after(() => s.close())

  test('?w=160 — квадрат 160 в webp, повторно — тот же файл', async () => {
    const r = await s.app.inject('/api/covers/artist/Thumb?w=160')
    assert.equal(r.statusCode, 200)
    assert.equal(r.headers['content-type'], 'image/webp')
    const meta = await sharp(r.rawPayload).metadata()
    assert.equal(meta.width, 160)
    assert.equal(meta.height, 160)
    assert.ok(r.rawPayload.length < big.length)
    const again = await s.app.inject('/api/covers/artist/Thumb?w=160')
    assert.deepEqual(again.rawPayload, r.rawPayload)
  })

  test('нестандартная ширина — ближайший размер не меньше', async () => {
    const r = await s.app.inject('/api/covers/artist/Thumb?w=200')
    assert.equal((await sharp(r.rawPayload).metadata()).width, 320)
  })

  test('без w, мусор или больше всех размеров — оригинал', async () => {
    for (const q of ['', '?w=abc', '?w=5000']) {
      const r = await s.app.inject(`/api/covers/artist/Thumb${q}`)
      assert.equal(r.headers['content-type'], 'image/png', q)
      assert.deepEqual(r.rawPayload, big, q)
    }
  })

  test('нет картинки — 404, как раньше', async () => {
    assert.equal((await s.app.inject('/api/covers/artist/Nobody?w=160')).statusCode, 404)
  })
})
