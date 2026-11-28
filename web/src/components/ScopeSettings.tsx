import { HardDriveDownload, ImagePlus, Pencil, UserPen, X } from 'lucide-react'
import { hasArtist } from '../lib/artists'
import { albumEdit, artistEdit } from '../lib/covers'
import { isOnDevice } from '../lib/format'
import { t as tx } from '../i18n'
import { isHost } from '../mode'
import { usePick, withLiked } from '../store'
import { Modal } from './Dialogs'
import { cx, DotLine, IconBtn, Toggle } from './ui'

export type ScopeKind = 'album' | 'artist' | 'playlist'

/**
 * Шестерёнка у альбома, артиста или плейлиста: редактирование и два переключателя —
 * «Кэшировать» (держать треки на телефоне; на сервере не нужно) и «Не показывать в Треках» (настройка этого устройства)
 */
export function ScopeSettings({ kind, value, onClose }: { kind: ScopeKind; value: string; onClose: () => void }) {
  const s = usePick(
    'tracks', 'playlists', 'likedOffline', 'ui', 'setUi', 'keepScopes', 'setKeepScope', 'setKeepOffline',
    'openCoverEdit', 'openArtistRename', 'openPlaylistEditor',
  )
  const playlist = kind === 'playlist' ? withLiked(s.tracks, s.playlists, s.likedOffline).find((p) => p.id === value) : undefined
  const list =
    kind === 'album' ? s.tracks.filter((t) => t.album === value)
    : kind === 'artist' ? s.tracks.filter((t) => hasArtist(t, value))
    : s.tracks.filter((t) => playlist?.trackIds.includes(t.id))
  const local = list.filter((t) => isOnDevice(t.status)).length
  const name = playlist?.name ?? value

  const kept = kind === 'playlist' ? !!playlist?.keepOffline : s.keepScopes[kind].includes(value)
  const setKept = (v: boolean) => (kind === 'playlist' ? s.setKeepOffline(value, v) : s.setKeepScope(kind, value, v))
  const hidden = s.ui.hidden[kind].includes(value)
  const setHidden = (v: boolean) =>
    s.setUi({ hidden: { ...s.ui.hidden, [kind]: v ? [...s.ui.hidden[kind].filter((x) => x !== value), value] : s.ui.hidden[kind].filter((x) => x !== value) } })

  const go = (fn: () => void) => () => {
    onClose()
    fn()
  }
  const actions: { icon: typeof Pencil; label: string; onClick: () => void }[] =
    kind === 'album'
      ? [{ icon: ImagePlus, label: tx('scope.cover'), onClick: go(() => s.openCoverEdit(albumEdit(value, list))) }]
      : kind === 'artist'
        ? [
            { icon: ImagePlus, label: tx('scope.photo'), onClick: go(() => s.openCoverEdit(artistEdit(value, list))) },
            { icon: UserPen, label: tx('menu.renameArtist'), onClick: go(() => s.openArtistRename([value])) },
          ]
        : playlist && !playlist.system
          ? [{ icon: Pencil, label: tx('scope.editPlaylist'), onClick: go(() => s.openPlaylistEditor({ mode: 'edit', id: value })) }]
          : []

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <span className="min-w-0 truncate text-lg font-medium">{name}</span>
        <IconBtn title={tx('common.close')} onClick={onClose} className="-mt-2 -me-2 shrink-0">
          <X size={18} />
        </IconBtn>
      </div>
      {actions.length > 0 && (
        <div className="mb-3 flex flex-col">
          {actions.map(({ icon: Icon, label, onClick }) => (
            <button key={label} onClick={onClick} className="flex items-center gap-3 rounded-2xl px-2 py-2.5 text-start text-sm hover:bg-card-2">
              <Icon size={18} strokeWidth={1.6} className="text-muted" />
              {label}
            </button>
          ))}
        </div>
      )}
      <div className={cx('flex flex-col gap-4', actions.length > 0 && 'border-t border-line pt-4')}>
        {/* на сервере всё и так в хранилище — держать «на устройстве» нечего */}
        {!isHost && (
          <div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm">{tx('scope.keep')}</div>
                <div className="text-xs text-muted">{tx('scope.keepHint')}</div>
              </div>
              <Toggle on={kept} onChange={setKept} />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <HardDriveDownload size={13} className="shrink-0 text-muted" />
              <DotLine className="flex-1" size={4} value={list.length ? local / list.length : 0} />
              <span className="font-mono text-[10px] text-muted">
                {local}/{list.length}
              </span>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm">{tx('scope.hide')}</div>
            <div className="text-xs text-muted">{tx('scope.hideHint')}</div>
          </div>
          <Toggle on={hidden} onChange={setHidden} />
        </div>
      </div>
    </Modal>
  )
}
