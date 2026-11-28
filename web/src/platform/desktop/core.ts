import { convertFileSrc } from '@tauri-apps/api/core'
import { plugins } from './plugins'

/**
 * Приложение для ПК (Tauri): этот файл подменяет @capacitor/core (web/vite.config.ts, --mode desktop).
 * Код устройства (lib/device.ts) один на телефон и ПК — он зовёт «Capacitor», а здесь те же вызовы идут в Rust
 * (desktop/src-tauri). Файлы отдаёт WebView2 по asset-протоколу Tauri
 */

export type PluginListenerHandle = { remove: () => Promise<void> }

/** «file:///C:/Users/…/a%20b.mp3» → «C:/Users/…/a b.mp3» */
export function uriToPath(uri: string): string {
  if (!uri.startsWith('file:')) return uri
  const p = decodeURIComponent(new URL(uri).pathname)
  return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p
}

export const Capacitor = {
  isNativePlatform: () => true,
  getPlatform: () => 'windows',
  convertFileSrc: (uri: string) => (uri.startsWith('file:') || /^[A-Za-z]:[\\/]/.test(uri) ? convertFileSrc(uriToPath(uri)) : uri),
}

export function registerPlugin<T>(name: string): T {
  const p = plugins[name]
  if (!p) throw new Error(`нет плагина ${name} в приложении для ПК`)
  return p as T
}
