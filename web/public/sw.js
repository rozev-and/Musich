// MUSICH в браузере: треки, скачанные заранее, играют из памяти браузера — без задержки и без сети.
// Страница просит «скачай заранее» (следующий трек в очереди, lib/webcache.ts) запросом с заголовком
// X-Musich-Prefetch — воркер скачивает файл целиком и кладёт в кэш. Плеер (<audio>) потом просит этот же трек
// кусками (Range) — воркер отдаёт их из кэша. Чего в кэше нет — идёт на сервер как обычно.
// Ключ — id трека, его версия (v) и качество (q): ключ входа и медиа-ключ в адресе на ключ не влияют.
// Хранится последних MAX треков (старые вытесняются).
const CACHE = 'musich-audio-v1'
const MAX = 40
const FILE_RE = /^\/api\/tracks\/([^/]+)\/file$/

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

const keyOf = (id, url) => `/__musich/audio/${encodeURIComponent(id)}?v=${url.searchParams.get('v') ?? ''}&q=${url.searchParams.get('q') ?? ''}`

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return
  const url = new URL(e.request.url)
  if (url.origin !== self.location.origin) return
  const m = FILE_RE.exec(url.pathname)
  if (!m || url.searchParams.has('warm')) return
  e.respondWith(handle(e.request, url, decodeURIComponent(m[1])))
})

async function handle(req, url, id) {
  const key = keyOf(id, url)
  const cache = await caches.open(CACHE)
  if (req.headers.get('X-Musich-Prefetch')) return prefetch(cache, key, url)
  const hit = await cache.match(key)
  if (!hit) return fetch(req)
  return fromCache(hit, req.headers.get('Range'))
}

async function prefetch(cache, key, url) {
  try {
    if (!(await cache.match(key))) {
      const res = await fetch(url.href, { cache: 'no-store' })
      if (res.status !== 200) return new Response(null, { status: 204 })
      await cache.put(key, res)
      // лишние — самые старые: ключи идут в порядке добавления
      const keys = await cache.keys()
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) await cache.delete(k)
    }
  } catch {
    /* сеть пропала или место кончилось — трек просто сыграет с сервера */
  }
  return new Response(null, { status: 204 })
}

// кусок файла по Range — так <audio> перематывает и узнаёт длину
async function fromCache(hit, range) {
  const blob = await hit.blob()
  const type = hit.headers.get('Content-Type') || 'audio/mpeg'
  const size = blob.size
  if (!range) return new Response(blob, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } })
  const m = /bytes=(\d*)-(\d*)/.exec(range)
  let start = m && m[1] ? Number(m[1]) : 0
  let end = m && m[2] ? Number(m[2]) : size - 1
  if (m && !m[1] && m[2]) {
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  }
  end = Math.min(end, size - 1)
  if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  })
}
