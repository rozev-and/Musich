import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveTags, safeFileName, UNKNOWN_ARTIST } from '../src/media.ts'
import { parseRange } from '../src/range.ts'

test('теги: «Мне нравится» и пустой альбом → альбом = название', () => {
  assert.equal(resolveTags({ title: 'Песня', artist: 'Кто-то', album: 'Мне нравится' }, 'x.mp3', 10).album, 'Песня')
  assert.equal(resolveTags({ title: 'Песня', artist: 'Кто-то', album: '  ' }, 'x.mp3', 10).album, 'Песня')
  assert.equal(resolveTags({ title: 'Песня', artist: 'Кто-то', album: 'Альбом' }, 'x.mp3', 10).album, 'Альбом')
})

test('теги: пустые исполнитель/название берутся из имени «Артист - Название»', () => {
  const t = resolveTags({}, 'Кино - Группа крови - Live.flac', 61.6)
  assert.equal(t.artist, 'Кино')
  assert.equal(t.title, 'Группа крови - Live')
  assert.equal(t.album, 'Группа крови - Live')
  assert.equal(t.duration, 62)
  const u = resolveTags({}, 'просто трек.mp3', undefined)
  assert.equal(u.title, 'просто трек')
  assert.equal(u.artist, UNKNOWN_ARTIST)
  assert.equal(u.duration, 0)
})

test('безопасное имя файла', () => {
  assert.equal(safeFileName('../../etc/a:b?.mp3'), 'a_b_.mp3')
  assert.equal(safeFileName('C:\\x\\Кино - Звезда.flac'), 'Кино - Звезда.flac')
  assert.equal(safeFileName('...'), '')
})

test('Range', () => {
  assert.equal(parseRange(undefined, 100), null)
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 })
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable')
  assert.equal(parseRange('bytes=0-1,5-6', 100), null)
  assert.equal(parseRange('items=0-1', 100), null)
})
