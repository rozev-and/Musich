import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pull, remove, status, syncOnce } from '../src/sync.js'
import { audio, exists, idOf, setup, sleep, writeOld, type Env } from './helpers.js'

let env: Env | undefined
afterEach(async () => {
  await env?.cleanup()
  env = undefined
})

describe('загрузка на сервер', () => {
  it('новый файл в папке уходит на сервер один раз', async () => {
    env = await setup()
    const data = audio()
    await writeOld(path.join(env.folder, 'Queen - Bohemian Rhapsody.mp3'), data)

    const r = await syncOnce(env.ctx)
    assert.deepEqual(r.uploaded, ['Queen - Bohemian Rhapsody.mp3'])
    const id = idOf(data)
    assert.equal(env.server.tracks.get(id)?.track.status, 'available')
    assert.deepEqual(env.server.tracks.get(id)?.data, data)
    assert.equal((await env.state()).files['Queen - Bohemian Rhapsody.mp3']?.id, id)

    const r2 = await syncOnce(env.ctx)
    assert.equal(r2.uploaded.length, 0)
    assert.equal(r2.downloaded.length, 0, 'свой же трек из ленты не качаем второй раз')
    assert.equal(env.server.count('POST', /^\/api\/tracks$/), 1)
    assert.deepEqual(await env.files(), ['Queen - Bohemian Rhapsody.mp3'])
  })

  it('файлы во вложенных папках тоже синхронизируются, не-аудио — нет', async () => {
    env = await setup()
    await writeOld(path.join(env.folder, 'Альбом', 'CD1', '01 - Трек.flac'), audio())
    await writeOld(path.join(env.folder, 'cover.jpg'), audio(100))
    const r = await syncOnce(env.ctx)
    assert.deepEqual(r.uploaded, ['Альбом/CD1/01 - Трек.flac'])
  })

  it('файл, который ещё пишется, ждёт следующего прохода', async () => {
    env = await setup({ stableMs: 300 })
    const file = path.join(env.folder, 'Growing - Song.mp3')
    await fs.writeFile(file, audio(1000))
    const pass = syncOnce(env.ctx)
    await sleep(100)
    await fs.appendFile(file, audio(1000))
    const r = await pass
    assert.deepEqual(r.growing, ['Growing - Song.mp3'])
    assert.equal(env.server.count('POST', /^\/api\/tracks$/), 0)

    await sleep(350)
    const r2 = await syncOnce(env.ctx)
    assert.deepEqual(r2.uploaded, ['Growing - Song.mp3'])
    assert.equal(env.server.tracks.get(idOf(await fs.readFile(file)))?.track.size, 2000)
  })
})

describe('дедупликация', () => {
  it('трек, который уже есть на сервере, не заливается повторно', async () => {
    env = await setup()
    const data = audio()
    env.server.addTrack('Other - Device.mp3', data) // залит с другого устройства
    await writeOld(path.join(env.folder, 'my copy.mp3'), data)

    const r = await syncOnce(env.ctx)
    assert.deepEqual(r.linked, ['my copy.mp3'])
    assert.equal(env.server.count('HEAD', /^\/api\/tracks\/by-hash\//), 1)
    assert.equal(env.server.count('POST', /^\/api\/tracks$/), 0)
    assert.deepEqual(await env.files(), ['my copy.mp3'], 'второй экземпляр из ленты не скачивается')
  })

  it('два одинаковых файла в папке — одна загрузка', async () => {
    env = await setup()
    const data = audio()
    await writeOld(path.join(env.folder, 'a.mp3'), data)
    await writeOld(path.join(env.folder, 'b.mp3'), data)
    await syncOnce(env.ctx)
    assert.equal(env.server.count('POST', /^\/api\/tracks$/), 1)
    assert.equal(env.server.tracks.size, 1)
  })
})

describe('скачивание', () => {
  it('новый трек с сервера сохраняется как «Артист - Название.формат» без запрещённых символов', async () => {
    env = await setup()
    const data = audio()
    const track = env.server.addTrack('AC/DC - Back: In Black?.mp3', data)
    assert.equal(track.artist, 'AC/DC')

    const r = await syncOnce(env.ctx)
    assert.deepEqual(r.downloaded, ['AC_DC - Back_ In Black_.mp3'])
    assert.deepEqual(await fs.readFile(path.join(env.folder, 'AC_DC - Back_ In Black_.mp3')), data)
    assert.deepEqual(await env.files(), ['AC_DC - Back_ In Black_.mp3'], 'временных файлов не осталось')
  })

  it('существующий файл с тем же именем не затирается', async () => {
    env = await setup()
    const mine = audio()
    await writeOld(path.join(env.folder, 'Artist - Song.mp3'), mine)
    const theirs = audio()
    env.server.addTrack('Artist - Song.mp3', theirs)

    await syncOnce(env.ctx)
    assert.deepEqual(await fs.readFile(path.join(env.folder, 'Artist - Song.mp3')), mine)
    assert.deepEqual(await fs.readFile(path.join(env.folder, 'Artist - Song (2).mp3')), theirs)
  })

  it('режим «только по запросу»: ничего не качает сам, pull скачивает', async () => {
    env = await setup({ mode: 'on-demand' })
    const data = audio()
    const track = env.server.addTrack('Lazy - Track.flac', data)

    const r = await syncOnce(env.ctx)
    assert.equal(r.downloaded.length, 0)
    assert.deepEqual(await env.files(), [])
    const s = await status(env.ctx)
    assert.deepEqual(s.toDownload.map((t) => t.id), [track.id])

    const p = await pull(env.ctx, track.id.slice(0, 6))
    assert.equal(p.path, 'Lazy - Track.flac')
    assert.deepEqual(await fs.readFile(path.join(env.folder, 'Lazy - Track.flac')), data)
  })
})

describe('удаление', () => {
  it('надгробие с сервера удаляет локальный файл', async () => {
    env = await setup()
    const track = env.server.addTrack('Gone - Soon.mp3', audio())
    await syncOnce(env.ctx)
    assert.ok(await exists(path.join(env.folder, 'Gone - Soon.mp3')))

    env.server.tombstone(track.id)
    const r = await syncOnce(env.ctx)
    assert.deepEqual(r.removedByServer, ['Gone - Soon.mp3'])
    assert.deepEqual(await env.files(), [])
    const st = await env.state()
    assert.deepEqual(st.files, {})
    assert.equal(st.remote[track.id], undefined)
  })

  it('файл, удалённый руками, не удаляется с сервера и не качается обратно', async () => {
    env = await setup()
    const data = audio()
    const track = env.server.addTrack('Keep - On Server.mp3', data)
    await syncOnce(env.ctx)
    await fs.rm(path.join(env.folder, 'Keep - On Server.mp3'))

    const r = await syncOnce(env.ctx)
    assert.deepEqual(r.removedByUser, [track.id])
    assert.equal(env.server.count('DELETE', /^\/api\/tracks\//), 0)
    assert.equal(env.server.tracks.get(track.id)?.track.status, 'available')
    assert.deepEqual((await env.state()).localOnlyDeleted, [track.id])

    const r2 = await syncOnce(env.ctx)
    assert.equal(r2.downloaded.length, 0)
    assert.deepEqual(await env.files(), [])

    // Пользователь передумал — pull возвращает трек.
    await pull(env.ctx, track.id)
    assert.deepEqual(await env.files(), ['Keep - On Server.mp3'])
    assert.deepEqual((await env.state()).localOnlyDeleted, [])
  })

  it('переименование файла — не удаление', async () => {
    env = await setup()
    await writeOld(path.join(env.folder, 'old name.mp3'), audio())
    await syncOnce(env.ctx)
    await fs.rename(path.join(env.folder, 'old name.mp3'), path.join(env.folder, 'new name.mp3'))
    const r = await syncOnce(env.ctx)
    assert.deepEqual(r.removedByUser, [])
    assert.deepEqual((await env.state()).localOnlyDeleted, [])
    assert.equal(env.server.count('POST', /^\/api\/tracks$/), 1)
  })

  it('remove --local убирает файл только с устройства', async () => {
    env = await setup()
    const track = env.server.addTrack('Local - Only.mp3', audio())
    await syncOnce(env.ctx)
    const r = await remove(env.ctx, path.join(env.folder, 'Local - Only.mp3'), 'local')
    assert.equal(r.id, track.id)
    assert.deepEqual(await env.files(), [])
    assert.equal(env.server.count('DELETE', /^\/api\/tracks\//), 0)
    await syncOnce(env.ctx)
    assert.deepEqual(await env.files(), [])
  })

  it('remove --everywhere удаляет из хранилища и с устройства', async () => {
    env = await setup()
    const track = env.server.addTrack('Delete - Everywhere.mp3', audio())
    await syncOnce(env.ctx)
    await remove(env.ctx, track.id, 'everywhere')
    assert.equal(env.server.count('DELETE', /^\/api\/tracks\//), 1)
    assert.equal(env.server.tracks.get(track.id)?.track.status, 'deleted')
    assert.deepEqual(await env.files(), [])
    const r = await syncOnce(env.ctx)
    assert.equal(r.downloaded.length, 0)
    assert.deepEqual((await env.state()).localOnlyDeleted, [])
  })

  it('если папка пропала, файлы не считаются удалёнными', async () => {
    env = await setup()
    await writeOld(path.join(env.folder, 'x.mp3'), audio())
    await syncOnce(env.ctx)
    await fs.rm(env.folder, { recursive: true })
    await assert.rejects(syncOnce(env.ctx), /Папка синхронизации не найдена/)
    const st = await env.state()
    assert.deepEqual(st.localOnlyDeleted, [])
    assert.equal(Object.keys(st.files).length, 1)
  })
})

describe('сбои сети', () => {
  it('обрыв соединения и 500 — повтор, проход доходит до конца', async () => {
    env = await setup()
    env.server.fail('GET', /^\/api\/changes$/, 'reset', 2)
    env.server.fail('POST', /^\/api\/tracks$/, '500', 1)
    env.server.fail('HEAD', /^\/api\/tracks\/by-hash\//, 'reset', 1)
    const data = audio()
    await writeOld(path.join(env.folder, 'Flaky - Net.mp3'), data)
    env.server.addTrack('Remote - One.mp3', audio())

    const r = await syncOnce(env.ctx)
    assert.deepEqual(r.uploaded, ['Flaky - Net.mp3'])
    assert.deepEqual(r.downloaded, ['Remote - One.mp3'])
    assert.equal(env.server.count('POST', /^\/api\/tracks$/), 2)
    assert.ok(env.server.count('GET', /^\/api\/changes$/) >= 3)
  })

  it('обрыв посреди файла — докачка через Range', async () => {
    env = await setup()
    const data = audio(256 * 1024)
    const track = env.server.addTrack('Big - File.flac', data)
    env.server.fail('GET', /\/file$/, 'cut', 1)

    const r = await syncOnce(env.ctx)
    assert.deepEqual(r.downloaded, ['Big - File.flac'])
    assert.deepEqual(await fs.readFile(path.join(env.folder, 'Big - File.flac')), data)
    const fileRequests = env.server.requests.filter((q) => q.path === `/api/tracks/${track.id}/file`)
    assert.equal(fileRequests.length, 2)
    assert.match(fileRequests[1]!.range ?? '', /^bytes=\d+-$/)
  })

  it('сервер недоступен — курсор не двигается, следующий проход продолжает с него', async () => {
    env = await setup({ retries: 1 })
    env.server.addTrack('First - Track.mp3', audio())
    const first = await syncOnce(env.ctx)
    const cursor = first.cursor
    assert.ok(cursor > 0)

    const second = env.server.addTrack('Second - Track.mp3', audio())
    env.server.fail('GET', /^\/api\/changes$/, 'reset', 10)
    await assert.rejects(syncOnce(env.ctx))
    const broken = await env.state()
    assert.equal(broken.cursor, cursor)
    assert.ok(broken.lastError)
    assert.ok(!(await exists(path.join(env.folder, 'Second - Track.mp3'))))

    env.server.clearFaults()
    const r = await syncOnce(env.ctx)
    assert.deepEqual(r.downloaded, ['Second - Track.mp3'])
    assert.equal(r.cursor, second.seq)
    assert.equal((await env.state()).lastError, undefined)
  })

  it('скачивание, упавшее из-за сети, повторяется на следующем проходе (курсор уже сдвинут, трек в очереди)', async () => {
    env = await setup({ retries: 0 })
    const data = audio()
    env.server.addTrack('Retry - Later.mp3', data)
    env.server.fail('GET', /\/file$/, 'reset', 1)
    await assert.rejects(syncOnce(env.ctx))
    assert.equal((await status(env.ctx)).toDownload.length, 1)

    const r = await syncOnce(env.ctx)
    assert.deepEqual(r.downloaded, ['Retry - Later.mp3'])
    assert.deepEqual(await fs.readFile(path.join(env.folder, 'Retry - Later.mp3')), data)
  })
})

describe('токен', () => {
  it('клиент передаёт Bearer-токен', async () => {
    env = await setup({}, 'secret')
    await writeOld(path.join(env.folder, 'Auth - Song.mp3'), audio())
    const r = await syncOnce(env.ctx)
    assert.equal(r.uploaded.length, 1)
  })
})
