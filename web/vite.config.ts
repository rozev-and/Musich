import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// версия приложения — в «Экосистеме» на странице сервера видно, у кого старый APK
const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version

// часть устройства (офлайн-библиотека, экран синхронизации) — только в сборках приложений: --mode device (Android)
// и --mode desktop (ПК, Tauri). Веб-сборка (сервер, Docker, Windows) берёт пустышки.
// На ПК код устройства тот же, что на телефоне, а плагины Capacitor подменяет src/platform/desktop (вызовы идут в Rust)
const src = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const app = (mode: string) => {
  const device = mode === 'device' || mode === 'desktop'
  const alias = [
    { find: '@device', replacement: src(device ? './src/lib/device.ts' : './src/lib/device-stub.ts') },
    { find: '@sync-view', replacement: src(device ? './src/views/Sync.tsx' : './src/views/SyncStub.tsx') },
  ]
  if (mode !== 'desktop') return alias
  const misc = src('./src/platform/desktop/misc.ts')
  return [
    ...alias,
    { find: /^@capacitor\/core$/, replacement: src('./src/platform/desktop/core.ts') },
    { find: /^@capacitor\/filesystem$/, replacement: src('./src/platform/desktop/filesystem.ts') },
    { find: /^@capacitor\/(preferences|network|device|app|share)$/, replacement: misc },
    { find: /^@capgo\/capacitor-share-target$/, replacement: misc },
  ]
}

export default defineConfig(({ mode }) => ({
  resolve: { alias: app(mode) },
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  // окно Tauri открывает сборку с диска; проверку типов делает npm run build:desktop
  server: {
    port: mode === 'desktop' ? 5174 : 5173,
    host: '127.0.0.1',
    // API — на локальный сервер (server/: npm run dev). В проде веб-морду раздаёт сам сервер
    proxy: { '/api': 'http://127.0.0.1:2290' },
  },
}))
