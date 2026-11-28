// Сквозная проверка бинаря: init → run → status → remove, конфиг во временной папке через MUSICH_CONFIG_DIR.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FakeServer } from './fake-server.js'
import { audio, tempDir, writeOld } from './helpers.js'

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js')

function cli(args: string[], configDir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, MUSICH_CONFIG_DIR: configDir } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    )
  })
}

describe('CLI musich-sync', () => {
  it('init → run → status → remove', async () => {
    const root = await tempDir()
    const server = await new FakeServer().start()
    try {
      const folder = path.join(root, 'Music')
      const dir = path.join(root, 'config')
      let r = await cli(['init', '--server', server.url, '--folder', folder, '--name', 'CLI'], dir)
      assert.equal(r.code, 0, r.stderr)
      const config = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as { deviceId: string; folder: string }
      assert.ok(server.devices.has(config.deviceId))
      assert.equal(config.folder, folder)

      await writeOld(path.join(folder, 'Cli - Upload.mp3'), audio())
      const remote = server.addTrack('Cli - Download.mp3', audio())
      r = await cli(['run'], dir)
      assert.equal(r.code, 0, r.stderr)
      assert.deepEqual((await fs.readdir(folder)).sort(), ['Cli - Download.mp3', 'Cli - Upload.mp3'])

      r = await cli(['status', '--json'], dir)
      assert.equal(r.code, 0, r.stderr)
      const s = JSON.parse(r.stdout) as { localTracks: number; remoteTracks: number; cursor: number }
      assert.equal(s.localTracks, 2)
      assert.equal(s.remoteTracks, 2)
      assert.ok(s.cursor > 0)

      r = await cli(['remove', remote.id, '--local'], dir)
      assert.equal(r.code, 0, r.stderr)
      assert.deepEqual(await fs.readdir(folder), ['Cli - Upload.mp3'])

      r = await cli(['remove', remote.id], dir)
      assert.equal(r.code, 2, 'без --local/--everywhere — ошибка использования')

      r = await cli(['run'], path.join(root, 'empty'))
      assert.equal(r.code, 1)
      assert.match(r.stderr, /init/)
    } finally {
      await server.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
