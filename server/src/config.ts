import { resolve } from 'node:path'

export interface Config {
  port: number
  host: string
  musicDir: string   // только первая папка при самом первом запуске; дальше папки — в базе, меняются в веб-морде
  dataDir: string
  staticDir?: string
  token?: string     // устаревший MUSICH_TOKEN: если задан, тоже пускает (для уже настроенных клиентов)
  scanOnStart: boolean
  maxUploadBytes: number
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def
  return !['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase())
}

// Переменные окружения — см. docs/API.md, «Окружение сервера».
// HOST и MAX_UPLOAD_MB в контракте нет, это запасные ручки (см. CONTRACT-NOTES.md).
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 2290)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT: неверное значение «${env.PORT}»`)
  return {
    port,
    host: env.HOST || '0.0.0.0',
    musicDir: resolve(env.MUSIC_DIR || '/music'),
    dataDir: resolve(env.DATA_DIR || '/data'),
    staticDir: env.STATIC_DIR ? resolve(env.STATIC_DIR) : undefined,
    token: env.MUSICH_TOKEN || undefined,
    scanOnStart: bool(env.SCAN_ON_START, true),
    maxUploadBytes: Number(env.MAX_UPLOAD_MB || 2048) * 1024 * 1024,
  }
}
