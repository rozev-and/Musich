import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isInside, listDirSafe, type Library } from './library.ts'
import { audioFormat } from './media.ts'

export interface ScanResult {
  added: number
  updated: number // файл на месте, но его изменили (например, теги) — трек перечитан
  moved: number
  skipped: number
  failed: number
  missing: number
}

/**
 * Обходит папки с музыкой (по умолчанию — все) и добавляет файлы, которых нет в базе.
 * Ничего не удаляет и не помечает удалённым: пропавший файл — только предупреждение в лог
 * (иначе непримонтированный диск превратился бы в надгробия и стёр музыку на всех устройствах).
 */
export async function scanLibrary(lib: Library, folders: string[] = lib.folderPaths()): Promise<ScanResult> {
  const known = lib.knownPaths()
  const seen = new Set<string>()
  const res: ScanResult = { added: 0, updated: 0, moved: 0, skipped: 0, failed: 0, missing: 0 }

  // Сначала только список аудиофайлов (это быстро), чтобы веб-морда видела «сделано N из M»
  async function list(dir: string, out: string[]) {
    for (const ent of await listDirSafe(dir)) {
      if (ent.name.startsWith('.')) continue // в т.ч. наша .musich-tmp
      const abs = join(dir, ent.name)
      if (ent.isDirectory()) await list(abs, out)
      else if (ent.isFile() && audioFormat(ent.name)) out.push(abs)
    }
    return out
  }

  async function ingest(abs: string) {
    seen.add(abs)
    try {
      const k = known.get(abs)
      if (k) {
        // файл на месте: тот же размер и время — не трогаем; иначе (или время ещё не знаем) — сверяем содержимое
        const st = await stat(abs)
        if (st.size === k.size && k.mtime !== null && Math.abs(st.mtimeMs - k.mtime) < 1) {
          res.skipped++
          return
        }
        res[await lib.refreshChanged(abs, k.id)]++
        return
      }
      res[await lib.ingestScanned(abs)]++
    } catch (e) {
      res.failed++
      lib.log.warn({ file: abs, err: (e as Error).message }, 'скан: ошибка')
    }
  }

  // одну папку два скана сразу не обходят: второй её просто пропускает
  const mine = folders.filter((f) => !lib.scanning.has(f))
  for (const f of mine) lib.scanning.set(f, { done: 0, total: 0 })
  // папки, которые реально прочитали: недоступная (диск не примонтирован, нет прав) или вдруг пустая при
  // известных треках — не трогаем вовсе. Иначе все её треки стали бы надгробиями, и телефоны стёрли бы свои копии
  const readable = new Set<string>()
  try {
    for (const f of mine) {
      const ok = await readdir(f).then(() => true, () => false)
      if (!ok) {
        lib.log.warn({ folder: f }, 'скан: папка недоступна — пропускаю, треки не трогаю')
        continue
      }
      const files = await list(f, [])
      const hadTracks = [...known.keys()].some((p) => isInside(p, f))
      if (files.length || !hadTracks) readable.add(f)
      else lib.log.warn({ folder: f }, 'скан: папка пуста, а треки в ней были — похоже, диск не подключён; треки не трогаю')
      const progress = { done: 0, total: files.length }
      lib.scanning.set(f, progress)
      for (const abs of files) {
        await ingest(abs)
        progress.done++
      }
    }
  } finally {
    for (const f of mine) lib.scanning.delete(f)
  }
  // пересчитываем после обхода: переложенные файлы уже получили новый путь. Пропавшим считаем только то,
  // что было известно до начала скана (загруженное или переименованное во время скана — не трогаем)
  // и чего действительно нет на диске
  for (const p of lib.knownPaths().keys()) {
    if ([...readable].some((f) => isInside(p, f)) && !seen.has(p) && known.has(p) && !existsSync(p)) {
      res.missing++
      lib.forgetMissing(p)
      lib.log.warn({ file: p }, 'скан: файл трека пропал с диска — убран из библиотеки')
    }
  }
  return res
}
