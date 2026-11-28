import { ListPlus, Play, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Logo, SERVICES } from '../components/Integrations'
import { TrackRow } from '../components/TrackRow'
import { cx } from '../components/ui'
import { fmtAgo, t, tn, type Key } from '../i18n'
import { fmtTime } from '../lib/format'
import { usePick, useStore } from '../store'
import type { Track } from '../types'
import { PageTitle } from './Library'

type Show = 'all' | 'have' | 'missing'
const SHOW: { id: Show; label: Key }[] = [
  { id: 'all', label: 'int.fAll' },
  { id: 'have', label: 'int.fHave' },
  { id: 'missing', label: 'int.fMissing' },
]

/**
 * Плейлист сервиса (Spotify, YouTube, Яндекс, VK) глазами библиотеки: что из него есть у нас — обычными строками,
 * их можно играть; чего нет — бледными строками с обложкой сервиса в том же порядке. Можно оставить только то или другое
 */
export function RemoteListPage() {
  const { remote, remoteList, tracks, play, syncRemote, toast } = usePick('remote', 'remoteList', 'tracks', 'play', 'syncRemote', 'toast')
  const [show, setShow] = useState<Show>('all')
  const [busy, setBusy] = useState(false)
  const entry = remote.find((r) => r.service === remoteList?.service)
  const svc = SERVICES.find((s) => s.id === remoteList?.service)
  if (!remoteList || !entry || !svc) return null

  const name = remoteList.list || t('int.liked')
  const items = entry.data.tracks.filter((x) => (remoteList.list ? x.lists.includes(remoteList.list) : x.liked))
  const byId = new Map(tracks.map((x) => [x.id, x]))
  const local = items.map((x) => (x.localId ? byId.get(x.localId) : undefined))
  const queue = local.filter((x): x is Track => !!x).map((x) => x.id)

  const refresh = async () => {
    setBusy(true)
    try {
      await syncRemote(entry.service)
      toast(t('int.synced'), 'ok')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-sm text-ink-muted">
        <Logo s={svc} size={18} /> {t(svc.name)} · {fmtAgo(Date.parse(entry.syncedAt))}
        {/* VK без входа присылают закладкой или вставкой — забирать заново нечего */}
        {entry.canSync && (
          <button
            onClick={() => void refresh()}
            disabled={busy}
            className="ms-auto flex items-center gap-2 rounded-full bg-card-2 px-4 py-2 text-sm text-fg hover:bg-card-3 disabled:opacity-60"
          >
            <RefreshCw size={14} className={cx(busy && 'animate-spin')} /> {t('int.refresh')}
          </button>
        )}
      </div>
      <PageTitle sub={`${t('int.haveOf', { n: queue.length, total: items.length })} · ${tn('n.tracks', items.length)}`}>{name}</PageTitle>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => queue[0] && play(queue[0], queue, name)}
          disabled={!queue.length}
          className="flex items-center gap-2 rounded-full bg-sel-page px-5 py-2.5 text-sm text-on-sel-page disabled:opacity-40"
        >
          <Play size={15} fill="currentColor" /> {t('int.playHave')}
        </button>
        {/* что из списка есть в библиотеке — своим плейлистом в MUSICH */}
        <button
          onClick={() => queue.length && useStore.getState().openPlaylistEditor({ mode: 'create', addIds: queue, name })}
          disabled={!queue.length}
          className="flex items-center gap-2 rounded-full border border-ink/20 px-5 py-2.5 text-sm disabled:opacity-40"
        >
          <ListPlus size={15} /> {t('imp.saveAs')}
        </button>
        <div className="ms-auto flex gap-1 rounded-full bg-card-2 p-1">
          {SHOW.map((o) => {
            const n = o.id === 'all' ? items.length : o.id === 'have' ? queue.length : items.length - queue.length
            return (
              <button
                key={o.id}
                onClick={() => setShow(o.id)}
                className={cx(
                  'flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition-colors',
                  show === o.id ? 'bg-sel text-on-sel' : 'text-muted hover:text-fg',
                )}
              >
                {t(o.label)} <span className="font-mono text-[11px] opacity-70">{n}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="widget overflow-hidden p-2">
        {items.map((x, i) => {
          const t0 = local[i]
          if (t0) return show === 'missing' ? null : <TrackRow key={x.id} t={t0} i={i} queue={queue} source={name} />
          if (show === 'have') return null
          return (
            <div key={x.id} className="flex items-center gap-3 rounded-2xl px-3 py-2 opacity-50">
              <span className="hidden w-6 shrink-0 text-center font-mono text-xs text-muted sm:block">{String(i + 1).padStart(2, '0')}</span>
              {x.cover ? (
                <img src={x.cover} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-11 w-11 shrink-0 rounded-xl object-cover grayscale" />
              ) : (
                <span className="h-11 w-11 shrink-0 rounded-xl bg-card-3" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px]">{x.title}</div>
                <div className="truncate text-xs text-muted">{x.artists.join(', ')}</div>
              </div>
              <span className="label shrink-0 text-muted">{t('int.notInLibrary')}</span>
              {x.duration ? <span className="hidden w-10 shrink-0 text-end font-mono text-xs text-muted sm:block">{fmtTime(x.duration)}</span> : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
