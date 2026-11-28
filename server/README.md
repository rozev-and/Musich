# MUSICH — сервер

Fastify 5 + встроенный `node:sqlite` + `music-metadata`. Нативных модулей нет, поэтому образ
собирается и под arm64 (Raspberry Pi 5). API — строго по [`../docs/API.md`](../docs/API.md),
решения по местам, которые контракт не описывает, — в [`CONTRACT-NOTES.md`](CONTRACT-NOTES.md).

Нужен Node **22.18+** (для `dev` и тестов: TypeScript запускается без сборки).
Собранному `dist/` хватит Node 22.13+.

## Команды

| | |
|---|---|
| `npm ci` | поставить зависимости |
| `npm run build` | собрать в `dist/` (`dist/index.js`) |
| `npm start` | запустить собранный сервер |
| `npm run dev` | запуск из исходников с перезапуском при правке; читает `.env`, если он есть |
| `npm test` | тесты (`node --test`; WAV-файлы генерируются во временных папках) |
| `npm run typecheck` | проверка типов вместе с тестами |

## Переменные окружения

Пользователь их не трогает: пароль, папки с музыкой и токены устройств задаются в веб-морде
и живут в базе (таблицы `settings`, `folders`, `tokens`).

| Переменная | По умолчанию | |
|---|---|---|
| `PORT` | `2290` | порт |
| `MUSIC_DIR` | `/music` | первая папка с музыкой при самом первом запуске, дальше папки — в базе |
| `DATA_DIR` | `/data` | `musich.db` и картинки (`covers/`) |
| `STATIC_DIR` | — | раздавать собранную веб-морду с `/` |
| `MUSICH_TOKEN` | — | устаревшее: общий токен для уже настроенных клиентов, пускает наравне с выданными |
| `SCAN_ON_START` | `true` | при старте в фоне просканировать все папки |
| `HOST` | `0.0.0.0` | адрес для `listen` |
| `MAX_UPLOAD_MB` | `2048` | лимит размера загружаемого файла |
| `LOG_LEVEL` | `info` | уровень логов pino |

## Запуск локально на копии нескольких треков

Сервер не меняет файлы в папках с музыкой, но удаление трека через API удаляет и его файл. Поэтому
для пробы — копия, а не основная папка с музыкой. PowerShell:

```powershell
cd Musich\server
npm ci
New-Item -ItemType Directory -Force .local\music | Out-Null
Get-ChildItem $HOME\Music -File | Select-Object -First 5 | Copy-Item -Destination .local\music
Copy-Item .env.example .env
npm run dev
```

Проверка. При первом запуске API закрыт, пока не задан пароль; `setup` выдаёт токен:

```powershell
curl.exe http://localhost:2290/api/health
curl.exe -H "Content-Type: application/json" -d '{\"password\":\"local-dev-pass\"}' http://localhost:2290/api/auth/setup
$t = "<token из ответа>"
curl.exe -H "Authorization: Bearer $t" http://localhost:2290/api/tracks
curl.exe -H "Authorization: Bearer $t" http://localhost:2290/api/folders
curl.exe -H "Authorization: Bearer $t" -F "file=@C:\path\to\song.mp3" http://localhost:2290/api/tracks
curl.exe -H "Authorization: Bearer $t" -H "Range: bytes=0-99" -D - -o NUL http://localhost:2290/api/tracks/<id>/file
curl.exe -H "Authorization: Bearer $t" "http://localhost:2290/api/changes?since=0"
```

С веб-мордой: `cd ..\web; npm run build`, затем `STATIC_DIR=../web/dist` в `.env` и открыть
`http://localhost:2290/`.

## Устройство

```
src/
  index.ts    запуск: конфиг, listen, фоновый скан, остановка по SIGTERM
  app.ts      Fastify: проверка токена, ошибки ApiError, все маршруты /api, статика
  auth.ts     пароль владельца (scrypt), токены браузеров и устройств
  library.ts  библиотека: папки с музыкой, треки, надгробия, лайки, плейлисты, картинки, устройства, /changes
  db.ts       SQLite, миграции (PRAGMA user_version), глобальный счётчик seq, настройки
  scanner.ts  обход папок с музыкой
  media.ts    хэш (id = первые 16 hex sha256), теги, правила альбома/имени файла
  range.ts    разбор заголовка Range
```

Данные: `DATA_DIR/musich.db` (WAL), `DATA_DIR/covers/tag/<id>` — картинки, вынутые из тегов,
`DATA_DIR/covers/custom/` — свои картинки. Временные файлы загрузок — `.musich-tmp/` внутри
папки для загрузок (чистится при старте, скан папки с точкой в начале имени пропускает).
`tracks.path` — абсолютный путь; базы со старыми путями от `MUSIC_DIR` переводятся при запуске.
