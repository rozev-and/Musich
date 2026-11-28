import { promises as fs } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { silentLog } from '../src/log.js'
import { loadConfig, loadState, saveConfig, type Config, type State } from '../src/store.js'
import { init, openContext, type Context } from '../src/sync.js'
import { FakeServer } from './fake-server.js'

export interface Env {
  server: FakeServer
  ctx: Context
  /** Папка синхронизации (временная). */
  folder: string
  /** Папка конфига (временная, вместо %APPDATA%\musich). */
  dir: string
  state(): Promise<State>
  files(): Promise<string[]>
  cleanup(): Promise<void>
}

export async function tempDir(prefix = 'musich-sync-test-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** Временная папка + конфиг + фейковый сервер; init уже выполнен. */
export async function setup(overrides: Partial<Config> = {}, token?: string): Promise<Env> {
  const root = await tempDir()
  const folder = path.join(root, 'Music')
  const dir = path.join(root, 'config')
  const server = await new FakeServer(token).start()
  await init(dir, { server: server.url, folder, name: 'Тестовый ПК', token }, silentLog)
  const config = await loadConfig(dir)
  await saveConfig(dir, { ...config, stableMs: 50, retries: 3, retryDelayMs: 5, ...overrides })
  const ctx = await openContext(dir, silentLog)
  return {
    server,
    ctx,
    folder,
    dir,
    state: () => loadState(dir),
    files: async () => (await fs.readdir(folder)).sort(),
    cleanup: async () => {
      await server.stop()
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

/** Случайное «аудио»: сервер-фейк тегов не читает, ему хватает имени файла. */
export function audio(size = 64 * 1024): Buffer {
  return randomBytes(size)
}

export function idOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

/** Файл со старым mtime — чтобы не ждать «перестал ли он расти». */
export async function writeOld(file: string, data: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, data)
  const past = new Date(Date.now() - 60_000)
  await fs.utimes(file, past, past)
}

export const exists = (file: string) => fs.stat(file).then(() => true, () => false)
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
