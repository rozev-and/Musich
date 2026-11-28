import { Capacitor, registerPlugin } from '@capacitor/core'

/**
 * Поиск MUSICH в домашней сети. Сервер объявляет себя по mDNS (`_musich._tcp`), телефон ищет системным поиском
 * (свой плагин Discovery, android/…/DiscoveryPlugin.java). Если роутер глушит такие пакеты — перебираем адреса
 * в подсети, где сервер был в последний раз: роутер обычно меняет только последнее число адреса.
 * Свой сервер узнаём по node — id, который он отдаёт в /api/health (без входа)
 */

export interface FoundServer {
  lan?: string[] // адреса сервера в домашней сети (из /api/health)
  url: string // http://192.168.0.161:2290
  node: string
  name: string
}

interface NsdResult {
  host: string
  port: number
  name?: string
  node?: string
  addr?: string // все адреса сервера через запятую
}

const Discovery = registerPlugin<{ discover(o: { timeout: number }): Promise<{ servers: NsdResult[] }> }>('Discovery')

/** Отвечает ли по адресу MUSICH — и какой (node, имя) */
export async function hello(url: string, timeout = 1500): Promise<FoundServer | null> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeout) })
    if (!res.ok) return null
    const data = (await res.json()) as { ok?: boolean; node?: string; name?: string; lan?: string[] }
    return data?.ok && data.node ? { url, node: data.node, name: data.name || 'MUSICH', lan: Array.isArray(data.lan) ? data.lan : [] } : null
  } catch {
    return null
  }
}

/** Системный поиск mDNS: у каждого найденного пробуем его адреса, пока один не ответит */
async function viaMdns(): Promise<FoundServer[]> {
  if (!Capacitor.isNativePlatform()) return []
  const { servers } = await Discovery.discover({ timeout: 3500 }).catch(() => ({ servers: [] as NsdResult[] }))
  const out: FoundServer[] = []
  for (const s of servers) {
    const hosts = [...new Set([s.host, ...(s.addr ?? '').split(',')].map((h) => h.trim()).filter(Boolean))]
    for (const h of hosts) {
      const found = await hello(`http://${h}:${s.port}`)
      if (found) {
        out.push(found)
        break
      }
    }
  }
  return out
}

/** Перебор подсети прошлого адреса: 192.168.0.1…254 на том же порту, пачками */
async function viaSubnet(hint: string): Promise<FoundServer[]> {
  const m = hint.match(/^http:\/\/(\d+\.\d+\.\d+)\.\d+(?::(\d+))?/)
  if (!m) return []
  const [, net, port = '2290'] = m
  const out: FoundServer[] = []
  const hosts = Array.from({ length: 254 }, (_, i) => `http://${net}.${i + 1}:${port}`)
  for (let i = 0; i < hosts.length; i += 48) {
    const batch = await Promise.all(hosts.slice(i, i + 48).map((u) => hello(u, 1200)))
    for (const f of batch) if (f) out.push(f)
  }
  return out
}

/** Все MUSICH в сети. hint — прошлый адрес сервера: если mDNS молчит, ищем в его подсети */
export async function findServers(hint?: string): Promise<FoundServer[]> {
  const byNode = new Map<string, FoundServer>()
  for (const f of await viaMdns()) byNode.set(f.node, f)
  if (!byNode.size && hint) for (const f of await viaSubnet(hint)) byNode.set(f.node, f)
  return [...byNode.values()]
}
