// Связка между страницей vk.com (page.js) и фоном расширения: по просьбе фона — или сам, если давно не забирали, —
// просит page.js собрать список и отдаёт его фону, а тот шлёт в MUSICH
;(() => {
  const ext = globalThis.browser ?? globalThis.chrome
  let busy = false

  const collect = () =>
    new Promise((resolve) => {
      const on = (e) => {
        if (e.source !== window || e.data?.musich !== 'tracks') return
        window.removeEventListener('message', on)
        resolve(e.data)
      }
      window.addEventListener('message', on)
      window.postMessage({ musich: 'collect' }, location.origin)
    })

  const run = async () => {
    if (busy) return
    busy = true
    try {
      const r = await collect()
      await ext.runtime.sendMessage({ type: 'push', tracks: r.tracks, error: r.error })
    } finally {
      busy = false
    }
  }

  ext.runtime.onMessage.addListener((m) => {
    if (m?.type === 'collect') void run()
  })
  // зашёл на vk.com — забираем, если с прошлого раза прошло больше получаса (или просили «сейчас»)
  ext.runtime.sendMessage({ type: 'due' }).then((due) => due && run(), () => {})
})()
