# MUSICH для ПК

Своё окно для Windows: копия музыки и библиотеки на ноутбуке, как у телефона. Играет без сети, а когда
сервер доступен (дома или через домен), синхронизируется с ним: лайки, плейлисты, история, новые треки.

Это не «Сервер для Windows» (`deploy/windows`): тот держит общую библиотеку для всех устройств, а это
приложение — одно из устройств.

## Как устроено

- Интерфейс — тот же `web/`, собранный в режиме устройства: `npm --prefix ../web run build:desktop`
  (`--mode desktop`, `web/.env.desktop`). Код устройства общий с телефоном — `web/src/lib/device.ts`.
- Вызовы Capacitor в этой сборке подменяет `web/src/platform/desktop/` (`web/vite.config.ts`) и отправляет их сюда, в Rust:
  - `src-tauri/src/fs.rs` — файлы и скачивание, где лежит музыка: папка приложения, «Музыка\MUSICH» или своя папка;
  - `src-tauri/src/net.rs` — поиск сервера в домашней сети (mDNS `_musich._tcp`);
  - `src-tauri/src/main.rs` — номер и имя ПК, запасная копия настроек, значок в трее, одно окно на компьютер.
- Что играет, WebView2 сам отдаёт в системный плеер Windows и медиаклавишам (Media Session).
- Крестик прячет окно в трей, музыка играет дальше. Выйти — «Выйти» в меню значка.

Папки: данные приложения — `%LOCALAPPDATA%\app.musich.desktop` (музыка — `MUSICH\Music`), общая —
`Музыка\MUSICH`.

## Сборка

Нужны Node 24, Rust (stable, MSVC) и Visual Studio Build Tools с C++.

```
npm ci --prefix ../web
npm ci
npm run build      # установщик: src-tauri/target/release/bundle/nsis/MUSICH_<версия>_x64-setup.exe
npm run dev        # окно с интерфейсом из vite (порт 5174), правки видно сразу
npm run icons      # значки из web/public/icons/icon.svg
```

На GitHub установщик собирает `.github/workflows/release.yml` по тегу — `MUSICH-PC-Setup.exe`.
