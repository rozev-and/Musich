import { invoke } from '@tauri-apps/api/core'
import type { PluginListenerHandle } from './core'
import { uriToPath } from './core'

/**
 * Остальные плагины Capacitor на ПК (web/vite.config.ts → --mode desktop):
 * Preferences, Network, Device, App, Share и «Поделиться → MUSICH» (на ПК его нет — музыку добавляют кнопкой или перетаскиванием)
 */

const noop: PluginListenerHandle = { remove: async () => {} }

/** Запасная копия настроек — файлом в папке приложения (на случай, если WebView2 почистит своё хранилище) */
export const Preferences = {
  get: (o: { key: string }) => invoke<string | null>('prefs_get', o).then((value) => ({ value })),
  set: (o: { key: string; value: string }) => invoke<void>('prefs_set', o),
  remove: (o: { key: string }) => invoke<void>('prefs_remove', o),
  keys: () => invoke<string[]>('prefs_keys').then((keys) => ({ keys })),
}

/** Сеть на ПК: провод тоже считаем «Wi‑Fi» — настройка «только по Wi‑Fi» про мобильный трафик */
const status = () => ({ connected: navigator.onLine, connectionType: navigator.onLine ? 'wifi' : 'none' })
export const Network = {
  getStatus: async () => status(),
  async addListener(_e: 'networkStatusChange', fn: (s: ReturnType<typeof status>) => void): Promise<PluginListenerHandle> {
    const on = () => fn(status())
    window.addEventListener('online', on)
    window.addEventListener('offline', on)
    return { remove: async () => (window.removeEventListener('online', on), window.removeEventListener('offline', on)) }
  },
}

/** Имя ПК — имя компьютера в Windows; номер — свой у установки, лежит в папке приложения */
export const Device = {
  getId: () => invoke<string>('device_id').then((identifier) => ({ identifier })),
  getInfo: () => invoke<string>('device_name').then((model) => ({ manufacturer: '', model, platform: 'windows', operatingSystem: 'windows' })),
}

export const App = {
  async addListener(e: string, fn: (s: { isActive: boolean }) => void): Promise<PluginListenerHandle> {
    if (e !== 'appStateChange') return noop // «Назад» на ПК нет
    const on = () => fn({ isActive: !document.hidden })
    document.addEventListener('visibilitychange', on)
    return { remove: async () => document.removeEventListener('visibilitychange', on) }
  },
  minimizeApp: async () => {},
}

/** «Поделиться» на ПК: показываем файл в Проводнике — дальше его можно перетащить куда угодно */
export const Share = {
  async share(o: { files?: string[] }) {
    const f = o.files?.[0]
    if (f) await invoke('reveal', { path: uriToPath(f) })
  },
}

export const CapacitorShareTarget = {
  addListener: async () => noop,
}
