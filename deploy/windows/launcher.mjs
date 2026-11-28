// MUSICH на Windows без Docker: этот файл запускает Планировщик заданий при старте компьютера (service.ps1).
// Поднимает сервер отдельным процессом и перезапускает его, если тот упал; пишет журнал.
// Где что лежит:
//   программа  — папка установки (рядом с этим файлом): node.exe, app\ (сервер и веб), extension\
//   данные     — %ProgramData%\MUSICH\data (база, обложки, миниатюры) — удаление программы их не трогает
//   музыка     — первая папка %ProgramData%\MUSICH\music; свои папки добавляются в «Настройки → Папки с музыкой»
//   журнал     — %ProgramData%\MUSICH\logs\musich.log (больше 10 МБ — старый уходит в musich.log.1)
// MUSICH_HOME меняет папку данных (для проверки сборки), MUSICH_PORT — порт (по умолчанию 2290)
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const home = process.env.MUSICH_HOME || join(process.env.ProgramData || 'C:\\ProgramData', 'MUSICH')
const dirs = { data: join(home, 'data'), music: join(home, 'music'), logs: join(home, 'logs') }
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })

const logFile = join(dirs.logs, 'musich.log')
const openLog = () => {
  try {
    if (statSync(logFile).size > 10 * 1024 * 1024) renameSync(logFile, `${logFile}.1`)
  } catch {
    /* журнала ещё нет */
  }
  return createWriteStream(logFile, { flags: 'a' })
}
let log = openLog()
const note = (msg) => log.write(`${JSON.stringify({ time: Date.now(), launcher: msg })}\n`)

const env = {
  ...process.env,
  NODE_ENV: 'production',
  PORT: process.env.MUSICH_PORT || '2290',
  DATA_DIR: dirs.data,
  MUSIC_DIR: dirs.music,
  STATIC_DIR: join(root, 'app', 'public'),
  // ffmpeg (сжатие качества) — если лежит рядом с программой или установлен в системе
  PATH: `${root};${process.env.PATH ?? ''}`,
}

let fails = 0
function start() {
  const began = Date.now()
  const child = spawn(process.execPath, [join(root, 'app', 'dist', 'index.js')], {
    cwd: join(root, 'app'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  note(`сервер запущен, pid ${child.pid}`)
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  child.on('exit', (code) => {
    // падает сразу после старта — ждём дольше (до минуты), чтобы не крутиться вхолостую
    fails = Date.now() - began < 60_000 ? fails + 1 : 0
    const wait = Math.min(60_000, 2000 * 2 ** Math.min(fails, 5))
    note(`сервер остановился (код ${code}), перезапуск через ${wait / 1000} с`)
    log.end()
    log = openLog()
    setTimeout(start, wait)
  })
}
start()
