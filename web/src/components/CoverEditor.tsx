import { FileInput, ImagePlus, Link, Pencil, RotateCcw, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { t } from '../i18n'
import { usePick, useStore, type CoverEdit } from '../store'
import { Modal } from './Dialogs'
import { CropDialog } from './CropDialog'
import { Cover, cx, IconBtn } from './ui'


/** Обложка с кнопкой «изменить» поверх — для шапок альбома, артиста, плейлиста */
export function EditableCover({
  onEdit,
  className,
  rounded = 'rounded-3xl',
  children,
}: {
  onEdit: () => void
  className?: string
  rounded?: string
  children: React.ReactNode
}) {
  return (
    <button onClick={onEdit} title={t('cover.edit')} className={cx('group/cover relative shrink-0 overflow-hidden', rounded, className)}>
      {children}
      <span className={cx('absolute inset-0 grid place-items-center bg-black/55 text-white opacity-0 transition-opacity group-hover/cover:opacity-100', rounded)}>
        <span className="flex flex-col items-center gap-1 text-xs">
          <Pencil size={18} />
          {t('common.change')}
        </span>
      </span>
    </button>
  )
}

/** Маленькая кнопка-карандаш в углу карточки (сама карточка кликабельна) */
export function CornerEdit({ onEdit }: { onEdit: () => void }) {
  return (
    <span
      role="button"
      title={t('cover.edit')}
      onClick={(e) => {
        e.stopPropagation()
        onEdit()
      }}
      className="absolute top-2 right-2 grid h-8 w-8 place-items-center rounded-full bg-sel text-on-sel opacity-0 shadow transition-opacity group-hover:opacity-100 hover:scale-105"
    >
      <Pencil size={14} />
    </span>
  )
}

export function CoverEditorDialog() {
  const edit = useStore((s) => s.coverEdit)
  if (!edit) return null
  return <Editor key={edit.key} edit={edit} />
}

function Editor({ edit }: { edit: CoverEdit }) {
  const { covers, openCoverEdit, setCover, toast, prefs, embedAlbumCover } = usePick('covers', 'openCoverEdit', 'setCover', 'toast', 'prefs', 'embedAlbumCover')
  const inFile = prefs.coverMode === 'file'
  const own = covers[edit.key]
  // undefined — без изменений, null — сбросить на картинку из тегов, строка — новая картинка
  const [pending, setPending] = useState<string | null | undefined>(undefined)
  const [link, setLink] = useState('')
  const [drag, setDrag] = useState(false)
  // выбранная картинка ждёт кадрирования (CropDialog), потом становится pending
  const [crop, setCrop] = useState<Blob | null>(null)
  const file = useRef<HTMLInputElement>(null)

  const close = () => openCoverEdit(null)
  const preview = pending === null ? edit.fallback : (pending ?? own ?? edit.fallback)
  const hasOwn = pending === undefined ? !!own : pending !== null
  const title = t(`cover.${edit.kind}`)
  const hint = t(`cover.${edit.kind}.hint`)
  const round = edit.kind === 'artist' ? 'rounded-full' : 'rounded-3xl'

  const takeFile = async (f?: File | null) => {
    if (!f) return
    if (!f.type.startsWith('image/')) return toast(t('toast.notImage'), 'error')
    setCrop(f)
  }

  const takeLink = () => {
    const url = link.trim()
    if (!/^https?:\/\//.test(url)) return toast(t('toast.needLink'), 'error')
    // картинку по ссылке тоже даём кадрировать, если сайт отдаёт её (CORS); не отдаёт — берём как есть
    void fetch(url)
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((b) => {
        if (!b.type.startsWith('image/')) throw new Error()
        setCrop(b)
        setLink('')
      })
      .catch(() => {
    const img = new Image()
    img.onload = () => {
      setPending(url)
      setLink('')
    }
    img.onerror = () => toast(t('toast.linkFailed'), 'error')
    img.src = url
      })
  }

  return (
    <>
    {crop && <CropDialog blob={crop} round={edit.kind === 'artist'} onCancel={() => setCrop(null)} onDone={(url) => (setPending(url), setCrop(null))} />}
    <Modal onClose={close}>
      <div className="mb-5 flex items-start justify-between">
        <span className="label text-muted">{title}</span>
        <IconBtn title={t('common.close')} onClick={close} className="-mt-2 -me-2">
          <X size={18} />
        </IconBtn>
      </div>

      <div className="mb-1 truncate text-lg">{edit.title}</div>
      <div className="mb-5 text-xs text-muted">
        {hint}
        {/* правка «меняет файл»: обложка трека вшивается в сам файл */}
        {edit.kind === 'track' && inFile && <span className="block text-fg">{t('cover.trackInFile')}</span>}
        {edit.kind === 'album' && inFile && <span className="block text-fg">{t('cover.albumInFile')}</span>}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          takeFile(e.dataTransfer.files[0])
        }}
        className="mb-5 flex justify-center"
      >
        <button
          onClick={() => file.current?.click()}
          className={cx('group/pic relative h-48 w-48 overflow-hidden', round, drag && 'ring-2 ring-red')}
          title={t('cover.upload')}
        >
          <Cover seed={edit.title} src={preview} size={0} className="h-full w-full" rounded={round} />
          <span className={cx('absolute inset-0 grid place-items-center bg-black/55 text-sm text-white opacity-0 transition-opacity group-hover/pic:opacity-100', drag && 'opacity-100', round)}>
            <span className="flex flex-col items-center gap-1">
              <ImagePlus size={22} />
              {drag ? t('cover.release') : t('cover.uploadShort')}
            </span>
          </span>
        </button>
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => takeFile(e.target.files?.[0])} />
      </div>

      <div className="flex flex-col gap-2">
        <button
          onClick={() => file.current?.click()}
          className="flex items-center justify-center gap-2 rounded-full border border-line py-2.5 text-sm hover:border-fg"
        >
          <ImagePlus size={15} /> {t('cover.fromPc')}
          <span className="text-xs text-muted">{t('cover.orDrop')}</span>
        </button>

        <div className="flex items-center gap-2 rounded-full bg-card-3 py-1 pr-1 pl-4">
          <Link size={14} className="shrink-0 text-muted" />
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && takeLink()}
            placeholder={t('cover.linkPh')}
            className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-muted"
          />
          <button onClick={takeLink} disabled={!link.trim()} className="rounded-full bg-sel px-4 py-1.5 text-sm text-on-sel disabled:opacity-40">
            {t('cover.take')}
          </button>
        </div>

        {/* своя обложка альбома в режиме «меняет файл» — можно вшить во все его треки */}
        {edit.kind === 'album' && inFile && own && pending === undefined && (
          <button
            onClick={() => {
              close()
              void embedAlbumCover(edit.key.slice(edit.key.indexOf(':') + 1))
            }}
            className="flex items-center justify-center gap-2 rounded-full bg-card-3 py-2.5 text-sm hover:bg-card-2"
          >
            <FileInput size={15} /> {t('cover.embedAlbum')}
          </button>
        )}

        {hasOwn && (
          <button onClick={() => setPending(null)} className="flex items-center justify-center gap-2 py-2 text-sm text-muted hover:text-fg">
            <RotateCcw size={14} />
            {edit.kind === 'artist' ? t('cover.resetArtist') : t('cover.resetTags')}
          </button>
        )}
      </div>

      <div className="mt-4 flex gap-2">
        <button onClick={close} className="flex-1 rounded-full py-3 text-sm text-muted hover:text-fg">
          {t('common.cancel')}
        </button>
        <button
          disabled={pending === undefined}
          onClick={() => setCover(edit.key, pending ?? null)}
          className="flex-1 rounded-full bg-sel py-3 text-sm text-on-sel disabled:opacity-40"
        >
          {t('common.save')}
        </button>
      </div>
    </Modal>
    </>
  )
}
