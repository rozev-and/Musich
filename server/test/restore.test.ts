import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { Track } from '../src/library.ts'
import { writeFileTags } from '../src/media.ts'
import { scanLibrary } from '../src/scanner.ts'
import { addUser, makeWav, multipart, PNG, startServer, type TestServer } from './helpers.ts'

// После бэкапа или переезда: обложки из тегов достаются заново; логин и папка загрузок — без учёта регистра
describe('после переезда', () => {
  let s: TestServer
  before(async () => {
    s = await startServer()
  })
  after(() => s.close())

  test('кэша обложек из тегов нет (не входит в бэкап) — сервер достаёт их из файлов', async () => {
    const t = (await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Pic - Cover.wav', makeWav(91, { title: 'Cover', artist: 'Pic' })) })).json() as Track
    const file = s.lib.trackFile(s.ownerId!, t.id)!.path
    writeFileTags(file, { picture: { mime: 'image/png', data: PNG } })
    await scanLibrary(s.lib) // скан перечитал файл: теперь у трека обложка из тегов
    const cache = join(s.cfg.dataDir, 'covers', 'tag', t.id)
    assert.ok(existsSync(cache), 'после скана обложка в кэше')

    await rm(cache) // как после восстановления бэкапа на новом сервере
    assert.equal((await s.app.inject(`/api/tracks/${t.id}/cover`)).statusCode, 404)
    await s.lib.restoreTagCovers()
    assert.ok(existsSync(cache))
    const cover = await s.app.inject(`/api/tracks/${t.id}/cover`)
    assert.equal(cover.statusCode, 200)
    assert.deepEqual(cover.rawPayload, PNG)
  })

  test('логин «rock», а в загрузках уже есть «Rock» — занят на любой системе', async () => {
    await mkdir(join(s.cfg.musicDir, 'Rock'), { recursive: true })
    await s.app.inject({ method: 'PATCH', url: '/api/server/settings', payload: { registration: true } })
    const r = await s.rawInject({ method: 'POST', url: '/api/auth/register', payload: { login: 'rock', password: 'rock-password' } })
    assert.equal(r.json().error, 'login_taken')
    // а свободный — проходит
    const ok = await addUser(s, 'jazz')
    assert.ok(ok.id)
  })
})
