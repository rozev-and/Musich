import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getSetting, getUserSetting, setSetting, setUserSetting, type Db } from './db.ts'

// ---------- медиа-ключ ----------

/**
 * Аудио и картинки грузятся тегами <audio>/<img>, которые не умеют слать заголовок с ключом входа, — ключ идёт в адресе.
 * Полный ключ входа в адресе оседал бы в журналах nginx/прокси и истории браузера. Поэтому в адрес идёт отдельный
 * медиа-ключ: только чтение файлов (аудио, обложки), живёт 14 дней, подпись — HMAC секретом сервера. Смена пароля и
 * «выйти везде» сдвигают «эпоху» пользователя — все его медиа-ключи сразу перестают действовать
 */
export const MEDIA_TTL_MS = 14 * 24 * 3600_000

const b64 = (b: Buffer) => b.toString('base64url')
function serverSecret(db: Db): Buffer {
  let s = getSetting(db, 'mediaSecret')
  if (!s) {
    s = randomBytes(32).toString('hex')
    setSetting(db, 'mediaSecret', s)
  }
  return Buffer.from(s, 'hex')
}
export const authEpoch = (db: Db, uid: string) => Number(getUserSetting(db, uid, 'authEpoch') ?? 0)
export const bumpEpoch = (db: Db, uid: string) => setUserSetting(db, uid, 'authEpoch', String(authEpoch(db, uid) + 1))

const sign = (db: Db, uid: string, exp: number) => b64(createHmac('sha256', serverSecret(db)).update(`${uid}|${exp}|${authEpoch(db, uid)}`).digest())

export function mediaKey(db: Db, uid: string, now = Date.now()) {
  const exp = now + MEDIA_TTL_MS
  return { key: `${b64(Buffer.from(uid))}.${exp.toString(36)}.${sign(db, uid, exp)}`, expiresAt: new Date(exp).toISOString() }
}

/** Медиа-ключ → чей он; undefined — подделан, просрочен или отозван */
export function verifyMediaKey(db: Db, key: string, now = Date.now()): string | undefined {
  const [u, e, sig] = key.split('.')
  if (!u || !e || !sig) return undefined
  const uid = Buffer.from(u, 'base64url').toString()
  const exp = parseInt(e, 36)
  if (!Number.isFinite(exp) || exp < now) return undefined
  const want = Buffer.from(sign(db, uid, exp))
  const got = Buffer.from(sig)
  return want.length === got.length && timingSafeEqual(want, got) ? uid : undefined
}

/** Какие адреса медиа-ключ открывает: только чтение файлов */
export const MEDIA_ROUTES = [
  /^\/api\/tracks\/[^/]+\/(file|cover)$/,
  /^\/api\/covers\/[^/]+\/[^/]+$/,
  /^\/api\/playlists\/[^/]+\/cover$/,
  /^\/api\/sync\/file\/[^/]+$/,
  /^\/api\/export$/, // выгрузка музыки zip-ом (скачивание по ссылке)
  /^\/api\/integrations\/vk\/extension$/,
]

// ---------- двухэтапный вход (TOTP, RFC 6238) ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const toB32 = (buf: Buffer) => {
  let bits = 0
  let val = 0
  let out = ''
  for (const byte of buf) {
    val = (val << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31]
  return out
}
const fromB32 = (s: string) => {
  let bits = 0
  let val = 0
  const out: number[] = []
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch)
    if (i < 0) continue
    val = (val << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** Код на момент времени (30 с, 6 цифр, HMAC-SHA1) — как в Google Authenticator, Aegis, 1Password */
export function totpCode(secretB32: string, now = Date.now(), step = 0) {
  const counter = Math.floor(now / 30_000) + step
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', fromB32(secretB32)).update(msg).digest()
  const o = h[h.length - 1] & 15
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(n % 1_000_000).padStart(6, '0')
}

interface Totp {
  secret: string
  enabled: boolean
  recovery: string[] // sha256 одноразовых кодов
  last?: number // последний принятый шаг — один код дважды не принимаем
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const readTotp = (db: Db, uid: string): Totp | null => {
  try {
    return JSON.parse(getUserSetting(db, uid, 'totp') ?? 'null')
  } catch {
    return null
  }
}
const writeTotp = (db: Db, uid: string, t: Totp | null) => setUserSetting(db, uid, 'totp', JSON.stringify(t))

export const totpEnabled = (db: Db, uid: string) => !!readTotp(db, uid)?.enabled

/** Начать включение: новый секрет (ещё не включён), адрес для QR в приложении-аутентификаторе */
export function totpSetup(db: Db, uid: string, account: string) {
  const secret = toB32(randomBytes(20))
  writeTotp(db, uid, { secret, enabled: false, recovery: [] })
  const label = encodeURIComponent(`MUSICH:${account}`)
  return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=MUSICH&digits=6&period=30` }
}

/** Код из приложения или одноразовый запасной код. Включение — только кодом из приложения */
export function totpCheck(db: Db, uid: string, code: string, allowRecovery = true, now = Date.now()): boolean {
  const t = readTotp(db, uid)
  if (!t) return false
  const c = code.replace(/\s|-/g, '')
  if (/^\d{6}$/.test(c)) {
    const step0 = Math.floor(now / 30_000)
    for (const d of [0, -1, 1]) {
      if (totpCode(t.secret, now, d) === c && (t.last ?? -1) < step0 + d) {
        writeTotp(db, uid, { ...t, last: step0 + d })
        return true
      }
    }
    return false
  }
  if (allowRecovery && t.enabled && t.recovery.includes(sha(c.toLowerCase()))) {
    writeTotp(db, uid, { ...t, recovery: t.recovery.filter((x) => x !== sha(c.toLowerCase())) })
    return true
  }
  return false
}

/** Код совпал — включаем и выдаём 8 запасных кодов (показываются один раз) */
export function totpEnable(db: Db, uid: string, code: string): string[] | null {
  const t = readTotp(db, uid)
  if (!t || t.enabled || !totpCheck(db, uid, code, false)) return null
  const codes = Array.from({ length: 8 }, () => randomBytes(5).toString('hex'))
  writeTotp(db, uid, { ...readTotp(db, uid)!, enabled: true, recovery: codes.map(sha) })
  return codes
}
export const totpDisable = (db: Db, uid: string) => writeTotp(db, uid, null)

// ---------- бэкап с паролем ----------

/**
 * Файл бэкапа целиком — это все пароли (хэши) и ключи интеграций. С паролем он шифруется AES-256-GCM,
 * ключ — scrypt от пароля. Формат: «MUSICHENC1» + соль 16 + iv 12 + шифротекст + тег 16
 */
const MAGIC = Buffer.from('MUSICHENC1')
const keyOf = (password: string, salt: Buffer) => scryptSync(password, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })

export async function encryptFile(src: string, dst: string, password: string) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyOf(password, salt), iv)
  const out = createWriteStream(dst)
  out.write(Buffer.concat([MAGIC, salt, iv]))
  await pipeline(createReadStream(src), cipher, out, { end: false })
  await new Promise<void>((ok, fail) => out.end(cipher.getAuthTag(), (e?: Error | null) => (e ? fail(e) : ok())))
}

export async function isEncrypted(file: string) {
  const fd = await open(file, 'r')
  try {
    const head = Buffer.alloc(MAGIC.length)
    await fd.read(head, 0, head.length, 0)
    return head.equals(MAGIC)
  } finally {
    await fd.close()
  }
}

/** Расшифровать в dst; неверный пароль или испорченный файл — ошибка */
export async function decryptFile(src: string, dst: string, password: string) {
  const fd = await open(src, 'r')
  const { size } = await fd.stat()
  const head = Buffer.alloc(MAGIC.length + 28)
  await fd.read(head, 0, head.length, 0)
  const tag = Buffer.alloc(16)
  await fd.read(tag, 0, 16, size - 16)
  await fd.close()
  const salt = head.subarray(MAGIC.length, MAGIC.length + 16)
  const iv = head.subarray(MAGIC.length + 16)
  const decipher = createDecipheriv('aes-256-gcm', keyOf(password, salt), iv)
  decipher.setAuthTag(tag)
  await pipeline(createReadStream(src, { start: head.length, end: size - 17 }), decipher as unknown as Transform, createWriteStream(dst))
}

// ---------- заголовки ----------

/**
 * Заголовки безопасности ставит сам сервер — не надеемся, что у каждого, кто поставит MUSICH, настроен nginx.
 * CSP: скрипты только свои; стили со style="" (так устроен интерфейс); картинки и звук — свои, data:, blob:,
 * обложки по https-ссылкам; встраивать MUSICH в чужие страницы нельзя
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' https: data: blob:", // data:/blob: — свои же картинки (кадрирование, миниатюры) превращаются в файл через fetch
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')
