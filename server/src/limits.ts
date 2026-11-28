import { randomInt } from 'node:crypto'
import { HttpError } from './errors.ts'

/**
 * Перебор пароля или кода подключения: с одного адреса — не больше max неудач за окно, потом пауза.
 * Живёт в памяти: перезапуск сервера счётчики сбрасывает, а для перебора это всё равно капля
 */
export class Attempts {
  private readonly seen = new Map<string, { fails: number; first: number; until: number }>()
  private readonly max: number
  private readonly window: number
  private readonly block: number

  constructor(max = 5, windowMs = 15 * 60_000, blockMs = 15 * 60_000) {
    this.max = max
    this.window = windowMs
    this.block = blockMs
  }

  /** Сколько ещё ждать, мс (0 — можно пробовать) */
  wait(key: string): number {
    const e = this.seen.get(key)
    if (!e) return 0
    const now = Date.now()
    if (e.until > now) return e.until - now
    if (now - e.first > this.window) this.seen.delete(key)
    return 0
  }

  fail(key: string) {
    const now = Date.now()
    let e = this.seen.get(key)
    if (!e || now - e.first > this.window) e = { fails: 0, first: now, until: 0 }
    e.fails++
    if (e.fails >= this.max) e.until = now + this.block
    this.seen.set(key, e)
    // старые записи не копим
    if (this.seen.size > 10_000) for (const [k, v] of this.seen) if (v.until < now && now - v.first > this.window) this.seen.delete(k)
  }

  ok(key: string) {
    this.seen.delete(key)
  }
}

export const tooMany = (ms: number) =>
  new HttpError(429, 'too_many_attempts', `Слишком много попыток — подождите ${Math.max(1, Math.ceil(ms / 60_000))} мин`)

const CODE_TTL = 10 * 60_000

/**
 * Коды подключения устройства (docs/SYNC.md): 6 цифр, живут 10 минут, срабатывают один раз.
 * Подключённое устройство показывает код (и QR), новое вводит его и получает свой постоянный ключ
 */
export class PairCodes {
  // код → до какого времени живёт и чей он: подключённое по коду устройство входит как тот, кто код создал
  private readonly codes = new Map<string, { until: number; userId: string }>()
  private globalFails: number[] = []

  create(userId: string): { code: string; expiresAt: string } {
    this.sweep()
    if (this.codes.size >= 20) throw new HttpError(429, 'too_many_codes', 'Слишком много кодов сразу — подождите пару минут')
    let code: string
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    while (this.codes.has(code))
    const until = Date.now() + CODE_TTL
    this.codes.set(code, { until, userId })
    return { code, expiresAt: new Date(until).toISOString() }
  }

  /**
   * Код верный и живой — сгорает сразу, ответ — чей он; неверный — undefined.
   * Неверных подряд слишком много со всего мира — гасим все коды
   */
  take(raw: string): string | undefined {
    this.sweep()
    const code = raw.replace(/\D/g, '')
    const hit = this.codes.get(code)
    if (hit && this.codes.delete(code)) return hit.userId
    const now = Date.now()
    this.globalFails = this.globalFails.filter((t) => now - t < CODE_TTL)
    this.globalFails.push(now)
    if (this.globalFails.length > 50) this.codes.clear()
    return undefined
  }

  private sweep() {
    const now = Date.now()
    for (const [c, { until }] of this.codes) if (until <= now) this.codes.delete(c)
  }
}
