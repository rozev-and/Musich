import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import type { Changes, Playlist, Track } from '../src/library.ts'
import { writeFileTags } from '../src/media.ts'
import { scanLibrary } from '../src/scanner.ts'
import { makeWav, multipart, PNG, startServer, type TestServer } from './helpers.ts'

const idOf = (buf: Buffer) => createHash('sha256').update(buf).digest('hex').slice(0, 16)

async function upload(s: TestServer, name: string, data: Buffer) {
  const res = await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart(name, data) })
  return { res, track: res.json() as Track }
}

describe('треки', () => {
  let s: TestServer
  before(async () => {
    s = await startServer()
  })
  after(() => s.close())

  test('health', async () => {
    const res = await s.app.inject('/api/health')
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().ok, true)
    assert.equal(typeof res.json().version, 'string')
  })

  test('CORS для приложения: предварительный запрос без токена — 204, у ответов — Allow-Origin', async () => {
    const pre = await s.app.inject({ method: 'OPTIONS', url: '/api/tracks', headers: { origin: 'http://localhost', 'access-control-request-method': 'GET' } })
    assert.equal(pre.statusCode, 204)
    assert.equal(pre.headers['access-control-allow-origin'], '*')
    assert.match(String(pre.headers['access-control-allow-headers']), /Authorization/)
    assert.match(String(pre.headers['access-control-allow-headers']), /X-Musich-Device/)
    const res = await s.app.inject('/api/tracks')
    assert.equal(res.headers['access-control-allow-origin'], '*')
  })

  test('загрузка: 201, теги, файл в MUSIC_DIR; повтор → 200 без дубликата', async () => {
    const wav = makeWav(1, { title: 'Song One', artist: 'Band', album: 'LP' }, 2)
    const { res, track } = await upload(s, 'Band - Song One.wav', wav)
    assert.equal(res.statusCode, 201, res.body)
    assert.equal(track.id, idOf(wav))
    assert.equal(track.title, 'Song One')
    assert.equal(track.artist, 'Band')
    assert.equal(track.album, 'LP')
    assert.equal(track.format, 'wav')
    assert.equal(track.size, wav.length)
    assert.equal(track.duration, 2)
    assert.equal(track.fileName, 'Band - Song One.wav')
    assert.equal(track.status, 'available')
    assert.equal(track.liked, false)
    assert.equal(track.hasCover, false)
    assert.ok(track.seq > 0)
    assert.deepEqual(await readFile(join(s.uploads, 'Band - Song One.wav')), wav)

    // тот же файл под другим именем — дедупликация по хэшу
    const again = await upload(s, 'copy.wav', wav)
    assert.equal(again.res.statusCode, 200)
    assert.equal(again.track.id, track.id)
    assert.equal(again.track.seq, track.seq)
    const files = (await readdir(s.uploads)).filter((f) => !f.startsWith('.'))
    assert.deepEqual(files, ['Band - Song One.wav'])

    const head = await s.app.inject({ method: 'HEAD', url: `/api/tracks/by-hash/${track.id}` })
    assert.equal(head.statusCode, 200)
    const head404 = await s.app.inject({ method: 'HEAD', url: '/api/tracks/by-hash/0123456789abcdef' })
    assert.equal(head404.statusCode, 404)

    const list = (await s.app.inject('/api/tracks')).json() as Track[]
    assert.deepEqual(list.map((t) => t.id), [track.id])
    assert.equal((await s.app.inject(`/api/tracks/${track.id}`)).json().title, 'Song One')
  })

  test('загрузка: пустые теги → из имени файла, кириллица; чужой файл с тем же именем не перезаписывается', async () => {
    const wav = makeWav(2)
    const { res, track } = await upload(s, 'Кино - Звезда.wav', wav)
    assert.equal(res.statusCode, 201, res.body)
    assert.equal(track.artist, 'Кино')
    assert.equal(track.title, 'Звезда')
    assert.equal(track.album, 'Звезда')
    assert.equal(track.fileName, 'Кино - Звезда.wav')

    const other = makeWav(3)
    const second = await upload(s, 'Кино - Звезда.wav', other)
    assert.equal(second.res.statusCode, 201)
    assert.notEqual(second.track.id, track.id)
    assert.deepEqual(await readFile(join(s.uploads, 'Кино - Звезда.wav')), wav)
    assert.ok(existsSync(join(s.uploads, `Кино - Звезда (${second.track.id.slice(0, 8)}).wav`)))
  })

  test('загрузка: не аудио → 415 ApiError, временных файлов не остаётся', async () => {
    const res = await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('notes.txt', Buffer.from('hello')) })
    assert.equal(res.statusCode, 415)
    assert.equal(res.json().error, 'unsupported_media_type')
    assert.equal(typeof res.json().message, 'string')
    const bad = await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('broken.mp3', Buffer.from('not really mp3')) })
    assert.equal(bad.statusCode, 415)
    assert.deepEqual(await readdir(join(s.uploads, '.musich-tmp')), [])
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/tracks', payload: { a: 1 } })).statusCode, 415)
  })

  test('файл: целиком и по Range', async () => {
    const wav = makeWav(4, {}, 1)
    const { track } = await upload(s, 'range.wav', wav)
    const full = await s.app.inject(`/api/tracks/${track.id}/file`)
    assert.equal(full.statusCode, 200)
    assert.equal(full.headers['content-type'], 'audio/wav')
    assert.equal(full.headers['accept-ranges'], 'bytes')
    assert.equal(Number(full.headers['content-length']), wav.length)
    assert.deepEqual(full.rawPayload, wav)

    const part = await s.app.inject({ url: `/api/tracks/${track.id}/file`, headers: { range: 'bytes=100-199' } })
    assert.equal(part.statusCode, 206)
    assert.equal(part.headers['content-range'], `bytes 100-199/${wav.length}`)
    assert.equal(Number(part.headers['content-length']), 100)
    assert.deepEqual(part.rawPayload, wav.subarray(100, 200))

    const tail = await s.app.inject({ url: `/api/tracks/${track.id}/file`, headers: { range: 'bytes=-10' } })
    assert.equal(tail.statusCode, 206)
    assert.deepEqual(tail.rawPayload, wav.subarray(wav.length - 10))

    const open = await s.app.inject({ url: `/api/tracks/${track.id}/file`, headers: { range: `bytes=${wav.length - 5}-` } })
    assert.deepEqual(open.rawPayload, wav.subarray(wav.length - 5))

    const bad = await s.app.inject({ url: `/api/tracks/${track.id}/file`, headers: { range: `bytes=${wav.length}-` } })
    assert.equal(bad.statusCode, 416)
    assert.equal(bad.headers['content-range'], `bytes */${wav.length}`)

    assert.equal((await s.app.inject('/api/tracks/0123456789abcdef/file')).statusCode, 404)
  })

  test('удаление → надгробие в /changes, файл удалён, повторная загрузка — в «Конфликты»', async () => {
    const wav = makeWav(5, { title: 'Doomed', artist: 'X' })
    const { track } = await upload(s, 'doomed.wav', wav)
    const cursor = ((await s.app.inject('/api/changes?since=0')).json() as Changes).cursor
    assert.ok(cursor >= track.seq)

    const del = await s.app.inject({ method: 'DELETE', url: `/api/tracks/${track.id}` })
    assert.equal(del.statusCode, 204)
    assert.ok(!existsSync(join(s.uploads, 'doomed.wav')))

    const ch = (await s.app.inject(`/api/changes?since=${cursor}`)).json() as Changes
    assert.equal(ch.tracks.length, 1)
    assert.equal(ch.tracks[0].id, track.id)
    assert.equal(ch.tracks[0].status, 'deleted')
    assert.equal(ch.cursor, ch.tracks[0].seq)
    assert.ok(ch.cursor > cursor)

    // без изменений — пустой ответ, курсор = since
    const none = (await s.app.inject(`/api/changes?since=${ch.cursor}`)).json() as Changes
    assert.deepEqual(none, { cursor: ch.cursor, tracks: [], playlists: [], covers: [] })

    assert.ok(!((await s.app.inject('/api/tracks')).json() as Track[]).some((t) => t.id === track.id))
    assert.equal((await s.app.inject(`/api/tracks/${track.id}`)).json().status, 'deleted')
    assert.equal((await s.app.inject({ method: 'HEAD', url: `/api/tracks/by-hash/${track.id}` })).statusCode, 404)
    assert.equal((await s.app.inject(`/api/tracks/${track.id}/file`)).statusCode, 404)
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/tracks/${track.id}` })).statusCode, 204)
    assert.equal((await s.app.inject({ method: 'DELETE', url: '/api/tracks/0123456789abcdef' })).statusCode, 404)

    // скан не воскрешает надгробие, даже если файл вернули руками
    await writeFile(join(s.uploads, 'doomed-copy.wav'), wav)
    await scanLibrary(s.lib)
    assert.equal(s.lib.getTrack(track.id)!.status, 'deleted')

    // прислали снова — не воскрешаем молча: 409 deleted, файл ждёт решения в «Конфликтах»
    const back = await upload(s, 'doomed.wav', wav)
    assert.equal(back.res.statusCode, 409)
    assert.equal(back.res.json().error, 'deleted')
    assert.equal(s.lib.getTrack(track.id)!.status, 'deleted')
  })

  test('лайк', async () => {
    const { track } = await upload(s, 'like.wav', makeWav(6))
    const liked = (await s.app.inject({ method: 'PUT', url: `/api/tracks/${track.id}/like`, payload: { liked: true } })).json() as Track
    assert.equal(liked.liked, true)
    assert.ok(liked.likedAt)
    assert.ok(liked.seq > track.seq)
    const unliked = (await s.app.inject({ method: 'PUT', url: `/api/tracks/${track.id}/like`, payload: { liked: false } })).json() as Track
    assert.equal(unliked.liked, false)
    assert.equal(unliked.likedAt, undefined)
    const bad = await s.app.inject({ method: 'PUT', url: `/api/tracks/${track.id}/like`, payload: {} })
    assert.equal(bad.statusCode, 400)
    assert.equal(bad.json().error, 'bad_request')
  })

  test('картинки: своя у трека и у альбома, hasCover, удаление', async () => {
    const { track } = await upload(s, 'Art - Pic.wav', makeWav(7, { title: 'Pic', artist: 'Art', album: 'Album/slash' }))
    assert.equal((await s.app.inject(`/api/tracks/${track.id}/cover`)).statusCode, 404)

    // теги RIFF INFO читаются как latin1, поэтому в WAV-тестах названия латиницей
    const album = encodeURIComponent('Album/slash')
    const put = await s.app.inject({ method: 'PUT', url: `/api/covers/album/${album}`, payload: PNG, headers: { 'content-type': 'image/png' } })
    assert.equal(put.statusCode, 204, put.body)
    const cover = await s.app.inject(`/api/tracks/${track.id}/cover`)
    assert.equal(cover.statusCode, 200)
    assert.equal(cover.headers['content-type'], 'image/png')
    assert.deepEqual(cover.rawPayload, PNG)
    assert.equal((await s.app.inject(`/api/tracks/${track.id}`)).json().hasCover, true)
    assert.deepEqual((await s.app.inject(`/api/covers/album/${album}`)).rawPayload, PNG)

    const ch = (await s.app.inject(`/api/changes?since=${track.seq}`)).json() as Changes
    assert.deepEqual(ch.covers.map((c) => [c.kind, c.key, c.deleted]), [['album', 'Album/slash', false]])
    assert.ok(ch.tracks.some((t) => t.id === track.id && t.hasCover))

    const notImage = await s.app.inject({ method: 'PUT', url: `/api/covers/artist/Art`, payload: Buffer.from('xx'), headers: { 'content-type': 'image/png' } })
    assert.equal(notImage.statusCode, 400)
    const wrongType = await s.app.inject({ method: 'PUT', url: `/api/covers/artist/Art`, payload: 'x', headers: { 'content-type': 'text/plain' } })
    assert.equal(wrongType.statusCode, 415)
    const big = await s.app.inject({
      method: 'PUT',
      url: `/api/covers/artist/Art`,
      payload: Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]),
      headers: { 'content-type': 'image/png' },
    })
    assert.equal(big.statusCode, 413)
    assert.equal((await s.app.inject('/api/covers/planet/x')).statusCode, 400)

    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/covers/album/${album}` })).statusCode, 204)
    assert.equal((await s.app.inject(`/api/tracks/${track.id}/cover`)).statusCode, 404)
    assert.equal((await s.app.inject(`/api/tracks/${track.id}`)).json().hasCover, false)
    const ch2 = (await s.app.inject(`/api/changes?since=${ch.cursor}`)).json() as Changes
    assert.deepEqual(ch2.covers.map((c) => c.deleted), [true])
  })

  test('скан MUSIC_DIR: добавляет новые файлы, имя «Артист - Название», подпапки', async () => {
    const sub = join(s.uploads, 'sub')
    await mkdir(sub, { recursive: true })
    const a = makeWav(8)
    const b = makeWav(9, { title: 'Tagged', artist: 'Someone' })
    await writeFile(join(sub, 'Сплин - Выхода нет.wav'), a)
    await writeFile(join(s.uploads, 'b.wav'), b)
    await writeFile(join(s.uploads, 'readme.txt'), 'skip me')
    const res = await scanLibrary(s.lib)
    assert.equal(res.added, 2)
    const ta = s.lib.getTrack(idOf(a))!
    assert.equal(ta.artist, 'Сплин')
    assert.equal(ta.title, 'Выхода нет')
    const tb = s.lib.getTrack(idOf(b))!
    assert.equal(tb.album, 'Tagged')
    // второй проход ничего не добавляет
    assert.equal((await scanLibrary(s.lib)).added, 0)
  })
})

describe('плейлисты', () => {
  let s: TestServer
  before(async () => {
    s = await startServer()
  })
  after(() => s.close())

  test('создать, изменить порядок, обложка, удалить → надгробие', async () => {
    const t1 = (await upload(s, 'a.wav', makeWav(11))).track
    const t2 = (await upload(s, 'b.wav', makeWav(12))).track

    const created = await s.app.inject({ method: 'POST', url: '/api/playlists', payload: { name: 'Дорога', trackIds: [t1.id, t2.id] } })
    assert.equal(created.statusCode, 201)
    const p = created.json() as Playlist
    assert.match(p.id, /^[0-9a-f-]{36}$/)
    assert.equal(p.description, '')
    assert.deepEqual(p.trackIds, [t1.id, t2.id])
    assert.equal(p.deleted, false)
    assert.equal(p.hasCover, false)

    const patched = (await s.app.inject({ method: 'PATCH', url: `/api/playlists/${p.id}`, payload: { trackIds: [t2.id, t1.id], description: 'летом' } })).json() as Playlist
    assert.deepEqual(patched.trackIds, [t2.id, t1.id])
    assert.equal(patched.name, 'Дорога')
    assert.equal(patched.description, 'летом')
    assert.ok(patched.seq > p.seq)

    const bad = await s.app.inject({ method: 'PATCH', url: `/api/playlists/${p.id}`, payload: { trackIds: ['nope'] } })
    assert.equal(bad.statusCode, 400)
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/playlists', payload: {} })).statusCode, 400)

    const put = await s.app.inject({ method: 'PUT', url: `/api/playlists/${p.id}/cover`, payload: PNG, headers: { 'content-type': 'image/png' } })
    assert.equal(put.statusCode, 204)
    assert.deepEqual((await s.app.inject(`/api/playlists/${p.id}/cover`)).rawPayload, PNG)
    const withCover = ((await s.app.inject('/api/playlists')).json() as Playlist[])[0]
    assert.equal(withCover.hasCover, true)
    assert.ok(withCover.seq > patched.seq)

    const before = ((await s.app.inject('/api/changes?since=0')).json() as Changes).cursor
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/playlists/${p.id}` })).statusCode, 204)
    assert.deepEqual((await s.app.inject('/api/playlists')).json(), [])
    const ch = (await s.app.inject(`/api/changes?since=${before}`)).json() as Changes
    assert.equal(ch.playlists.length, 1)
    assert.equal(ch.playlists[0].deleted, true)
    assert.equal(ch.covers.length, 0) // обложки плейлистов идут через сам плейлист
    assert.equal((await s.app.inject({ method: 'PATCH', url: `/api/playlists/${p.id}`, payload: { name: 'x' } })).statusCode, 404)
    // треки не тронуты
    assert.equal(((await s.app.inject('/api/tracks')).json() as Track[]).length, 2)
  })

  test('устройства', async () => {
    const reg = await s.app.inject({ method: 'POST', url: '/api/devices', payload: { name: 'Домашний ПК', kind: 'desktop' } })
    assert.equal(reg.statusCode, 201)
    const d = reg.json()
    assert.equal(d.name, 'Домашний ПК')
    const seen = await s.app.inject({ method: 'POST', url: `/api/devices/${d.id}/seen` })
    assert.equal(seen.statusCode, 200)
    assert.ok(seen.json().lastSeenAt >= d.lastSeenAt)
    assert.equal(seen.json().pendingUp, 0)
    // устройство сообщает, что у него ждёт синхронизации
    const st = (await s.app.inject({ method: 'POST', url: `/api/devices/${d.id}/seen`, payload: { pendingUp: 3, pendingDown: 12, synced: true } })).json()
    assert.equal(st.pendingUp, 3)
    assert.equal(st.pendingDown, 12)
    assert.ok(st.syncedAt)
    assert.equal(((await s.app.inject('/api/devices')).json() as unknown[]).length, 1)
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/devices', payload: { name: 'x', kind: 'toaster' } })).statusCode, 400)
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/devices/nope/seen' })).statusCode, 404)
  })
})

describe('переименование и история прослушиваний', () => {
  let s: TestServer
  before(async () => {
    s = await startServer()
  })
  after(() => s.close())

  test('переименование пишет теги в файл: id тот же, новый отпечаток, всё привязанное на месте', async () => {
    const wav = makeWav(21, { title: 'Old Song', artist: 'Band' })
    const t = (await upload(s, 'Band - Old Song.wav', wav)).track
    await s.app.inject({ method: 'PUT', url: `/api/tracks/${t.id}/like`, payload: { liked: true } })
    const p = (await s.app.inject({ method: 'POST', url: '/api/playlists', payload: { name: 'P', trackIds: [t.id] } })).json() as Playlist
    await s.app.inject({ method: 'PUT', url: `/api/covers/track/${t.id}`, payload: PNG, headers: { 'content-type': 'image/png' } })
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/plays', payload: { trackId: t.id } })).statusCode, 201)

    const res = await s.app.inject({ method: 'PATCH', url: `/api/tracks/${t.id}`, payload: { title: 'New Song', artist: 'Band, Guest' } })
    assert.equal(res.statusCode, 200, res.body)
    const { track, previousId } = res.json() as { track: Track; previousId: string }
    assert.equal(previousId, t.id)
    assert.equal(track.id, t.id)
    assert.notEqual(track.hash, t.hash)
    assert.equal(track.title, 'New Song')
    assert.equal(track.artist, 'Band, Guest')
    assert.equal(track.liked, true)
    assert.equal(track.addedAt, t.addedAt)
    assert.equal(track.hasCover, true)
    // файл переименован по правилу «Артист - Название», старого нет; отпечаток = хэш нового содержимого
    assert.equal(track.fileName, 'Band, Guest - New Song.wav')
    const file = await readFile(join(s.uploads, 'Band, Guest - New Song.wav'))
    assert.equal(idOf(file), track.hash)
    assert.equal(existsSync(join(s.uploads, 'Band - Old Song.wav')), false)

    assert.equal((await s.app.inject(`/api/tracks/${t.id}`)).json().status, 'available')
    assert.deepEqual(((await s.app.inject('/api/playlists')).json() as Playlist[]).find((x) => x.id === p.id)!.trackIds, [track.id])
    assert.deepEqual((await s.app.inject(`/api/covers/track/${track.id}`)).rawPayload, PNG)
    const plays = (await s.app.inject('/api/plays')).json() as { trackId: string }[]
    assert.deepEqual(plays.map((x) => x.trackId), [track.id])
  })

  test('имя файла — по правилу «Артист - Название» (по умолчанию); пустое тело → 400; без изменений — тот же трек', async () => {
    const t = (await upload(s, '07 track.wav', makeWav(22, { title: 'A', artist: 'B' }))).track
    const renamed = (await s.app.inject({ method: 'PATCH', url: `/api/tracks/${t.id}`, payload: { title: 'C' } })).json() as { track: Track }
    assert.equal(renamed.track.fileName, 'B - C.wav')
    assert.equal(renamed.track.title, 'C')
    assert.equal(renamed.track.id, t.id)
    assert.equal((await s.app.inject({ method: 'PATCH', url: `/api/tracks/${renamed.track.id}`, payload: {} })).statusCode, 400)
    const same = (await s.app.inject({ method: 'PATCH', url: `/api/tracks/${renamed.track.id}`, payload: { title: 'C' } })).json() as { track: Track }
    assert.equal(same.track.id, renamed.track.id)
    assert.equal((await s.app.inject({ method: 'PATCH', url: '/api/tracks/ffffffffffffffff', payload: { title: 'X' } })).statusCode, 404)
  })

  test('переименование артиста: меняется только он, в совместных треках тоже; картинка артиста переезжает', async () => {
    const solo = (await upload(s, 'Kord - Solo.wav', makeWav(31, { title: 'Solo', artist: 'Kord' }))).track
    const duo = (await upload(s, 'Kord, Raven - Duo.wav', makeWav(32, { title: 'Duo', artist: 'Kord, Raven' }))).track
    const feat = (await upload(s, 'f.wav', makeWav(33, { title: 'Feat', artist: 'Other feat. kord' }))).track
    const other = (await upload(s, 'o.wav', makeWav(34, { title: 'Nope', artist: 'Kordhell' }))).track
    await s.app.inject({ method: 'PUT', url: `/api/covers/artist/Kord`, payload: PNG, headers: { 'content-type': 'image/png' } })

    const res = await s.app.inject({ method: 'POST', url: '/api/artists/rename', payload: { from: 'Kord', to: 'KORD' } })
    assert.equal(res.statusCode, 200, res.body)
    const { renamed, failed } = res.json() as { renamed: { track: Track; previousId: string }[]; failed: number }
    assert.equal(failed, 0)
    const by = new Map(renamed.map((r) => [r.previousId, r.track]))
    assert.equal(by.size, 3)
    assert.equal(by.get(solo.id)!.artist, 'KORD')
    assert.equal(by.get(solo.id)!.fileName, 'KORD - Solo.wav')
    assert.equal(by.get(duo.id)!.artist, 'KORD, Raven')
    assert.equal(by.get(feat.id)!.artist, 'Other feat. KORD')
    assert.equal(by.get(feat.id)!.fileName, 'Other feat. KORD - Feat.wav')
    assert.equal(((await s.app.inject(`/api/tracks/${other.id}`)).json() as Track).artist, 'Kordhell')
    assert.deepEqual((await s.app.inject('/api/covers/artist/KORD')).rawPayload, PNG)
    assert.equal((await s.app.inject('/api/covers/artist/Kord')).statusCode, 404)

    assert.equal((await s.app.inject({ method: 'POST', url: '/api/artists/rename', payload: { from: 'Нет такого', to: 'X' } })).statusCode, 404)
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/artists/rename', payload: { from: 'KORD' } })).statusCode, 400)
  })

  test('перенос номера: сдвигаются только треки между старым и новым местом, номер пишется в файл', async () => {
    const lib = s.lib as unknown as { renameTrack: (id: string, p: { trackNo: number }) => Promise<{ track: Track }> }
    // пять треков с номерами 101..105
    const ids: string[] = []
    for (let n = 1; n <= 5; n++) {
      const up = (await upload(s, `n${n}.wav`, makeWav(40 + n, { title: `N${n}` }))).track
      ids.push((await lib.renameTrack(up.id, { trackNo: 100 + n })).track.id)
    }
    const numbers = async () => {
      const all = (await s.app.inject('/api/tracks')).json() as Track[]
      return Object.fromEntries(all.filter((t) => /^N\d$/.test(t.title)).map((t) => [t.title, t.trackNo]))
    }
    assert.deepEqual(await numbers(), { N1: 101, N2: 102, N3: 103, N4: 104, N5: 105 })

    // N5 → 102: N2..N4 сдвигаются вниз, N1 не трогаем
    const up = await s.app.inject({ method: 'POST', url: `/api/tracks/${ids[4]}/number`, payload: { number: 102 } })
    assert.equal(up.statusCode, 200, up.body)
    assert.equal((up.json() as { renamed: unknown[] }).renamed.length, 4)
    assert.deepEqual(await numbers(), { N1: 101, N5: 102, N2: 103, N3: 104, N4: 105 })

    // N1 → 104: N5, N2, N3 сдвигаются вверх
    const n1 = ((await s.app.inject('/api/tracks')).json() as Track[]).find((t) => t.title === 'N1')!
    await s.app.inject({ method: 'POST', url: `/api/tracks/${n1.id}/number`, payload: { number: 104 } })
    assert.deepEqual(await numbers(), { N5: 101, N2: 102, N3: 103, N1: 104, N4: 105 })

    // номер записан в сам файл: отпечаток файла на диске = hash трека
    const n1now = ((await s.app.inject('/api/tracks')).json() as Track[]).find((t) => t.title === 'N1')!
    assert.equal(idOf(await readFile(join(s.uploads, n1now.fileName))), n1now.hash)
    assert.equal((await s.app.inject({ method: 'POST', url: `/api/tracks/${n1now.id}/number`, payload: { number: 0 } })).statusCode, 400)
  })

  test('новый трек без номера получает следующий номер в файл; старую версию файла второй раз не заводим', async () => {
    const all = async () => (await s.app.inject('/api/tracks')).json() as Track[]
    const max = Math.max(0, ...(await all()).map((t) => t.trackNo ?? 0))
    const wav = makeWav(50, { title: 'Fresh', trackNo: null })
    const { res, track } = await upload(s, 'Fresh.wav', wav)
    assert.equal(res.statusCode, 201, res.body)
    assert.equal(track.trackNo, max + 1)
    // номер дописан в файл — содержимое другое: id остаётся отпечатком исходного файла, hash — нового
    assert.equal(track.id, idOf(wav))
    assert.notEqual(track.hash, idOf(wav))
    assert.equal(idOf(await readFile(join(s.uploads, track.fileName))), track.hash)

    // тот же исходный файл ещё раз (например, со второго устройства) — это уже существующий трек
    const again = await upload(s, 'Fresh copy.wav', wav)
    assert.equal(again.res.statusCode, 200)
    assert.equal(again.track.id, track.id)
    assert.equal((await all()).filter((t) => t.title === 'Fresh').length, 1)
    // и быстрая проверка перед загрузкой знает, что этот оригинал уже есть
    assert.equal((await s.app.inject({ method: 'HEAD', url: `/api/tracks/by-hash/${idOf(wav)}` })).statusCode, 200)

    // скан нашёл файл без номера — тоже получает следующий
    await writeFile(join(s.uploads, 'Scanned.wav'), makeWav(51, { title: 'Scanned', trackNo: null }))
    await scanLibrary(s.lib)
    assert.equal((await all()).find((t) => t.title === 'Scanned')!.trackNo, max + 2)
  })

  test('порядок плейлистов', async () => {
    const mk = async (name: string) => ((await s.app.inject({ method: 'POST', url: '/api/playlists', payload: { name } })).json() as Playlist).id
    const a = await mk('A')
    await mk('B')
    const c = await mk('C')
    const names = async () => ((await s.app.inject('/api/playlists')).json() as Playlist[]).filter((p) => 'ABCD'.includes(p.name) && p.name.length === 1).map((p) => p.name)
    assert.deepEqual(await names(), ['A', 'B', 'C'])
    const res = await s.app.inject({ method: 'PUT', url: '/api/playlists/order', payload: { ids: [c, a] } })
    assert.equal(res.statusCode, 200)
    // кого не назвали — в конец, как был
    assert.deepEqual(await names(), ['C', 'A', 'B'])
    await mk('D')
    assert.deepEqual(await names(), ['C', 'A', 'B', 'D'])
  })

  test('история: только живые треки, свежие сверху, хранится всегда', async () => {
    const t = (await upload(s, 'h.wav', makeWav(23))).track
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/plays', payload: { trackId: 'ffffffffffffffff' } })).statusCode, 404)
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/plays', payload: { trackId: 'nope' } })).statusCode, 400)
    // два прослушивания «из прошлого»: 2 и 4 дня назад — оба остаются (история не чистится)
    const db = (s.lib as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()
    // история у каждого пользователя своя — пишем от владельца
    db.prepare('INSERT INTO plays (track_id, played_at, user_id) VALUES (?, ?, ?)').run(t.id, ago(2), s.ownerId)
    db.prepare('INSERT INTO plays (track_id, played_at, user_id) VALUES (?, ?, ?)').run(t.id, ago(4), s.ownerId)
    // телефон досылает прослушивание без сети со своим временем; время из будущего — «сейчас»
    const at = ago(1)
    const late = await s.app.inject({ method: 'POST', url: '/api/plays', payload: { trackId: t.id, at } })
    assert.equal(late.json().playedAt, at)
    const future = await s.app.inject({ method: 'POST', url: '/api/plays', payload: { trackId: t.id, at: new Date(Date.now() + 86_400_000).toISOString() } })
    assert.ok(Date.parse(future.json().playedAt) <= Date.now())
    await s.app.inject({ method: 'POST', url: '/api/plays', payload: { trackId: t.id } })
    const plays = (await s.app.inject('/api/plays')).json() as { trackId: string; playedAt: string }[]
    assert.equal(plays[0].trackId, t.id)
    assert.ok(plays.every((p, i) => i === 0 || plays[i - 1].playedAt >= p.playedAt))
    // у этого трека: 4 и 2 дня назад, вчерашнее (присланное позже), «из будущего» и сегодняшнее
    assert.equal(plays.filter((p) => p.trackId === t.id).length, 5)
  })
})

describe('сплошная нумерация', () => {
  let s: TestServer
  beforeEach(async () => {
    s = await startServer()
  })
  afterEach(() => s.close())

  // номера переписываются в фоне — ждём, пока список придёт к ожидаемому
  const numbers = async () =>
    Object.fromEntries(((await s.app.inject('/api/tracks')).json() as Track[]).map((t) => [t.title, t.trackNo]))
  const waitFor = async (want: Record<string, number>) => {
    for (let i = 0; i < 100; i++) {
      const got = await numbers()
      if (JSON.stringify(Object.entries(got).sort()) === JSON.stringify(Object.entries(want).sort())) return
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.deepEqual(await numbers(), want)
  }

  test('удалили трек — следующие номера сдвигаются на −1, id переписанных треков прежние', async () => {
    const ids: string[] = []
    for (let n = 1; n <= 4; n++) ids.push((await upload(s, `t${n}.wav`, makeWav(60 + n, { title: `T${n}`, trackNo: n }))).track.id)
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/tracks/${ids[1]}` })).statusCode, 204)
    await waitFor({ T1: 1, T3: 2, T4: 3 })
    // T3 переписан в файле (номер 2), но id тот же — лайки и плейлисты не переезжают
    const ch = (await s.app.inject('/api/changes?since=0')).json() as Changes
    const t3 = ch.tracks.find((t) => t.id === ids[2])!
    assert.equal(t3.status, 'available')
    assert.equal(t3.trackNo, 2)
  })

  test('перенумеровать подряд: дыра закрывается, одинаковые номера расходятся, никто не прыгает в середину', async () => {
    for (const [title, no] of [['A', 1], ['B', 2], ['D', 4], ['E1', 5], ['E2', 5], ['F', 6]] as const) {
      await upload(s, `${title}.wav`, makeWav(70 + title.charCodeAt(0) + title.length, { title, trackNo: no }))
    }
    const res = await s.app.inject({ method: 'POST', url: '/api/tracks/renumber' })
    assert.equal(res.statusCode, 202)
    assert.equal(res.json().changes, 2) // только D и E1: A, B, E2 и F по счёту и так на своих местах
    await waitFor({ A: 1, B: 2, D: 3, E1: 4, E2: 5, F: 6 })
  })

  test('правка трека пишет в файл и год', async () => {
    const t = (await upload(s, 'Y - Song.wav', makeWav(85, { title: 'Song', artist: 'Y', trackNo: 1 }))).track
    const res = await s.app.inject({ method: 'PATCH', url: `/api/tracks/${t.id}`, payload: { year: 2021 } })
    assert.equal(res.statusCode, 200, res.body)
    const { track } = res.json() as { track: Track }
    assert.equal(track.year, 2021)
    assert.equal(track.id, t.id)
    assert.equal(idOf(await readFile(join(s.uploads, track.fileName))), track.hash)
  })

  test('файл изменили на диске мимо MUSICH — скан перечитывает теги, лайк и номер остаются', async () => {
    const t = (await upload(s, 'Disk - Old.wav', makeWav(86, { title: 'Old', artist: 'Disk', trackNo: 7 }))).track
    await s.app.inject({ method: 'PUT', url: `/api/tracks/${t.id}/like`, payload: { liked: true } })
    // «редактор тегов» переписал файл на месте
    writeFileTags(join(s.uploads, 'Disk - Old.wav'), { title: 'New' })
    const scan = await scanLibrary(s.lib)
    assert.equal(scan.updated, 1)
    const all = (await s.app.inject('/api/tracks')).json() as Track[]
    assert.equal(all.length, 1)
    assert.equal(all[0].title, 'New')
    assert.equal(all[0].trackNo, 7)
    assert.equal(all[0].liked, true)
    assert.equal(all[0].id, t.id)
    assert.notEqual(all[0].hash, t.hash)
    // повторный скан уже ничего не трогает
    assert.equal((await scanLibrary(s.lib)).updated, 0)
  })

  test('файл пропал с диска — скан убирает трек из библиотеки, номера не трогает', async () => {
    await upload(s, 'Keep - One.wav', makeWav(81, { title: 'One', artist: 'Keep', trackNo: 1 }))
    await upload(s, 'Gone - Two.wav', makeWav(82, { title: 'Two', artist: 'Gone', trackNo: 2 }))
    await upload(s, 'Keep - Three.wav', makeWav(83, { title: 'Three', artist: 'Keep', trackNo: 3 }))
    await rm(join(s.uploads, 'Gone - Two.wav'))
    const scan = await scanLibrary(s.lib)
    assert.equal(scan.missing, 1)
    assert.deepEqual(await numbers(), { One: 1, Three: 3 })
  })
})

describe('MUSICH_TOKEN из окружения (для старых клиентов)', () => {
  let s: TestServer
  before(async () => {
    s = await startServer({ MUSICH_TOKEN: 'secret-token' }, { login: false })
  })
  after(() => s.close())

  test('без токена 401, с токеном 200, health открыт', async () => {
    const no = await s.app.inject('/api/tracks')
    assert.equal(no.statusCode, 401)
    assert.equal(no.json().error, 'unauthorized')
    assert.equal((await s.app.inject({ url: '/api/tracks', headers: { authorization: 'Bearer wrong' } })).statusCode, 401)
    assert.equal((await s.app.inject({ url: '/api/tracks', headers: { authorization: 'Bearer secret-token' } })).statusCode, 200)
    // ключ входа в адресе больше не принимается — только заголовок (в адресах — медиа-ключ ?mk=)
    assert.equal((await s.app.inject('/api/tracks?token=secret-token')).statusCode, 401)
    assert.equal((await s.app.inject('/api/health')).statusCode, 200)
    const up = await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('x.wav', makeWav(20)) })
    assert.equal(up.statusCode, 401)
  })

  test('неизвестный путь API → 404 ApiError', async () => {
    const res = await s.app.inject({ url: '/api/nope', headers: { authorization: 'Bearer secret-token' } })
    assert.equal(res.statusCode, 404)
    assert.equal(res.json().error, 'not_found')
  })
})

describe('STATIC_DIR', () => {
  let s: TestServer
  before(async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const web = await mkdtemp(join(tmpdir(), 'musich-web-'))
    await mkdir(join(web, 'assets'))
    await writeFile(join(web, 'index.html'), '<!doctype html><title>MUSICH</title>')
    await writeFile(join(web, 'assets', 'app.js'), 'console.log(1)')
    s = await startServer({ STATIC_DIR: web })
  })
  after(() => s.close())

  test('раздаёт веб-морду и SPA-фолбэк', async () => {
    assert.match((await s.app.inject('/')).body, /MUSICH/)
    assert.equal((await s.app.inject('/assets/app.js')).body, 'console.log(1)')
    assert.match((await s.app.inject('/library')).body, /MUSICH/)
    assert.equal((await s.app.inject('/assets/missing.js')).statusCode, 404)
    assert.equal((await s.app.inject('/api/nope')).json().error, 'not_found')
    assert.equal((await s.app.inject('/api/health')).json().ok, true)
  })
})
