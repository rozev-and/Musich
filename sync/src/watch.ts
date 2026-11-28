// Демон: следит за папкой и раз в pollIntervalSec опрашивает /changes. Проходы не пересекаются.
import { watch as fsWatch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import { describeError } from './api.js'
import { TMP_SUFFIX } from './files.js'
import { syncOnce, type Context, type PassResult } from './sync.js'

export interface WatchOptions {
  signal: AbortSignal
  /** Пауза после события в папке, чтобы собрать пачку изменений в один проход. */
  debounceMs?: number
  onPass?: (result: PassResult | Error) => void
}

export async function watchFolder(ctx: Context, opts: WatchOptions): Promise<void> {
  const { log, config } = ctx
  const debounceMs = opts.debounceMs ?? 1500
  let running = false
  let again = false
  let timer: NodeJS.Timeout | undefined

  const schedule = (ms: number) => {
    if (opts.signal.aborted) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void pass(), ms)
  }

  async function pass(): Promise<void> {
    timer = undefined
    if (running) {
      again = true
      return
    }
    running = true
    try {
      const r = await syncOnce(ctx)
      const summary = [
        r.uploaded.length && `↑${r.uploaded.length}`,
        r.downloaded.length && `↓${r.downloaded.length}`,
        r.removedByServer.length && `✗${r.removedByServer.length}`,
        r.removedByUser.length && `−${r.removedByUser.length}`,
      ].filter(Boolean)
      if (summary.length) log.info(`Проход: ${summary.join(' ')}, курсор ${r.cursor}`)
      // Файлы ещё пишутся — заглянем снова, когда они должны успокоиться.
      if (r.growing.length) again = true
      opts.onPass?.(r)
    } catch (e) {
      log.error(`Синхронизация не удалась: ${describeError(e)}. Попробую снова через ${config.pollIntervalSec} с`)
      opts.onPass?.(e as Error)
    } finally {
      running = false
      if (again && !opts.signal.aborted) {
        again = false
        schedule(Math.max(debounceMs, config.stableMs))
      }
    }
  }

  let watcher: FSWatcher | undefined
  try {
    watcher = fsWatch(config.folder, { recursive: true }, (_event, name) => {
      if (name && String(name).endsWith(TMP_SUFFIX)) return
      if (name && path.basename(String(name)).startsWith('.')) return
      if (running) again = true
      else schedule(debounceMs)
    })
    watcher.on('error', (e) => log.warn(`Слежение за папкой: ${describeError(e)}; остаётся опрос по таймеру`))
  } catch (e) {
    log.warn(`Не получилось следить за папкой (${describeError(e)}), работаю только по таймеру`)
  }

  const interval = setInterval(() => void pass(), config.pollIntervalSec * 1000)
  log.info(`Слежу за ${config.folder}, опрос сервера раз в ${config.pollIntervalSec} с. Ctrl+C — остановить`)
  await pass()

  await new Promise<void>((resolve) => {
    if (opts.signal.aborted) return resolve()
    opts.signal.addEventListener('abort', () => resolve(), { once: true })
  })
  clearInterval(interval)
  if (timer) clearTimeout(timer)
  watcher?.close()
  // Даём текущему проходу закончиться, чтобы не оборвать запись состояния.
  while (running) await new Promise((r) => setTimeout(r, 50))
}
