import { useEffect, useState } from 'react'
import { Modal } from '../components/Dialogs'
import { CloudDownload, CloudUpload, HardDrive, Laptop, Monitor, Pause, Play, Plus, RefreshCw, Server, ShieldCheck, Smartphone } from 'lucide-react'
import { trackCover } from '../lib/covers'
import { fmtAgo, fmtSize, t as tx, tn } from '../i18n'
import { getApiBase } from '../lib/api'
import { usePick } from '../store'
import { Cover, cx, DotLine, DotNum } from '../components/ui'
import { PageTitle } from './Library'
import { useProgress } from '../lib/pos'

export function Sync() {
  const prog = useProgress()
  const { tracks, syncNow, covers, devices, stats, conn, changeServer, settings, setSetting, syncInfo, setUploadOpen, pauseSync, resumeSync, checkSync, power, standalone, startBinding } = usePick(
    'tracks', 'syncNow', 'covers', 'devices', 'stats', 'conn', 'changeServer', 'settings', 'setSetting', 'syncInfo', 'setUploadOpen', 'pauseSync', 'resumeSync', 'checkSync', 'power', 'standalone', 'startBinding',
  )
  const online = conn === 'online'
  const onPhone = tracks.filter((t) => t.status === 'synced')
  const phoneMb = onPhone.reduce((a, t) => a + t.sizeMb, 0)
  const limitMb = settings.storageLimitGb * 1024
  const [cleanup, setCleanup] = useState(false)
  const queue = tracks.filter((t) => t.status === 'uploading' || t.status === 'downloading')
  // сколько ждёт отправки и скачивания — считает синхронизация (а не только то, что идёт прямо сейчас)
  const up = syncInfo.up
  const down = syncInfo.down
  const busy = syncInfo.running || queue.some((t) => t.progress !== undefined)
  // сколько из нужного уже на телефоне: скачанное + то, что ещё ждёт
  const total = onPhone.length + down
  const libraryMb = tracks.reduce((a, x) => a + x.sizeMb, 0)
  // экономия заряда без зарядки: фоновая передача ждёт (кнопка «Синхронизировать» всё равно запускает)
  const held = power.saving && !power.charging
  const state = syncInfo.paused ? tx('sync.paused') : busy ? tx('sync.busy') : up || down ? tx(held ? 'sync.held' : 'sync.waiting') : tx('sync.done')
  const icons = { desktop: Monitor, laptop: Laptop, phone: Smartphone }

  // сервер не привязан: синхронизировать не с чем — что на телефоне и кнопка «Привязать»
  if (standalone)
    return (
      <div>
        <PageTitle sub={tx('solo.syncSub')}>{tx('nav.server')}</PageTitle>
        <section className="widget flex flex-col gap-5 p-6">
          <span className="label flex items-center gap-2 text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-muted" />
            {tx('solo.noServer')}
          </span>
          <p className="max-w-md text-sm text-muted">{tx('solo.noServerHint')}</p>
          <div>
            <div className="flex items-center gap-2 text-muted">
              <Smartphone size={16} strokeWidth={1.6} /> <span className="text-sm">{tx('solo.onPhone')}</span>
            </div>
            <DotNum className="text-6xl">{tracks.length}</DotNum>
            <div className="font-mono text-[11px] text-muted">{fmtSize(libraryMb)}</div>
          </div>
          <button onClick={startBinding} className="flex items-center gap-2 self-start rounded-full bg-sel px-5 py-3 text-sm text-on-sel transition-transform active:scale-95">
            <Server size={16} /> {tx('solo.bind')}
          </button>
        </section>
      </div>
    )

  return (
    <div>
      <PageTitle sub={tx('sync.sub')}>{tx('nav.server')}</PageTitle>

      {/* музыка на телефоне занимает больше лимита — предложить почистить (только телефон, сервер не трогаем) */}
      <div className="widget mb-3 flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="text-[15px]">{tx('space.title')}</div>
          <div className={cx('text-xs', limitMb && phoneMb > limitMb ? 'text-red' : 'text-muted')}>
            {limitMb ? tx('space.usedOf', { used: fmtSize(phoneMb), limit: fmtSize(limitMb) }) : tx('space.used', { used: fmtSize(phoneMb) })}
          </div>
          {limitMb > 0 && <DotLine className="mt-2" size={3} value={Math.min(1, phoneMb / limitMb)} />}
        </div>
        <button onClick={() => setCleanup(true)} disabled={!onPhone.length} className="rounded-full bg-card-3 px-4 py-2 text-sm disabled:opacity-40">
          {tx('space.free')}
        </button>
      </div>
      {cleanup && <CleanupDialog onClose={() => setCleanup(false)} />}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* статус */}
        <section className="widget flex flex-col gap-5 p-6 lg:col-span-2">
          <div className="flex items-center justify-between">
            <span className="label text-muted">{tx('sync.status')}</span>
            <span className="label flex items-center gap-2 text-muted">
              <span className={cx('h-1.5 w-1.5 rounded-full', syncInfo.paused ? 'bg-muted' : busy ? 'blink bg-red' : up || down ? 'bg-red' : 'bg-fg')} />
              {state}
            </span>
          </div>
          <div className="flex flex-wrap items-end gap-8">
            <div>
              <div className="flex items-center gap-2 text-muted">
                <CloudUpload size={16} strokeWidth={1.6} /> <span className="text-sm">{tx('sync.toServer')}</span>
              </div>
              <DotNum className="text-6xl">{up}</DotNum>
            </div>
            <div>
              <div className="flex items-center gap-2 text-muted">
                <CloudDownload size={16} strokeWidth={1.6} /> <span className="text-sm">{tx('sync.toDevice')}</span>
              </div>
              <DotNum className="text-6xl">{down}</DotNum>
            </div>
          </div>
          {/* всего: вся библиотека на сервере и сколько из неё лежит на телефоне */}
          <div className="grid grid-cols-2 gap-2">
            {[
              [Server, tx('sync.onServer'), tracks.length, libraryMb],
              [Smartphone, tx('sync.onPhone'), onPhone.length, phoneMb],
            ].map(([Icon, label, n, mb], i) => {
              const I = Icon as typeof Server
              return (
                <div key={i} className="rounded-2xl bg-card-2 p-3">
                  <div className="flex items-center gap-1.5 text-xs text-muted">
                    <I size={13} strokeWidth={1.6} /> {label as string}
                  </div>
                  <div className="font-dot text-2xl font-black">{(n as number).toLocaleString()}</div>
                  <div className="font-mono text-[11px] text-muted">{fmtSize(mb as number)}</div>
                </div>
              )
            })}
          </div>
          {/* скачано из нужного: полоска и числа */}
          {total > 0 && (
            <div className="flex flex-col gap-1.5">
              <DotLine size={4} value={onPhone.length / total} />
              <div className="flex justify-between font-mono text-[11px] text-muted">
                <span>{tx('sync.wantedOf', { done: onPhone.length, total })}</span>
                <span>{fmtSize(phoneMb)}</span>
              </div>
            </div>
          )}
          {/* идёт — «Остановить»; на паузе — «Продолжить»; иначе — «Синхронизировать»; и всегда «Проверить» */}
          <div className="flex flex-wrap items-center gap-2">
            {syncInfo.paused ? (
              <button onClick={resumeSync} className="flex items-center gap-2 rounded-full bg-sel px-5 py-3 text-sm text-on-sel transition-transform active:scale-95">
                <Play size={15} /> {tx('sync.resume')}
              </button>
            ) : busy ? (
              <button onClick={pauseSync} className="flex items-center gap-2 rounded-full bg-sel px-5 py-3 text-sm text-on-sel transition-transform active:scale-95">
                <Pause size={15} /> {tx('sync.stop')}
              </button>
            ) : (
              <button onClick={syncNow} className="flex items-center gap-2 rounded-full bg-sel px-5 py-3 text-sm text-on-sel transition-transform active:scale-95">
                <RefreshCw size={15} /> {tx('sync.syncBtn')}
              </button>
            )}
            <button
              onClick={() => void checkSync()}
              disabled={syncInfo.checking}
              className="flex items-center gap-2 rounded-full bg-card-3 px-5 py-3 text-sm transition-transform active:scale-95 disabled:opacity-60"
            >
              <ShieldCheck size={15} className={cx(syncInfo.checking && 'animate-pulse')} /> {tx('sync.check')}
            </button>
            <span className="ms-auto text-xs text-muted">
              {syncInfo.at ? tx('sync.last', { ago: fmtAgo(syncInfo.at) }) : tx('sync.never')}
            </span>
          </div>
          {/* добавленное здесь сразу играет, а на сервер уходит само */}
          <button
            onClick={() => setUploadOpen(true)}
            className="flex items-center gap-3 rounded-2xl bg-card-2 p-3 text-start text-sm transition-colors hover:bg-card-3"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-card-3">
              <Plus size={16} />
            </span>
            <span className="min-w-0">
              {tx('nav.addMusic')}
              <span className="block text-xs text-muted">{tx('sync.addHint')}</span>
            </span>
          </button>
        </section>

        {/* сервер */}
        <section className="widget flex flex-col gap-3 p-6">
          <span className="label text-muted">{tx('sync.server')}</span>
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-card-3">
              <Server size={18} strokeWidth={1.6} />
            </span>
            <div className="min-w-0">
              <div className="truncate font-mono text-sm" dir="ltr">{getApiBase() || location.origin}</div>
              <div className="flex items-center gap-1.5 text-xs text-muted">
                <span className={cx('h-1.5 w-1.5 rounded-full', online ? 'bg-fg' : 'blink bg-red')} />
                {online ? tx('server.online') : tx('server.offline')}
              </div>
            </div>
          </div>
          <div className="mt-auto flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] text-muted">musich-server v{stats?.version ?? '…'}</span>
            <button onClick={changeServer} className="text-xs text-muted hover:text-fg">
              {tx('dev.otherServer')}
            </button>
          </div>
        </section>

        {/* что лежит на телефоне и что качать */}
        <section className="widget flex flex-col gap-3 p-6">
          <span className="label text-muted">{tx('dev.onPhone')}</span>
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-card-3">
              <HardDrive size={18} strokeWidth={1.6} />
            </span>
            <div className="min-w-0">
              <div className="text-sm">{tn('n.tracks', onPhone.length)}</div>
              <div className="text-xs text-muted">{fmtSize(phoneMb)}</div>
            </div>
          </div>
          <p className="text-xs text-muted">{tx('dev.onPhoneHint')}</p>
          {/* что держать на телефоне — два варианта, видно, какой выбран */}
          <div className="mt-auto flex flex-col gap-1.5">
            <span className="text-sm">{tx('set.keepWhat')}</span>
            {([false, true] as const).map((all) => (
              <button
                key={String(all)}
                onClick={() => setSetting('autoDownload', all)}
                className={cx(
                  'flex items-center justify-between rounded-2xl px-4 py-2.5 text-start text-sm transition-colors',
                  settings.autoDownload === all ? 'bg-sel text-on-sel' : 'bg-card-2 hover:bg-card-3',
                )}
              >
                {all ? tx('set.keepAll') : tx('set.keepSome')}
                {all && <span className="font-mono text-[11px] opacity-70">{fmtSize(libraryMb)}</span>}
              </button>
            ))}
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            {tx('set.wifi')}
            <input type="checkbox" className="h-4 w-4 accent-[var(--red)]" checked={settings.wifiOnly} onChange={(e) => setSetting('wifiOnly', e.target.checked)} />
          </label>
        </section>

        {/* очередь */}
        <section className="widget flex flex-col gap-2 p-6 lg:col-span-2 lg:row-span-2">
          <span className="label mb-2 text-muted">{tx('sync.queue', { n: queue.length })}</span>
          {queue.length === 0 && <div className="py-10 text-center text-sm text-muted">{tx('sync.queueEmpty')}</div>}
          {queue.map((t) => (
            <div key={t.id} className="flex items-center gap-3 rounded-2xl bg-card-2 p-3">
              <Cover seed={t.album} src={trackCover(t, covers)} className="h-10 w-10" rounded="rounded-xl" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm">{t.title}</span>
                  <span className="font-mono text-[11px] text-muted">{Math.round(prog[t.id] ?? t.progress ?? 0)}%</span>
                </div>
                <div className="mt-1.5 flex items-center gap-3">
                  {t.status === 'uploading' ? (
                    <CloudUpload size={13} className="shrink-0 text-red" />
                  ) : (
                    <CloudDownload size={13} className="shrink-0 text-fg" />
                  )}
                  <DotLine className="flex-1" size={3} value={(prog[t.id] ?? t.progress ?? 0) / 100} />
                  <span className="font-mono text-[10px] text-muted">{fmtSize(t.sizeMb)}</span>
                </div>
              </div>
            </div>
          ))}
        </section>

        {/* устройства */}
        <section className="widget flex flex-col gap-3 p-6">
          <span className="label mb-1 text-muted">{tx('sync.devices', { n: devices.length })}</span>
          {devices.map((d) => {
            const Icon = icons[d.kind]
            return (
              <div key={d.id} className="flex items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-card-3">
                  <Icon size={17} strokeWidth={1.6} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">
                    {d.name}
                    {d.current && <span className="text-muted"> · {tx('sync.thisDevice')}</span>}
                  </div>
                  <div className="text-xs text-muted">
                    {d.online ? tx('server.online') : tx('server.offline')} · {fmtAgo(d.lastSeenAt)}
                  </div>
                </div>
                <span className={cx('h-2 w-2 rounded-full', d.online ? 'bg-fg' : 'bg-dot-off')} />
              </div>
            )
          })}
        </section>
      </div>
    </div>
  )
}

/**
 * Освободить место на телефоне: убрать скачанные треки (на сервере они остаются и сами больше не качаются).
 * Два варианта: давно не слушал (60 дней) — или всё, кроме «Избранного» и плейлистов «держать на устройстве»
 */
function CleanupDialog({ onClose }: { onClose: () => void }) {
  const { tracks, playlists, plays, loadPlays, freeUpSpace, currentId } = usePick('tracks', 'playlists', 'plays', 'loadPlays', 'freeUpSpace', 'currentId')
  const [mode, setMode] = useState<'old' | 'notKept'>('old')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (plays === null) void loadPlays()
  }, [plays, loadPlays])
  const kept = new Set(playlists.filter((p) => p.keepOffline).flatMap((p) => p.trackIds))
  const last = new Map<string, number>()
  for (const p of plays ?? []) {
    const at = Date.parse(p.playedAt)
    if (at > (last.get(p.trackId) ?? 0)) last.set(p.trackId, at)
  }
  const old = Date.now() - 60 * 86_400_000
  const list = tracks.filter(
    (t) => t.status === 'synced' && t.id !== currentId && !t.liked && !kept.has(t.id) && (mode === 'notKept' || (last.get(t.id) ?? 0) < old),
  )
  const mb = list.reduce((a, t) => a + t.sizeMb, 0)
  return (
    <Modal onClose={onClose}>
      <div className="mb-1 text-lg font-medium">{tx('space.free')}</div>
      <p className="mb-4 text-sm text-muted">{tx('space.freeHint')}</p>
      <div className="mb-4 flex flex-col gap-1.5">
        {(['old', 'notKept'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cx('rounded-2xl px-4 py-3 text-start text-[15px] transition-colors', mode === m ? 'bg-sel text-on-sel' : 'bg-card-3')}
          >
            {tx(m === 'old' ? 'space.old' : 'space.notKept')}
          </button>
        ))}
      </div>
      <div className="mb-4 text-sm">{tx('space.will', { n: list.length, size: fmtSize(mb) })}</div>
      <div className="flex gap-2">
        <button onClick={onClose} className="flex-1 rounded-full bg-card-3 py-3 text-sm">
          {tx('common.cancel')}
        </button>
        <button
          disabled={!list.length || busy}
          onClick={async () => {
            setBusy(true)
            await freeUpSpace(list.map((t) => t.id))
            onClose()
          }}
          className="flex-1 rounded-full bg-sel py-3 text-sm text-on-sel disabled:opacity-40"
        >
          {tx('space.go')}
        </button>
      </div>
    </Modal>
  )
}
