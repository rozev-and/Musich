import { createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import mdns from 'multicast-dns'
import type { FastifyBaseLogger } from 'fastify'

/**
 * MUSICH объявляет себя в домашней сети (mDNS, `_musich._tcp`), чтобы приложение на телефоне находило его само —
 * без ввода адреса, и снова находило, когда роутер выдал ПК другой адрес (docs/SYNC.md, «Приложения и связь»).
 * Отвечаем отдельно на каждой сетевой карте и со своим адресом этой карты: у ПК бывают VPN и виртуальные сети,
 * и телефон должен получить адрес той сети, в которой он сам. Карты и адреса пересматриваем раз в 30 секунд
 */

const TYPE = '_musich._tcp.local'

// адреса домашних сетей (и сетей контейнеров): 10.x, 172.16–31.x, 192.168.x
const lanAddresses = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .filter((a) => !!a && a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))
    .map((a) => a!.address)

export function announce(o: { port: number; node: string; name: () => string; log: FastifyBaseLogger }): { stop: () => void } {
  // имя хоста — только буквы и цифры: из id узла
  const tag = createHash('sha256').update(o.node).digest('hex').slice(0, 8)
  const instance = `MUSICH-${tag}.${TYPE}`
  const host = `musich-${tag}.local`
  const sockets = new Map<string, mdns.MulticastDNS>()

  const records = (ip: string) => {
    const txt = [`node=${o.node}`, `name=${o.name()}`, `addr=${lanAddresses().join(',')}`, 'v=1']
    return {
      ptr: { name: TYPE, type: 'PTR' as const, ttl: 120, data: instance },
      rest: [
        { name: instance, type: 'SRV' as const, ttl: 120, data: { port: o.port, target: host, priority: 0, weight: 0 } },
        { name: instance, type: 'TXT' as const, ttl: 120, data: txt },
        { name: host, type: 'A' as const, ttl: 120, data: ip },
      ],
    }
  }

  const open = (ip: string) => {
    // loopback: свой же ответ слышен и на этом ПК — так сервер можно найти и проверить отсюда
    const m = mdns({ interface: ip, reuseAddr: true, loopback: true })
    m.on('query', (q) => {
      const asked = q.questions.some((x) => {
        const n = x.name.toLowerCase()
        return n === TYPE || n === instance.toLowerCase() || n === host
      })
      if (!asked) return
      const r = records(ip)
      m.respond({ answers: [r.ptr], additionals: r.rest })
    })
    m.on('error', (e: Error) => o.log.warn({ ip, err: e.message }, 'mDNS: ошибка на сетевой карте'))
    // сразу заявляем о себе — телефон, который уже ищет, увидит без повторного вопроса
    const r = records(ip)
    m.respond({ answers: [r.ptr, ...r.rest] })
    sockets.set(ip, m)
  }

  const refresh = () => {
    const ips = new Set(lanAddresses())
    for (const [ip, m] of sockets)
      if (!ips.has(ip)) {
        m.destroy()
        sockets.delete(ip)
      }
    for (const ip of ips)
      if (!sockets.has(ip)) {
        try {
          open(ip)
        } catch (e) {
          o.log.warn({ ip, err: (e as Error).message }, 'mDNS: не получилось слушать сетевую карту')
        }
      }
  }
  refresh()
  const timer = setInterval(refresh, 30_000)
  o.log.info({ addresses: [...sockets.keys()] }, 'MUSICH объявлен в локальной сети (mDNS)')
  return {
    stop() {
      clearInterval(timer)
      for (const m of sockets.values()) m.destroy()
      sockets.clear()
    },
  }
}
