import assert from 'node:assert/strict'
import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { movedPath, type Track } from '../src/library.ts'
import { makeWav, multipart, startServer, type TestServer } from './helpers.ts'

// «Папка переехала»: пути в базе меняются, id трека и лайк остаются
describe('папка переехала', () => {
  let s: TestServer
  before(async () => {
    s = await startServer()
  })
  after(() => s.close())

  test('виндовый путь → путь на Linux-сервере', () => {
    const from = 'C:\\Users\\me\\Music\\Вся музыка'
    const to = '/mnt/das_3tb/DAS_system/Music'
    assert.equal(movedPath(`${from}\\Sub\\A - B.flac`, from, to), '/mnt/das_3tb/DAS_system/Music/Sub/A - B.flac')
    assert.equal(movedPath(`${from}\\.musich-trash\\x.mp3`, from, to), '/mnt/das_3tb/DAS_system/Music/.musich-trash/x.mp3')
    assert.equal(movedPath(from, from, to), to)
    assert.equal(movedPath('D:\\other\\x.mp3', from, to), 'D:\\other\\x.mp3')
    assert.equal(movedPath(`${from} 2\\x.mp3`, from, to), `${from} 2\\x.mp3`) // соседняя папка с похожим именем — не трогаем
  })

  test('пути переписываются, трек тот же, лайк на месте', async () => {
    const t = (await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Mv - One.wav', makeWav(9, { title: 'One', artist: 'Mv' })) })).json() as Track
    await s.app.inject({ method: 'PUT', url: `/api/tracks/${t.id}/like`, payload: { liked: true } })
    const from = s.lib.folderPaths()[0]
    const to = join(s.root, 'moved-music')
    await mkdir(to, { recursive: true })
    await cp(from, to, { recursive: true }) // музыку скопировали на новый диск
    const r = await s.app.inject({ method: 'POST', url: '/api/folders/move', payload: { from, to } })
    assert.equal(r.statusCode, 200, r.body)
    assert.ok((r.json() as { tracks: number }).tracks >= 1)
    assert.ok(s.lib.folderPaths().includes(to))
    assert.ok(!s.lib.folderPaths().includes(from))
    const tf = s.lib.trackFile(s.ownerId!, t.id)!
    assert.ok(tf.path.startsWith(to), tf.path)
    const after = (await s.app.inject(`/api/tracks/${t.id}`)).json() as Track
    assert.equal(after.liked, true)
    // несуществующая папка — ошибка, ничего не меняется
    const bad = await s.app.inject({ method: 'POST', url: '/api/folders/move', payload: { from: to, to: join(s.root, 'nope') } })
    assert.ok(bad.statusCode >= 400)
  })
})
