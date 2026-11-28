import { invoke } from '@tauri-apps/api/core'
import { t } from '../../i18n'

/**
 * Свои плагины телефона — на ПК:
 *  MusicStore — где лежит музыка: папка приложения, «Музыка\MUSICH» или своя папка (выбор через окно Windows);
 *  NowPlaying — что играет: через Media Session, WebView2 сам отдаёт его в системный плеер Windows и медиаклавишам;
 *  Discovery  — поиск MUSICH в домашней сети по mDNS (в Rust)
 */

type Listener = (d: { action: string; seekTime?: number }) => void
const handles = { remove: async () => {} }

let artwork: MediaImage[] = []
const nowPlaying = {
  async update(o: { title: string; artist: string; album: string; playing: boolean; duration: number; position: number; artwork?: string }) {
    const ms = navigator.mediaSession
    if (!ms) return
    if (o.artwork !== undefined) artwork = o.artwork ? [{ src: `data:image/jpeg;base64,${o.artwork}`, sizes: '512x512', type: 'image/jpeg' }] : []
    ms.metadata = new MediaMetadata({ title: o.title, artist: o.artist, album: o.album, artwork })
    ms.playbackState = o.playing ? 'playing' : 'paused'
    try {
      if (o.duration > 0) ms.setPositionState({ duration: o.duration, position: Math.min(o.position, o.duration), playbackRate: 1 })
    } catch {
      /* позиция за пределами — пропускаем */
    }
  },
  async stop() {
    if (!navigator.mediaSession) return
    navigator.mediaSession.metadata = null
    navigator.mediaSession.playbackState = 'none'
  },
  async addListener(_e: 'action', fn: Listener) {
    const ms = navigator.mediaSession
    if (!ms) return handles
    for (const a of ['play', 'pause', 'nexttrack', 'previoustrack'] as const) ms.setActionHandler(a, () => fn({ action: a }))
    ms.setActionHandler('seekto', (d) => fn({ action: 'seekto', seekTime: d.seekTime }))
    return handles
  },
}

// своя папка: Rust пускает её файлы в плеер (asset-протокол), только когда о ней знает — говорим ему при запуске
try {
  const tree = (JSON.parse(localStorage.getItem('musich-storage') ?? 'null') as { tree?: { uri: string } } | null)?.tree?.uri
  if (tree) void invoke('allow_dir', { uri: tree }).catch(() => {})
} catch {
  /* настроек ещё нет */
}

const musicStore = {
  shared: () => invoke('store_shared'),
  requestRead: async () => ({ granted: true }), // на ПК разрешений на папки нет
  pickFolder: () => invoke('store_pick'),
  move: (o: { from: string; target: string; tree?: string; name: string }) => invoke('store_move', { from: o.from, target: o.target, tree: o.tree ?? null, name: o.name }),
  rename: (o: { uri: string; name: string }) => invoke('store_rename', o),
  remove: (o: { uri: string }) => invoke('store_remove', o),
  stat: (o: { uri: string }) => invoke('store_stat', o),
  list: (o: { target: string; tree?: string }) => invoke('store_list', { target: o.target, tree: o.tree ?? null }),
}

// подписи в трее — на языке интерфейса (язык подгружается не сразу)
setTimeout(() => void invoke('tray_labels', { show: t('desk.show'), quit: t('desk.quit') }).catch(() => {}), 3000)

const discovery = {
  discover: (o: { timeout: number }) => invoke('discover', { timeoutMs: o.timeout }),
}

export const plugins: Record<string, unknown> = { MusicStore: musicStore, NowPlaying: nowPlaying, Discovery: discovery }
