// Простая межпроцессная блокировка: watch, run, remove и pull не пишут state.json одновременно.
import { promises as fs } from 'node:fs'
import path from 'node:path'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function withLock<T>(dir: string, fn: () => Promise<T>, waitMs = 120_000): Promise<T> {
  const file = path.join(dir, 'sync.lock')
  await fs.mkdir(dir, { recursive: true })
  const started = Date.now()
  for (;;) {
    try {
      const handle = await fs.open(file, 'wx')
      await handle.writeFile(String(process.pid))
      await handle.close()
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const owner = Number.parseInt(await fs.readFile(file, 'utf8').catch(() => ''), 10)
      // Хозяин блокировки умер (или файл пустой после сбоя) — забираем.
      if (!Number.isFinite(owner) || (owner !== process.pid && !alive(owner))) {
        await fs.rm(file, { force: true })
        continue
      }
      if (Date.now() - started > waitMs) {
        throw new Error(`Синхронизация уже идёт в другом процессе (pid ${owner}). Если это не так — удалите ${file}`)
      }
      await sleep(200)
    }
  }
  try {
    return await fn()
  } finally {
    await fs.rm(file, { force: true })
  }
}
