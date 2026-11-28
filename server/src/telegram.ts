import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { Document, Long, MemoryStorage, TelegramClient, WebCryptoProvider, type tl } from '@mtcute/web'
import { getUserSetting, setUserSetting } from './db.ts'
import { badRequest } from './errors.ts'
import type { Library } from './library.ts'
import { trackIdFromHash } from './media.ts'

/**
 * Telegram: музыка из профиля аккаунта («Музыка» на странице профиля) — в библиотеку, файлами.
 * Вход — аккаунтом пользователя (MTProto, библиотека mtcute): свои api_id и api_hash с my.telegram.org,
 * номер, код из Telegram и облачный пароль, если он есть. Сессия хранится в настройках пользователя на этом сервере
 * и даёт полный доступ к аккаунту — поэтому «Отключить» завершает её и в самом Telegram.
 * Качаем по одному файлу; уже забранное помним (id документа → id трека), повторно не качаем.
 * Боты сюда не подходят: музыку профиля через Bot API не забрать
 */

interface Conf {
  apiId?: number
  apiHash?: string
  session?: string
  account?: string
  syncedAt?: string
  imported?: Record<string, string> // id документа в Telegram → id трека
  error?: string
}

export interface TelegramStatus {
  configured: boolean
  connected: boolean
  account?: string
  syncedAt?: string
  imported: number
  running?: { done: number; total: number; added: number; failed: number }
  error?: string
}

const KEY = 'integration:telegram'

// криптография mtcute — WebAssembly; в Node её не скачать по fetch, отдаём файлом из пакета
// (типов WebAssembly в настройках сервера нет — берём из globalThis)
const WA = (globalThis as unknown as { WebAssembly: { Module: new (bytes: Uint8Array) => object } }).WebAssembly
let wasm: object | undefined
const wasmModule = () => (wasm ??= new WA.Module(readFileSync(createRequire(import.meta.url).resolve('@mtcute/wasm/mtcute.wasm')))) as never

const EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
}

const errText = (e: unknown) => (e as { text?: string })?.text ?? (e instanceof Error ? e.message : String(e))

export class Telegram {
  private readonly lib: Library
  // начатый вход: ждём код (и, может быть, пароль). Живёт до перезапуска сервера, 15 минут
  private readonly pending = new Map<string, { tg: TelegramClient; phone: string; hash?: string; at: number }>()
  private readonly running = new Map<string, NonNullable<TelegramStatus['running']>>()

  constructor(lib: Library) {
    this.lib = lib
  }

  stop() {
    for (const p of this.pending.values()) void p.tg.destroy().catch(() => {})
    this.pending.clear()
  }

  private conf(uid: string): Conf {
    try {
      return JSON.parse(getUserSetting(this.lib.db, uid, KEY) ?? '{}') as Conf
    } catch {
      return {}
    }
  }
  private save(uid: string, patch: Partial<Conf>) {
    setUserSetting(this.lib.db, uid, KEY, JSON.stringify({ ...this.conf(uid), ...patch }))
  }

  private client(c: Conf): TelegramClient {
    if (!c.apiId || !c.apiHash) throw badRequest('Сначала впиши api_id и api_hash')
    return new TelegramClient({
      apiId: c.apiId,
      apiHash: c.apiHash,
      storage: new MemoryStorage(),
      crypto: new WebCryptoProvider({ wasmInput: wasmModule() }),
      logLevel: 1, // только ошибки
      initConnectionOptions: { deviceModel: 'MUSICH', appVersion: '0.1.0' },
    })
  }

  status(uid: string): TelegramStatus {
    const c = this.conf(uid)
    const run = this.running.get(uid)
    return {
      configured: !!c.apiId && !!c.apiHash,
      connected: !!c.session,
      ...(c.account ? { account: c.account } : {}),
      ...(c.syncedAt ? { syncedAt: c.syncedAt } : {}),
      imported: Object.keys(c.imported ?? {}).length,
      ...(run ? { running: { ...run } } : {}),
      ...(c.error ? { error: c.error } : {}),
    }
  }

  configure(uid: string, apiId: string, apiHash: string) {
    const id = Number(apiId.trim())
    if (!Number.isInteger(id) || id <= 0) throw badRequest('api_id — это число')
    if (!/^[0-9a-f]{32}$/i.test(apiHash.trim())) throw badRequest('api_hash — 32 символа из цифр и букв a–f')
    this.save(uid, { apiId: id, apiHash: apiHash.trim().toLowerCase(), error: undefined })
  }

  private async dropPending(uid: string) {
    const p = this.pending.get(uid)
    this.pending.delete(uid)
    if (p) await p.tg.destroy().catch(() => {})
  }

  /** Шаг 1: номер → Telegram присылает код (в приложение Telegram или SMS) */
  async sendCode(uid: string, phone: string): Promise<{ sent: true }> {
    await this.dropPending(uid)
    const num = phone.replace(/[^\d+]/g, '')
    if (num.replace(/\D/g, '').length < 7) throw badRequest('Номер — в международном формате, например +7 999 123-45-67')
    const tg = this.client(this.conf(uid))
    try {
      await tg.connect()
      const r = await tg.sendCode({ phone: num })
      if (!('phoneCodeHash' in r)) throw badRequest('Telegram не прислал код, попробуй ещё раз')
      this.pending.set(uid, { tg, phone: num, hash: r.phoneCodeHash, at: Date.now() })
      return { sent: true }
    } catch (e) {
      await tg.destroy().catch(() => {})
      throw badRequest(`Telegram: ${errText(e)}`)
    }
  }

  private live(uid: string) {
    const p = this.pending.get(uid)
    if (!p || Date.now() - p.at > 15 * 60_000) throw badRequest('Вход устарел — начни заново')
    return p
  }

  /** Шаг 2: код. Если на аккаунте облачный пароль — { password: true }, дальше шаг 3 */
  async signIn(uid: string, code: string): Promise<{ password?: true; account?: string }> {
    const p = this.live(uid)
    try {
      await p.tg.signIn({ phone: p.phone, phoneCodeHash: p.hash!, phoneCode: code.replace(/\D/g, '') })
    } catch (e) {
      if (errText(e) === 'SESSION_PASSWORD_NEEDED') return { password: true }
      throw badRequest(`Telegram: ${errText(e)}`)
    }
    return { account: await this.finish(uid) }
  }

  /** Шаг 3: облачный пароль */
  async password(uid: string, password: string): Promise<{ account: string }> {
    const p = this.live(uid)
    try {
      await p.tg.checkPassword(password)
    } catch (e) {
      throw badRequest(errText(e) === 'PASSWORD_HASH_INVALID' ? 'Неверный пароль' : `Telegram: ${errText(e)}`)
    }
    return { account: await this.finish(uid) }
  }

  private async finish(uid: string): Promise<string> {
    const p = this.live(uid)
    const me = await p.tg.getMe()
    const account = me.username ? `@${me.username}` : me.displayName
    this.save(uid, { session: await p.tg.exportSession(), account, error: undefined })
    await this.dropPending(uid)
    return account
  }

  /** Отключить: завершаем вход в самом Telegram и забываем сессию (api_id и api_hash оставляем) */
  async disconnect(uid: string) {
    await this.dropPending(uid)
    const c = this.conf(uid)
    if (c.session) {
      const tg = this.client(c)
      try {
        await tg.importSession(c.session)
        await tg.connect()
        await tg.call({ _: 'auth.logOut' })
      } catch {
        /* сессию уже завершили в Telegram — просто забываем */
      } finally {
        await tg.destroy().catch(() => {})
      }
    }
    setUserSetting(this.lib.db, uid, KEY, JSON.stringify({ apiId: c.apiId, apiHash: c.apiHash, imported: c.imported }))
  }

  /** Забрать музыку профиля в библиотеку — в фоне; ход виден в status().running */
  importProfile(uid: string): TelegramStatus {
    const c = this.conf(uid)
    if (!c.session) throw badRequest('Сначала войди в Telegram')
    if (!this.running.has(uid)) {
      const run = { done: 0, total: 0, added: 0, failed: 0 }
      this.running.set(uid, run)
      void this.runImport(uid, run).finally(() => this.running.delete(uid))
    }
    return this.status(uid)
  }

  private async runImport(uid: string, run: NonNullable<TelegramStatus['running']>) {
    const c = this.conf(uid)
    const tg = this.client(c)
    try {
      await tg.importSession(c.session!)
      await tg.connect()
      // весь список: по 100, пока не кончится
      const docs: tl.RawDocument[] = []
      for (let offset = 0; ; ) {
        const r = await tg.call({ _: 'users.getSavedMusic', id: { _: 'inputUserSelf' }, offset, limit: 100, hash: Long.ZERO })
        if (r._ !== 'users.savedMusic') break
        for (const d of r.documents) if (d._ === 'document') docs.push(d)
        offset += r.documents.length
        if (!r.documents.length || offset >= r.count) break
      }
      run.total = docs.length
      const tmpDir = await this.lib.uploadTmpDir(uid)
      for (const d of docs) {
        const key = d.id.toString()
        const known = this.conf(uid).imported?.[key]
        if (known && this.lib.track(uid, known)) {
          run.done++
          continue
        }
        const tmp = join(tmpDir, `${randomUUID()}.upload`)
        try {
          const doc = new Document(d)
          const hash = createHash('sha256')
          const out = createWriteStream(tmp)
          for await (const chunk of tg.downloadAsIterable(doc)) {
            hash.update(chunk)
            if (!out.write(chunk)) await new Promise<void>((ok) => out.once('drain', () => ok()))
          }
          out.end()
          await finished(out)
          const audio = d.attributes.find((a): a is tl.RawDocumentAttributeAudio => a._ === 'documentAttributeAudio')
          const named = d.attributes.find((a): a is tl.RawDocumentAttributeFilename => a._ === 'documentAttributeFilename')?.fileName
          const ext = EXT[d.mimeType] ?? 'mp3'
          const fallback = [audio?.performer, audio?.title].filter(Boolean).join(' - ') || `telegram-${key}`
          const { track, created } = await this.lib.ingestUpload(uid, tmp, trackIdFromHash(hash.digest('hex')), named || `${fallback}.${ext}`, 'Telegram')
          this.save(uid, { imported: { ...this.conf(uid).imported, [key]: track.id } })
          if (created) run.added++
        } catch {
          run.failed++
        } finally {
          await rm(tmp, { force: true })
          run.done++
        }
      }
      this.save(uid, { syncedAt: new Date().toISOString(), error: undefined })
    } catch (e) {
      const text = errText(e)
      // вход завершили в Telegram («Устройства» → завершить) — сессия больше не действует
      if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED/.test(text)) this.save(uid, { session: undefined, account: undefined, error: 'Вход в Telegram завершён — войди снова' })
      else this.save(uid, { error: `Telegram: ${text}` })
    } finally {
      await tg.destroy().catch(() => {})
    }
  }
}
