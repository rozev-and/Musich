import { Merge, Server, Smartphone } from 'lucide-react'
import { useState } from 'react'
import { t, tn } from '../i18n'
import * as journal from '../lib/node/journal'
import { usePick } from '../store'
import { cx } from './ui'
import { Modal } from './Dialogs'

/**
 * Сервер привязан, а на телефоне уже было своё: сколько чего с каждой стороны и чьё имя оставить.
 * «Объединить» — всё в одну библиотеку (файлы по отпечатку, лайки, плейлисты; одноимённые плейлисты сливаются).
 * «Отмена» — отвязать и остаться без сервера
 */
export function MergeDialog() {
  const { tracks, playlists, account, confirmMerge, cancelMerge } = usePick('tracks', 'playlists', 'account', 'confirmMerge', 'cancelMerge')
  const [busy, setBusy] = useState(false)
  const [profile] = useState(() => {
    try {
      return (JSON.parse(localStorage.getItem('musich-profile') ?? 'null') as { name?: string } | null)?.name ?? ''
    } catch {
      return ''
    }
  })
  const [localName, setLocalName] = useState(!!profile && !account.name)

  const events = journal.pending()
  const created = new Set(events.filter((e) => e.type === 'playlist.create').map((e) => e.key))
  // последнее значение лайка по каждому треку — сколько из них «нравится»
  const likes = new Map<string, boolean>()
  for (const e of events) if (e.type === 'like.set') likes.set(e.key, e.value === true)
  const phone = {
    tracks: tracks.filter((x) => x.id.startsWith('up:')).length,
    likes: [...likes.values()].filter(Boolean).length,
    playlists: created.size,
  }
  const server = {
    tracks: tracks.filter((x) => !x.id.startsWith('up:')).length,
    playlists: playlists.filter((p) => !created.has(p.id)).length,
  }

  const go = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    await fn()
    setBusy(false)
  }
  const side = 'flex flex-1 flex-col gap-1 rounded-2xl bg-card-3 p-4'
  const nameBtn = (on: boolean) =>
    cx('flex-1 truncate rounded-full px-3 py-2 text-sm transition-colors', on ? 'bg-sel text-on-sel' : 'text-muted hover:text-fg')

  return (
    <Modal onClose={() => {}}>
      <div className="mb-1 text-lg font-medium">{t('merge.title')}</div>
      <p className="mb-4 text-sm text-muted">{t('merge.hint')}</p>
      <div className="mb-4 flex gap-2">
        <div className={side}>
          <span className="label flex items-center gap-1.5 text-muted">
            <Smartphone size={13} /> {t('merge.phone')}
          </span>
          <span className="text-sm">{tn('n.tracks', phone.tracks)}</span>
          <span className="text-sm">{t('merge.likes', { n: phone.likes })}</span>
          <span className="text-sm">{t('merge.playlists', { n: phone.playlists })}</span>
        </div>
        <div className={side}>
          <span className="label flex items-center gap-1.5 text-muted">
            <Server size={13} /> {t('merge.server')}
          </span>
          <span className="text-sm">{tn('n.tracks', server.tracks)}</span>
          <span className="text-sm">{t('merge.playlists', { n: server.playlists })}</span>
        </div>
      </div>
      {profile && account.name && profile !== account.name && (
        <div className="mb-4">
          <div className="label mb-2 text-muted">{t('merge.name')}</div>
          <div className="flex rounded-full bg-card-3 p-1">
            <button onClick={() => setLocalName(true)} className={nameBtn(localName)}>
              {profile}
            </button>
            <button onClick={() => setLocalName(false)} className={nameBtn(!localName)}>
              {account.name}
            </button>
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <button disabled={busy} onClick={() => void go(cancelMerge)} className="flex-1 rounded-full py-3 text-sm text-muted hover:text-fg disabled:opacity-40">
          {t('common.cancel')}
        </button>
        <button
          disabled={busy}
          onClick={() => void go(() => confirmMerge(localName || (!!profile && !account.name)))}
          className="flex flex-1 items-center justify-center gap-2 rounded-full bg-sel py-3 text-sm text-on-sel disabled:opacity-40"
        >
          <Merge size={15} /> {t('merge.go')}
        </button>
      </div>
    </Modal>
  )
}
