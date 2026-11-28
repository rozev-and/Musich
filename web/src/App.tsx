import { Eye, Upload, X } from 'lucide-react'
import { LoadingBar } from './components/LoadingBar'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef } from 'react'
import { CoverEditorDialog } from './components/CoverEditor'
import { DeleteDialog, Toasts, UploadDialog } from './components/Dialogs'
import { ArtistRenameDialog, FullPlayer, RenameDialog, TrackInfoDialog } from './components/FullPlayer'
import { Logo, MobileNav, Sidebar } from './components/Nav'
import { PlayerBar } from './components/PlayerBar'
import { LyricsSheet } from './components/Lyrics'
import { SearchSheet } from './components/SearchSheet'
import { PlaylistDeleteDialog, PlaylistEditorDialog, PlaylistPicker } from './components/PlaylistDialogs'
import { LANGS, t } from './i18n'
import { applyTheme } from './lib/themes'
import { selectCurrent, useStore } from './store'
import { livePosition } from './lib/pos'
import { Albums, Artists } from './views/Collections'
import { Home } from './views/Home'
import { Library } from './views/Library'
import { PlaylistPage } from './views/Playlists'
import { isHost } from './mode'
import { Avatar } from './components/Avatar'
import { cx } from './components/ui'
import { AuthScreen, BindingBack, ConnectScreen, OfflineScreen, ProfileScreen } from './views/AuthScreen'
import { MergeDialog } from './components/MergeDialog'
import { LockScreen } from './components/LockScreen'

// Редкие разделы грузим, только когда их открывают: приложение стартует быстрее (меньше кода разбирать на запуске)
const History = lazy(() => import('./views/History').then((m) => ({ default: m.History })))
const RemoteListPage = lazy(() => import('./views/RemoteList').then((m) => ({ default: m.RemoteListPage })))
const SyncPage = lazy(() => (isHost ? import('./views/Server').then((m) => ({ default: m.Server })) : import('@sync-view').then((m) => ({ default: m.Sync }))))
const IntegrationsPage = lazy(() => import('./views/IntegrationsPage').then((m) => ({ default: m.IntegrationsPage })))
const Settings = lazy(() => import('./views/Settings').then((m) => ({ default: m.Settings })))
const AccountPage = lazy(() => import('./views/Account').then((m) => ({ default: m.AccountPage })))

// сервер обновили, пока страница была открыта: старого куска раздела уже нет — просто перезагружаемся
window.addEventListener('vite:preloadError', () => location.reload())

const views = {
  home: Home,
  library: Library,
  albums: Albums,
  artists: Artists,
  history: History,
  playlist: PlaylistPage,
  remote: RemoteListPage,
  sync: SyncPage, // на хосте раздел «Синхронизация» — это страница сервера
  integrations: IntegrationsPage,
  settings: Settings,
  account: AccountPage,
}

/** Телефон без сервера: маленький значок в шапке вместо плашки и уведомлений. Нажать — поискать сервер сейчас */
function OfflineBadge() {
  const syncNow = useStore((s) => s.syncNow)
  return (
    <button
      onClick={syncNow}
      title={t('dev.offline')}
      aria-label={t('dev.offline')}
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-ink/15 px-3 text-xs text-ink-muted"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-red" />
      {t('dev.offlineBadge')}
    </button>
  )
}

/** Владелец смотрит чужую библиотеку: плашка сверху, пока не выйдет. Правки в это время недоступны */
function ViewAsBanner() {
  const viewAs = useStore((s) => s.viewAs)
  const exit = useStore((s) => s.exitUserLibrary)
  if (!viewAs) return null
  return (
    <div className="mx-4 flex items-center gap-3 rounded-full bg-sel py-2 ps-4 pe-2 text-sm text-on-sel md:mx-0">
      <Eye size={16} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{t('viewAs.banner', { name: viewAs.name })}</span>
      <button onClick={() => void exit()} className="flex shrink-0 items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-xs text-fg">
        <X size={13} /> {t('viewAs.exit')}
      </button>
    </div>
  )
}

export default function App() {
  const view = useStore((s) => s.view)
  const theme = useStore((s) => s.theme)
  const palette = useStore((s) => s.palette)
  const accent = useStore((s) => s.accent)
  const customThemes = useStore((s) => s.customThemes)
  const sel = useStore((s) => s.sel)
  const blocks = useStore((s) => s.blocks)
  const radius = useStore((s) => s.radius)
  // язык читаем здесь: смена языка перерисовывает App, а с ним и всё дерево
  const lang = useStore((s) => s.lang)
  const tick = useStore((s) => s.tick)
  const setUploadOpen = useStore((s) => s.setUploadOpen)
  const setView = useStore((s) => s.setView)
  const account = useStore((s) => s.account)
  const conn = useStore((s) => s.conn) // сервер спрашивает сам стор при загрузке
  const probing = useStore((s) => s.probing)
  const standalone = useStore((s) => s.standalone)
  const mergePending = useStore((s) => s.mergePending)
  const locked = useStore((s) => s.locked)
  const hasTrack = useStore((s) => !!selectCurrent(s))
  const View = views[view]
  // новая вкладка — сверху, а не на прокрутке прошлой
  const mainRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [view])

  // режим, тема и акцент — CSS-переменными на <html>; до первой отрисовки, чтобы не мигала тема по умолчанию
  useLayoutEffect(() => applyTheme(theme, palette, accent, customThemes, sel, blocks), [theme, palette, accent, customThemes, sel, blocks])
  useLayoutEffect(() => document.documentElement.style.setProperty('--rk', String(radius)), [radius])

  useEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.dir = LANGS.find((l) => l.id === lang)?.dir ?? 'ltr'
  }, [lang])

  // таймер сна: раз в секунду и только пока он заведён — лишний таймер будит телефон зря
  const sleepAt = useStore((s) => s.sleepAt)
  useEffect(() => {
    if (!sleepAt) return
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [tick, sleepAt])

  // вернулись после входа в Spotify: ?integration=spotify[&error=…] — открываем «Аккаунт» и говорим, как прошло
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    if (!q.get('integration')) return
    const err = q.get('error')
    history.replaceState(null, '', location.pathname)
    const s = useStore.getState()
    s.setView('integrations')
    s.toast(err ? t('int.failed', { msg: err }) : t('int.connected', { name: t('svc.spotify') }), err ? 'error' : 'ok')
  }, [])

  // Горячие клавиши плеера (если не печатаем в поле); список — в настройках, там же выключаются
  useEffect(() => {
    let unmuted = 0
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState()
      const el = e.target as HTMLElement
      if (!s.settings.hotkeys || e.ctrlKey || e.metaKey || e.altKey || el.closest('input, textarea, select, [contenteditable="true"]')) return
      const act = (fn: () => void) => {
        e.preventDefault()
        fn()
      }
      const dur = s.tracks.find((t) => t.id === s.currentId)?.duration ?? Infinity
      switch (e.code) {
        case 'Space':
          // на кнопке пробел её и нажимает
          if (!el.closest('button')) act(s.toggle)
          return
        case 'ArrowRight':
          return act(() => (e.shiftKey ? s.next() : s.seek(Math.min(livePosition() + 5, dur))))
        case 'ArrowLeft':
          return act(() => (e.shiftKey ? s.prev() : s.seek(Math.max(0, livePosition() - 5))))
        // без Shift стрелки вверх-вниз листают страницу
        case 'ArrowUp':
          if (e.shiftKey) act(() => s.setVolume(Math.min(100, s.volume + 5)))
          return
        case 'ArrowDown':
          if (e.shiftKey) act(() => s.setVolume(Math.max(0, s.volume - 5)))
          return
        case 'KeyM':
          return act(() => {
            if (s.volume > 0) {
              unmuted = s.volume
              s.setVolume(0)
            } else s.setVolume(unmuted || 70)
          })
        case 'KeyL':
          if (s.currentId) act(() => s.toggleLike(s.currentId!))
          return
        case 'KeyS':
          return act(s.toggleShuffle)
        case 'KeyR':
          return act(s.toggleRepeat)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // PIN-код: ничего не показываем, пока не введут (музыка при этом может играть дальше)
  if (locked) return <LockScreen />
  // пока спрашиваем сервер — пустая страница (доли секунды), чтобы не мигать интерфейсом перед входом
  if (conn === 'checking') return null
  // local — телефон без сервера: обычный интерфейс со скачанной музыкой и плашкой «нет связи»
  if (conn !== 'online' && conn !== 'local')
    return (
      <>
        {conn === 'offline' ? <OfflineScreen /> : conn === 'connect' ? <ConnectScreen /> : conn === 'profile' ? <ProfileScreen /> : <AuthScreen />}
        <BindingBack />
        <Toasts />
        <LoadingBar />
      </>
    )

  return (
    <div className="flex h-full gap-3 py-3 md:p-3">
      {/* на телефоне боковые отступы — внутри прокрутки (main): так строки треков могут дойти до краёв экрана */}
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <ViewAsBanner />
        <header className="flex items-center justify-between px-4 md:hidden">
          {/* логотип — только на Главной; на остальных тут название страницы (его кладёт сюда PageTitle) */}
          {view === 'home' ? <Logo /> : <div id="page-title" className="min-w-0 flex-1 pe-3" />}
          <div className="flex items-center gap-2">
            {conn === 'local' && !standalone && !probing && <OfflineBadge />}
            {/* компактно, без подписей: «добавить музыку» и аккаунт */}
            <button
              onClick={() => setUploadOpen(true)}
              aria-label={t('nav.addMusic')}
              title={t('nav.addMusic')}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sel-page text-on-sel-page"
            >
              <Upload size={16} />
            </button>
            {/* на телефоне сайдбара нет — аккаунт открывается аватаркой в шапке */}
            <button onClick={() => setView('account')} aria-label={t('nav.account')} title={t('nav.account')} className="shrink-0">
              <Avatar name={account.name} src={account.avatar} size={36} />
            </button>
          </div>
        </header>

        {/* на телефоне снизу поверх списка — плеер и меню: последние строки докручиваются из-под них */}
        <main ref={mainRef} className={cx('min-h-0 flex-1 overflow-y-auto px-4 pt-2 md:pt-6 md:pb-4', hasTrack ? 'pb-[150px]' : 'pb-[84px]')}>
          {/* key — новая вкладка мягко проявляется, а не подменяется рывком */}
          <div key={view} className="view-in">
            <Suspense fallback={null}>
              <View />
            </Suspense>
          </div>
        </main>

        {/* без трека плеера нет. На ПК — своим блоком внизу, на телефоне — плавает над нижним меню поверх списка */}
        {hasTrack && (
          <div className="max-md:fixed max-md:inset-x-3 max-md:z-30 max-md:bottom-[calc(84px+var(--safe-bottom))]">
            <PlayerBar />
          </div>
        )}
      </div>

      <MobileNav />
      <DeleteDialog />
      <UploadDialog />
      <FullPlayer />
      <LyricsSheet />
      <SearchSheet />
      <TrackInfoDialog />
      <RenameDialog />
      <ArtistRenameDialog />
      <PlaylistPicker />
      <PlaylistEditorDialog />
      <PlaylistDeleteDialog />
      <CoverEditorDialog />
      {/* сервер привязан, а на телефоне было своё — спрашиваем, объединять ли */}
      {mergePending && conn === 'online' && <MergeDialog />}
      <Toasts />
        <LoadingBar />
    </div>
  )
}
