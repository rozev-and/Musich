import { it, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { watchFolder } from '../src/watch.js'
import { audio, exists, idOf, setup, sleep, type Env } from './helpers.js'

let env: Env | undefined
after(async () => env?.cleanup())

async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('не дождался')
    await sleep(50)
  }
}

it('watch: новый файл в папке заливается, новый трек с сервера скачивается', async () => {
  env = await setup({ pollIntervalSec: 1, stableMs: 100 })
  const e = env
  const ac = new AbortController()
  const running = watchFolder(e.ctx, { signal: ac.signal, debounceMs: 100 })
  try {
    const data = audio()
    await fs.writeFile(path.join(e.folder, 'Watch - Me.mp3'), data)
    await until(() => e.server.tracks.has(idOf(data)))

    e.server.addTrack('Poll - Me.mp3', audio())
    await until(() => exists(path.join(e.folder, 'Poll - Me.mp3')))
  } finally {
    ac.abort()
    await running
  }
  assert.equal(e.server.count('POST', /^\/api\/tracks$/), 1)
})
