import { ArrowRightLeft, Globe, Laptop, Monitor, Server as ServerIcon, Smartphone, Star, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fmtAgo, fmtSize, t, tn } from '../i18n'
import { api, type DeviceInfo, type Ecosystem as EcoData, type ServerDevice } from '../lib/api'
import { useStore } from '../store'
import { Modal } from './Dialogs'
import { cx, IconBtn } from './ui'

const MB = 1024 * 1024
const ONLINE_MS = 2 * 60_000
type Dev = ServerDevice & { info?: DeviceInfo }

/** Версия a старше b (0.1.0 < 0.2.0) */
const older = (a?: string, b?: string) => {
  if (!a || !b) return false
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0)
  return false
}
const seenAt = (d: Dev) => Date.parse(d.lastSeenAt)
const isWeb = (d: Dev) => d.info?.client === 'web'

/**
 * Браузер с домена и с домашнего адреса — для браузера два разных сайта, на сервере два устройства.
 * Показываем одной строкой: самое свежее, «на связи» — если на связи хоть одно
 */
function merge(devs: Dev[]): { d: Dev; ids: string[] }[] {
  const out: { d: Dev; ids: string[] }[] = []
  for (const d of [...devs].sort((a, b) => seenAt(b) - seenAt(a))) {
    const same = isWeb(d) ? out.find((x) => isWeb(x.d) && x.d.name === d.name) : undefined
    if (same) same.ids.push(d.id)
    else out.push({ d, ids: [d.id] })
  }
  return out
}

/**
 * «Экосистема» на странице «Сервер»: простой список — сервер и устройства, сколько на каждом треков,
 * на связи или нет. Что-то не так (старое приложение, мало места, давно без синхронизации) — строчкой под устройством
 */
export function Ecosystem() {
  const [eco, setEco] = useState<EcoData | null>(null)
  const forgetDevice = useStore((s) => s.forgetDevice)
  // переезд — это бэкап со всеми паролями: начать его может только сам владелец
  const owner = useStore((s) => s.me?.role === 'owner')
  const [moving, setMoving] = useState(false)
  useEffect(() => {
    let on = true
    const load = () => api<EcoData>('/ecosystem').then((r) => on && setEco(r), () => {})
    void load()
    const id = setInterval(() => document.visibilityState === 'visible' && void load(), 10_000)
    return () => {
      on = false
      clearInterval(id)
    }
  }, [])
  if (!eco) return null

  const groups = eco.users.map((u) => ({ u, rows: merge(u.devices) }))
  const rows = groups.flatMap((g) => g.rows)
  const online = rows.filter(({ d }) => Date.now() - seenAt(d) < ONLINE_MS).length
  const serverTracks = eco.users.reduce((a, u) => a + u.tracks, 0)
  const serverBytes = eco.users.reduce((a, u) => a + u.bytes, 0)
  const many = eco.users.length > 1

  return (
    <section className="widget flex flex-col p-6 lg:col-span-3">
      <div className="mb-2 flex items-center gap-3">
        <span className="label text-muted">{t('eco.title')}</span>
        <span className="flex-1" />
        <span className="text-xs text-muted">{t('eco.online', { n: online + 1, total: rows.length + 1 })}</span>
      </div>

      {/* сервер — всегда на связи: страница открыта с него. Он же главный узел: аккаунты и журнал живут на нём */}
      <Row icon={ServerIcon} kind={t('eco.server')} name={eco.server.name} badge={t('eco.main')} on main={`${serverTracks} ${tn('w.tracks', serverTracks)}`} extra={fmtSize(serverBytes / MB)} />

      {groups.map(({ u, rows: list }) =>
        list.length === 0 ? null : (
          <div key={u.id}>
            {many && <div className="mt-4 mb-1 px-1 text-xs text-muted">{u.me ? t('eco.you') : u.name || u.login}</div>}
            {list.map(({ d, ids }) => (
              <DeviceRow key={d.id} d={d} serverVersion={eco.server.version} onForget={u.me ? () => ids.forEach((id) => void forgetDevice(id)) : undefined} />
            ))}
          </div>
        ),
      )}
      {rows.length === 0 && <p className="pt-3 text-sm text-muted">{t('server.noDevices')}</p>}
      {owner && (
        <button onClick={() => setMoving(true)} className="mt-4 flex items-center gap-2 self-start text-sm text-muted transition-colors hover:text-fg">
          <ArrowRightLeft size={15} strokeWidth={1.8} />
          {t('eco.move')}
        </button>
      )}
      {moving && <MoveDialog onClose={() => setMoving(false)} />}
    </section>
  )
}

function DeviceRow({ d, serverVersion, onForget }: { d: Dev; serverVersion: string; onForget?: () => void }) {
  const i = d.info
  const on = Date.now() - seenAt(d) < ONLINE_MS
  const web = isWeb(d)
  const icon = web ? Globe : d.kind === 'phone' ? Smartphone : d.kind === 'laptop' ? Laptop : Monitor
  const kind = web ? t('eco.browser') : d.kind === 'phone' ? t('eco.phone') : t('eco.computer')
  // браузер своих треков не держит — играет с сервера; приложение без сведений — старая версия
  const main = web ? t('eco.fromServer') : i?.tracks !== undefined ? `${i.tracks} ${tn('w.tracks', i.tracks)}` : t('eco.update')
  const extra = !web && i?.free !== undefined ? t('eco.freeShort', { free: fmtSize(i.free / MB) }) : undefined
  const warn =
    older(i?.version, serverVersion)
      ? t('eco.warnOld')
      : i?.free !== undefined && i.free < 1024 * MB
        ? t('eco.warnSpace')
        : !web && d.syncedAt && Date.now() - Date.parse(d.syncedAt) > 7 * 86_400_000
          ? t('eco.warnSync', { ago: fmtAgo(Date.parse(d.syncedAt)) })
          : undefined
  return <Row icon={icon} kind={kind} name={d.name} on={on} ago={on ? undefined : fmtAgo(seenAt(d))} main={main} extra={extra} warn={warn} muted={web || i?.tracks === undefined} onForget={onForget} />
}

/**
 * Как перенести главный узел на другой сервер — пока по шагам руками (бэкап → восстановить → «Папка переехала»).
 * Потом — в одну кнопку, с переходным периодом для устройств не на связи
 */
function MoveDialog({ onClose }: { onClose: () => void }) {
  const steps = ['eco.move1', 'eco.move2', 'eco.move3', 'eco.move4', 'eco.move5'] as const
  return (
    <Modal onClose={onClose}>
      <div className="mb-4 flex items-center gap-3">
        <h2 className="flex-1 text-xl font-medium">{t('eco.moveTitle')}</h2>
        <IconBtn title={t('eco.moveOk')} onClick={onClose} className="text-muted">
          <X size={18} />
        </IconBtn>
      </div>
      <p className="mb-4 text-sm text-muted">{t('eco.moveIntro')}</p>
      <ol className="mb-4 flex flex-col gap-3">
        {steps.map((k, i) => (
          <li key={k} className="flex gap-3 text-[15px]">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-card-3 text-xs font-medium">{i + 1}</span>
            <span className={cx(i === steps.length - 1 && 'text-red')}>{t(k)}</span>
          </li>
        ))}
      </ol>
      <p className="mb-2 text-sm text-muted">{t('eco.moveNote')}</p>
      <p className="mb-5 text-sm text-muted">{t('eco.moveSoon')}</p>
      <button onClick={onClose} className="w-full rounded-full bg-card-3 py-3 text-sm font-medium hover:bg-sel hover:text-on-sel">
        {t('eco.moveOk')}
      </button>
    </Modal>
  )
}

function Row(p: { icon: typeof Globe; kind: string; name: string; badge?: string; on: boolean; ago?: string; main: string; extra?: string; warn?: string; muted?: boolean; onForget?: () => void }) {
  const Icon = p.icon
  return (
    <div className="group flex items-center gap-3 border-b border-line py-3 last:border-0">
      <span className={cx('h-2 w-2 shrink-0 rounded-full', p.on ? 'bg-green' : 'bg-dot-off')} />
      <Icon size={17} strokeWidth={1.6} className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px]">
          <span className="text-muted">{p.kind}</span> {p.name}
          {p.badge && (
            <span className="ms-2 inline-flex items-center gap-1 rounded-full bg-card-3 px-2 py-0.5 align-middle text-[11px] text-muted">
              <Star size={11} className="fill-current" />
              {p.badge}
            </span>
          )}
        </div>
        <div className={cx('text-xs', p.warn ? 'text-red' : 'text-muted')}>{p.warn ?? (p.on ? t('server.online') : t('eco.was', { ago: p.ago ?? '' }))}</div>
      </div>
      <div className="shrink-0 text-end">
        <div className={cx('text-sm', p.muted ? 'text-muted' : 'font-medium')}>{p.main}</div>
        {p.extra && <div className="text-xs text-muted">{p.extra}</div>}
      </div>
      {p.onForget && (
        <IconBtn title={t('server.forget')} onClick={p.onForget} className="text-muted opacity-0 group-hover:opacity-100 focus:opacity-100">
          <X size={15} />
        </IconBtn>
      )}
    </div>
  )
}
