import { RotateCcw, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fmtAgo, fmtSize, t, tn } from '../i18n'
import { api, type TrashItem } from '../lib/api'
import { usePick } from '../store'
import { Modal } from './Dialogs'
import { cx, IconBtn } from './ui'

const DAY = 86_400_000

/** Корзина сервера: удалённые треки ещё лежат на диске — вернуть на место или стереть насовсем */
export function TrashDialog({ onClose, onChange }: { onClose: () => void; onChange?: (items: TrashItem[]) => void }) {
  const { toast, pullChanges } = usePick('toast', 'pullChanges')
  const [items, setItems] = useState<TrashItem[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // «Очистить» стирает всё безвозвратно — второй клик подтверждает
  const [sure, setSure] = useState(false)

  const update = (list: TrashItem[]) => {
    setItems(list)
    onChange?.(list)
  }
  useEffect(() => {
    api<TrashItem[]>('/trash').then(update, (e: Error) => toast(e.message, 'error'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!sure) return
    const id = setTimeout(() => setSure(false), 3000)
    return () => clearTimeout(id)
  }, [sure])

  const run = async (key: string, fn: () => Promise<unknown>, after: (list: TrashItem[]) => TrashItem[], done?: string) => {
    if (busy) return
    setBusy(key)
    try {
      await fn()
      update(after(items ?? []))
      if (done) toast(done)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }
  const restore = (it: TrashItem) =>
    run(it.id, async () => {
      await api(`/trash/${it.id}/restore`, { method: 'POST' })
      await pullChanges()
    }, (l) => l.filter((x) => x.id !== it.id), t('trash.restored', { title: it.title }))
  const purge = (it: TrashItem) => run(it.id, () => api(`/trash/${it.id}`, { method: 'DELETE' }), (l) => l.filter((x) => x.id !== it.id))
  const purgeAll = () => {
    if (!sure) return setSure(true)
    setSure(false)
    void run('#all', () => api('/trash', { method: 'DELETE' }), () => [], t('trash.emptied'))
  }

  const total = (items ?? []).reduce((a, x) => a + x.size, 0)

  return (
    <Modal onClose={onClose} wide>
      <div className="mb-1 flex items-start justify-between">
        <span className="label text-muted">{t('trash.title')}</span>
        <IconBtn title={t('common.close')} onClick={onClose} className="-mt-2 -me-2">
          <X size={18} />
        </IconBtn>
      </div>
      <div className="mb-4 text-xs text-muted">
        {items?.length ? `${tn('n.tracks', items.length)} · ${fmtSize(total / 1048576)} · ` : ''}
        {t('trash.hint')}
      </div>

      {items === null ? (
        <div className="py-10 text-center text-sm text-muted">…</div>
      ) : !items.length ? (
        <div className="py-10 text-center text-sm text-muted">{t('trash.empty')}</div>
      ) : (
        <div className="-mx-2 max-h-[55vh] overflow-y-auto">
          {items.map((it) => {
            const left = Math.max(0, Math.ceil((Date.parse(it.expiresAt) - Date.now()) / DAY))
            return (
              <div key={it.id} className={cx('flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-card-3', busy === it.id && 'opacity-50')}>
                <span className="w-12 shrink-0 font-mono text-xs text-muted">{it.trackNo ? `№${it.trackNo}` : ''}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{it.title}</div>
                  <div className="truncate text-xs text-muted">
                    {it.artist} · {fmtAgo(Date.parse(it.deletedAt))} · {tn('trash.left', left)}
                  </div>
                </div>
                <IconBtn title={t('trash.restore')} onClick={() => void restore(it)}>
                  <RotateCcw size={16} />
                </IconBtn>
                <IconBtn title={t('trash.purge')} onClick={() => void purge(it)} className="hover:text-red">
                  <Trash2 size={16} />
                </IconBtn>
              </div>
            )
          })}
        </div>
      )}

      <div className="mt-4 flex gap-2">
        <button onClick={onClose} className="flex-1 rounded-full py-3 text-sm text-muted hover:text-fg">
          {t('common.close')}
        </button>
        {!!items?.length && (
          <button
            onClick={purgeAll}
            disabled={!!busy}
            className={cx('flex-1 rounded-full py-3 text-sm transition-colors', sure ? 'bg-red text-on-red' : 'bg-card-3 text-red hover:bg-red/15')}
          >
            {sure ? t('trash.sure') : t('trash.emptyAll')}
          </button>
        )}
      </div>
    </Modal>
  )
}
