// Конфиг и состояние клиента: где лежат, как читаются и как атомарно пишутся.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export type DownloadMode = 'all' | 'on-demand'
export type DeviceKind = 'desktop' | 'laptop' | 'phone'

export interface Config {
  server: string // базовый адрес без /api, например http://pi5.local:2290
  token?: string
  deviceId: string
  deviceName: string
  deviceKind: DeviceKind
  folder: string // абсолютный путь к папке синхронизации
  mode: DownloadMode // качать всё или только по запросу (musich-sync pull)
  pollIntervalSec: number // как часто watch опрашивает /changes
  stableMs: number // сколько файл не должен расти, чтобы считаться готовым
  retries: number // сколько раз повторять запрос при сетевой ошибке
  retryDelayMs: number // базовая пауза между повторами (растёт экспоненциально)
}

export const DEFAULTS = {
  mode: 'all' as DownloadMode,
  pollIntervalSec: 30,
  stableMs: 2000,
  retries: 5,
  retryDelayMs: 1000,
}

/** Локальный файл, который клиент уже сопоставил с треком. Ключ — путь относительно папки, через «/». */
export interface FileEntry {
  id: string // id трека на сервере (постоянный)
  hash?: string // отпечаток локального файла; нет — старая запись, тогда он равен id
  size: number
  mtimeMs: number
}

/** Минимум о серверном треке, чтобы качать по запросу и показывать status без сети. */
export interface RemoteTrack {
  id: string
  hash?: string // отпечаток файла на сервере
  artist: string
  title: string
  format: string
  fileName: string
  size: number
}

export interface State {
  version: 1
  cursor: number
  files: Record<string, FileEntry>
  /** id треков, удалённых «только здесь»: их не качаем обратно, пока не попросят (pull). */
  localOnlyDeleted: string[]
  /** Доступные на сервере треки (из ленты /changes). */
  remote: Record<string, RemoteTrack>
  lastSyncAt?: string
  lastError?: string
}

export function emptyState(): State {
  return { version: 1, cursor: 0, files: {}, localOnlyDeleted: [], remote: {} }
}

/** Папка конфига: MUSICH_CONFIG_DIR → %APPDATA%\musich → $XDG_CONFIG_HOME/musich → ~/.config/musich. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MUSICH_CONFIG_DIR) return path.resolve(env.MUSICH_CONFIG_DIR)
  if (process.platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'musich')
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'musich')
  return path.join(os.homedir(), '.config', 'musich')
}

export const configPath = (dir: string) => path.join(dir, 'config.json')
export const statePath = (dir: string) => path.join(dir, 'state.json')

async function readJson<T>(file: string): Promise<T | undefined> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  return JSON.parse(text) as T
}

/** Пишет JSON через временный файл рядом и rename — файл либо старый, либо новый целиком. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  // На Windows rename поверх файла иногда падает с EPERM/EBUSY, пока его держит антивирус или OneDrive.
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt < 10 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
        continue
      }
      await fs.rm(tmp, { force: true })
      throw e
    }
  }
}

export async function loadConfig(dir: string): Promise<Config> {
  const raw = await readJson<Partial<Config>>(configPath(dir))
  if (!raw) throw new Error(`Нет конфига в ${dir}. Сначала выполните: musich-sync init --server ... --folder ...`)
  if (!raw.server || !raw.folder || !raw.deviceId) throw new Error(`Конфиг ${configPath(dir)} неполный, выполните init заново`)
  return {
    deviceName: '',
    deviceKind: 'desktop',
    ...DEFAULTS,
    ...raw,
  } as Config
}

export async function loadConfigIfExists(dir: string): Promise<Partial<Config> | undefined> {
  return readJson<Partial<Config>>(configPath(dir))
}

export async function saveConfig(dir: string, config: Config): Promise<void> {
  await writeJsonAtomic(configPath(dir), config)
}

export async function loadState(dir: string): Promise<State> {
  const raw = await readJson<Partial<State>>(statePath(dir))
  return { ...emptyState(), ...raw, version: 1 }
}

export async function saveState(dir: string, state: State): Promise<void> {
  await writeJsonAtomic(statePath(dir), state)
}
