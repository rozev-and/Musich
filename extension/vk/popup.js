// Окошко расширения: когда забирали, сколько треков, ошибка; «Разрешить доступ» (Firefox спрашивает отдельно)
// и «Забрать сейчас»
const ext = globalThis.browser ?? globalThis.chrome
const origins = ['https://vk.com/*', new URL(self.MUSICH.server).origin.replace(/:\d+$/, '') + '/*']
const $ = (id) => document.getElementById(id)

const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60_000)
  if (m < 1) return 'только что'
  if (m < 60) return m + ' мин назад'
  const h = Math.round(m / 60)
  return h < 24 ? h + ' ч назад' : Math.round(h / 24) + ' дн назад'
}

async function render() {
  const st = await ext.storage.local.get(['lastSync', 'count', 'error'])
  $('status').textContent = st.lastSync
    ? `Забрано ${st.count} треков из «Моей музыки» · ${ago(st.lastSync)}. Сервер: ${self.MUSICH.server}`
    : `Ещё не забирали. Открой vk.com — расширение заберёт «Мою музыку» само. Сервер: ${self.MUSICH.server}`
  $('error').hidden = !st.error
  $('error').textContent = st.error ?? ''
  const granted = await ext.permissions.contains({ origins }).catch(() => true)
  $('perm').hidden = granted
  $('sync').disabled = !granted
}

$('grant').onclick = async () => {
  await ext.permissions.request({ origins }).catch(() => false)
  render()
}
$('sync').onclick = async () => {
  $('sync').disabled = true
  $('sync').textContent = 'Забираю…'
  await ext.runtime.sendMessage({ type: 'syncNow' }).catch(() => {})
}
ext.storage.onChanged.addListener(() => {
  $('sync').textContent = 'Забрать сейчас'
  render()
})
render()
