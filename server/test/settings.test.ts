import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { setSetting } from '../src/db.ts'
import type { Changes, Folder, Track } from '../src/library.ts'
import { makeWav, multipart, startServer, TEST_PASSWORD, type TestServer } from './helpers.ts'

const idOf = (buf: Buffer) => createHash('sha256').update(buf).digest('hex').slice(0, 16)
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

// скан после POST /folders идёт в фоне — ждём, пока папки перестанут сканироваться
async function scanDone(s: TestServer) {
  for (let i = 0; i < 200 && s.lib.scanning.size; i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(s.lib.scanning.size, 0, 'скан не закончился')
}

describe('вход без конфигов', () => {
  let s: TestServer
  before(async () => {
    s = await startServer({}, { login: false })
  })
  after(() => s.close())

  test('первый запуск: API закрыт до пароля, setup выдаёт токен, второй раз нельзя', async () => {
    const closed = await s.rawInject('/api/tracks')
    assert.equal(closed.statusCode, 401)
    assert.equal(closed.json().error, 'setup_required')
    assert.deepEqual((await s.rawInject('/api/auth/status')).json(), { setupDone: false, authenticated: false, registration: false, ownerNeedsLogin: false })

    const short = await s.rawInject({ method: 'POST', url: '/api/auth/setup', payload: { login: 'owner', password: '123' } })
    assert.equal(short.statusCode, 400)

    // подпись входа при создании владельца — браузер (user-agent), name — имя в профиле
    const setup = await s.rawInject({ method: 'POST', url: '/api/auth/setup', payload: { login: 'owner', password: TEST_PASSWORD }, headers: { 'user-agent': 'Firefox' } })
    assert.equal(setup.statusCode, 201)
    const token = setup.json().token as string
    assert.match(token, /^[0-9a-f]{48}$/)
    assert.equal((await s.rawInject({ url: '/api/tracks', headers: bearer(token) })).statusCode, 200)
    const st = (await s.rawInject({ url: '/api/auth/status', headers: bearer(token) })).json()
    assert.deepEqual(st, { setupDone: true, authenticated: true, registration: false, ownerNeedsLogin: false, user: { id: setup.json().user.id, login: 'owner', name: '', role: 'owner' } })

    const again = await s.rawInject({ method: 'POST', url: '/api/auth/setup', payload: { login: 'other', password: 'другой-пароль' } })
    assert.equal(again.statusCode, 409)
    const no = await s.rawInject('/api/tracks')
    assert.equal(no.json().error, 'unauthorized')
  })

  test('вход, токены устройств, выход, смена пароля', async () => {
    const wrong = await s.rawInject({ method: 'POST', url: '/api/auth/login', payload: { login: 'owner', password: 'not-the-password' } })
    assert.equal(wrong.statusCode, 401)
    const login = await s.rawInject({ method: 'POST', url: '/api/auth/login', payload: { login: 'owner', password: TEST_PASSWORD, name: 'Телефон' } })
    assert.equal(login.statusCode, 200)
    const token = login.json().token as string

    // токен для устройства: создаётся в веб-морде, показывается один раз
    const created = await s.rawInject({ method: 'POST', url: '/api/tokens', payload: { name: 'Pixel 8' }, headers: bearer(token) })
    assert.equal(created.statusCode, 201)
    const device = created.json() as { id: string; token: string; name: string }
    assert.equal(device.name, 'Pixel 8')
    assert.equal((await s.rawInject({ url: '/api/tracks', headers: bearer(device.token) })).statusCode, 200)

    const list = (await s.rawInject({ url: '/api/tokens', headers: bearer(token) })).json() as { id: string; name: string; current: boolean }[]
    assert.deepEqual(list.map((t) => t.name), ['Firefox', 'Телефон', 'Pixel 8'])
    assert.deepEqual(list.filter((t) => t.current).map((t) => t.name), ['Телефон'])
    assert.ok(!JSON.stringify(list).includes(device.token), 'сами токены в списке не светятся')

    assert.equal((await s.rawInject({ method: 'DELETE', url: `/api/tokens/${device.id}`, headers: bearer(token) })).statusCode, 204)
    assert.equal((await s.rawInject({ url: '/api/tracks', headers: bearer(device.token) })).statusCode, 401)

    const badChange = await s.rawInject({ method: 'PUT', url: '/api/auth/password', payload: { current: 'nope', password: 'new-password-1' }, headers: bearer(token) })
    assert.equal(badChange.statusCode, 403)
    const change = await s.rawInject({ method: 'PUT', url: '/api/auth/password', payload: { current: TEST_PASSWORD, password: 'new-password-1' }, headers: bearer(token) })
    assert.equal(change.statusCode, 204)
    assert.equal((await s.rawInject({ method: 'POST', url: '/api/auth/login', payload: { login: 'OWNER', password: 'new-password-1' } })).statusCode, 200)

    assert.equal((await s.rawInject({ method: 'POST', url: '/api/auth/logout', headers: bearer(token) })).statusCode, 204)
    assert.equal((await s.rawInject({ url: '/api/tracks', headers: bearer(token) })).statusCode, 401)
  })
})

describe('сводка, кто прислал, профиль, устройства', () => {
  let s: TestServer
  before(async () => {
    s = await startServer()
  })
  after(() => s.close())

  test('кто прислал: устройство по x-musich-device, иначе имя входа; лента и сводка', async () => {
    const dev = (await s.app.inject({ method: 'POST', url: '/api/devices', payload: { name: 'Pixel 8', kind: 'phone' } })).json() as { id: string }
    const fromPhone = await s.app.inject({ method: 'POST', url: '/api/tracks', ...withHeader(multipart('Band - One.wav', makeWav(41)), 'x-musich-device', dev.id) })
    assert.equal(fromPhone.statusCode, 201, fromPhone.body)
    assert.equal((fromPhone.json() as Track).source, 'Pixel 8')
    const fromBrowser = await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Band - Two.wav', makeWav(42)) })
    assert.equal((fromBrowser.json() as Track).source, 'tests')

    const act = (await s.app.inject('/api/activity')).json() as { incoming: unknown[]; recent: { title: string; source?: string }[] }
    assert.deepEqual(act.incoming, [])
    assert.deepEqual(act.recent.map((r) => r.source).sort(), ['Pixel 8', 'tests'])

    const st = (await s.app.inject('/api/stats')).json()
    assert.equal(st.tracks, 2)
    assert.equal(st.artists, 1)
    assert.ok(st.musicBytes > 0)
    assert.ok(st.disk === null || st.disk.total > 0)
  })

  test('профиль: сохраняется в базе, фото можно убрать', async () => {
    assert.deepEqual((await s.app.inject('/api/profile')).json(), { login: 'tests', name: '', email: '' })
    const avatar = 'data:image/png;base64,iVBORw0KGgo='
    const put = await s.app.inject({ method: 'PUT', url: '/api/profile', payload: { name: 'rozev', avatar } })
    assert.equal(put.statusCode, 200)
    assert.deepEqual(put.json(), { login: 'tests', name: 'rozev', email: '', avatar })
    assert.equal((await s.app.inject({ method: 'PUT', url: '/api/profile', payload: { avatar: 'javascript:alert(1)' } })).statusCode, 400)
    const cleared = (await s.app.inject({ method: 'PUT', url: '/api/profile', payload: { avatar: null } })).json()
    assert.deepEqual(cleared, { login: 'tests', name: 'rozev', email: '' })
  })

  test('забыть устройство', async () => {
    const list = (await s.app.inject('/api/devices')).json() as { id: string }[]
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/devices/${list[0].id}` })).statusCode, 204)
    assert.deepEqual((await s.app.inject('/api/devices')).json(), [])
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/devices/${list[0].id}` })).statusCode, 404)
  })
})

function withHeader(req: { payload: Buffer; headers: Record<string, string> }, name: string, value: string) {
  return { ...req, headers: { ...req.headers, [name]: value } }
}

describe('папки с музыкой', () => {
  let s: TestServer
  let other: string
  before(async () => {
    s = await startServer()
    other = join(s.root, 'das', 'music')
    await mkdir(join(other, 'Rock'), { recursive: true })
    await mkdir(join(s.root, 'das', '.hidden'), { recursive: true })
  })
  after(() => s.close())

  const folders = async () => (await s.app.inject('/api/folders')).json() as Folder[]

  test('первый запуск: одна папка — MUSIC_DIR, в неё же загрузки', async () => {
    assert.deepEqual(await folders(), [{ path: s.cfg.musicDir, userId: s.ownerId, uploads: true, tracks: 0, scanning: false }])
  })

  test('обзор диска сервера: только папки, без скрытых', async () => {
    const res = await s.app.inject(`/api/fs?path=${encodeURIComponent(join(s.root, 'das'))}`)
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json(), { path: join(s.root, 'das'), parent: s.root, dirs: ['music'] })
    assert.equal((await s.app.inject(`/api/fs?path=${encodeURIComponent(join(s.root, 'nope'))}`)).statusCode, 404)
    assert.equal((await s.app.inject('/api/fs?path=relative')).statusCode, 400)
    assert.equal((await s.app.inject('/api/fs')).json().parent, null) // корень
  })

  test('добавить папку: проверки, скан в фоне, счётчик треков', async () => {
    const a = makeWav(31, { title: 'Song A', artist: 'Band' })
    await writeFile(join(other, 'Rock', 'a.wav'), a)

    const post = (path: string) => s.app.inject({ method: 'POST', url: '/api/folders', payload: { path } })
    assert.equal((await post('music')).statusCode, 400)
    assert.equal((await post(join(s.root, 'nope'))).statusCode, 404)
    assert.equal((await post(s.cfg.musicDir)).statusCode, 409)
    assert.equal((await post(join(s.cfg.musicDir, '..'))).statusCode, 409) // внутри неё уже есть папка
    assert.equal((await post(s.cfg.dataDir)).statusCode, 400)

    const added = await post(other)
    assert.equal(added.statusCode, 201, added.body)
    assert.equal(added.json().scanning, true)
    await scanDone(s)
    const list = await folders()
    assert.deepEqual(list.map((f) => [f.path, f.uploads, f.tracks]), [[s.cfg.musicDir, true, 0], [other, false, 1]])
    assert.equal(s.lib.getTrack(idOf(a))!.status, 'available')
  })

  test('папка для загрузок: новые файлы ложатся в неё', async () => {
    const put = await s.app.inject({ method: 'PUT', url: '/api/folders/uploads', payload: { path: other } })
    assert.equal(put.statusCode, 200)
    assert.deepEqual((put.json() as Folder[]).map((f) => f.uploads), [false, true])
    const wav = makeWav(32)
    const up = await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Up - Load.wav', wav) })
    assert.equal(up.statusCode, 201, up.body)
    // загрузки — в подпапку пользователя: <папка загрузок>/<логин>
    assert.ok(existsSync(join(other, 'tests', 'Up - Load.wav')))
    assert.deepEqual(await readdir(join(other, 'tests', '.musich-tmp')), [])
    const file = await s.app.inject(`/api/tracks/${(up.json() as Track).id}/file`)
    assert.deepEqual(file.rawPayload, wav)
    assert.equal((await s.app.inject({ method: 'PUT', url: '/api/folders/uploads', payload: { path: '/nope' } })).statusCode, 404)
  })

  test('убрать папку: треки — надгробия, файлы на месте; вернуть — треки воскресают', async () => {
    const a = idOf(makeWav(31, { title: 'Song A', artist: 'Band' }))
    const cursor = ((await s.app.inject('/api/changes?since=0')).json() as Changes).cursor

    const del = await s.app.inject({ method: 'DELETE', url: `/api/folders?path=${encodeURIComponent(other)}` })
    assert.equal(del.statusCode, 204)
    const list = await folders()
    assert.deepEqual(list.map((f) => [f.path, f.uploads]), [[s.cfg.musicDir, true]]) // загрузки вернулись в оставшуюся
    assert.ok(existsSync(join(other, 'Rock', 'a.wav')))
    const ch = (await s.app.inject(`/api/changes?since=${cursor}`)).json() as Changes
    assert.deepEqual(ch.tracks.map((t) => t.status), ['deleted', 'deleted'])
    assert.ok(!((await s.app.inject('/api/tracks')).json() as Track[]).length)

    const last = await s.app.inject({ method: 'DELETE', url: `/api/folders?path=${encodeURIComponent(s.cfg.musicDir)}` })
    assert.equal(last.statusCode, 409)

    assert.equal((await s.app.inject({ method: 'POST', url: '/api/folders', payload: { path: other } })).statusCode, 201)
    await scanDone(s)
    assert.equal(s.lib.getTrack(a)!.status, 'available')
    assert.equal(((await s.app.inject('/api/tracks')).json() as Track[]).length, 2)
  })

  test('прогресс скана: пока идёт — сколько файлов пройдено из скольких', async () => {
    const dir = join(s.root, 'many')
    await mkdir(dir, { recursive: true })
    for (let i = 0; i < 12; i++) await writeFile(join(dir, `t${i}.wav`), makeWav(100 + i))
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/folders', payload: { path: dir } })).statusCode, 201)
    // ждём, пока сервер посчитает файлы (сначала только список, потом обработка)
    let seen: Folder | undefined
    for (let i = 0; i < 500 && s.lib.scanning.has(dir); i++) {
      const f = (await folders()).find((x) => x.path === dir)!
      if (f.scanTotal) {
        seen = f
        break
      }
      await new Promise((r) => setTimeout(r, 1))
    }
    assert.ok(seen, 'прогресс не показался')
    assert.equal(seen.scanTotal, 12)
    assert.ok(seen.scanDone! <= 12)
    await scanDone(s)
    const after = (await folders()).find((x) => x.path === dir)!
    assert.deepEqual([after.tracks, after.scanning, after.scanTotal], [12, false, undefined])
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/folders?path=${encodeURIComponent(dir)}` })).statusCode, 204)
  })

  test('пересканировать всё: 202, новые файлы находятся', async () => {
    const b = makeWav(33)
    await writeFile(join(s.cfg.musicDir, 'b.wav'), b)
    const res = await s.app.inject({ method: 'POST', url: '/api/scan' })
    assert.equal(res.statusCode, 202)
    await scanDone(s)
    assert.equal(s.lib.getTrack(idOf(b))!.status, 'available')
  })

  test('старая база: относительные пути переводятся в абсолютные', async () => {
    const wav = makeWav(34)
    await writeFile(join(s.cfg.musicDir, 'old.wav'), wav)
    await s.startScan([s.cfg.musicDir])
    const id = idOf(wav)
    s.lib.db.prepare('UPDATE tracks SET path = ? WHERE id = ?').run('old.wav', id)
    setSetting(s.lib.db, 'paths', 'relative')
    await s.lib.init()
    assert.equal((s.lib.db.prepare('SELECT path FROM tracks WHERE id = ?').get(id) as { path: string }).path, join(s.cfg.musicDir, 'old.wav'))
    assert.equal((await s.app.inject(`/api/tracks/${id}/file`)).statusCode, 200)
  })
})
