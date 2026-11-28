import { Download, X } from 'lucide-react'
import { useState } from 'react'
import { fmtSize, t } from '../i18n'
import { downloadUrl, startDownload } from '../lib/api'
import { usePick } from '../store'
import { Modal } from './Dialogs'
import { cx, IconBtn } from './ui'

type Lists = 'none' | 'copies' | 'm3u'

/**
 * Выгрузка музыки zip-архивом: все треки одной папкой, по папке на альбом, плейлисты —
 * папками с копиями или .m3u8 со ссылками на общую папку треков. Архив собирает сервер потоком
 */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const { tracks, playlists } = usePick('tracks', 'playlists')
  const [all, setAll] = useState(true)
  const [albums, setAlbums] = useState(false)
  const [lists, setLists] = useState<Lists>('none')

  const size = new Map(tracks.map((x) => [x.id, x.sizeMb]))
  const sum = (ids: Iterable<string>) => [...ids].reduce((a, id) => a + (size.get(id) ?? 0), 0)
  const listIds = [tracks.filter((x) => x.liked).map((x) => x.id), ...playlists.map((p) => p.trackIds)]
  const total =
    (all ? sum(size.keys()) : 0) +
    (albums ? sum(size.keys()) : 0) +
    (lists === 'copies' ? listIds.reduce((a, ids) => a + sum(ids), 0) : 0) +
    (lists === 'm3u' && !all ? sum(new Set(listIds.flat())) : 0)
  const empty = !all && !albums && lists === 'none'

  const go = () => {
    startDownload(
      downloadUrl('/export', {
        tracks: all ? '1' : '0',
        albums: albums ? '1' : '0',
        playlists: lists,
        names: JSON.stringify({ tracks: t('exp.dirTracks'), albums: t('exp.dirAlbums'), playlists: t('exp.dirPlaylists'), liked: t('exp.dirLiked') }),
      }),
    )
    onClose()
  }

  const chip = (on: boolean, label: string, onClick: () => void) => (
    <button
      onClick={onClick}
      className={cx('rounded-full px-4 py-2 text-sm transition-colors', on ? 'bg-sel text-on-sel' : 'bg-card-3 text-muted hover:text-fg')}
    >
      {label}
    </button>
  )

  return (
    <Modal onClose={onClose}>
      <div className="mb-1 flex items-start justify-between">
        <span className="label text-muted">{t('exp.title')}</span>
        <IconBtn title={t('common.close')} onClick={onClose} className="-mt-2 -me-2">
          <X size={18} />
        </IconBtn>
      </div>
      <div className="mb-5 text-xs text-muted">{t('exp.hint')}</div>

      <div className="mb-2 text-[15px]">{t('exp.what')}</div>
      <div className="mb-5 flex flex-wrap gap-2">
        {chip(all, t('exp.all'), () => setAll(!all))}
        {chip(albums, t('exp.albums'), () => setAlbums(!albums))}
        {chip(lists !== 'none', t('exp.playlists'), () => setLists(lists === 'none' ? 'copies' : 'none'))}
      </div>

      {lists !== 'none' && (
        <>
          <div className="mb-2 text-[15px]">{t('exp.listsAs')}</div>
          <div className="mb-5 flex flex-col gap-2">
            {(['copies', 'm3u'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setLists(v)}
                className={cx('rounded-2xl px-4 py-3 text-start transition-colors', lists === v ? 'bg-sel text-on-sel' : 'bg-card-3 hover:bg-card-2')}
              >
                <span className="block text-sm">{t(v === 'copies' ? 'exp.copies' : 'exp.m3u')}</span>
                <span className={cx('block text-xs', lists === v ? 'text-on-sel/70' : 'text-muted')}>{t(v === 'copies' ? 'exp.copiesHint' : 'exp.m3uHint')}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="mb-4 font-mono text-xs text-muted">{empty ? t('exp.nothing') : t('exp.size', { size: fmtSize(total) })}</div>
      <div className="flex gap-2">
        <button onClick={onClose} className="flex-1 rounded-full py-3 text-sm text-muted hover:text-fg">
          {t('common.cancel')}
        </button>
        <button
          onClick={go}
          disabled={empty}
          className="flex flex-1 items-center justify-center gap-2 rounded-full bg-sel py-3 text-sm text-on-sel disabled:opacity-40"
        >
          <Download size={15} /> {t('exp.download')}
        </button>
      </div>
    </Modal>
  )
}
