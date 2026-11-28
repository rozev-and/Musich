#!/usr/bin/env node
// musich-sync — CLI клиента синхронизации MUSICH.
import { parseArgs } from 'node:util'
import { describeError } from './api.js'
import { consoleLog } from './log.js'
import { configDir, type DeviceKind, type DownloadMode } from './store.js'
import { init, openContext, pull, remove, status, syncOnce } from './sync.js'
import { watchFolder } from './watch.js'

const HELP = `musich-sync — синхронизация папки с музыкой с сервером MUSICH

  musich-sync init --server <url> --folder <папка> [--name <имя>] [--kind desktop|laptop|phone]
                   [--token <токен>] [--mode all|on-demand] [--poll <секунд>]
  musich-sync run                          один проход синхронизации
  musich-sync watch                        демон: следит за папкой и опрашивает сервер
  musich-sync status [--json]              что на устройстве, что в очереди, курсор
  musich-sync remove <id|файл> --local     убрать только с этого устройства
  musich-sync remove <id|файл> --everywhere  удалить из хранилища (со всех устройств)
  musich-sync pull <id>                    скачать трек по запросу / вернуть удалённый «только здесь»

Общие флаги: -v/--verbose — подробный лог.
Конфиг и состояние: %APPDATA%\\musich (Windows) или ~/.config/musich; переопределяется MUSICH_CONFIG_DIR.`

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: 'string' },
      folder: { type: 'string' },
      name: { type: 'string' },
      kind: { type: 'string' },
      token: { type: 'string' },
      mode: { type: 'string' },
      poll: { type: 'string' },
      local: { type: 'boolean' },
      everywhere: { type: 'boolean' },
      json: { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [command, ...rest] = positionals
  const log = consoleLog(values.verbose)
  const dir = configDir()

  if (!command || values.help || command === 'help') {
    console.log(HELP)
    return command || values.help ? 0 : 2
  }

  switch (command) {
    case 'init': {
      if (values.kind && !['desktop', 'laptop', 'phone'].includes(values.kind)) return usage('--kind: desktop, laptop или phone')
      if (values.mode && !['all', 'on-demand'].includes(values.mode)) return usage('--mode: all или on-demand')
      const poll = values.poll ? Number(values.poll) : undefined
      if (poll !== undefined && !(poll >= 5)) return usage('--poll: число секунд, не меньше 5')
      const config = await init(
        dir,
        {
          server: values.server,
          folder: values.folder,
          name: values.name,
          kind: values.kind as DeviceKind | undefined,
          token: values.token ?? process.env.MUSICH_TOKEN,
          mode: values.mode as DownloadMode | undefined,
          pollIntervalSec: poll,
        },
        log,
      )
      log.info(`Готово. Папка: ${config.folder}, режим: ${config.mode}. Конфиг: ${dir}`)
      return 0
    }
    case 'run': {
      const ctx = await openContext(dir, log)
      const r = await syncOnce(ctx)
      log.info(
        `Залито ${r.uploaded.length}, уже было ${r.linked.length}, скачано ${r.downloaded.length}, ` +
          `удалено по серверу ${r.removedByServer.length}, удалено вручную ${r.removedByUser.length}, курсор ${r.cursor}`,
      )
      if (r.growing.length) log.info(`Ещё пишутся (возьму в следующий раз): ${r.growing.join(', ')}`)
      return r.failed.length ? 1 : 0
    }
    case 'watch': {
      const ctx = await openContext(dir, log)
      const ac = new AbortController()
      const stop = () => {
        log.info('Останавливаюсь…')
        ac.abort()
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      await watchFolder(ctx, { signal: ac.signal })
      return 0
    }
    case 'status': {
      const ctx = await openContext(dir, log)
      const s = await status(ctx)
      if (values.json) {
        console.log(JSON.stringify(s, null, 2))
        return 0
      }
      const c = s.config
      console.log(`Сервер:        ${c.server}${c.token ? ' (с токеном)' : ''}`)
      console.log(`Устройство:    ${c.deviceName} (${c.deviceKind}), id ${c.deviceId}`)
      console.log(`Папка:         ${c.folder}`)
      console.log(`Режим:         ${c.mode === 'all' ? 'качать всё' : 'только по запросу'}`)
      console.log(`Курсор:        ${s.cursor}`)
      console.log(`Последний раз: ${s.lastSyncAt ?? 'ещё не синхронизировалось'}`)
      if (s.lastError) console.log(`Ошибка:        ${s.lastError}`)
      console.log(`На устройстве: ${s.localTracks} треков, в хранилище: ${s.remoteTracks}`)
      console.log(`Ждут загрузки на сервер: ${s.toUpload.length}`)
      for (const f of s.toUpload.slice(0, 20)) console.log(`  ↑ ${f}`)
      console.log(`${c.mode === 'all' ? 'Ждут скачивания' : 'Можно скачать (pull)'}: ${s.toDownload.length}`)
      for (const t of s.toDownload.slice(0, 20)) console.log(`  ↓ ${t.id}  ${t.artist} - ${t.title}`)
      console.log(`Удалено только здесь: ${s.localOnlyDeleted.length}`)
      return 0
    }
    case 'remove': {
      const ref = rest[0]
      if (!ref) return usage('укажите id трека или путь к файлу')
      if (Boolean(values.local) === Boolean(values.everywhere)) return usage('укажите ровно один из флагов --local или --everywhere')
      const ctx = await openContext(dir, log)
      const r = await remove(ctx, ref, values.everywhere ? 'everywhere' : 'local')
      log.info(
        values.everywhere
          ? `Трек ${r.id} удалён из хранилища${r.removed.length ? ` и с устройства: ${r.removed.join(', ')}` : ''}`
          : `Трек ${r.id} убран с устройства${r.removed.length ? `: ${r.removed.join(', ')}` : ''}; обратно качаться не будет (вернуть: musich-sync pull ${r.id})`,
      )
      return 0
    }
    case 'pull': {
      const ref = rest[0]
      if (!ref) return usage('укажите id трека')
      const ctx = await openContext(dir, log)
      const r = await pull(ctx, ref)
      log.info(`Трек ${r.id} на устройстве: ${r.path}`)
      return 0
    }
    default:
      return usage(`неизвестная команда «${command}»`)
  }
}

function usage(msg: string): number {
  console.error(`musich-sync: ${msg}\n\n${HELP}`)
  return 2
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (e) => {
    console.error(`musich-sync: ${describeError(e)}`)
    process.exitCode = 1
  },
)
