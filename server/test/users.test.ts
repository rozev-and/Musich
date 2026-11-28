import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import type { Changes, Folder, Playlist, Track } from '../src/library.ts'
import { addUser, makeWav, multipart, startServer, TEST_LOGIN, TEST_PASSWORD, type TestServer, type TestUser } from './helpers.ts'

const sha16 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex').slice(0, 16)
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const hlc = (ms: number) => `${new Date(ms).toISOString()}/000000`

async function scanDone(s: TestServer) {
  for (let i = 0; i < 300 && s.lib.scanning.size; i++) await new Promise((r) => setTimeout(r, 20))
  assert.equal(s.lib.scanning.size, 0, 'скан не закончился')
}

describe('пользователи: вход и регистрация', () => {
  let s: TestServer
  before(async () => {
    s = await startServer()
  })
  after(() => s.close())

  test('setup создал владельца; статус — с пользователем, регистрация выключена', async () => {
    const st = (await s.app.inject('/api/auth/status')).json()
    assert.deepEqual(st, {
      setupDone: true, authenticated: true, registration: false, ownerNeedsLogin: false,
      user: { id: s.ownerId, login: TEST_LOGIN, name: '', role: 'owner' },
    })
    const anon = (await s.rawInject('/api/auth/status')).json()
    assert.equal(anon.authenticated, false)
    assert.equal(anon.user, undefined)
    const again = await s.rawInject({ method: 'POST', url: '/api/auth/setup', payload: { login: 'second', password: TEST_PASSWORD } })
    assert.equal(again.statusCode, 409)
  })

  test('вход: логин без учёта регистра; неверный пароль или логин — 401', async () => {
    const ok = await s.rawInject({ method: 'POST', url: '/api/auth/login', payload: { login: 'TESTS', password: TEST_PASSWORD, name: 'Pixel' } })
    assert.equal(ok.statusCode, 200)
    assert.deepEqual(Object.keys(ok.json()).sort(), ['token', 'user'])
    assert.deepEqual(ok.json().user, { id: s.ownerId, login: TEST_LOGIN, name: '', role: 'owner' })
    assert.equal((await s.rawInject({ method: 'POST', url: '/api/auth/login', payload: { login: TEST_LOGIN, password: 'wrong-password' } })).statusCode, 401)
    assert.equal((await s.rawInject({ method: 'POST', url: '/api/auth/login', payload: { login: 'nobody', password: TEST_PASSWORD } })).statusCode, 401)
  })

  test('регистрация: закрыта по умолчанию, открывается владельцем; занятый и плохой логин, короткий пароль', async () => {
    const closed = await s.rawInject({ method: 'POST', url: '/api/auth/register', payload: { login: 'bob', password: 'bob-password' } })
    assert.equal(closed.statusCode, 403)
    assert.equal(closed.json().error, 'registration_closed')
    assert.deepEqual((await s.app.inject('/api/server/settings')).json(), { registration: false })

    const open = await s.app.inject({ method: 'PATCH', url: '/api/server/settings', payload: { registration: true } })
    assert.deepEqual(open.json(), { registration: true })
    assert.equal((await s.rawInject('/api/auth/status')).json().registration, true)

    const reg = await s.rawInject({ method: 'POST', url: '/api/auth/register', payload: { login: 'bob', password: 'bob-password', name: 'Боб' } })
    assert.equal(reg.statusCode, 201, reg.body)
    assert.equal(reg.json().user.login, 'bob')
    assert.equal(reg.json().user.name, 'Боб') // name — имя в профиле
    assert.equal(reg.json().user.role, 'user')
    assert.equal((await s.rawInject({ url: '/api/profile', headers: bearer(reg.json().token) })).json().name, 'Боб')

    const taken = await s.rawInject({ method: 'POST', url: '/api/auth/register', payload: { login: 'BOB', password: 'bob-password' } })
    assert.equal(taken.statusCode, 409)
    assert.equal(taken.json().error, 'login_taken')
    for (const login of ['ab', 'с кириллицей', 'a b', 'x'.repeat(33), 'bad/slash']) {
      const bad = await s.rawInject({ method: 'POST', url: '/api/auth/register', payload: { login, password: 'bob-password' } })
      assert.equal(bad.statusCode, 400, login)
      assert.doesNotMatch(bad.json().error, /pass/)
    }
    const short = await s.rawInject({ method: 'POST', url: '/api/auth/register', payload: { login: 'carol', password: 'short' } })
    assert.equal(short.statusCode, 400)
    // в папке загрузок уже лежит чужая папка с таким именем — логин не отдаём
    await mkdir(join(s.cfg.musicDir, 'Rock'), { recursive: true })
    const clash = await s.rawInject({ method: 'POST', url: '/api/auth/register', payload: { login: 'rock', password: 'rock-password' } })
    assert.equal(clash.json().error, 'login_taken')
  })
})

describe('пользователи: всё раздельно', () => {
  let s: TestServer
  let bob: TestUser
  let mine: Track
  const wav = makeWav(501, { title: 'Shared', artist: 'Band' })
  before(async () => {
    s = await startServer()
    bob = await addUser(s, 'bob')
    mine = (await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Band - Shared.wav', wav) })).json()
  })
  after(() => s.close())

  test('чужой трек — 404: не видно, не лайкнуть, не послушать, не удалить, файла нет', async () => {
    assert.equal(mine.id, sha16(wav)) // у владельца id — как раньше, отпечаток файла
    assert.deepEqual((await bob.inject('/api/tracks')).json(), [])
    assert.equal((await bob.inject(`/api/tracks/${mine.id}`)).statusCode, 404)
    assert.equal((await bob.inject(`/api/tracks/${mine.id}/file`)).statusCode, 404)
    assert.equal((await bob.inject(`/api/tracks/${mine.id}/cover`)).statusCode, 404)
    assert.equal((await bob.inject(`/api/tracks/by-hash/${mine.hash}`)).statusCode, 404)
    assert.equal((await bob.inject({ method: 'PUT', url: `/api/tracks/${mine.id}/like`, payload: { liked: true } })).statusCode, 404)
    assert.equal((await bob.inject({ method: 'POST', url: '/api/plays', payload: { trackId: mine.id } })).statusCode, 404)
    assert.equal((await bob.inject({ method: 'PATCH', url: `/api/tracks/${mine.id}`, payload: { title: 'X' } })).statusCode, 404)
    assert.equal((await bob.inject({ method: 'DELETE', url: `/api/tracks/${mine.id}` })).statusCode, 404)
    assert.equal(s.lib.getTrack(mine.id)!.status, 'available')
    assert.equal(s.lib.getTrack(mine.id)!.liked, false)
    const ch = (await bob.inject('/api/changes?since=0')).json() as Changes
    assert.deepEqual([ch.tracks, ch.playlists, ch.covers], [[], [], []])
    assert.equal(((await bob.inject('/api/stats')).json() as { tracks: number }).tracks, 0)
    assert.deepEqual((await bob.inject('/api/plays')).json(), [])
  })

  test('один и тот же файл у двоих — два трека, два файла; у пользователя — в <загрузки>/<логин>', async () => {
    const res = await bob.inject({ method: 'POST', url: '/api/tracks', ...multipart('Band - Shared.wav', wav) })
    assert.equal(res.statusCode, 201, res.body)
    const his = res.json() as Track
    assert.notEqual(his.id, mine.id)
    assert.equal(his.id, sha16(`${bob.id}:${sha16(wav)}`))
    assert.equal(his.hash, mine.hash)
    assert.ok(existsSync(join(s.cfg.musicDir, 'bob', 'Band - Shared.wav')))
    assert.ok(existsSync(join(s.uploads, 'Band - Shared.wav')))
    // по отпечатку каждый находит свой
    assert.equal((await bob.inject(`/api/tracks/by-hash/${mine.hash}`)).json().id, his.id)
    assert.equal((await s.app.inject(`/api/tracks/by-hash/${mine.hash}`)).json().id, mine.id)
    // повторная загрузка — тот же трек
    assert.equal((await bob.inject({ method: 'POST', url: '/api/tracks', ...multipart('Band - Shared.wav', wav) })).statusCode, 200)
    // лайк одного не задевает другого
    await bob.inject({ method: 'PUT', url: `/api/tracks/${his.id}/like`, payload: { liked: true } })
    assert.equal(s.lib.getTrack(mine.id)!.liked, false)
    assert.deepEqual(((await s.app.inject('/api/tracks')).json() as Track[]).map((t) => t.id), [mine.id])
    const ch = (await bob.inject('/api/changes?since=0')).json() as Changes
    assert.deepEqual(ch.tracks.map((t) => t.id), [his.id])
  })

  test('плейлисты, устройства, корзина, настройки — свои', async () => {
    const p = (await s.app.inject({ method: 'POST', url: '/api/playlists', payload: { name: 'Мой', trackIds: [mine.id] } })).json() as Playlist
    assert.deepEqual((await bob.inject('/api/playlists')).json(), [])
    assert.equal((await bob.inject({ method: 'PATCH', url: `/api/playlists/${p.id}`, payload: { name: 'Чужой' } })).statusCode, 404)
    assert.equal((await bob.inject({ method: 'DELETE', url: `/api/playlists/${p.id}` })).statusCode, 404)
    const bp = (await bob.inject({ method: 'POST', url: '/api/playlists', payload: { name: 'Боба' } })).json() as Playlist
    assert.equal(bp.position, 0) // порядок — свой у каждого
    assert.deepEqual(((await s.app.inject('/api/playlists')).json() as Playlist[]).map((x) => x.name), ['Мой'])

    const dev = (await s.app.inject({ method: 'POST', url: '/api/devices', payload: { name: 'Pixel', kind: 'phone', hwId: 'hw-1' } })).json()
    assert.deepEqual((await bob.inject('/api/devices')).json(), [])
    assert.equal((await bob.inject({ method: 'DELETE', url: `/api/devices/${dev.id}` })).statusCode, 404)
    // тот же телефон под другим аккаунтом — своя запись
    const bdev = (await bob.inject({ method: 'POST', url: '/api/devices', payload: { name: 'Pixel', kind: 'phone', hwId: 'hw-1' } })).json()
    assert.notEqual(bdev.id, dev.id)

    await bob.inject({ method: 'PATCH', url: '/api/prefs', payload: { trashDays: 3, rescanMinutes: 5 } })
    const bprefs = (await bob.inject('/api/prefs')).json()
    assert.equal(bprefs.trashDays, 3)
    assert.equal(bprefs.rescanMinutes, 60) // расписание скана — у владельца
    assert.equal((await s.app.inject('/api/prefs')).json().trashDays, 30)

    assert.equal((await bob.inject({ method: 'POST', url: `/api/trash/${mine.id}/restore` })).statusCode, 404)
    assert.deepEqual((await bob.inject('/api/trash')).json(), [])
    assert.deepEqual((await bob.inject('/api/folders')).json(), [])
  })

  test('только владелец: пользователи, настройки сервера, папки, обзор диска, скан, бэкап — 403', async () => {
    for (const [method, url, payload] of [
      ['GET', '/api/users'], ['GET', '/api/server/settings'], ['PATCH', '/api/server/settings', { registration: false }],
      ['POST', '/api/folders', { path: s.root }], ['DELETE', `/api/folders?path=${encodeURIComponent(s.cfg.musicDir)}`],
      ['PUT', '/api/folders/uploads', { path: s.cfg.musicDir }], ['PUT', '/api/folders/owner', { path: s.cfg.musicDir, userId: bob.id }],
      ['GET', `/api/fs?path=${encodeURIComponent(s.root)}`], ['POST', '/api/scan'], ['GET', '/api/backup'],
      ['PUT', `/api/users/${s.ownerId}/password`, { password: 'hacked-password' }], ['DELETE', `/api/users/${s.ownerId}`],
    ] as [string, string, object?][]) {
      const res = await bob.inject({ method: method as 'GET', url, ...(payload ? { payload } : {}) })
      assert.equal(res.statusCode, 403, `${method} ${url}: ${res.body}`)
    }
  })

  test('журнал синхронизации — у каждого свой; событие о чужом треке не применяется', async () => {
    const phone = `phone-${randomUUID()}`
    const his = ((await bob.inject('/api/tracks')).json() as Track[])[0]
    const push = (events: unknown[]) => bob.inject({ method: 'POST', url: '/api/sync/push', payload: { events } })
    const ev = (n: number, key: string, value: boolean) => ({ id: `${phone}:${n}`, node: phone, n, hlc: hlc(Date.now() + n), type: 'like.set', key, field: 'like', value, base: null })
    const r = (await push([ev(1, his.id, false), ev(2, mine.id, true)])).json()
    assert.deepEqual([r.stored, r.applied], [2, 1])
    assert.equal(s.lib.getTrack(mine.id)!.liked, false)
    assert.equal(s.lib.getTrack(his.id)!.liked, false)
    const ownerVec = (await s.app.inject('/api/sync/hello')).json().vector as Record<string, number>
    assert.equal(ownerVec[phone], undefined)
    const bobPull = (await bob.inject({ method: 'POST', url: '/api/sync/pull', payload: { vector: {} } })).json() as { events: { key: string; node: string }[] }
    assert.ok(!bobPull.events.some((e) => e.key === mine.id && (e as unknown as { type: string }).type === 'track.add'), 'в журнале Боба нет треков владельца')
    // у сервера в журнале Боба номера свои, с 1 и без пропусков
    const server = (await bob.inject('/api/sync/hello')).json().node as string
    const ns = bobPull.events.filter((e) => e.node === server).map((e) => (e as unknown as { n: number }).n)
    assert.deepEqual(ns, ns.map((_, i) => i + 1))
    assert.equal((await bob.inject(`/api/sync/file/${mine.hash}`)).statusCode, 200) // у Боба тот же файл свой
  })

  test('вход по коду — токен того, кто создал код', async () => {
    const { code } = (await bob.inject({ method: 'POST', url: '/api/sync/codes' })).json()
    const paired = await s.rawInject({ method: 'POST', url: '/api/sync/pair', payload: { code, name: 'Телефон Боба' } })
    assert.equal(paired.statusCode, 200, paired.body)
    const st = (await s.rawInject({ url: '/api/auth/status', headers: bearer(paired.json().key) })).json()
    assert.equal(st.user.id, bob.id)
  })

  test('просмотр чужой библиотеки: владелец читает, писать нельзя; не владельцу — 403', async () => {
    const his = ((await bob.inject('/api/tracks')).json() as Track[])[0]
    const as = { 'x-musich-as': bob.id }
    const list = (await s.app.inject({ url: '/api/tracks', headers: as })).json() as Track[]
    assert.deepEqual(list.map((t) => t.id), [his.id])
    assert.equal((await s.app.inject({ url: '/api/profile', headers: as })).json().login, 'bob')
    // <audio>/<img> заголовков не шлют — ?as=
    assert.equal((await s.app.inject(`/api/tracks/${his.id}/file?as=${bob.id}`)).statusCode, 200)
    assert.equal((await s.app.inject(`/api/tracks/${his.id}/file`)).statusCode, 404)
    assert.equal((await s.app.inject({ method: 'PUT', url: `/api/tracks/${his.id}/like`, payload: { liked: true }, headers: as })).statusCode, 403)
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/playlists', payload: { name: 'X' }, headers: as })).statusCode, 403)
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/tracks/${his.id}?as=${bob.id}` })).statusCode, 403)
    assert.equal((await bob.inject({ url: '/api/tracks', headers: { 'x-musich-as': s.ownerId! } })).statusCode, 403)
    assert.equal((await bob.inject(`/api/tracks?as=${s.ownerId}`)).statusCode, 403)
    assert.equal((await s.app.inject({ url: '/api/tracks', headers: { 'x-musich-as': randomUUID() } })).statusCode, 404)
    const pre = await s.rawInject({ method: 'OPTIONS', url: '/api/tracks', headers: { origin: 'http://localhost', 'access-control-request-method': 'GET' } })
    assert.match(String(pre.headers['access-control-allow-headers']), /X-Musich-As/)
  })
})

describe('пользователи: управление владельцем', () => {
  let s: TestServer
  let bob: TestUser
  before(async () => {
    s = await startServer()
    bob = await addUser(s, 'bob', 'bob-password')
    await bob.inject({ method: 'POST', url: '/api/tracks', ...multipart('Bob - One.wav', makeWav(601)) })
  })
  after(() => s.close())

  test('список пользователей: логин, имя, роль, когда заходил, треков и места', async () => {
    const users = (await s.app.inject('/api/users')).json() as { id: string; login: string; role: string; tracks: number; bytes: number; createdAt: string; lastSeenAt: string | null }[]
    assert.deepEqual(users.map((u) => [u.login, u.role, u.tracks]), [[TEST_LOGIN, 'owner', 0], ['bob', 'user', 1]])
    const b = users.find((u) => u.login === 'bob')!
    assert.ok(b.bytes > 0)
    assert.ok(b.createdAt && b.lastSeenAt)
    assert.deepEqual(Object.keys(b).sort(), ['bytes', 'createdAt', 'id', 'lastSeenAt', 'login', 'name', 'role', 'tracks'])
  })

  test('сброс пароля: старые входы пользователя сброшены, новый пароль работает', async () => {
    const res = await s.app.inject({ method: 'PUT', url: `/api/users/${bob.id}/password`, payload: { password: 'new-bob-password' } })
    assert.equal(res.statusCode, 204)
    assert.equal((await bob.inject('/api/tracks')).statusCode, 401)
    assert.equal((await s.rawInject({ method: 'POST', url: '/api/auth/login', payload: { login: 'bob', password: 'bob-password' } })).statusCode, 401)
    const login = await s.rawInject({ method: 'POST', url: '/api/auth/login', payload: { login: 'bob', password: 'new-bob-password' } })
    assert.equal(login.statusCode, 200)
    bob = { ...bob, token: login.json().token, inject: (o) => s.rawInject({ ...(typeof o === 'string' ? { url: o } : o), headers: bearer(login.json().token) }) as never }
    assert.equal((await s.app.inject({ method: 'PUT', url: `/api/users/${randomUUID()}/password`, payload: { password: 'whatever-123' } })).statusCode, 404)
  })

  test('папку можно отдать пользователю: её треки переезжают к нему', async () => {
    const dir = join(s.root, 'shared')
    await mkdir(dir, { recursive: true })
    const a = makeWav(602, { title: 'Folder', artist: 'Disk' })
    await writeFile(join(dir, 'a.wav'), a)
    const add = await s.app.inject({ method: 'POST', url: '/api/folders', payload: { path: dir } })
    assert.equal(add.statusCode, 201)
    assert.equal((add.json() as Folder).userId, s.ownerId)
    await scanDone(s)
    assert.equal(s.lib.getTrack(sha16(a))!.status, 'available')

    const put = await s.app.inject({ method: 'PUT', url: '/api/folders/owner', payload: { path: dir, userId: bob.id } })
    assert.equal(put.statusCode, 200, put.body)
    await scanDone(s)
    assert.equal(s.lib.getTrack(sha16(a))!.status, 'deleted') // у владельца — надгробие «папку убрали»
    const his = ((await bob.inject('/api/tracks')).json() as Track[]).find((t) => t.title === 'Folder')
    assert.ok(his)
    assert.equal(his.id, sha16(`${bob.id}:${sha16(a)}`))
    assert.deepEqual(((await bob.inject('/api/folders')).json() as Folder[]).map((f) => [f.path, f.userId, f.tracks]), [[dir, bob.id, 1]])
    const all = (await s.app.inject('/api/folders')).json() as Folder[]
    assert.deepEqual(all.map((f) => f.userId), [s.ownerId, bob.id])
    assert.equal((await s.app.inject({ method: 'PUT', url: '/api/folders/owner', payload: { path: dir, userId: randomUUID() } })).statusCode, 404)
  })

  test('удалить пользователя: записи и папка загрузок стёрты, файлы назначенной папки на месте; себя нельзя', async () => {
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/users/${s.ownerId}` })).statusCode, 403)
    const uploads = join(s.cfg.musicDir, 'bob')
    assert.ok(existsSync(join(uploads, 'Bob - One.wav')))
    const res = await s.app.inject({ method: 'DELETE', url: `/api/users/${bob.id}` })
    assert.equal(res.statusCode, 204)
    assert.ok(!existsSync(uploads))
    assert.ok(existsSync(join(s.root, 'shared', 'a.wav')))
    assert.equal((await bob.inject('/api/tracks')).statusCode, 401)
    const left = s.lib.db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE user_id = ?').get(bob.id) as { n: number }
    assert.equal(left.n, 0)
    assert.deepEqual(((await s.app.inject('/api/users')).json() as { login: string }[]).map((u) => u.login), [TEST_LOGIN])
    assert.deepEqual(((await s.app.inject('/api/folders')).json() as Folder[]).map((f) => f.path), [s.cfg.musicDir])
    assert.equal((await s.app.inject({ method: 'DELETE', url: `/api/users/${bob.id}` })).statusCode, 404)
  })
})

describe('пользователи: обновление старой базы (схема 18)', () => {
  let root: string
  let app: Awaited<ReturnType<typeof buildApp>>['app']
  let lib: Awaited<ReturnType<typeof buildApp>>['lib']
  const oldToken = randomBytes(24).toString('hex')
  const ids = ['00112233445566aa', '00112233445566bb']
  const playlistId = randomUUID()

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'musich-migrate-'))
    const music = join(root, 'music')
    const data = join(root, 'data')
    await mkdir(music, { recursive: true })
    await mkdir(data, { recursive: true })
    // база, какой её оставил прежний сервер: пароль и профиль в settings, без пользователей
    const db = openDb(join(data, 'musich.db'), 18)
    const salt = randomBytes(16)
    const hash = `scrypt:${salt.toString('hex')}:${scryptSync(TEST_PASSWORD, salt, 32).toString('hex')}`
    const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    ins.run('password', hash)
    ins.run('profile', JSON.stringify({ name: 'Игорь', email: 'i@example.com' }))
    ins.run('prefs', JSON.stringify({ trashDays: 7, rescanMinutes: 0 }))
    ins.run('dupIgnored', JSON.stringify(['band—song']))
    ins.run('integration:vk:tracks', '[]')
    ins.run('paths', 'absolute')
    ins.run('journal', 'v1')
    db.prepare('INSERT INTO folders (path, uploads, added_at) VALUES (?, 1, ?)').run(music, '2026-01-01T00:00:00.000Z')
    const t = db.prepare(
      `INSERT INTO tracks (id, title, artist, album, duration, size, format, file_name, path, added_at, status, seq, hash, orig_hash, track_no, tags_v)
       VALUES (?, ?, 'Band', 'LP', 1, 100, 'wav', ?, ?, '2026-01-01T00:00:00.000Z', 'available', ?, ?, ?, ?, 2)`,
    )
    ids.forEach((id, i) => t.run(id, `Song ${i}`, `s${i}.wav`, join(music, `s${i}.wav`), i + 1, id, id, i + 1))
    for (const id of ids) db.prepare('INSERT INTO hashes (hash, track_id, seen_at) VALUES (?, ?, ?)').run(id, id, '2026-01-01T00:00:00.000Z')
    db.prepare('INSERT INTO likes (track_id, liked_at) VALUES (?, ?)').run(ids[0], '2026-01-02T00:00:00.000Z')
    db.prepare("INSERT INTO playlists (id, name, track_ids, created_at, updated_at, seq) VALUES (?, 'Old', ?, '2026-01-01', '2026-01-01', 3)").run(playlistId, JSON.stringify(ids))
    db.prepare("INSERT INTO covers (kind, key, mime, file, updated_at, seq) VALUES ('album', 'LP', 'image/png', 'x.png', '2026-01-01', 4)").run()
    db.prepare("INSERT INTO plays (track_id, played_at) VALUES (?, '2026-01-03T00:00:00.000Z')").run(ids[1])
    db.prepare("INSERT INTO devices (id, name, kind, created_at, last_seen_at, hw_id) VALUES ('dev-1', 'Nothing', 'phone', '2026-01-01', '2026-01-01', 'hw-old')").run()
    // входом пользовались недавно: вход без дела дольше 90 дней истекает (auth.ts TOKEN_IDLE_MS)
    db.prepare("INSERT INTO tokens (id, hash, name, created_at, last_used_at) VALUES ('tok-1', ?, 'Телефон', '2026-01-01', ?)").run(
      createHash('sha256').update(oldToken).digest('hex'),
      new Date().toISOString(),
    )
    db.prepare("INSERT INTO events (id, node, n, hlc, type, key, field, value, base) VALUES ('oldnode:1', 'oldnode', 1, ?, 'like.set', ?, 'like', 'true', NULL)").run(
      hlc(Date.parse('2026-01-02')), ids[0],
    )
    db.exec('DELETE FROM journal_pending')
    db.close()
    const cfg = loadConfig({ MUSIC_DIR: music, DATA_DIR: data, SCAN_ON_START: 'false' })
    ;({ app, lib } = await buildApp(cfg, { logger: false }))
    await app.ready()
  })
  after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })

  test('всё досталось владельцу: id треков прежние, лайки, плейлисты, настройки, устройства, старый вход', async () => {
    const st = (await app.inject('/api/auth/status')).json()
    assert.deepEqual([st.setupDone, st.ownerNeedsLogin, st.registration], [true, true, false])
    // старый токен телефона пускает — как владельца
    const auth = bearer(oldToken)
    const me = (await app.inject({ url: '/api/auth/status', headers: auth })).json()
    assert.equal(me.user.role, 'owner')
    assert.equal(me.user.login, null)
    assert.equal(me.user.name, 'Игорь')
    const tracks = (await app.inject({ url: '/api/tracks', headers: auth })).json() as Track[]
    assert.deepEqual(tracks.map((t) => t.id).sort(), ids)
    assert.equal(tracks.find((t) => t.id === ids[0])!.liked, true)
    assert.equal(tracks.find((t) => t.id === ids[0])!.hasCover, true) // своя обложка альбома осталась у владельца
    const pl = (await app.inject({ url: '/api/playlists', headers: auth })).json() as Playlist[]
    assert.deepEqual(pl.map((p) => [p.id, p.trackIds]), [[playlistId, ids]])
    assert.equal(((await app.inject({ url: '/api/plays', headers: auth })).json() as unknown[]).length, 1)
    assert.equal((await app.inject({ url: '/api/prefs', headers: auth })).json().trashDays, 7)
    assert.deepEqual(((await app.inject({ url: '/api/devices', headers: auth })).json() as { id: string }[]).map((d) => d.id), ['dev-1'])
    assert.equal((await app.inject({ url: `/api/tracks/by-hash/${ids[1]}`, headers: auth })).json().id, ids[1])
    assert.deepEqual(((await app.inject({ url: '/api/folders', headers: auth })).json() as Folder[]).map((f) => f.userId), [me.user.id])
    const profile = (await app.inject({ url: '/api/profile', headers: auth })).json()
    assert.deepEqual(profile, { login: null, name: 'Игорь', email: 'i@example.com' })
    const vec = (await app.inject({ url: '/api/sync/hello', headers: auth })).json().vector
    assert.equal(vec.oldnode, 1)
    // ничего не осталось без хозяина; пароль и профиль переехали в users
    for (const table of ['tracks', 'likes', 'playlists', 'plays', 'covers', 'hashes', 'devices', 'folders', 'tokens', 'events', 'user_settings', 'journal_pending'])
      assert.equal((lib.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id IS NOT ?`).get(me.user.id) as { n: number }).n, 0, table)
    assert.equal(lib.db.prepare("SELECT 1 FROM settings WHERE key IN ('password', 'profile', 'prefs')").get(), undefined)
  })

  test('claim: нынешний пароль + новый логин; дальше вход по логину', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/claim', payload: { login: 'igor', password: 'wrong-password' } })
    assert.equal(wrong.statusCode, 401)
    const bad = await app.inject({ method: 'POST', url: '/api/auth/claim', payload: { login: 'i', password: TEST_PASSWORD } })
    assert.equal(bad.statusCode, 400)
    const claim = await app.inject({ method: 'POST', url: '/api/auth/claim', payload: { login: 'igor', password: TEST_PASSWORD } })
    assert.equal(claim.statusCode, 200, claim.body)
    assert.equal(claim.json().user.login, 'igor')
    assert.equal(claim.json().user.role, 'owner')
    assert.equal((await app.inject('/api/auth/status')).json().ownerNeedsLogin, false)
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/claim', payload: { login: 'other', password: TEST_PASSWORD } })).statusCode, 409)
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'igor', password: TEST_PASSWORD } })
    assert.equal(login.statusCode, 200)
    const tracks = (await app.inject({ url: '/api/tracks', headers: bearer(login.json().token) })).json() as Track[]
    assert.equal(tracks.length, 2)
  })
})
