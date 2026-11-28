import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { getSetting, setSetting, tx, type Db } from './db.ts'
import { badRequest, forbidden, HttpError, notFound } from './errors.ts'

/*
 * Вход без конфигов: при первом открытии веб-морда просит создать владельца (логин и пароль, setup),
 * дальше браузер и устройства ходят с токенами. У каждого пользователя свои токены; в базе лежит только sha256 от них.
 * Пользователей заводит регистрация (если владелец её включил). MUSICH_TOKEN из окружения пускает как владельца —
 * для уже настроенных клиентов.
 */

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>
const KEY_LEN = 32
export const MIN_PASSWORD = 8
/** Вход без дела дольше этого — истекает */
export const TOKEN_IDLE_MS = 90 * 24 * 3600_000
// логин — латиница, цифры, точка, подчёркивание, дефис; без учёта регистра
// с буквы или цифры и на них же кончается: «.alex» стал бы скрытой папкой загрузок (скан её не видит), «abc.» и
// «con»/«nul» ломают папки на Windows
export const LOGIN_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{1,30})[a-zA-Z0-9]$/
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

// owner — один, создаёт сервер; admin — управляет сервером наравне с ним (назначает владелец); user — только своё
export type Role = 'owner' | 'admin' | 'user'

export interface UserRow {
  id: string
  login: string | null
  name: string
  email: string
  avatar: string | null
  password: string | null
  role: Role
  created_at: string
  last_seen_at: string | null
}

/** Кто вошёл — так его видит интерфейс */
export interface UserInfo {
  id: string
  login: string | null
  name: string
  role: Role
}

export const userInfo = (u: UserRow): UserInfo => ({ id: u.id, login: u.login, name: u.name, role: u.role })

export interface TokenInfo {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string
  current: boolean
}

interface TokenRow {
  id: string
  name: string
  created_at: string
  last_used_at: string
}

const now = () => new Date().toISOString()
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function safeEqual(a: Buffer, b: Buffer) {
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Особый id для MUSICH_TOKEN из окружения: его нельзя ни показать в списке, ни отозвать */
export const LEGACY_TOKEN_ID = 'env'

// притормаживаем перебор
const slow = () => new Promise((r) => setTimeout(r, 700))

export class Auth {
  private readonly db: Db
  private readonly legacy?: string

  constructor(db: Db, legacyToken?: string) {
    this.db = db
    this.legacy = legacyToken
    // сервер ходит только по MUSICH_TOKEN, а владельца ещё нет — заводим его без логина и пароля: токен пускает
    // как владельца, а логин и пароль он задаст в веб-морде (setup)
    if (legacyToken && !this.owner()) this.insertUser(null, null, '', 'owner')
  }

  // ---------- пользователи ----------

  owner(): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE role = 'owner'").get() as UserRow | undefined
  }

  user(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
  }

  byLogin(login: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE login = ?').get(login) as UserRow | undefined
  }

  listUsers(): UserRow[] {
    return this.db.prepare("SELECT * FROM users ORDER BY role != 'owner', role != 'admin', created_at, id").all() as unknown as UserRow[]
  }

  /** Сменить роль: admin ⇄ user. Владельца так не меняют — только передачей владения */
  setRole(userId: string, role: 'admin' | 'user') {
    const u = this.user(userId)
    if (!u) throw notFound('Пользователь не найден')
    if (u.role === 'owner') throw forbidden('Роль владельца меняется только передачей владения')
    this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId)
  }

  /** Пароль подходит этому пользователю (подтверждение опасных действий) */
  async passwordOk(userId: string, password: string): Promise<boolean> {
    return this.check(this.user(userId), password)
  }

  /** Передать владение: новый — владелец, прежний — администратор. У нового должен быть логин (иначе ему не войти) */
  transferOwner(fromId: string, toId: string) {
    const to = this.user(toId)
    if (!to) throw notFound('Пользователь не найден')
    if (toId === fromId) throw badRequest('Вы и так владелец')
    if (!to.login) throw badRequest('У пользователя нет логина')
    tx(this.db, () => {
      // id треков «по отпечатку» остаются за тем, у кого они были (см. миграцию 20)
      this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('plainIdUser', ?)").run(fromId)
      this.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(fromId)
      this.db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(toId)
    })
  }

  /** Владелец создан и у него есть пароль */
  get ready(): boolean {
    return !!this.owner()?.password
  }

  /** Владелец есть, а логина у него нет — сервер обновился со «входа по одному паролю» */
  get ownerNeedsLogin(): boolean {
    const o = this.owner()
    return !!o?.password && !o.login
  }

  /** Свободная регистрация: включает владелец в настройках сервера, по умолчанию выключена */
  get registration(): boolean {
    return getSetting(this.db, 'registration') === '1'
  }

  setRegistration(on: boolean) {
    setSetting(this.db, 'registration', on ? '1' : '0')
  }

  private insertUser(login: string | null, password: string | null, name: string, role: Role): UserRow {
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO users (id, login, name, email, password, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, login, name, '', password, role, now())
    return this.user(id)!
  }

  private async hash(password: string): Promise<string> {
    const salt = randomBytes(16)
    const key = await scryptAsync(password, salt, KEY_LEN)
    return `scrypt:${salt.toString('hex')}:${key.toString('hex')}`
  }

  private async check(u: UserRow | undefined, password: string): Promise<boolean> {
    if (!u?.password) return false
    const [, salt, key] = u.password.split(':')
    return safeEqual(await scryptAsync(password, Buffer.from(salt, 'hex'), KEY_LEN), Buffer.from(key, 'hex'))
  }

  private validate(password: string) {
    if (password.length < MIN_PASSWORD) throw badRequest(`Пароль — хотя бы ${MIN_PASSWORD} символов`)
  }

  validateLogin(login: string): string {
    const l = login.trim()
    if (!LOGIN_RE.test(l) || RESERVED.test(l)) throw new HttpError(400, 'bad_login', 'Логин: латиница, цифры, «.», «_», «-», от 3 до 32 символов')
    return l
  }

  private checkFree(login: string, exceptId?: string) {
    const taken = this.byLogin(login)
    if (taken && taken.id !== exceptId) throw new HttpError(409, 'login_taken', 'Такой логин уже занят')
  }

  private issue(userId: string, name: string): { id: string; token: string } {
    const id = randomUUID()
    const token = randomBytes(24).toString('hex')
    const ts = now()
    this.db
      .prepare('INSERT INTO tokens (id, hash, name, created_at, last_used_at, user_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, sha(token), name, ts, ts, userId)
    this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(ts, userId)
    return { id, token }
  }

  /**
   * Первый запуск: создать владельца. Кто первым открыл сервер, тот и владелец.
   * adopt — отдать ему то, что появилось до него (папка с музыкой из MUSIC_DIR)
   */
  async setup(login: string, password: string, name: string, tokenName: string, adopt: (ownerId: string) => void): Promise<{ token: string; user: UserRow }> {
    if (this.ready) throw new HttpError(409, 'conflict', 'Сервер уже настроен — войдите')
    const l = this.validateLogin(login)
    this.validate(password)
    const hash = await this.hash(password)
    const user = tx(this.db, () => {
      const placeholder = this.owner()
      this.checkFree(l, placeholder?.id)
      let u: UserRow
      if (placeholder) {
        this.db.prepare('UPDATE users SET login = ?, password = ?, name = ? WHERE id = ?').run(l, hash, name || placeholder.name, placeholder.id)
        u = this.user(placeholder.id)!
      } else u = this.insertUser(l, hash, name, 'owner')
      adopt(u.id)
      return u
    })
    return { token: this.issue(user.id, tokenName).token, user: this.user(user.id)! }
  }

  /** Владелец после обновления: нынешний пароль + новый логин */
  async claim(login: string, password: string, tokenName: string): Promise<{ token: string; user: UserRow }> {
    if (!this.ready) throw new HttpError(409, 'setup_required', 'Сначала создайте владельца')
    const owner = this.owner()!
    if (owner.login) throw new HttpError(409, 'conflict', 'Логин уже задан — войдите')
    const l = this.validateLogin(login)
    if (!(await this.check(owner, password))) {
      await slow()
      throw new HttpError(401, 'unauthorized', 'Неверный пароль')
    }
    this.checkFree(l, owner.id)
    this.db.prepare('UPDATE users SET login = ? WHERE id = ?').run(l, owner.id)
    return { token: this.issue(owner.id, tokenName).token, user: this.user(owner.id)! }
  }

  /**
   * Вход по логину и паролю. Без логина (старые приложения слали только пароль) — это вход владельца
   */
  // second — второй шаг входа (код из приложения-аутентификатора): после пароля, до выдачи ключа; бросает ошибку
  async login(login: string | undefined, password: string, tokenName: string, second?: (u: UserRow) => void): Promise<{ token: string; user: UserRow }> {
    if (!this.ready) throw new HttpError(409, 'setup_required', 'Сначала создайте владельца')
    const u = login?.trim() ? this.byLogin(login.trim()) : this.owner()
    if (!u || !(await this.check(u, password))) {
      await slow()
      throw new HttpError(401, 'unauthorized', 'Неверный логин или пароль')
    }
    second?.(u)
    return { token: this.issue(u.id, tokenName).token, user: u }
  }

  /** Регистрация нового пользователя. loginFree — нет ли на диске чужой папки с таким именем в папке загрузок */
  async register(login: string, password: string, name: string, tokenName: string, loginFree: (login: string) => boolean): Promise<{ token: string; user: UserRow }> {
    if (!this.ready) throw new HttpError(409, 'setup_required', 'Сначала создайте владельца')
    if (!this.registration) throw new HttpError(403, 'registration_closed', 'Регистрация на этом сервере выключена')
    const l = this.validateLogin(login)
    this.validate(password)
    const hash = await this.hash(password)
    const user = tx(this.db, () => {
      this.checkFree(l)
      if (!loginFree(l)) throw new HttpError(409, 'login_taken', 'Такой логин уже занят')
      return this.insertUser(l, hash, name, 'user')
    })
    return { token: this.issue(user.id, tokenName).token, user }
  }

  // keepTokenId — вход, с которого меняют пароль: он остаётся, все остальные входы сбрасываются
  async changePassword(userId: string, current: string, next: string, keepTokenId?: string) {
    if (!(await this.check(this.user(userId), current))) throw new HttpError(403, 'forbidden', 'Текущий пароль неверный')
    this.validate(next)
    const hash = await this.hash(next)
    tx(this.db, () => {
      this.db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, userId)
      this.db.prepare('DELETE FROM tokens WHERE user_id = ? AND id IS NOT ?').run(userId, keepTokenId ?? null)
    })
  }

  /** «Выйти на всех устройствах»: остаётся только этот вход */
  logoutOthers(userId: string, keepTokenId?: string) {
    return this.db.prepare('DELETE FROM tokens WHERE user_id = ? AND id IS NOT ?').run(userId, keepTokenId ?? null).changes
  }

  /** Владелец задаёт пользователю новый пароль: все его входы сбрасываются */
  async resetPassword(userId: string, next: string) {
    if (!this.user(userId)) throw notFound('Пользователь не найден')
    this.validate(next)
    const hash = await this.hash(next)
    tx(this.db, () => {
      this.db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, userId)
      this.db.prepare('DELETE FROM tokens WHERE user_id = ?').run(userId)
    })
  }

  /** Профиль: имя, почта, фото (avatar: null — убрать) */
  saveProfile(userId: string, patch: { name?: string; email?: string; avatar?: string | null }) {
    const u = this.user(userId)
    if (!u) throw notFound('Пользователь не найден')
    this.db
      .prepare('UPDATE users SET name = ?, email = ?, avatar = ? WHERE id = ?')
      .run(patch.name ?? u.name, patch.email ?? u.email, patch.avatar === undefined ? u.avatar : patch.avatar, userId)
  }

  /** Записи о пользователе и его входы. Его музыку и прочее стирает Library.deleteUserData */
  removeUser(userId: string) {
    const u = this.user(userId)
    if (!u) throw notFound('Пользователь не найден')
    if (u.role === 'owner') throw forbidden('Владельца удалить нельзя')
    tx(this.db, () => {
      this.db.prepare('DELETE FROM tokens WHERE user_id = ?').run(userId)
      this.db.prepare('DELETE FROM users WHERE id = ?').run(userId)
    })
  }

  // ---------- токены ----------

  /** Токен → id токена и чей он; undefined, если такого нет */
  verify(token: string): { tokenId: string; userId: string } | undefined {
    if (this.legacy && safeEqual(Buffer.from(token), Buffer.from(this.legacy))) {
      const o = this.owner()
      return o ? { tokenId: LEGACY_TOKEN_ID, userId: o.id } : undefined
    }
    const r = this.db.prepare('SELECT id, last_used_at, user_id FROM tokens WHERE hash = ?').get(sha(token)) as
      | { id: string; last_used_at: string; user_id: string | null }
      | undefined
    if (!r?.user_id) return undefined
    // вход, которым не пользовались 90 дней, истекает (потерянный телефон, забытый браузер)
    if (Date.now() - Date.parse(r.last_used_at) > TOKEN_IDLE_MS) {
      this.db.prepare('DELETE FROM tokens WHERE id = ?').run(r.id)
      return undefined
    }
    // «последний раз» с точностью до минуты: не пишем в базу на каждый запрос
    if (Date.now() - Date.parse(r.last_used_at) > 60_000) {
      const ts = now()
      this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(ts, r.id)
      this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(ts, r.user_id)
    }
    return { tokenId: r.id, userId: r.user_id }
  }

  /** Имя входа по id токена — им подписываются загрузки из браузера */
  name(id?: string): string | undefined {
    if (!id || id === LEGACY_TOKEN_ID) return undefined
    return (this.db.prepare('SELECT name FROM tokens WHERE id = ?').get(id) as { name: string } | undefined)?.name
  }

  list(userId: string, currentId?: string): TokenInfo[] {
    const rows = this.db.prepare('SELECT id, name, created_at, last_used_at FROM tokens WHERE user_id = ? ORDER BY created_at, id').all(userId) as unknown as TokenRow[]
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, current: r.id === currentId }))
  }

  /** Токен для устройства: показывается один раз, дальше виден только в списке по имени */
  create(userId: string, name: string): TokenInfo & { token: string } {
    const { id, token } = this.issue(userId, name)
    return { ...this.list(userId, id).find((t) => t.id === id)!, token }
  }

  revoke(userId: string, id: string) {
    if (id === LEGACY_TOKEN_ID) throw badRequest('Токен из окружения (MUSICH_TOKEN) отзывается только там')
    const res = this.db.prepare('DELETE FROM tokens WHERE id = ? AND user_id = ?').run(id, userId)
    if (!res.changes) throw notFound('Токен не найден')
  }
}
