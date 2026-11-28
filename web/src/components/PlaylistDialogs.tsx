import { Check, ImagePlus, Plus, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { toCoverDataUrl } from '../lib/covers'
import { t, tn } from '../i18n'
import { usePick, useStore, withLiked } from '../store'
import { PlaylistCover } from '../views/Playlists'
import { Modal } from './Dialogs'
import { Cover, IconBtn } from './ui'

function Header({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="mb-5 flex items-start justify-between">
      <span className="label text-muted">{title}</span>
      <IconBtn title={t('common.close')} onClick={onClose} className="-mt-2 -me-2">
        <X size={18} />
      </IconBtn>
    </div>
  )
}

/** Выбор плейлиста для одного или нескольких треков */
export function PlaylistPicker() {
  const ids = useStore((s) => s.pickerIds)
  const { playlists: own, tracks, likedOffline, openPicker, addToPlaylist, openPlaylistEditor } = usePick('playlists', 'tracks', 'likedOffline', 'openPicker', 'addToPlaylist', 'openPlaylistEditor')
  if (!ids) return null
  const playlists = withLiked(tracks, own, likedOffline)

  const close = () => openPicker(null)
  const first = tracks.find((t) => t.id === ids[0])
  const what = ids.length === 1 && first ? `«${first.title}»` : tn('n.tracks', ids.length)

  return (
    <Modal onClose={close}>
      <Header title={t('pl.picker')} onClose={close} />
      <div className="mb-4 truncate text-lg">{what}</div>

      <button
        onClick={() => openPlaylistEditor({ mode: 'create', addIds: ids })}
        className="mb-2 flex w-full items-center gap-3 rounded-2xl border border-dashed border-line p-2 text-start hover:border-fg/40"
      >
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-card-3">
          <Plus size={18} />
        </span>
        <span className="text-[15px]">{t('nav.newPlaylist')}</span>
      </button>

      <div className="-mx-2 flex max-h-80 flex-col overflow-y-auto">
        {playlists.map((p) => {
          const already = ids.every((id) => p.trackIds.includes(id))
          return (
            <button
              key={p.id}
              disabled={already}
              onClick={() => addToPlaylist(p.id, ids)}
              className="flex items-center gap-3 rounded-2xl p-2 text-start transition-colors hover:bg-card-2 disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <PlaylistCover p={p} className="h-11 w-11" rounded="rounded-xl" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px]">{p.name}</span>
                <span className="block text-xs text-muted">
                  {tn('n.tracks', p.trackIds.length)}
                </span>
              </span>
              {already && (
                <span className="label flex items-center gap-1 text-muted">
                  <Check size={13} /> {t('pl.already')}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </Modal>
  )
}

/** Создание и редактирование плейлиста */
export function PlaylistEditorDialog() {
  const editor = useStore((s) => s.playlistEditor)
  if (!editor) return null
  // key — чтобы форма заново заполнялась для каждого открытия
  return <EditorForm key={editor.mode === 'edit' ? editor.id : 'new'} />
}

function EditorForm() {
  const { playlistEditor: editor, playlists, openPlaylistEditor, savePlaylist, toast } = usePick('playlistEditor', 'playlists', 'openPlaylistEditor', 'savePlaylist', 'toast')
  const existing = editor?.mode === 'edit' ? playlists.find((p) => p.id === editor.id) : undefined
  // новый плейлист из импорта — имя уже подставлено
  const [name, setName] = useState(existing?.name ?? (editor?.mode === 'create' ? (editor.name ?? '') : ''))
  const [description, setDescription] = useState(existing?.description ?? '')
  const [coverUrl, setCoverUrl] = useState(existing?.coverUrl)
  const file = useRef<HTMLInputElement>(null)

  if (!editor) return null
  const close = () => openPlaylistEditor(null)
  const save = () => name.trim() && savePlaylist({ name: name.trim(), description: description.trim(), coverUrl })
  const adding = editor.mode === 'create' ? editor.addIds.length : 0

  return (
    <Modal onClose={close}>
      <Header title={existing ? t('pl.playlist') : t('nav.newPlaylist')} onClose={close} />

      <form
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
        className="flex flex-col gap-4"
      >
        <div className="flex items-center gap-4">
          <button type="button" onClick={() => file.current?.click()} className="group relative shrink-0" title={t('pl.uploadCover')}>
            {coverUrl ? (
              <img src={coverUrl} alt="" className="h-24 w-24 rounded-2xl object-cover" />
            ) : (
              <Cover seed={(name || 'новый') + '#p'} className="h-24 w-24" />
            )}
            <span className="absolute inset-0 grid place-items-center rounded-2xl bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100">
              <ImagePlus size={20} />
            </span>
          </button>
          <div className="flex flex-col gap-1 text-sm">
            <button type="button" onClick={() => file.current?.click()} className="text-start hover:underline">
              {t('pl.uploadCover')}
            </button>
            {coverUrl && (
              <button type="button" onClick={() => setCoverUrl(undefined)} className="text-start text-muted hover:text-fg">
                {t('pl.dotCover')}
              </button>
            )}
            <span className="text-xs text-muted">{t('pl.noCoverHint')}</span>
          </div>
          <input
            ref={file}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) toCoverDataUrl(f).then(setCoverUrl, () => toast(t('toast.notImage'), 'error'))
            }}
          />
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="label text-muted">{t('pl.name')}</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('pl.namePh')}
            className="rounded-2xl bg-card-3 px-4 py-3 text-[15px] outline-none focus:ring-1 focus:ring-fg"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="label text-muted">{t('pl.desc')}</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('pl.optional')}
            className="rounded-2xl bg-card-3 px-4 py-3 text-sm outline-none focus:ring-1 focus:ring-fg"
          />
        </label>

        {adding > 0 && (
          <div className="text-xs text-muted">
            {tn('pl.willAdd', adding)}
          </div>
        )}

        <div className="mt-1 flex gap-2">
          <button type="button" onClick={close} className="flex-1 rounded-full py-3 text-sm text-muted hover:text-fg">
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={!name.trim()} className="flex-1 rounded-full bg-sel py-3 text-sm text-on-sel disabled:opacity-40">
            {existing ? t('common.save') : t('common.create')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function PlaylistDeleteDialog() {
  const id = useStore((s) => s.playlistDeleteId)
  const p = useStore((s) => s.playlists.find((x) => x.id === s.playlistDeleteId))
  const { askDeletePlaylist, deletePlaylist } = usePick('askDeletePlaylist', 'deletePlaylist')
  if (!id || !p) return null
  const close = () => askDeletePlaylist(null)

  return (
    <Modal onClose={close}>
      <Header title={t('pl.deleteTitle')} onClose={close} />
      <div className="mb-6 flex items-center gap-4">
        <PlaylistCover p={p} className="h-16 w-16" />
        <div className="min-w-0">
          <div className="truncate text-lg font-medium">{p.name}</div>
          <div className="text-sm text-muted">{t('pl.deleteHint')}</div>
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={close} className="flex-1 rounded-full py-3 text-sm text-muted hover:text-fg">
          {t('common.cancel')}
        </button>
        <button onClick={() => deletePlaylist(p.id)} className="flex-1 rounded-full bg-red py-3 text-sm text-on-red">
          {t('pl.delete')}
        </button>
      </div>
    </Modal>
  )
}
