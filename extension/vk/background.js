// Фон расширения: принимает собранный на vk.com список и отправляет его в MUSICH. Раз в час просит открытую
// вкладку vk.com собрать заново; кнопка «Забрать сейчас» в окошке расширения — открывает vk.com сама, если нужно
if (typeof importScripts === 'function') importScripts('config.js') // Chrome; Firefox подключает config.js сам (background.scripts)
const ext = globalThis.browser ?? globalThis.chrome
const EVERY = 30 * 60_000

const state = () => ext.storage.local.get(['lastSync', 'count', 'error', 'force', 'ownTab'])

async function push(tracks, error) {
  const st = await state()
  if (error || !tracks) {
    await ext.storage.local.set({ error: error || 'Список не собрался', force: false })
  } else {
    try {
      const res = await fetch(self.MUSICH.server + '/api/integrations/vk/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + self.MUSICH.token },
        body: JSON.stringify({ liked: tracks, lists: [] }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.message || 'MUSICH ответил ' + res.status)
      }
      await ext.storage.local.set({ lastSync: Date.now(), count: tracks.length, error: null, force: false })
    } catch (e) {
      await ext.storage.local.set({ error: 'Не достучался до MUSICH: ' + (e?.message ?? e), force: false })
    }
  }
  // вкладку vk.com, которую открыли сами ради «Забрать сейчас», — закрываем
  if (st.ownTab) {
    ext.tabs.remove(st.ownTab).catch(() => {})
    await ext.storage.local.set({ ownTab: null })
  }
}

async function syncNow() {
  const tabs = await ext.tabs.query({ url: 'https://vk.com/*' })
  if (tabs[0]) return ext.tabs.sendMessage(tabs[0].id, { type: 'collect' }).catch(() => {})
  const tab = await ext.tabs.create({ url: 'https://vk.com/audio', active: false })
  await ext.storage.local.set({ force: true, ownTab: tab.id })
}

ext.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m?.type === 'push') {
    push(m.tracks, m.error)
    return false
  }
  if (m?.type === 'due') {
    state().then((st) => reply(!!st.force || !st.lastSync || Date.now() - st.lastSync > EVERY))
    return true
  }
  if (m?.type === 'syncNow') {
    syncNow().then(() => reply(true))
    return true
  }
  return false
})

ext.alarms.create('musich-sync', { periodInMinutes: 60 })
ext.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'musich-sync') return
  const tabs = await ext.tabs.query({ url: 'https://vk.com/*' })
  if (tabs[0]) ext.tabs.sendMessage(tabs[0].id, { type: 'collect' }).catch(() => {})
})
