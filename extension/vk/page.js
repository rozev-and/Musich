// Работает внутри страницы vk.com (как её собственный код): просит у VK список «Моей музыки» тем же запросом,
// которым VK заполняет свою страницу. Вход — твой, уже открытый в браузере. Ответ отдаёт bridge.js
;(() => {
  const strip = (s) =>
    String(s ?? '')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim()

  // ответы VK бывают с «<!--» в начале, а части ответа — строками с JSON внутри
  const parse = (text) => {
    const data = JSON.parse(text.replace(/^<!--/, ''))
    let part = data?.payload?.[1]?.[0]
    if (typeof part === 'string') part = JSON.parse(part)
    return part
  }

  const loadSection = async (ownerId, offset) => {
    const body = new URLSearchParams({
      act: 'load_section',
      al: '1',
      claim: '0',
      is_loading_all: '1',
      offset: String(offset),
      owner_id: String(ownerId),
      playlist_id: '-1', // −1 — «Моя музыка»
      type: 'playlist',
      access_hash: '',
    })
    const res = await fetch('/al_audio.php?act=load_section', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body,
    })
    if (!res.ok) throw new Error('VK ответил ' + res.status)
    return parse(await res.text())
  }

  const collect = async () => {
    const ownerId = window.vk?.id
    if (!ownerId) throw new Error('Не вошёл в VK на этой вкладке')
    const tracks = []
    const seen = new Set()
    for (let offset = 0, guard = 0; guard < 200; guard++) {
      const part = await loadSection(ownerId, offset)
      for (const a of part?.list ?? []) {
        // строка трека VK: [id, владелец, ссылка, название, исполнитель, длительность, …, обложки «маленькая,большая» на 14-м месте]
        const id = a[1] + '_' + a[0]
        if (seen.has(id)) continue
        seen.add(id)
        const cover = String(a[14] ?? '').split(',')[0]
        tracks.push({
          id,
          title: strip(a[3]),
          artist: strip(a[4]),
          duration: Number(a[5]) || undefined,
          cover: cover.startsWith('https://') ? cover : undefined,
        })
      }
      if (!part?.hasMore || !part.nextOffset || part.nextOffset <= offset) break
      offset = part.nextOffset
      await new Promise((r) => setTimeout(r, 400)) // не торопим VK
    }
    return tracks
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.musich !== 'collect') return
    try {
      window.postMessage({ musich: 'tracks', tracks: await collect() }, location.origin)
    } catch (err) {
      window.postMessage({ musich: 'tracks', error: String(err?.message ?? err) }, location.origin)
    }
  })
})()
