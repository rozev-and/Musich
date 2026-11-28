import { FolderSearch } from 'lucide-react'
import { t } from '../i18n'
import { usePick } from '../store'
import { cx, DotLine } from './ui'

/**
 * Пока сервер сканирует папку — заглушка с прогрессом вместо дёргающегося списка.
 * Новые треки стор копит и показывает разом, когда скан закончится
 */
export function ScanBanner({ className }: { className?: string }) {
  const { musicFolders } = usePick('musicFolders')
  const busy = musicFolders.filter((f) => f.scanning)
  if (!busy.length) return null
  const done = busy.reduce((a, f) => a + (f.scanDone ?? 0), 0)
  const total = busy.reduce((a, f) => a + (f.scanTotal ?? 0), 0)
  return (
    <section className={cx('widget flex flex-col gap-3 p-5', className)}>
      <div className="flex items-center justify-between gap-3">
        <span className="label flex items-center gap-2 text-muted">
          <span className="blink h-1.5 w-1.5 rounded-full bg-red" />
          {t('scan.title')}
        </span>
        <FolderSearch size={15} strokeWidth={1.6} className="text-muted" />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div dir="ltr" className="min-w-0 truncate font-mono text-xs text-muted">
          {busy.map((f) => f.path).join(' · ')}
        </div>
        <div className="font-mono text-[11px] whitespace-nowrap text-muted">
          {/* пока сервер ещё считает файлы, total = 0 */}
          {total ? t('scan.progress', { done, total }) : t('scan.counting')}
        </div>
      </div>
      <DotLine value={total ? done / total : 0} size={5} />
      <div className="text-xs text-muted">{t('scan.hint')}</div>
    </section>
  )
}
