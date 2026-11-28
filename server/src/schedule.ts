import { watch, type FSWatcher } from 'node:fs'
import type { Library } from './library.ts'
import type { Prefs } from './prefs.ts'

const HOUR = 3_600_000
// после последнего изменения в папке ждём, пока файл докопируется
const SETTLE_MS = 4000

export interface Schedule {
  /** Папки поменялись (добавили, убрали) — следим за новым списком */
  refresh(): void
  stop(): void
}

/**
 * Фоновые дела сервера: чистка корзины раз в час, скан по расписанию (раз в rescanMinutes, 0 — выкл)
 * и слежка за папками — новый или изменённый файл подхватывается сам, без кнопки «пересканировать»
 */
export function startSchedule(lib: Library, scan: (folders?: string[]) => Promise<void>): Schedule {
  const clean = () => void lib.cleanTrash().catch((e: Error) => lib.log.warn({ err: e.message }, 'корзина: чистка упала'))
  clean()
  const cleanTimer = setInterval(clean, HOUR)
  cleanTimer.unref()

  let rescanTimer: NodeJS.Timeout | null = null
  let watchers: FSWatcher[] = []
  let settle: NodeJS.Timeout | null = null
  const dirty = new Set<string>()
  let current = lib.prefs()

  // изменения копятся, скан — когда в папках всё затихло и сам сервер ничего не переписывает
  // (перенумерация меняет файлы сотнями — сканировать посреди неё незачем)
  const flush = () => {
    settle = null
    if (lib.busy) return arm()
    const folders = [...dirty]
    dirty.clear()
    if (folders.length) void scan(folders)
  }
  const arm = () => {
    if (settle) clearTimeout(settle)
    settle = setTimeout(flush, SETTLE_MS)
    settle.unref()
  }

  const unwatch = () => {
    for (const w of watchers) w.close()
    watchers = []
  }
  const rewatch = () => {
    unwatch()
    if (!current.watch) return
    for (const folder of lib.folderPaths()) {
      try {
        const w = watch(folder, { recursive: true }, (_ev, name) => {
          // свои служебные папки (.musich-tmp, .musich-trash) и прочие скрытые — не повод сканировать
          if (name && String(name).split(/[\\/]/).some((part) => part.startsWith('.'))) return
          dirty.add(folder)
          arm()
        })
        w.on('error', (e) => lib.log.warn({ folder, err: e.message }, 'слежка за папкой остановилась'))
        w.unref()
        watchers.push(w)
      } catch (e) {
        lib.log.warn({ folder, err: (e as Error).message }, 'не получается следить за папкой — остаётся скан по расписанию')
      }
    }
  }

  const reschedule = () => {
    if (rescanTimer) clearInterval(rescanTimer)
    rescanTimer = null
    if (current.rescanMinutes > 0) {
      rescanTimer = setInterval(() => void scan(), current.rescanMinutes * 60_000)
      rescanTimer.unref()
    }
  }

  rewatch()
  reschedule()
  lib.onPrefsChange = (p: Prefs) => {
    const prev = current
    current = p
    if (p.watch !== prev.watch) rewatch()
    if (p.rescanMinutes !== prev.rescanMinutes) reschedule()
    // срок корзины сократили — лишнее стираем сразу
    if (p.trashDays < prev.trashDays) clean()
  }

  return {
    refresh: rewatch,
    stop() {
      clearInterval(cleanTimer)
      if (rescanTimer) clearInterval(rescanTimer)
      if (settle) clearTimeout(settle)
      unwatch()
      lib.onPrefsChange = undefined
    },
  }
}
