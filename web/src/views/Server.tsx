import { CloudUpload, Copy, Pause, Play, FolderSearch, HardDrive, Laptop, Monitor, RefreshCw, RotateCcw, Smartphone, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from '../components/Dialogs'
import type { Activity } from '../store'
import type { Device } from '../types'
import { api, mediaUrl, type ServerTrack } from '../lib/api'
import { fmtTime } from '../lib/format'
import { fmtAgo, fmtSize, getLang, t as tx, tn } from '../i18n'
import { groupByArtist } from '../lib/artists'
import { selectIsOwner, usePick, useStore } from '../store'
import { Cover, cx, DotLine, DotNum, IconBtn, Seek } from '../components/ui'
import { PageTitle } from './Library'
import { Ecosystem } from '../components/Ecosystem'

const MB = 1024 * 1024

/** Хост: вместо синхронизации — состояние самого сервера и подключённых к нему устройств */
export function Server() {
  const [log, setLog] = useState(false)
  const { tracks, activity, incoming, devices, stats, rescan, rescanning } = usePick('tracks', 'activity', 'incoming', 'devices', 'stats', 'rescan', 'rescanning')
  // пересканировать папки может только владелец (сервер остальным ответит 403)
  const isOwner = useStore(selectIsOwner)
  const albums = new Set(tracks.map((t) => t.album)).size
  const artists = groupByArtist(tracks).length
  const disk = stats?.disk
  const used = disk ? disk.total - disk.free : 0

  return (
    <div>
      <PageTitle sub={tx('server.sub')}>{tx('nav.server')}</PageTitle>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* диск: тот, куда ложатся загрузки */}
        <section className="widget flex flex-col gap-4 p-6 lg:col-span-2">
          <div className="flex items-center justify-between">
            <span className="label text-muted">{tx('server.disk')}</span>
            <HardDrive size={15} strokeWidth={1.6} className="text-muted" />
          </div>
          {disk ? (
            <>
              <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
                <DotNum className="text-6xl">{Math.round((used / disk.total) * 100)}%</DotNum>
                <div className="pb-1 text-sm text-muted">
                  <div>{tx('server.used', { used: fmtSize(used / MB), total: fmtSize(disk.total / MB) })}</div>
                  <div>{tx('server.free', { free: fmtSize(disk.free / MB) })}</div>
                </div>
              </div>
              <DotLine size={5} value={used / disk.total} />
            </>
          ) : (
            <div className="py-6 text-sm text-muted">{tx('server.diskUnknown')}</div>
          )}
        </section>

        {/* библиотека (своего внешнего адреса сервер не знает: перед ним может стоять nginx или другой прокси — его не показываем) */}
        <section className="widget flex flex-col gap-3 p-6">
          <div className="flex items-center justify-between gap-2">
            <span className="label text-muted">{tx('server.library')}</span>
            <span className="font-mono text-[11px] text-muted">musich-server v{stats?.version ?? '…'}</span>
          </div>
          <div>
            <DotNum className="text-5xl">{tracks.length}</DotNum>
            <div className="mt-1 text-sm text-muted">{tn('w.tracks', tracks.length)}</div>
          </div>
          <div className="flex flex-wrap gap-x-4 font-mono text-[11px] text-muted">
            <span>{tx('server.libSize', { size: fmtSize((stats?.musicBytes ?? 0) / MB) })}</span>
            <span>{tn('n.albums', albums)}</span>
            <span>{tn('n.artists', artists)}</span>
          </div>
          {isOwner && (
            <>
              <button
                onClick={rescan}
                disabled={rescanning}
                className="mt-auto flex items-center justify-center gap-2 rounded-full bg-sel px-4 py-2.5 text-sm text-on-sel transition-transform active:scale-95 disabled:opacity-60"
              >
                <RefreshCw size={15} className={cx(rescanning && 'animate-spin')} /> {tx('server.rescan')}
              </button>
              <p className="text-xs text-muted">{tx('server.rescanHint')}</p>
            </>
          )}
        </section>

        {/* экосистема: сервер и все устройства — где сколько музыки, места, как подключены, версии, что играет */}
        <Ecosystem />

        {/* что приходило */}
        <section className="widget flex flex-col gap-2 p-6 lg:col-span-2">
          {/* компактно: последнее событие и «Все» — весь список окном, со временем и устройством */}
          <div className="flex items-center gap-3">
            <span className="label text-muted">{tx('server.activity')}</span>
            <span className="flex-1" />
            {activity.length > 0 && (
              <button onClick={() => setLog(true)} className="rounded-full bg-card-3 px-4 py-1.5 text-xs transition-colors hover:bg-sel hover:text-on-sel">
                {tx('server.activityAll', { n: activity.length })}
              </button>
            )}
          </div>

          {incoming.length > 0 && (
            <>
              <div className="label mb-1 flex items-center gap-2 text-muted">
                <span className="blink h-1.5 w-1.5 rounded-full bg-red" />
                {tx('server.incoming')}
              </div>
              {incoming.map((u) => {
                const p = u.total ? (u.received / u.total) * 100 : 0
                return (
                  <div key={u.id} className="flex items-center gap-3 rounded-2xl bg-card-2 p-3">
                    <Cover seed={u.fileName} className="h-10 w-10" rounded="rounded-xl" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm">{u.fileName}</span>
                        <span className="font-mono text-[11px] text-muted">{Math.round(p)}%</span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-3">
                        <CloudUpload size={13} className="shrink-0 text-red" />
                        <DotLine className="flex-1" size={3} value={p / 100} />
                        <span className="text-[11px] text-muted">{u.source ?? '—'}</span>
                      </div>
                    </div>
                  </div>
                )
              })}
              <div className="my-2 h-px bg-line" />
            </>
          )}

          {activity.length === 0 && <div className="py-10 text-center text-sm text-muted">{tx('server.activityEmpty')}</div>}
          {activity.slice(0, 1).map((a) => (
            <div key={a.id} className="flex items-center gap-3 rounded-2xl px-1 py-1">
              {a.device ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green" />
              ) : (
                <FolderSearch size={13} strokeWidth={1.6} className="shrink-0 text-muted" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">
                {a.device ? tx('server.sentBy', { device: a.device, title: a.title }) : tx('server.foundInFolder', { title: a.title })}
              </span>
              <span className="shrink-0 text-xs text-muted">{fmtAgo(a.at)}</span>
            </div>
          ))}
        </section>

        {log && <ActivityLog list={activity} devices={devices} onClose={() => setLog(false)} />}

        <Conflicts />
      </div>
    </div>
  )
}

interface ConflictList {
  returned: { id: string; trackId: string; title: string; artist: string; fileName: string; source?: string; createdAt: string }[]
  duplicates: { key: string; tracks: ServerTrack[] }[]
}

const DUP_PAGE = 10

/**
 * Прослушать файл прямо в «Конфликтах»: свой маленький плеер, не трогая очередь. Играет один файл за раз;
 * основной плеер на это время встаёт на паузу. Ушли со страницы — звук останавливается
 */
function usePreview() {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [state, setState] = useState<{ id: string; playing: boolean; pos: number; dur: number } | null>(null)
  const { playing, toggle } = usePick('playing', 'toggle')
  useEffect(() => () => audio.current?.pause(), [])

  const play = (tr: ServerTrack) => {
    let a = audio.current
    if (!a) {
      a = new Audio()
      a.preload = 'metadata'
      const sync = () => setState((st) => st && { ...st, playing: !a!.paused, pos: a!.currentTime, dur: a!.duration || st.dur })
      a.addEventListener('timeupdate', sync)
      a.addEventListener('play', sync)
      a.addEventListener('pause', sync)
      a.addEventListener('loadedmetadata', sync)
      a.addEventListener('ended', sync)
      audio.current = a
    }
    if (state?.id === tr.id) {
      if (a.paused) void a.play()
      else a.pause()
      return
    }
    a.src = mediaUrl(`/tracks/${tr.id}/file`, tr.hash)
    setState({ id: tr.id, playing: true, pos: 0, dur: tr.duration })
    if (playing) toggle()
    void a.play().catch(() => setState((st) => st && { ...st, playing: false }))
  }
  const seek = (v: number) => {
    const a = audio.current
    if (!a || !state) return
    a.currentTime = v * (a.duration || state.dur)
  }
  return { state, play, seek }
}

/**
 * Что ждёт решения: удалённый трек прислали с устройства снова (вернуть или не нужен)
 * и возможные дубли — одинаковые исполнитель и название у разных файлов (удалить лишний или «это разные треки»)
 */
// Качество файла: без потерь (flac, wav…) всегда лучше; дальше — по битрейту (размер / длительность)
const LOSSLESS = ['flac', 'wav', 'alac', 'aiff', 'aif', 'ape', 'wv']
const kbps = (t: ServerTrack) => (t.duration ? Math.round((t.size * 8) / t.duration / 1000) : 0)
const quality = (t: ServerTrack) => (LOSSLESS.includes(t.format.toLowerCase()) ? 100_000 : 0) + kbps(t)
const bestOf = (list: ServerTrack[]) => list.reduce((a, b) => (quality(b) > quality(a) ? b : a))

function Conflicts() {
  const { toast, deleteEverywhere, pullChanges } = usePick('toast', 'deleteEverywhere', 'pullChanges')
  const [data, setData] = useState<ConflictList | null>(null)
  const [shown, setShown] = useState(DUP_PAGE)
  const preview = usePreview()
  const load = useCallback(() => {
    api<ConflictList>('/conflicts').then(setData, (e: Error) => toast(e.message, 'error'))
  }, [toast])
  useEffect(load, [load])

  // оставить лучший файл: остальные — в корзину; лайк переносим на оставшийся
  const keepBest = async (list: ServerTrack[]) => {
    const best = bestOf(list)
    if (list.some((x) => x.liked) && !best.liked) await api(`/tracks/${best.id}/like`, { method: 'PUT', body: { liked: true } })
    for (const x of list) if (x.id !== best.id) await deleteEverywhere(x.id)
  }
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e) {
      toast((e as Error).message, 'error')
    }
    load()
  }
  const total = (data?.returned.length ?? 0) + (data?.duplicates.length ?? 0)

  return (
    <section className="widget flex flex-col gap-3 p-6 lg:col-span-3">
      <div className="flex items-center justify-between gap-2">
        <span className="label text-muted">{tx('conf.title')}</span>
        {total > 0 && <span className="rounded-full bg-red px-2 py-0.5 font-mono text-[11px] text-on-red">{total}</span>}
      </div>
      {data && total === 0 && <p className="py-4 text-sm text-muted">{tx('conf.none')}</p>}

      {!!data?.returned.length && (
        <div className="flex flex-col gap-1">
          <div className="text-[15px]">{tx('conf.returned')}</div>
          <p className="mb-1 text-xs text-muted">{tx('conf.returnedHint')}</p>
          {data.returned.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-2xl bg-card-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">
                  {c.artist} — {c.title}
                </div>
                <div className="text-xs text-muted">
                  {c.source ?? '—'} · {fmtAgo(Date.parse(c.createdAt))}
                </div>
              </div>
              <button
                onClick={() => act(async () => {
                  await api(`/conflicts/${c.id}`, { method: 'POST', body: { action: 'restore' } })
                  await pullChanges()
                })}
                className="flex items-center gap-1.5 rounded-full bg-sel px-3 py-1.5 text-xs text-on-sel"
              >
                <RotateCcw size={13} /> {tx('conf.restore')}
              </button>
              <button
                onClick={() => act(() => api(`/conflicts/${c.id}`, { method: 'POST', body: { action: 'discard' } }))}
                className="rounded-full bg-card-3 px-3 py-1.5 text-xs hover:text-red"
              >
                {tx('conf.discard')}
              </button>
            </div>
          ))}
        </div>
      )}

      {!!data?.duplicates.length && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-[15px]">
            <Copy size={14} className="text-muted" /> {tx('conf.duplicates')}
            <span className="font-mono text-xs text-muted">{data.duplicates.length}</span>
          </div>
          <p className="-mt-1 text-xs text-muted">{tx('conf.duplicatesHint')}</p>
          <button
            onClick={() => act(async () => { for (const g of data.duplicates) await keepBest(g.tracks) })}
            className="self-start rounded-full border border-fg/20 px-3.5 py-1.5 text-xs transition-colors hover:border-fg/50"
          >
            {tx('dup.keepBestAll', { n: data.duplicates.length })}
          </button>
          {data.duplicates.slice(0, shown).map((g) => {
            const best = bestOf(g.tracks)
            return (
            <div key={g.key} className="rounded-2xl bg-card-2 p-2">
              {g.tracks.map((tr) => {
                const p = preview.state?.id === tr.id ? preview.state : null
                return (
                  <div key={tr.id} className={cx('rounded-xl px-2 py-1.5', p && 'bg-card-3')}>
                    <div className="flex items-center gap-3">
                      {/* прослушать прямо здесь: сравнить на слух, что это за файл */}
                      <button
                        onClick={() => preview.play(tr)}
                        title={p?.playing ? tx('common.pause') : tx('common.play')}
                        className={cx('grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors', p ? 'bg-sel text-on-sel' : 'bg-card-3 text-muted hover:text-fg')}
                      >
                        {p?.playing ? <Pause size={14} /> : <Play size={14} className="ms-0.5" />}
                      </button>
                      <span className="w-12 shrink-0 font-mono text-[11px] text-muted">{tr.trackNo ? `№${tr.trackNo}` : ''}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">
                          {tr.id === best.id && <span className="me-2 rounded-full bg-red/15 px-2 py-0.5 text-[11px] text-red">{tx('dup.best')}</span>}
                          {tr.artist} — {tr.title}
                        </div>
                        <div className="truncate text-xs text-muted">
                          {tr.album} · {tr.format.toUpperCase()} · {kbps(tr)} kbps · {fmtSize(tr.size / MB)} · {fmtTime(tr.duration)} · {tr.fileName}
                        </div>
                      </div>
                      <IconBtn title={tx('conf.deleteThis')} onClick={() => act(() => deleteEverywhere(tr.id))} className="text-muted hover:text-red">
                        <Trash2 size={15} />
                      </IconBtn>
                    </div>
                    {/* играет — полоска, её можно мотать */}
                    {p && (
                      <div className="mt-1.5 flex items-center gap-3 ps-11">
                        <span className="w-10 font-mono text-[11px] text-muted">{fmtTime(p.pos)}</span>
                        <Seek value={p.dur ? p.pos / p.dur : 0} onChange={preview.seek} className="flex-1" />
                        <span className="w-10 text-end font-mono text-[11px] text-muted">{fmtTime(p.dur)}</span>
                      </div>
                    )}
                  </div>
                )
              })}
              <div className="mt-1 flex flex-wrap gap-1 ps-1">
                <button onClick={() => act(() => keepBest(g.tracks))} className="rounded-full bg-sel px-3 py-1 text-xs text-on-sel">
                  {tx('dup.keepBest')}
                </button>
                <button
                  onClick={() => act(() => api('/conflicts/duplicates/ignore', { method: 'POST', body: { key: g.key } }))}
                  className="rounded-full px-2 py-1 text-xs text-muted hover:text-fg"
                >
                  {tx('conf.different')}
                </button>
              </div>
            </div>
            )
          })}
          {data.duplicates.length > shown && (
            <button onClick={() => setShown(shown + DUP_PAGE)} className="self-center rounded-full bg-card-3 px-4 py-2 text-xs">
              {tx('conf.more', { n: Math.min(DUP_PAGE, data.duplicates.length - shown) })}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * «Что приходило» целиком: у каждого события — когда (дата и время) и откуда: устройство (по его имени — свой значок)
 * или скан папки на сервере
 */
function ActivityLog({ list, devices, onClose }: { list: Activity[]; devices: Device[]; onClose: () => void }) {
  const icons = { desktop: Monitor, laptop: Laptop, phone: Smartphone }
  const when = new Intl.DateTimeFormat(getLang(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  return (
    <Modal onClose={onClose} wide>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-lg font-medium">{tx('server.activity')}</div>
          <div className="text-xs text-muted">{tx('server.activityHint')}</div>
        </div>
        <IconBtn title={tx('common.close')} onClick={onClose} className="-mt-2 -me-2 shrink-0">
          <X size={18} />
        </IconBtn>
      </div>
      <div className="flex flex-col">
        {list.map((a) => {
          const dev = a.device ? devices.find((d) => d.name === a.device) : undefined
          const Icon = a.device ? (dev ? icons[dev.kind] : Smartphone) : FolderSearch
          return (
            <div key={a.id} className="flex items-center gap-3 border-b border-line py-2.5 last:border-0">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-card-3 text-muted">
                <Icon size={15} strokeWidth={1.6} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{a.title}</div>
                <div className="truncate text-xs text-muted">
                  {a.artist} · {a.device ?? tx('server.fromFolder')}
                </div>
              </div>
              <span className="shrink-0 text-end font-mono text-[11px] text-muted" title={new Date(a.at).toLocaleString(getLang())}>
                {when.format(a.at)}
              </span>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
