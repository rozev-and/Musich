import { Disc3, HardDriveDownload, History, House, ListMusic, MicVocal, Plus, Server, Settings, Trash2, Upload, Music } from 'lucide-react'
import { useEffect, useState, type ComponentType } from 'react'
import { api, type TrashItem } from '../lib/api'
import { Logo as ServiceLogo, SERVICES } from './Integrations'
import { isHost } from '../mode'
import { Avatar } from './Avatar'
import { t, type Key } from '../i18n'
import { usePick, useStore, withLiked, type NavId, type SideId } from '../store'
import type { Playlist, View } from '../types'
import { PlaylistCover, usePlaylistDrop } from '../views/Playlists'
import { TrashDialog } from './TrashDialog'
import { cx } from './ui'

/** Значок «Треки» — обычная нота lucide, в одном стиле с остальными значками меню */
export function NoteIcon({ size = 24, strokeWidth, className }: { size?: number; strokeWidth?: number; className?: string }) {
  return <Music size={size} strokeWidth={strokeWidth} className={className} />
}

type NavIcon = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>

// label — короткая подпись (нижнее меню телефона), full — полная (сайдбар)
const items: { id: View; label: Key; full?: Key; icon: NavIcon }[] = [
  { id: 'home', label: 'nav.home', icon: House },
  { id: 'library', label: 'nav.library', icon: NoteIcon },
  { id: 'albums', label: 'nav.albums', icon: Disc3 },
  { id: 'artists', label: 'nav.artists', icon: MicVocal },
  { id: 'history', label: 'nav.history', icon: History },
  // на хосте — страница самого сервера, в приложении — связь с ним и синхронизация; и там и там «Сервер»
  { id: 'sync', label: 'nav.server', icon: Server },
  { id: 'settings', label: 'nav.settings', icon: Settings },
]

/** Что можно поставить в левую панель (Настройки → Интерфейс → «Левая панель») */
export const SIDE_CHOICES: { id: SideId; label: Key; icon: NavIcon }[] = [
  ...items.map((x) => ({ id: x.id as SideId, label: x.full ?? x.label, icon: x.icon })),
  ...(isHost ? [{ id: 'trash' as const, label: 'trash.title' as Key, icon: Trash2 }] : []),
]

// Какой раздел меню подсвечивать: плейлист живёт в «Альбомах», а страница альбома или артиста — это «Треки»
// с отбором, но для человека он всё ещё в «Альбомах» / «Артистах»
const useSection = () =>
  useStore((s): View => (s.view === 'playlist' ? 'albums' : s.view === 'library' && s.scope ? (s.scope.type === 'album' ? 'albums' : 'artists') : s.view))
const isActive = (section: View, id: View) => section === id

export function Logo({ className }: { className?: string }) {
  return (
    <div dir="ltr" className={cx('flex items-stretch gap-1.5', className)}>
      {/* знак — тот же проигрыватель, что на иконке приложения (scripts/make-icons.mjs) */}
      <img src="/favicon.svg" alt="" className="me-1 h-[26px] w-[26px] self-center" />
      <span className="font-logo text-[26px] font-black leading-none tracking-tight">MUSICH</span>
      {/* справа столбик: красная точка сверху, подпись мелко снизу */}
      <span className="flex flex-col justify-between">
        <span className="h-2 w-2 rounded-full bg-red" />
        <span className="font-logo text-[11px] leading-none font-bold whitespace-nowrap">by rozev</span>
      </span>
    </div>
  )
}

export function Sidebar() {
  const view = useSection()
  const setView = useStore((s) => s.setView)
  // хост: сколько файлов сейчас загружается на сервер; устройство — своя очередь передач
  const syncing = useStore((s) =>
    isHost ? s.incoming.length : s.tracks.filter((t) => t.status === 'uploading' || t.status === 'downloading').length,
  )
  const setUploadOpen = useStore((s) => s.setUploadOpen)
  // что и в каком порядке — из настроек; «Настройки» есть всегда, иначе в них не попасть
  const side = useStore((s) => s.ui.side)
  const order = (side.includes('settings') ? side : [...side, 'settings']).filter((id) => id !== 'trash' || isHost)

  return (
    <aside className="widget hidden w-60 shrink-0 flex-col p-5 md:flex">
      <Logo className="px-2 pt-1 pb-8" />
      <nav className="flex flex-col gap-1">
        {order.map((sid) => {
          if (sid === 'trash') return <SidebarTrash key="trash" />
          const item = items.find((x) => x.id === sid)
          if (!item) return null
          const { id, label, full, icon: Icon } = item
          return (
            <button
              key={id}
              onClick={() => setView(id)}
              className={cx(
                'flex items-center gap-3 rounded-full px-4 py-2.5 text-start text-sm transition-colors',
                isActive(view, id) ? 'bg-sel text-on-sel' : 'text-muted hover:bg-card-2 hover:text-fg',
              )}
            >
              <Icon size={17} strokeWidth={1.6} />
              <span className="flex-1">{t(full ?? label)}</span>
              {id === 'sync' && syncing > 0 && (
                <span className="flex items-center gap-1.5 font-mono text-[11px]">
                  <span className="blink h-1.5 w-1.5 rounded-full bg-red" />
                  {syncing}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      <SidebarPlaylists />

      <div className="mt-auto pt-4">
        <button
          onClick={() => setUploadOpen(true)}
          className="flex w-full items-center justify-center gap-2 rounded-full border border-line px-4 py-3 text-sm transition-colors hover:border-fg"
        >
          <Upload size={16} strokeWidth={1.6} />
          {t('nav.addMusic')}
        </button>
        <AccountButton active={view === 'account'} onClick={() => setView('account')} />
      </div>
    </aside>
  )
}

/** «Корзина» в меню (только хост — корзина живёт на сервере): открывает её окном, рядом — сколько в ней треков */
function SidebarTrash() {
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState(0)
  useEffect(() => {
    api<TrashItem[]>('/trash').then((list) => setCount(list.length), () => {})
  }, [open])
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-3 rounded-full px-4 py-2.5 text-start text-sm text-muted transition-colors hover:bg-card-2 hover:text-fg"
      >
        <Trash2 size={17} strokeWidth={1.6} />
        <span className="flex-1">{t('trash.title')}</span>
        {count > 0 && <span className="font-mono text-[11px]">{count}</span>}
      </button>
      {open && <TrashDialog onClose={() => setOpen(false)} onChange={(list) => setCount(list.length)} />}
    </>
  )
}

/** Внизу сайдбара: аватарка, имя и плашка — клик открывает аккаунт */
function AccountButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  const account = useStore((s) => s.account)
  return (
    <button
      onClick={onClick}
      className={cx(
        'mt-3 flex w-full items-center gap-3 rounded-2xl p-2 text-start transition-colors',
        active ? 'bg-card-2' : 'hover:bg-card-2',
      )}
    >
      <Avatar name={account.name} src={account.avatar} size={40} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{account.name}</span>
        <span className="mt-0.5 inline-block rounded-full bg-red px-2 py-px text-[10px] font-medium text-on-red">
          {t(isHost ? 'acc.owner' : 'acc.member')}
        </span>
      </span>
    </button>
  )
}

/** Список плейлистов в сайдбаре — на них можно бросать треки */
function SidebarPlaylists() {
  const { tracks, playlists: own, likedOffline, openPlaylistEditor, setView, setAlbumsTab } = usePick('tracks', 'playlists', 'likedOffline', 'openPlaylistEditor', 'setView', 'setAlbumsTab')
  // в сайдбаре — «Избранное» и свои; умные плейлисты живут на странице плейлистов
  const playlists = withLiked(tracks, own, likedOffline)
  return (
    <div className="mt-6 flex min-h-0 flex-col">
      <div className="mb-2 flex items-center justify-between px-4">
        {/* заголовок — ссылка на все плейлисты (Альбомы → Мои) */}
        <button
          onClick={() => {
            setView('albums')
            setAlbumsTab('mine')
          }}
          className="label text-muted underline-offset-4 transition-colors hover:text-fg hover:underline"
        >
          {t('nav.myPlaylists')}
        </button>
        <button
          onClick={() => openPlaylistEditor({ mode: 'create', addIds: [] })}
          title={t('nav.newPlaylist')}
          className="grid h-6 w-6 place-items-center rounded-full text-muted hover:bg-card-2 hover:text-fg"
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        {playlists.map((p) => (
          <SidebarPlaylist key={p.id} p={p} />
        ))}
        <SidebarRemote />
      </div>
    </div>
  )
}

/**
 * «Интеграции» в сайдбаре: плейлисты подключённых сервисов (лайки и плейлисты), у каждого — сколько есть в библиотеке.
 * «+» — подключить или настроить сервисы
 */
/** Плейлисты подключённых сервисов: «понравившиеся» и плейлисты, у каждого — сколько есть в библиотеке */
export function useRemoteLists() {
  const remote = useStore((s) => s.remote)
  return remote.flatMap(({ service, data }) => {
    const s = SERVICES.find((x) => x.id === service)!
    const liked = data.tracks.filter((x) => x.liked)
    const out = liked.length ? [{ service, s, list: '', name: t('int.liked'), have: liked.filter((x) => x.localId).length, total: liked.length }] : []
    for (const l of data.lists) {
      const items = data.tracks.filter((x) => x.lists.includes(l))
      out.push({ service, s, list: l, name: l, have: items.filter((x) => x.localId).length, total: items.length })
    }
    return out
  })
}

function SidebarRemote() {
  const { openRemoteList, setView } = usePick('openRemoteList', 'setView')
  const open = useStore((s) => (s.view === 'remote' ? s.remoteList : null))
  const lists = useRemoteLists()
  return (
    <>
      <div className="mt-4 mb-1 flex shrink-0 items-center justify-between px-4">
        <span className="label text-muted">{t('nav.integrations')}</span>
        <button
          onClick={() => setView('integrations')}
          title={t('int.manage')}
          className="grid h-6 w-6 place-items-center rounded-full text-muted hover:bg-card-2 hover:text-fg"
        >
          <Plus size={14} />
        </button>
      </div>
      {lists.map((l) => {
        const active = open?.service === l.service && open.list === l.list
        return (
          <button
            key={`${l.service}:${l.list}`}
            onClick={() => openRemoteList(l.service, l.list)}
            title={`${t(l.s.name)} · ${t('int.haveOf', { n: l.have, total: l.total })}`}
            className={cx(
              'flex shrink-0 items-center gap-3 rounded-2xl px-2 py-1.5 text-start text-sm transition-colors',
              active ? 'bg-card-2 text-fg' : 'text-muted hover:bg-card-2 hover:text-fg',
            )}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-card-2">
              <ServiceLogo s={l.s} size={18} />
            </span>
            <span className="min-w-0 flex-1 truncate">{l.name}</span>
            <span className="font-mono text-[11px] opacity-60">
              {l.have}/{l.total}
            </span>
          </button>
        )
      })}
    </>
  )
}

function SidebarPlaylist({ p }: { p: Playlist }) {
  const active = useStore((s) => s.view === 'playlist' && s.playlistId === p.id)
  const openPlaylist = useStore((s) => s.openPlaylist)
  const { over, side, handlers } = usePlaylistDrop(p, 'y')
  return (
    <button
      {...handlers}
      onClick={() => openPlaylist(p.id)}
      className={cx(
        'relative flex shrink-0 items-center gap-3 rounded-2xl px-2 py-1.5 text-start text-sm transition-colors',
        active ? 'bg-card-2 text-fg' : 'text-muted hover:bg-card-2 hover:text-fg',
        over && 'bg-card-3 text-fg ring-1 ring-red',
      )}
    >
      {/* куда встанет перетаскиваемый плейлист */}
      {side && <span className={cx('absolute inset-x-2 h-0.5 rounded-full bg-red', side === 'before' ? '-top-px' : '-bottom-px')} />}
      <PlaylistCover p={p} className="h-8 w-8" rounded="rounded-lg" />
      <span className="min-w-0 flex-1 truncate">{p.name}</span>
      {p.system && <span className="font-mono text-[11px] opacity-60">{p.trackIds.length}</span>}
      {!isHost && p.keepOffline && <HardDriveDownload size={13} className="shrink-0 opacity-60" />}
    </button>
  )
}

/** Всё, что можно поставить в нижнюю панель: подпись, значок, что открыть и когда пункт «выбран» */
export const NAV_CHOICES: { id: NavId; label: Key; icon: NavIcon }[] = [
  { id: 'home', label: 'nav.home', icon: House },
  { id: 'library', label: 'nav.library', icon: NoteIcon },
  { id: 'albums', label: 'nav.albums', icon: Disc3 },
  { id: 'playlists', label: 'nav.playlists', icon: ListMusic },
  { id: 'artists', label: 'nav.artists', icon: MicVocal },
  { id: 'history', label: 'nav.history', icon: History },
  { id: 'sync', label: 'nav.server', icon: Server },
  { id: 'settings', label: 'nav.settings', icon: Settings },
]

export function MobileNav() {
  const section = useSection()
  const { setView, setAlbumsTab, ui, albumsTab } = usePick('setView', 'setAlbumsTab', 'ui', 'albumsTab')
  // альбомы и плейлисты — одна страница с вкладками: пункт выбран, если открыта его вкладка
  const active = (id: NavId) =>
    id === 'playlists' ? section === 'albums' && albumsTab === 'mine' : id === 'albums' ? section === 'albums' && albumsTab !== 'mine' : section === id
  const open = (id: NavId) => {
    if (id === 'playlists' || id === 'albums') {
      setAlbumsTab(id === 'playlists' ? 'mine' : 'albums')
      return setView('albums')
    }
    setView(id)
  }
  const shown = ui.nav.map((id) => NAV_CHOICES.find((c) => c.id === id)).filter((c) => !!c)
  return (
    <nav className="widget fixed inset-x-3 z-30 flex justify-around px-2 py-2 md:hidden" style={{ bottom: 'calc(0.75rem + var(--safe-bottom))' }}>
      {/* что в панели и в каком порядке — Настройки → Интерфейс → «Нижняя панель» */}
      {shown.map(({ id, label, icon: Icon }) => (
        // крупные значки без подписей — подпись остаётся для экранного диктора
        <button
          key={id}
          onClick={() => open(id)}
          aria-label={t(label)}
          // выбранная вкладка — просто ярче, остальные приглушены
          className={cx('flex flex-1 items-center justify-center rounded-2xl py-2.5 transition-colors', active(id) ? 'text-fg' : 'text-muted/50')}
        >
          <Icon size={26} strokeWidth={active(id) ? 2 : 1.6} />
        </button>
      ))}
    </nav>
  )
}
