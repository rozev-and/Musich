import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { freeName, isAudioFile, sanitizeName, trackFileName } from '../src/files.js'
import { configDir, writeJsonAtomic } from '../src/store.js'
import { tempDir } from './helpers.js'

describe('имена файлов', () => {
  it('убирает запрещённые в Windows символы', () => {
    assert.equal(sanitizeName('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j')
    assert.equal(sanitizeName('trailing dots... '), 'trailing dots')
    assert.equal(sanitizeName('CON'), '_CON')
    assert.equal(sanitizeName('nul.txt'), '_nul.txt')
    assert.equal(sanitizeName('   '), '_')
    assert.equal(sanitizeName('tab\there'), 'tab here')
    assert.ok(sanitizeName('x'.repeat(500)).length <= 180)
  })

  it('«Артист - Название.формат», с запасным вариантом из имени файла', () => {
    assert.equal(trackFileName({ artist: 'Кино', title: 'Группа крови', format: 'FLAC' }), 'Кино - Группа крови.flac')
    assert.equal(trackFileName({ artist: '', title: 'Intro', format: 'mp3' }), 'Intro.mp3')
    assert.equal(trackFileName({ artist: '', title: '', format: '', fileName: '01 track.ogg' }), '01 track.ogg')
  })

  it('свободное имя не затирает существующие', async () => {
    const dir = await tempDir()
    try {
      await fs.writeFile(path.join(dir, 'A - B.mp3'), 'x')
      await fs.writeFile(path.join(dir, 'A - B (2).mp3'), 'x')
      assert.equal(await freeName(dir, 'A - B.mp3'), 'A - B (3).mp3')
      assert.equal(await freeName(dir, 'C.mp3'), 'C.mp3')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('временные и не-аудио файлы игнорируются', () => {
    assert.ok(isAudioFile('song.MP3'))
    assert.ok(!isAudioFile('.abc.musich-part'))
    assert.ok(!isAudioFile('cover.jpg'))
    assert.ok(!isAudioFile('.hidden.mp3'))
  })
})

describe('конфиг', () => {
  it('MUSICH_CONFIG_DIR переопределяет папку конфига', () => {
    assert.equal(configDir({ MUSICH_CONFIG_DIR: path.join('x', 'y') }), path.resolve('x', 'y'))
    if (process.platform === 'win32') assert.equal(configDir({ APPDATA: 'C:\\AD' }), path.join('C:\\AD', 'musich'))
  })

  it('атомарная запись: целый файл и без временных хвостов', async () => {
    const dir = await tempDir()
    try {
      const file = path.join(dir, 'state.json')
      await writeJsonAtomic(file, { a: 1 })
      await Promise.all(Array.from({ length: 10 }, (_, i) => writeJsonAtomic(file, { a: i })))
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { a: number }
      assert.equal(typeof parsed.a, 'number')
      assert.deepEqual(await fs.readdir(dir), ['state.json'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
