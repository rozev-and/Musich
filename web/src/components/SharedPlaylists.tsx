import { ChevronDown, ListPlus, Play, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { t as tx, tn } from '../i18n'
import { api } from '../lib/api'
import { useStore } from '../store'
import { Modal } from './Dialogs'
import { cx, IconBtn, Toggle } from './ui'

/**
 * Общие плейлисты (server/src/shares.ts): хозяин отдаёт свой плейлист другим пользователям сервера.
 * У получателя своя библиотека — он видит «артист — название» и играет то, что есть у него; может сохранить себе
 */
type Person = { id: string; login: string | null; name: string }
type Shared = { id: string; name: string; description: string; owner: string; items: { artist: string; title: string; trackId?: string }[] }

/** Кнопка у своего плейлиста: окно со списком пользователей сервера, отметил — поделился */
export function SharePlaylistButton({ pid }: { pid: string }) {
  const [open, setOpen] = useState(false)
  const [people, setPeople] = useState<Person[] | null>(null)
  // на сервере больше никого — кнопку не показываем
  useEffect(() => {
    api<Person[]>('/users/directory').then(setPeople, () => setPeople([]))
  }, [])
  if (!people?.length) return null
  return (
    <>
      <IconBtn title={tx('share.withUsers')} onClick={() => setOpen(true)}>
        <Users size={16} strokeWidth={1.6} />
      </IconBtn>
      {open && <ShareDialog pid={pid} people={people} onClose={() => setOpen(false)} />}
    </>
  )
}

function ShareDialog({ pid, people, onClose }: { pid: string; people: Person[]; onClose: () => void }) {
  const toast = useStore((s) => s.toast)
  const [ids, setIds] = useState<Set<string> | null>(null)
  useEffect(() => {
    api<{ userIds: string[] }>(`/playlists/${pid}/shares`).then((r) => setIds(new Set(r.userIds)), () => setIds(new Set()))
  }, [pid])
  const save = async () => {
    try {
      await api(`/playlists/${pid}/shares`, { method: 'PUT', body: { userIds: [...(ids ?? [])] } })
      toast(tx('share.saved'), 'ok')
      onClose()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  return (
    <Modal onClose={onClose}>
      <div className="mb-1 text-lg font-medium">{tx('share.withUsers')}</div>
      <p className="mb-4 text-xs text-muted">{tx('share.withUsersHint')}</p>
      <div className="flex max-h-[50vh] flex-col overflow-y-auto">
        {people.map((p) => (
          <label key={p.id} className="flex items-center gap-3 border-b border-line py-3 last:border-0">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px]">{p.name || p.login}</span>
              {p.login && <span className="block truncate font-mono text-xs text-muted">{p.login}</span>}
            </span>
            <Toggle
              on={!!ids?.has(p.id)}
              onChange={(v) =>
                setIds((cur) => {
                  const next = new Set(cur)
                  if (v) next.add(p.id)
                  else next.delete(p.id)
                  return next
                })
              }
            />
          </label>
        ))}
      </div>
      <div className="mt-5 flex gap-2">
        <button onClick={onClose} className="flex-1 rounded-full bg-card-3 py-3 text-sm">
          {tx('common.cancel')}
        </button>
        <button onClick={() => void save()} disabled={!ids} className="flex-1 rounded-full bg-sel py-3 text-sm text-on-sel disabled:opacity-40">
          {tx('common.done')}
        </button>
      </div>
    </Modal>
  )
}

/** «Со мной поделились» — под своими плейлистами; раскрыл — список, играть что есть, сохранить себе */
export function SharedWithMe() {
  const conn = useStore((s) => s.conn)
  const [list, setList] = useState<Shared[]>([])
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    if (conn === 'online') api<Shared[]>('/shared').then(setList, () => setList([]))
  }, [conn])
  if (!list.length) return null
  const s = useStore.getState()
  return (
    <section className="mt-8">
      <div className="label mb-3 text-ink-muted">{tx('share.withMe')}</div>
      <div className="flex flex-col gap-2">
        {list.map((p) => {
          const have = p.items.filter((x) => x.trackId).map((x) => x.trackId!)
          const isOpen = open === p.id
          return (
            <div key={p.id} className="widget p-3">
              <button onClick={() => setOpen(isOpen ? null : p.id)} className="flex w-full items-center gap-3 text-start">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-card-3 text-muted">
                  <Users size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px]">{p.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {p.owner} · {tx('int.haveOf', { n: have.length, total: p.items.length })}
                  </span>
                </span>
                <ChevronDown size={16} className={cx('shrink-0 text-muted transition-transform', isOpen && 'rotate-180')} />
              </button>
              {isOpen && (
                <div className="mt-3 flex flex-col gap-2">
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => have[0] && s.play(have[0], have, p.name)}
                      disabled={!have.length}
                      className="flex items-center gap-2 rounded-full bg-sel px-4 py-2 text-sm text-on-sel disabled:opacity-40"
                    >
                      <Play size={14} fill="currentColor" /> {tx('int.playHave')}
                    </button>
                    <button
                      onClick={() => s.openPlaylistEditor({ mode: 'create', addIds: have, name: p.name })}
                      disabled={!have.length}
                      className="flex items-center gap-2 rounded-full border border-ink/20 px-4 py-2 text-sm disabled:opacity-40"
                    >
                      <ListPlus size={14} /> {tx('imp.saveAs')}
                    </button>
                  </div>
                  <div className="flex flex-col">
                    {p.items.map((x, i) => (
                      <button
                        key={i}
                        disabled={!x.trackId}
                        onClick={() => x.trackId && s.play(x.trackId, have, p.name)}
                        className={cx('flex items-center gap-3 rounded-xl px-2 py-1.5 text-start text-sm', x.trackId ? 'hover:bg-card-2' : 'opacity-40')}
                      >
                        <span className="w-6 shrink-0 font-mono text-xs text-muted">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate">
                          {x.artist} — {x.title}
                        </span>
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted">{tn('n.tracks', p.items.length)}</p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
