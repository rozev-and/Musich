import { CloudOff, HardDrive, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { trackCover } from '../lib/covers'
import { fmtSize, t } from '../i18n'
import { usePick, useStore } from '../store'
import { Cover, cx, IconBtn } from './ui'
import { isHost } from '../mode'

/**
 * Окно поверх страницы; wide — вдвое шире обычного (длинные тексты).
 * Рисуется прямо в body: внутри полупрозрачного блока (backdrop-filter) fixed отсчитывался бы от блока, а не от экрана
 */
export function Modal({ children, onClose, wide }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm"
      style={{ paddingTop: 'max(1rem, var(--safe-top))', paddingBottom: 'max(1rem, var(--safe-bottom))' }}
      onClick={onClose}
    >
      <div className={`widget solid w-full p-6 ${wide ? 'max-w-3xl' : 'max-w-md'}`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  )
}

function Choice({
  icon,
  title,
  hint,
  danger,
  onClick,
}: {
  icon: ReactNode
  title: string
  hint: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'group flex w-full items-center gap-4 rounded-3xl border p-4 text-start transition-colors',
        danger ? 'border-red/40 hover:bg-red hover:border-red' : 'border-line hover:bg-card-2 hover:border-fg/40',
      )}
    >
      <span
        className={cx(
          'grid h-10 w-10 shrink-0 place-items-center rounded-full',
          danger ? 'bg-red/15 text-red group-hover:bg-white/20 group-hover:text-on-red' : 'bg-card-3',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className={cx('block text-[15px] font-medium', danger && 'group-hover:text-on-red')}>{title}</span>
        <span className={cx('block text-xs text-muted', danger && 'group-hover:text-on-red/80')}>{hint}</span>
      </span>
    </button>
  )
}

/** Главный сценарий удаления: только с устройства или из хранилища */
export function DeleteDialog() {
  const id = useStore((s) => s.deleteId)
  const track = useStore((s) => s.tracks.find((t) => t.id === s.deleteId))
  const { askDelete, deleteFromDevice, deleteEverywhere, covers } = usePick('askDelete', 'deleteFromDevice', 'deleteEverywhere', 'covers')

  if (!id || !track) return null
  // на хосте удалить можно только из хранилища — «только с этого устройства» здесь не бывает
  const onDevice = !isHost && track.status === 'synced'
  const notUploaded = !isHost && track.status === 'uploading'

  return (
    <Modal onClose={() => askDelete(null)}>
      <div className="mb-5 flex items-start justify-between">
        <span className="label text-muted">{t('del.title')}</span>
        <IconBtn title={t('common.close')} onClick={() => askDelete(null)} className="-mt-2 -me-2">
          <X size={18} />
        </IconBtn>
      </div>

      <div className="mb-6 flex items-center gap-4">
        <Cover seed={track.album} src={trackCover(track, covers)} className="h-16 w-16" />
        <div className="min-w-0">
          <div className="truncate text-lg font-medium">{track.title}</div>
          <div className="truncate text-sm text-muted">
            {track.artist} · {fmtSize(track.sizeMb)}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {onDevice && (
          <Choice
            icon={<HardDrive size={18} strokeWidth={1.6} />}
            title={t('del.deviceOnly')}
            hint={t('del.deviceOnlyHint')}
            onClick={() => deleteFromDevice(track.id)}
          />
        )}
        <Choice
          danger
          icon={<CloudOff size={18} strokeWidth={1.6} />}
          title={notUploaded ? t('del.cancelUpload') : t('del.fromStorage')}
          hint={
            notUploaded
              ? t('del.notUploadedHint')
              : t('del.fromStorageHint')
          }
          onClick={() => deleteEverywhere(track.id)}
        />
      </div>

      <button onClick={() => askDelete(null)} className="mt-4 w-full rounded-full py-3 text-sm text-muted hover:text-fg">
        {t('common.cancel')}
      </button>
    </Modal>
  )
}

/** Добавление музыки: по сути кладём файлы в папку синхронизации */
export function UploadDialog() {
  const open = useStore((s) => s.uploadOpen)
  const { setUploadOpen, uploadFiles } = usePick('setUploadOpen', 'uploadFiles')
  const [drag, setDrag] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  if (!open) return null

  const take = (files: FileList | null) => {
    const audio = [...(files ?? [])].filter((f) => /audio|\.(mp3|flac|m4a|aac|ogg|oga|opus|wav|aiff?|wma|ape|wv)$/i.test(f.type || f.name))
    if (audio.length) uploadFiles(audio)
  }

  return (
    <Modal onClose={() => setUploadOpen(false)}>
      <div className="mb-5 flex items-start justify-between">
        <span className="label text-muted">{t('upload.title')}</span>
        <IconBtn title={t('common.close')} onClick={() => setUploadOpen(false)} className="-mt-2 -me-2">
          <X size={18} />
        </IconBtn>
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
          take(e.dataTransfer.files)
        }}
        onClick={() => input.current?.click()}
        className={cx(
          'flex cursor-pointer flex-col items-center gap-3 rounded-3xl border-2 border-dashed px-6 py-10 text-center transition-colors',
          drag ? 'border-red bg-red/5' : 'border-line hover:border-fg/40',
        )}
      >
        <span className="grid h-14 w-14 place-items-center rounded-full bg-card-3">
          <Upload size={22} strokeWidth={1.6} />
        </span>
        <div className="text-[15px]">{t('upload.drop')}</div>
        <div className="text-xs text-muted">{t('upload.orPick')}</div>
        <input ref={input} type="file" multiple accept="audio/*" hidden onChange={(e) => take(e.target.files)} />
      </div>

      {/* хост: файлы сразу уходят в хранилище; устройство: «положи в папку синхронизации» */}
      {isHost ? (
        <div className="mt-5 text-xs text-muted">{t('upload.hostHint')}</div>
      ) : (
        <div className="mt-5 rounded-2xl bg-card-2 p-4">
          <div className="label mb-1 text-muted">{t('upload.folder')}</div>
          <div className="truncate text-xs">{t('sync.folderSoon')}</div>
          <div className="mt-2 text-xs text-muted">{t('upload.folderHint')}</div>
        </div>
      )}
    </Modal>
  )
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div
      className="pointer-events-none fixed right-4 left-4 z-[60] flex flex-col items-center gap-2 md:left-auto md:items-end"
      style={{ top: 'calc(1rem + var(--safe-top))' }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={cx(
            'widget flex max-w-sm items-center gap-3 px-5 py-3 text-sm shadow-2xl ring-1',
            t.kind === 'ok' && 'ring-green/50',
            t.kind === 'error' && 'ring-red/60',
            t.kind === 'info' && 'ring-transparent',
          )}
        >
          <span
            className={cx(
              'h-2 w-2 shrink-0 rounded-full',
              t.kind === 'ok' && 'bg-green',
              t.kind === 'error' && 'bg-red',
              t.kind === 'info' && 'bg-muted',
            )}
          />
          {t.text}
        </div>
      ))}
    </div>
  )
}
