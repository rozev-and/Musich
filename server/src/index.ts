import { buildApp, VERSION, type Server } from './app.ts'
import { loadConfig } from './config.ts'
import { announce } from './discovery.ts'

const cfg = loadConfig()
let server: Server | null = null
// объявление в локальной сети (mDNS): приложение на телефоне находит сервер само
let announcer: { stop: () => void } | null = null

// Сервер можно пересобрать на ходу (после восстановления бэкапа): закрыть старый и поднять новый на том же порту
async function start() {
  const s = await buildApp(cfg, {
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      serializers: {
        // ключи в адресе (?mk=, старый ?token=) не должны попадать в журнал
        req: (req) => ({ method: req.method, url: req.url.replace(/([?&](?:token|mk)=)[^&]*/gi, '$1***'), remoteAddress: req.ip }),
      },
    },
    onRestart: () => void restart(),
  })
  server = s
  const { app, lib, auth, startScan } = s
  await app.listen({ port: cfg.port, host: cfg.host })
  app.log.info(
    { version: VERSION, folders: lib.folderPaths(), dataDir: cfg.dataDir, staticDir: cfg.staticDir ?? null, passwordSet: auth.ready },
    'MUSICH сервер запущен',
  )
  if (!auth.ready) app.log.info(`откройте http://<адрес сервера>:${cfg.port} и задайте пароль`)
  if (process.env.MUSICH_MDNS !== '0') {
    try {
      announcer = announce({ port: cfg.port, node: s.node.id, name: s.node.name, log: app.log })
    } catch (e) {
      app.log.warn({ err: (e as Error).message }, 'mDNS: не получилось объявить сервер в сети')
    }
  }

  // Скан идёт в фоне: на Pi большая библиотека хэшируется минутами, а /api/health должен отвечать сразу
  if (cfg.scanOnStart) void startScan()
}

let restarting = false
async function restart() {
  if (restarting || !server) return
  restarting = true
  server.app.log.info('перезапускаюсь')
  try {
    announcer?.stop()
    announcer = null
    await server.app.close()
    server = null
    await start()
  } catch (e) {
    console.error('перезапуск не удался', e)
    process.exit(1)
  } finally {
    restarting = false
  }
}

let closing = false
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (closing) return
    closing = true
    server?.app.log.info({ sig }, 'останавливаюсь')
    ;(server ? server.app.close() : Promise.resolve()).then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
}

await start()
