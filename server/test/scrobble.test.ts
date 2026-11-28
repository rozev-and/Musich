import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import type { Auth } from '../src/auth.ts'
import type { Track } from '../src/library.ts'
import { lastfmSig, Scrobbler } from '../src/scrobble.ts'
import { makeWav, multipart, startServer, type TestServer } from './helpers.ts'

// Скробблинг без настоящих сервисов: подставной fetch записывает, что ушло
describe('скробблинг', () => {
  let s: TestServer
  before(async () => {
    s = await startServer()
  })
  after(() => s.close())

  test('подпись Last.fm: параметры по алфавиту, без format, + секрет', () => {
    const sig = lastfmSig({ method: 'auth.getToken', api_key: 'K', format: 'json' }, 'S')
    assert.equal(sig, createHash('md5').update('api_keyKmethodauth.getTokenS').digest('hex'))
  })

  test('ListenBrainz: подключение, отправка новых прослушиваний, короткие треки не уходят', async () => {
    const sent: { url: string; body: unknown }[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/validate-token')) return new Response(JSON.stringify({ valid: true, user_name: 'me' }))
      sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      return new Response('{}')
    }) as typeof fetch
    const auth = { listUsers: () => [{ id: s.ownerId! }] } as unknown as Auth
    const sc = new Scrobbler((s.lib as unknown as { db: never }).db, s.lib, auth, fake)

    const st = await sc.connectListenBrainz(s.ownerId!, ' tok ')
    assert.equal(st.listenbrainz.connected, true)
    assert.equal(st.listenbrainz.user, 'me')

    const long = (await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Sc - Long.wav', makeWav(31, { title: 'Long', artist: 'Sc' }, 31)) })).json() as Track
    const short = (await s.app.inject({ method: 'POST', url: '/api/tracks', ...multipart('Sc - Short.wav', makeWav(3, { title: 'Short', artist: 'Sc' }, 3)) })).json() as Track
    const at = (sec: number) => new Date(Date.now() + sec * 1000).toISOString()
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/plays', payload: { trackId: long.id, at: at(1) } })).statusCode < 300, true)
    await s.app.inject({ method: 'POST', url: '/api/plays', payload: { trackId: short.id, at: at(2) } })

    await sc.tick()
    assert.equal(sent.length, 1)
    const body = sent[0].body as { listen_type: string; payload: { track_metadata: { track_name: string; artist_name: string } }[] }
    assert.equal(body.listen_type, 'single')
    assert.deepEqual(body.payload.map((p) => p.track_metadata.track_name), ['Long'])
    assert.equal(sc.status(s.ownerId!).listenbrainz.sent, 1)

    // второй круг — нечего отправлять (курсор сдвинулся, короткий трек тоже пройден)
    await sc.tick()
    assert.equal(sent.length, 1)

    assert.equal(sc.disconnect(s.ownerId!, 'listenbrainz').listenbrainz.connected, false)
  })

  test('ключи наружу не отдаются, плохой ключ Last.fm — 400', async () => {
    const r = await s.app.inject('/api/scrobble')
    assert.equal(r.statusCode, 200)
    assert.ok(!JSON.stringify(r.json()).includes('token'))
    const bad = await s.app.inject({ method: 'POST', url: '/api/scrobble/lastfm/start', payload: { apiKey: 'x', secret: 'y' } })
    assert.equal(bad.statusCode, 400)
  })
})
