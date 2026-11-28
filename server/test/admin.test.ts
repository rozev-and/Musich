import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { Track } from '../src/library.ts'
import { addUser, makeWav, multipart, startServer, TEST_PASSWORD, type TestServer, type TestUser } from './helpers.ts'

// Администраторы управляют сервером наравне с владельцем; роли и передачу владения меняет только владелец
describe('администраторы и передача владения', () => {
  let s: TestServer
  let anna: TestUser
  let boris: TestUser
  const role = (u: TestUser) => async () => ((await u.inject('/api/auth/status')).json() as { user: { role: string } }).user.role

  before(async () => {
    s = await startServer()
    anna = await addUser(s, 'anna')
    boris = await addUser(s, 'boris')
  })
  after(() => s.close())

  test('обычный пользователь не управляет сервером', async () => {
    assert.equal((await anna.inject('/api/users')).statusCode, 403)
  })

  test('владелец делает администратора — тот управляет сервером, но не ролями', async () => {
    const r = await s.app.inject({ method: 'PUT', url: `/api/users/${anna.id}/role`, payload: { role: 'admin' } })
    assert.equal(r.statusCode, 200, r.body)
    assert.equal(await role(anna)(), 'admin')
    assert.equal((await anna.inject('/api/users')).statusCode, 200)
    assert.equal((await anna.inject('/api/server/settings')).statusCode, 200)
    // смотрит чужую библиотеку
    assert.equal((await anna.inject({ url: '/api/changes?since=0', headers: { 'x-musich-as': boris.id } })).statusCode, 200)
    // обычного пользователя сбросить может, владельца — нет, роли раздавать — нет
    assert.equal((await anna.inject({ method: 'PUT', url: `/api/users/${boris.id}/password`, payload: { password: 'new-password-1' } })).statusCode, 204)
    assert.equal((await anna.inject({ method: 'PUT', url: `/api/users/${s.ownerId}/password`, payload: { password: 'new-password-1' } })).statusCode, 403)
    assert.equal((await anna.inject({ method: 'DELETE', url: `/api/users/${s.ownerId}` })).statusCode, 403)
    assert.equal((await anna.inject({ method: 'PUT', url: `/api/users/${boris.id}/role`, payload: { role: 'admin' } })).statusCode, 403)
  })

  test('владелец снимает администратора', async () => {
    const r = await s.app.inject({ method: 'PUT', url: `/api/users/${anna.id}/role`, payload: { role: 'user' } })
    assert.equal(r.statusCode, 200)
    assert.equal(await role(anna)(), 'user')
    assert.equal((await anna.inject('/api/users')).statusCode, 403)
  })

  test('передача владения: нужен пароль; прежний владелец — администратор; id треков не путаются', async () => {
    // трек владельца до передачи: id = отпечаток файла
    const wav = makeWav(70, { title: 'Owner song', artist: 'Band' })
    const mine = (await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Band - Owner.wav', wav) })).json() as Track

    const wrong = await s.app.inject({ method: 'POST', url: `/api/users/${anna.id}/owner`, payload: { password: 'nope-nope' } })
    assert.equal(wrong.statusCode, 401)
    const ok = await s.app.inject({ method: 'POST', url: `/api/users/${anna.id}/owner`, payload: { password: TEST_PASSWORD } })
    assert.equal(ok.statusCode, 200, ok.body)
    assert.equal(await role(anna)(), 'owner')
    assert.equal(((await s.app.inject('/api/auth/status')).json() as { user: { role: string } }).user.role, 'admin')

    // тот же файл у нового владельца — отдельный трек с другим id (у прежнего id = отпечаток так и остался за ним)
    const hers = (await anna.inject({ method: 'POST', url: '/api/tracks', ...multipart('Band - Owner.wav', wav) })).json() as Track
    assert.ok(hers.id)
    assert.notEqual(hers.id, mine.id)
    assert.equal(((await s.app.inject(`/api/tracks/${mine.id}`)).json() as Track).title, 'Owner song')
  })
})
