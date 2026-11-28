import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { isHost } from './mode'

// В приложении на телефоне настройки сначала восстанавливаются из надёжного хранилища (lib/durable.ts) —
// до того, как стор их прочитает, поэтому App грузится уже после
async function start() {
  // пришли с кодом входа (переключатель «Домен / Дома»), а вход тут уже есть — код не нужен, убираем из адреса
  try {
    if (isHost && localStorage.getItem('musich-token') && new URLSearchParams(location.search).has('pair')) {
      const u = new URL(location.href)
      u.searchParams.delete('pair')
      history.replaceState(null, '', u)
    }
  } catch {
    /* без хранилища — не важно */
  }
  if (!isHost) await (await import('./lib/durable')).restoreDurable()
  // словарь выбранного языка — до первого кадра, чтобы интерфейс сразу был на нём
  const { detectLang, loadLang } = await import('./i18n')
  await loadLang(detectLang())
  // веб: следующий трек — заранее в память браузера (lib/webcache.ts)
  ;(await import('./lib/webcache')).registerAudioCache()
  const { default: App } = await import('./App')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
void start()
