/**
 * Треки в памяти браузера (public/sw.js): следующий трек в очереди скачивается целиком заранее и потом играет
 * из кэша — переход мгновенный, даже когда сервер далеко (домен через туннель, медленная отдача из дома).
 * Только веб-версия и только по https (или localhost): service worker без них не работает; на телефоне треки
 * и так лежат файлами
 */
import { isHost } from '../mode'

export function registerAudioCache() {
  if (!isHost || !('serviceWorker' in navigator) || !window.isSecureContext) return
  void navigator.serviceWorker.register('/sw.js').catch(() => {})
}

const inflight = new Set<string>()
/** Скачать трек заранее (адрес потока — как у плеера: с ключом, версией и качеством) */
export function prefetchAudio(url: string) {
  if (!navigator.serviceWorker?.controller || inflight.has(url)) return
  inflight.add(url)
  void fetch(url, { headers: { 'X-Musich-Prefetch': '1' } })
    .catch(() => {})
    .finally(() => inflight.delete(url))
}
