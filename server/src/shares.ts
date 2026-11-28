import type { Auth } from './auth.ts'
import type { Db } from './db.ts'
import { badRequest } from './errors.ts'
import type { Library } from './library.ts'

/**
 * Общие плейлисты: хозяин делится своим плейлистом с другими пользователями сервера.
 * Библиотеки у всех свои, поэтому получатель видит список «артист — название» и то, что из него есть у него
 * (сравнение без регистра, ё/е и знаков). Получатель только смотрит и играет, может сохранить себе копией
 */
export interface SharedItem {
  artist: string
  title: string
  trackId?: string // такой трек есть в библиотеке получателя
}
export interface SharedPlaylist {
  id: string
  name: string
  description: string
  owner: string // имя или логин хозяина
  items: SharedItem[]
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '')

export class Shares {
  private db: Db
  private lib: Library
  private auth: Auth
  constructor(db: Db, lib: Library, auth: Auth) {
    this.db = db
    this.lib = lib
    this.auth = auth
  }

  /** С кем поделился хозяин этим плейлистом */
  list(ownerId: string, pid: string): string[] {
    this.lib.activePlaylist(ownerId, pid)
    return (this.db.prepare('SELECT user_id FROM playlist_shares WHERE owner_id = ? AND playlist_id = ?').all(ownerId, pid) as { user_id: string }[]).map((r) => r.user_id)
  }

  /** Заменить список получателей целиком */
  set(ownerId: string, pid: string, userIds: string[]): string[] {
    this.lib.activePlaylist(ownerId, pid)
    const known = new Set(this.auth.listUsers().map((u) => u.id))
    const ids = [...new Set(userIds)].filter((id) => id !== ownerId)
    if (ids.some((id) => !known.has(id))) throw badRequest('Такого пользователя нет')
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM playlist_shares WHERE owner_id = ? AND playlist_id = ?').run(ownerId, pid)
      const ins = this.db.prepare('INSERT INTO playlist_shares (playlist_id, owner_id, user_id, created_at) VALUES (?, ?, ?, ?)')
      for (const id of ids) ins.run(pid, ownerId, id, new Date().toISOString())
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return ids
  }

  /** Чем поделились со мной: удалённые плейлисты и ушедшие хозяева пропускаем */
  sharedWith(userId: string): SharedPlaylist[] {
    const rows = this.db.prepare('SELECT playlist_id, owner_id FROM playlist_shares WHERE user_id = ? ORDER BY created_at DESC').all(userId) as { playlist_id: string; owner_id: string }[]
    if (!rows.length) return []
    const users = new Map(this.auth.listUsers().map((u) => [u.id, u]))
    const mine = new Map<string, string>()
    for (const t of this.lib.listTracks(userId)) mine.set(`${norm(t.artist)}|${norm(t.title)}`, t.id)
    const out: SharedPlaylist[] = []
    for (const r of rows) {
      const owner = users.get(r.owner_id)
      if (!owner) continue
      let p
      try {
        p = this.lib.activePlaylist(r.owner_id, r.playlist_id)
      } catch {
        continue
      }
      const items = p.trackIds
        .map((id) => this.lib.track(r.owner_id, id))
        .filter((t) => !!t)
        .map((t) => {
          const trackId = mine.get(`${norm(t.artist)}|${norm(t.title)}`)
          return { artist: t.artist, title: t.title, ...(trackId ? { trackId } : {}) }
        })
      out.push({ id: p.id, name: p.name, description: p.description, owner: owner.name || owner.login || '', items })
    }
    return out
  }
}
