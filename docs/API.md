# MUSICH — контракт бэкенда

Общий договор для трёх частей, которые пишутся параллельно: **сервер** (`server/`),
**клиент синхронизации** (`sync/`) и **деплой** (Dockerfile, compose). Менять контракт —
только здесь и согласованно. Веб-морда (`web/`) подключится к API позже.

## Стек

| Часть | Технологии |
|---|---|
| Сервер | Node 22 LTS+, TypeScript (ESM), Fastify 5, SQLite через встроенный `node:sqlite` (`DatabaseSync`), `music-metadata` для тегов |
| Клиент синхронизации | Node 22+, TypeScript (ESM), CLI-демон `musich-sync`, без нативных зависимостей |
| Деплой | Один docker-образ (multi-stage: сборка `web` + `server`), `docker-compose.yml`, `linux/amd64` и `linux/arm64` (pi5) |

Тесты: `node --test` (встроенный раннер) или vitest — на выбор части. Никаких нативных модулей
(better-sqlite3, sharp и т.п.), чтобы образ собирался под ARM без компилятора.

## Модель данных и синхронизации

> Будущая модель — каждое устройство автономно, синхронизация журналом событий и подсистема конфликтов —
> описана в [`SYNC.md`](SYNC.md) (утверждена как основа, ещё не сделана). Ниже — как работает сейчас.

- **Сервер — источник правды** о библиотеке. Каждое устройство держит у себя копию части треков
  в своей «папке синхронизации».
- **id трека = первые 16 hex от sha256 содержимого файла.** Один и тот же файл на двух устройствах
  получает один id, поэтому дубликаты не заливаются дважды, а клиент сопоставляет свои файлы
  с серверными по хэшу.
- **Лента изменений.** У каждой записи (трек, плейлист, лайк, картинка) есть `seq` — глобальный
  монотонный счётчик изменений. Клиент хранит последний увиденный `seq` (курсор) и спрашивает
  `GET /api/changes?since=<seq>`.
- **Удаление из хранилища** = надгробие (tombstone): трек помечается `deleted`, файл удаляется
  с сервера, запись остаётся в ленте. Устройство, увидев надгробие, удаляет свой локальный файл.
- **Удаление только с устройства** — чисто клиентское действие, сервер о нём не знает
  (клиент запоминает, что этот id качать обратно не надо, пока пользователь не попросит).
- **Оригиналы файлов не меняем никогда.** Свои картинки, лайки, плейлисты — записи в базе.

## Окружение сервера

**Человек не правит конфиги.** Пароль, папки с музыкой и токены устройств задаются в веб-морде
и хранятся в базе. Переменные ниже один раз прописаны в образе и compose.

| Переменная | По умолчанию | Что это |
|---|---|---|
| `PORT` | `2290` | порт HTTP |
| `MUSIC_DIR` | `/music` | папка с музыкой **только при самом первом запуске**; дальше список папок — в базе |
| `DATA_DIR` | `/data` | SQLite `musich.db`, обложки `covers/` |
| `STATIC_DIR` | — | если задан — раздавать собранную веб-морду (`web/dist`) с `/` |
| `MUSICH_TOKEN` | — | устаревшее: если задан, этот общий токен тоже пускает (для уже настроенных клиентов) |
| `SCAN_ON_START` | `true` | при старте просканировать все папки и добавить файлы, которых нет в базе |

Чтобы папки на дисках хоста можно было выбрать в веб-морде, compose монтирует в контейнер
`/mnt` и `/media` по тем же путям.

## Вход

- Все `/api/*`, кроме `/health` и `/auth/status|setup|login`, требуют токен:
  `Authorization: Bearer <token>`. Для `<audio src>` / `<img src>` — медиа-ключ `?mk=` (`GET /auth/media-key`): только чтение файлов, 14 дней. Ключ входа в адресе (`?token=`) сервер не принимает.
- **Первый запуск:** пароля нет, API отвечает `401 { error: "setup_required" }`. Веб-морда
  просит придумать пароль (`POST /auth/setup`) и получает токен. Кто первым открыл сервер, тот и владелец.
- Дальше браузер входит паролем (`POST /auth/login` → токен). Токен для устройства создаётся
  в веб-морде (`POST /tokens`) и показывается один раз. В базе лежит только sha256 токена.
- Приложение на телефоне (Capacitor) входит тем же паролем со своего адреса (`http://localhost`):
  сервер отвечает с `Access-Control-Allow-Origin: *`, предварительный `OPTIONS` проходит без токена.
  После входа приложение регистрирует себя (`POST /devices`, `kind: "phone"`) и шлёт `X-Musich-Device`.

Сборка и запуск сервера (на это опирается Dockerfile):
`cd server && npm ci && npm run build` → `server/dist/index.js`; запуск `node dist/index.js`
(или `npm start`). Проверка живости: `GET /api/health` → `200 {"ok":true,"version":"..."}`.

## Форматы

```ts
type TrackStatus = 'available' | 'deleted'

interface Track {
  id: string            // 16 hex — постоянный: отпечаток (sha256) файла, каким трек впервые пришёл. Не меняется при прошивке тегов
  hash: string          // нынешний отпечаток файла (16 hex sha256): меняется, когда файл прошивают — тогда устройства качают его заново
  fileChanged?: boolean // файл уже не тот, с которым трек пришёл (прошит в MUSICH или поправлен на диске)
  autoGain?: number     // громкость, которую клиент измерил сам (дБ) — для «выравнивать автоматически», если нет ReplayGain
  title: string
  artist: string
  album: string         // если в тегах пусто или «Мне нравится» — равен title (сингл)
  year?: number
  trackNo?: number      // номер трека из тегов («№» в проводнике). Нет в тегах — сервер сам пишет в файл следующий после самого большого (id при этом меняется; старую версию файла при повторной заливке узнаёт и возвращает существующий трек)
  duration: number      // секунды, целое
  gain?: number         // ReplayGain трека из тегов, дБ — клиент по нему выравнивает громкость
  albumGain?: number    // ReplayGain альбома, дБ
  peak?: number         // пик трека (доля от 1): громче него прибавлять нельзя
  size: number          // байты
  format: string        // 'flac' | 'mp3' | ...
  fileName: string      // исходное имя файла (для сохранения на устройстве)
  hasCover: boolean     // есть ли картинка (из тегов или своя)
  liked: boolean
  likedAt?: string      // ISO
  addedAt: string       // ISO
  status: TrackStatus
  seq: number
  source?: string       // кто прислал: имя устройства (по X-Musich-Device) или входа; нет — нашёлся сканом папки
  edited?: boolean      // название/исполнитель/альбом/год исправлены только в MUSICH (Prefs.editMode = 'overlay'), файл прежний
  replacedBy?: string   // только у старых надгробий (до постоянных id): новый id того же трека — клиенту стоит заменить старый id у себя
}

interface Playlist {
  id: string            // uuid
  name: string
  description: string
  trackIds: string[]    // порядок важен
  position: number      // место в списке плейлистов (с нуля), задаётся PUT /playlists/order
  hasCover: boolean
  updatedAt: string
  deleted: boolean
  seq: number
}

interface Device {
  id: string            // uuid, выдаёт сервер
  name: string
  kind: 'desktop' | 'laptop' | 'phone'
  lastSeenAt: string
}

interface Changes {
  cursor: number        // максимальный seq в ответе (или since, если пусто)
  tracks: Track[]       // в т.ч. status: 'deleted'
  playlists: Playlist[] // в т.ч. deleted: true
  covers: { kind: 'track' | 'album' | 'artist'; key: string; seq: number; deleted: boolean }[]
}

interface Folder {
  path: string          // абсолютный путь, как его видит сервер
  uploads: boolean      // сюда кладутся загрузки; такая папка ровно одна
  tracks: number        // сколько треков библиотеки лежит в ней
  scanning: boolean
}

interface DirListing { path: string; parent: string | null; dirs: string[] }   // только папки, без скрытых

interface TokenInfo { id: string; name: string; createdAt: string; lastUsedAt: string; current: boolean }

interface Prefs {          // общие настройки сервера, меняются только в веб-морде
  playThreshold: number    // через сколько секунд засчитывать прослушивание, 0 — половина трека (10)
  trashDays: number        // сколько дней держать удалённое в корзине, 1–365 (30)
  rescanMinutes: number    // скан всех папок по расписанию, 0 — выкл (60)
  watch: boolean           // следить за папками: новый/изменённый файл подхватывается сам (true)
  editMode: 'file' | 'overlay'   // правка трека: теги в самом файле (id прежний, меняется hash) или только в MUSICH поверх тегов (файл и id прежние) ('file')
  coverMode: 'file' | 'overlay'  // картинки: обложка трека вшивается в его файл (обложку альбома клиент сам вшивает во все треки через POST /albums/embed-cover) или только в MUSICH ('file'; в старых настройках без поля — как editMode)
  fileNames: 'artist-title' | 'number-artist-title' | 'keep'   // имя файла после правки тегов
  autoNumber: boolean      // трек без номера получает следующий после самого большого (true)
  shiftOnDelete: boolean   // удалили №6 — №7, 8… становятся №6, 7… (true)
  separators: { comma: boolean; feat: boolean; x: boolean; amp: boolean }   // чем делить артистов в теге
}

interface TrashItem {      // трек в корзине: файл ещё на диске
  id: string; title: string; artist: string; album: string; trackNo?: number
  duration: number; size: number; format: string; fileName: string
  deletedAt: string; expiresAt: string   // ISO; после expiresAt сервер стирает файл сам
}

interface ApiError { error: string; message: string }   // любой 4xx/5xx
```

## Эндпоинты

Все пути с префиксом `/api`. JSON, кроме файлов и картинок.

### Служебное
| Метод | Путь | Что делает |
|---|---|---|
| GET | `/health` | `{ ok: true, version, node, name }`, без токена. `node` — id сервера: по нему приложение узнаёт свой сервер на новом адресе. Сервер ещё и объявляет себя в локальной сети по mDNS: `_musich._tcp`, TXT `node`, `name`, `addr` (все адреса через запятую); отключить — `MUSICH_MDNS=0` |
| POST | `/devices` | `{ name, kind }` → `Device` (регистрация устройства) |
| GET | `/devices` | `Device[]` |
| POST | `/devices/:id/seen` | обновить `lastSeenAt` (клиент дёргает при каждой синхронизации) |
| DELETE | `/devices/:id` | забыть устройство, `204`. Его токен отзывается отдельно (`DELETE /tokens/:id`) |
| GET | `/stats` | `{ tracks, albums, artists, musicBytes, disk: { total, free } \| null, version }` — диск папки для загрузок |
| GET | `/activity` | `{ incoming: [{ id, fileName, received, total, source?, startedAt }], recent: [{ id, title, artist, source?, addedAt }] }` — загрузки, которые идут сейчас, и 20 последних треков |
| GET | `/profile` | `{ name, email, avatar? }` — профиль владельца |
| PUT | `/profile` | `{ name?, email?, avatar? }` → профиль; `avatar` — `data:image/(jpeg\|png\|webp);base64,…` до ~500 КБ, `null` — убрать |
| GET | `/prefs` | `Prefs` |
| PATCH | `/prefs` | часть `Prefs` → `Prefs`. Короче срок корзины — лишнее стирается сразу |

Клиент синхронизации шлёт заголовок `X-Musich-Device: <id устройства>`: по нему сервер подписывает
загруженные треки (`Track.source`). Без него подписью служит имя входа (токена).

### Вход и токены
| Метод | Путь | Что делает |
|---|---|---|
| GET | `/auth/status` | `{ setupDone, authenticated }`, без токена |
| POST | `/auth/setup` | `{ password, name? }` → `201 { token }`. Только пока пароля нет, иначе `409`. Пароль от 8 символов |
| POST | `/auth/login` | `{ password, name? }` → `{ token }`; неверный пароль — `401`. С одного адреса 5 неверных паролей за 15 минут — дальше 15 минут `429` с `Retry-After`. Адрес за своим прокси (nginx на той же машине или в своей сети) берётся из `X-Forwarded-For`. |
| POST | `/auth/logout` | отозвать текущий токен, `204` |
| PUT | `/auth/password` | `{ current, password }` → `204`; неверный текущий — `403` |
| GET | `/tokens` | `TokenInfo[]` — где выполнен вход (браузеры и устройства), без самих токенов |
| POST | `/tokens` | `{ name }` → `201 TokenInfo & { token }` — токен для устройства, показать один раз |
| DELETE | `/tokens/:id` | отозвать, `204` |

### Папки с музыкой
| Метод | Путь | Что делает |
|---|---|---|
| GET | `/folders` | `Folder[]` |
| POST | `/folders` | `{ path }` → `201 Folder` и скан этой папки в фоне. `400` — путь не абсолютный или это `DATA_DIR`; `404` — папки нет; `409` — уже есть, вложена в другую или содержит другую |
| DELETE | `/folders?path=` | убрать из библиотеки, `204`. Файлы не трогаются; треки из неё становятся надгробиями с пометкой «папку убрали», и если папку вернуть, скан их воскресит. Последнюю папку убрать нельзя (`409`); если убрали папку для загрузок, ею становится первая оставшаяся |
| PUT | `/folders/uploads` | `{ path }` → `Folder[]` — куда класть загрузки |
| POST | `/scan` | пересканировать все папки в фоне (сам сервер ещё сканирует по `Prefs.rescanMinutes` и, если `Prefs.watch`, — папку, где что-то поменялось), `202 Folder[]`. Треки, чьих файлов больше нет в папке, убираются из библиотеки (надгробие с `unlinked`, номера не сдвигаются); вернётся файл — скан вернёт и трек |
| GET | `/fs?path=` | `DirListing` — обзор диска сервера для выбора папки (без `path` — корень) |

### Треки
| Метод | Путь | Что делает |
|---|---|---|
| GET | `/tracks` | `Track[]` (только `available`) |
| GET | `/tracks/:id` | `Track` (404 если нет) |
| GET, HEAD | `/tracks/by-hash/:hash` | `Track`, чей это файл — по любому отпечатку из истории трека (каким пришёл, после каждой прошивки); 404 — такого файла нет. Проверка перед загрузкой: старая копия файла на устройстве — это тот же трек |
| POST | `/tracks` | загрузка файла, `multipart/form-data`, поле `file`. Сервер считает хэш, кладёт файл в папку для загрузок, читает теги. Если такой id уже есть — `200` с существующим `Track`, иначе `201` с новым. Если трек был удалён (надгробие) — восстанавливает |
| GET | `/tracks/:id/file` | сам файл, **с поддержкой `Range`** (206), правильный `Content-Type`, `Content-Length`, `Accept-Ranges: bytes` |
| GET | `/tracks/:id/cover` | картинка трека: своя → своя у альбома → из тегов; 404 если нет |
| GET | `/tracks/:id/lyrics` | текст песни: `.lrc` рядом с файлом, иначе теги (USLT/SYLT, LYRICS) → `{ lyrics: string | null }` — LRC или обычный текст |
| DELETE | `/tracks/:id` | удалить из хранилища: надгробие, а файл уезжает в корзину (`.musich-trash` той же папки с музыкой) на `Prefs.trashDays` дней, `204`. Нумерация сплошная: если номер был только у этого трека, все треки с бо́льшим номером сдвигаются на −1 (в фоне, номер пишется в файлы — id прежние, меняется `hash`); выключается `Prefs.shiftOnDelete` |
| PUT | `/tracks/:id/like` | `{ liked: boolean }` → `Track` |
| PATCH | `/tracks/:id` | переименование: `{ title?, artist?, album?, year? }` (`year: 0` — убрать) (хотя бы одно поле) → `{ track: Track, previousId }`. При `Prefs.editMode = 'file'` теги пишутся в сам файл: **id прежний**, меняется `hash` (устройства скачают файл заново); при `'overlay'` — правка поверх тегов, файл не трогается. `previousId` всегда равен id. Имя файла — по `Prefs.fileNames`. `409` — ровно такой файл уже есть |
| PUT | `/tracks/:id/loudness` | `{ gain }` (дБ, −30…20) → `Track`: громкость, измеренная клиентом, — общая для всех устройств |
| POST | `/albums/embed-cover` | `{ album }` → `{ done, failed }`: своя обложка альбома вшивается во все его файлы (id прежние, меняется `hash`) |
| DELETE | `/tracks/:id/overrides` | убрать правки «только в MUSICH» → `Track` с данными из тегов файла |
| POST | `/tracks/:id/number` | `{ number }` → `{ renamed: [{ track, previousId }], failed }`: трек встаёт на номер `number` (тег «№»), треки между старым и новым номером сдвигаются на единицу; номер пишется в файлы (id прежние, меняется `hash`). Треки с тем же номером, что был у переносимого, не трогаются |
| POST | `/tracks/renumber` | пронумеровать всю библиотеку подряд 1…N в нынешнем порядке (по номеру, при равных — кто раньше добавлен): закрывает дыры и разводит одинаковые номера. `202 { changes }` — сколько треков поменяют номер; идёт в фоне |

### Корзина
| Метод | Путь | Что делает |
|---|---|---|
| GET | `/trash` | `TrashItem[]`, свежие сверху |
| POST | `/trash/:id/restore` | вернуть файл на прежнее место (занято — с приставкой id) → `Track`. Если номер трека за это время занял другой, трек встаёт в конец (новый номер пишется в файл, id прежний) |
| DELETE | `/trash/:id` | стереть насовсем, `204` |
| DELETE | `/trash` | очистить корзину, `204` |

### Интеграции
Списки треков из Spotify, YouTube Music, Яндекс Музыки и VK — сравнить с библиотекой (только чтение). service — spotify, youtube, yandex, vk. VK музыку сторонним программам не отдаёт — список присылает расширение браузера MUSICH ← VK (папка extension/vk; сервер отдаёт его архивом с вписанными адресом и ключом). Ключ приложения в сервисе владелец заводит сам и вписывает в веб-морде; токены и снимок списка — в settings (`integration:<service>`, `integration:<service>:tracks`).

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/integrations` | `[{ service, configured, connected, account?, syncedAt?, total?, missing?, error? }]` |
| PUT | `/integrations/:service/config` | `{ clientId, clientSecret? }` (у YouTube секрет обязателен) → статусы |
| POST | `/integrations/spotify/start` | `{ redirectUri, origin }` → `{ url }` — вход в Spotify (OAuth с PKCE). redirectUri должен быть вписан в приложении Spotify (http — только 127.0.0.1) |
| GET | `/integrations/spotify/callback` | без токена: Spotify возвращает сюда, сервер меняет код на токены и уводит на `<origin>/?integration=spotify[&error=…]` |
| POST | `/integrations/youtube/start` | `{ userCode, verificationUrl, expiresIn }` — вход в Google кодом (device flow); сервер сам ждёт подтверждения |
| POST | `/integrations/:service/sync` | забрать лайки и плейлисты → статус |
| GET | `/integrations/:service/compare` | `{ total, matched, lists, tracks: [{ id, title, artists, album?, liked, lists, localId?, cover?, duration? }] }` — localId: нашёлся в библиотеке (по исполнителю и названию; скобки в названии — и как текст, и без них); cover — ссылка на обложку у сервиса, duration — секунды |
| DELETE | `/integrations/:service` | отключить (вход и список забыть, ключ оставить) |
| POST | `/integrations/yandex/token` | `{ token }` — токен Яндекса (или адрес страницы с `#access_token=…`): неофициальный API Яндекс Музыки, лайки и все плейлисты аккаунта |
| GET | `/integrations/vk/extension?origin=` | расширение MUSICH ← VK архивом (`musich-vk.zip`): в `config.js` — origin сервера и новый ключ «Расширение VK → MUSICH», в manifest — разрешение на этот сервер |
| POST | `/integrations/vk/push` | `{ liked: [{ id?, artist?, title, duration?, cover? }], lists?: [{ name, tracks }] }` — расширение присылает «Мою музыку» (и плейлисты) целиком: снимок VK заменяется |
| POST | `/integrations/yandex/public` | `{ link }` — открытый профиль (`users/<логин>`, лайки + открытые плейлисты) или плейлист (`users/<логин>/playlists/<номер>`) без входа |
| POST | `/integrations/:service/import` | `{ list, tracks: [{ artist, title }] }` — список, вставленный текстом; заменяет прежний список с тем же именем |

### Конфликты
| Метод | Путь | Что делает |
|---|---|---|
| GET | `/conflicts` | `{ returned: [{ id, trackId, title, artist, fileName, source?, createdAt }], duplicates: [{ key, tracks: Track[] }] }`. returned — удалённый в MUSICH трек снова прислали с устройства (`POST /tracks` ответил `409 deleted`, файл ждёт в `.musich-conflicts`); duplicates — одинаковые исполнитель и название у разных файлов |
| POST | `/conflicts/:id` | `{ action: 'restore' \| 'discard' }` → `{ track }`: вернуть трек (из корзины или из присланного файла) или стереть присланный файл |
| POST | `/conflicts/duplicates/ignore` | `{ key }` → `204`: «это разные треки», группу больше не показывать |

### Артисты
| Метод | Путь | Что делает |
|---|---|---|
| POST | `/artists/rename` | `{ from, to }` → `{ renamed: [{ track, previousId }], failed }`. Каждый трек артиста переименовывается как в `PATCH /tracks/:id` (теги в файле, id прежний). Артисты в теге делятся по запятой, feat./ft. и « x » — в совместных треках меняется только `from` (регистр не важен). Своя картинка артиста переезжает на новое имя. `404` — таких треков нет |

### История прослушиваний
Прослушивание засчитывает клиент: реально прослушано `Prefs.playThreshold` секунд (0 — половина трека; трек короче — целиком),
перемотка не считается. История хранится всегда.

| Метод | Путь | Что делает |
|---|---|---|
| POST | `/plays` | `{ trackId, at? }` → `201 { trackId, playedAt, source? }`; 404, если трека нет. `at` — когда слушали (телефон без сети копит прослушивания и досылает их потом); время из будущего считается «сейчас» |
| GET | `/plays` | история (последние 20 000 прослушиваний), свежие сверху: `[{ trackId, playedAt, source? }]` |

### Плейлисты
| Метод | Путь | Что делает |
|---|---|---|
| GET | `/playlists` | `Playlist[]` (без удалённых). «Избранное» не хранится: это треки с `liked` |
| POST | `/playlists` | `{ name, description?, trackIds? }` → `201 Playlist` (встаёт в конец списка) |
| PUT | `/playlists/order` | `{ ids }` — плейлисты в нужном порядке → `Playlist[]`; кого нет в `ids`, остаются в конце в прежнем порядке |
| PATCH | `/playlists/:id` | `{ name?, description?, trackIds? }` → `Playlist` (trackIds — полный новый порядок) |
| DELETE | `/playlists/:id` | надгробие, `204`. Треки не трогает |

### Свои картинки
`kind` — `track` | `album` | `artist`, `key` — id трека, название альбома или имя артиста (URL-encoded).
| Метод | Путь | Что делает |
|---|---|---|
| PUT | `/covers/:kind/:key` | тело — картинка (`image/jpeg` / `image/png` / `image/webp`, до 5 МБ). У трека при `Prefs.coverMode = 'file'` картинка вшивается в сам файл (id прежний, меняется `hash`) |
| GET | `/covers/:kind/:key` | картинка или 404 |

У всех GET картинок (`/tracks/:id/cover`, `/covers/:kind/:key`, `/playlists/:id/cover`) есть `?w=160|320|480`: квадратная копия этой ширины в `image/webp` для списков (другое число — ближайший размер не меньше; больше 480 или мусор — оригинал). Копии лежат в `<DATA_DIR>/thumbs`, в бэкап не входят и пересоздаются сами.

| DELETE | `/covers/:kind/:key` | вернуть картинку из тегов, `204` |
| GET | `/playlists/:id/cover`, PUT, DELETE | то же для плейлиста |

### Бэкап и выгрузка
Выгрузку `/export` можно скачать ссылкой с медиа-ключом `?mk=`, как файлы треков; бэкап — только с заголовком.

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/backup` | файл `musich-backup-<дата>.db`: снимок базы, свои картинки — в таблице `musich_backup_files` внутри. Музыки в нём нет |
| POST | `/backup/restore` | `multipart/form-data`, поле `file` — бэкап. Проверяется, что это база MUSICH (`400` — нет), → `202 { restarting: true }`, и сервер перезапускается уже с ним. Прежняя база остаётся рядом: `musich.db.before-restore` |
| GET | `/export?tracks=1&albums=1&playlists=copies\|m3u&names=` | zip-архив музыки потоком, без сжатия, с `Content-Length`. `tracks` — все треки в одной папке, `albums` — по папке на альбом («Артист - Альбом»), `playlists`: `copies` — папка на плейлист с копиями по порядку, `m3u` — `.m3u8` со ссылками на общую папку треков (туда попадут хотя бы треки из плейлистов). «Избранное» выгружается как плейлист. `names` — JSON `{ tracks, albums, playlists, liked }` с именами папок |

### Синхронизация
| Метод | Путь | Что делает |
|---|---|---|
| GET | `/changes?since=<seq>` | `Changes` — всё, что изменилось после `seq` (`since=0` — всё сразу) |
| GET | `/sync/hello` | `{ node, name, kind: 'server', vector }` — узел и его вектор (журнал событий, [SYNC.md](SYNC.md)) |
| POST | `/sync/pull` | `{ vector?, limit? }` (limit ≤ 5000, по умолчанию 1000) → `{ events: SyncEvent[], more }` — события, которых нет у спрашивающего |
| GET / HEAD | `/sync/file/:hash` | файл трека или своей картинки по отпечатку (16 hex), с `Range` |
| POST | `/sync/codes` | → `{ code, expiresAt }` — одноразовый код подключения: 6 цифр, 10 минут, один раз (не больше 20 живых) |
| POST | `/sync/pair` | **без входа.** `{ code, name?, kind? }` → `{ key, node, name }` — обменять код на свой ключ устройства. С одного адреса 5 неверных кодов за 15 минут — дальше `429` и `Retry-After`; больше 50 неверных со всех адресов за 10 минут — все живые коды гаснут |

### Telegram — музыка профиля в библиотеку

Вход аккаунтом пользователя (MTProto): свои api_id и api_hash с my.telegram.org. Сессия — в настройках пользователя на сервере (`integration:telegram`), «Отключить» завершает её и в Telegram.

| Метод | Путь | Что |
|---|---|---|
| GET | `/integrations/telegram` | `{ configured, connected, account?, syncedAt?, imported, running?: { done, total, added, failed }, error? }` |
| PUT | `/integrations/telegram/config` | `{ apiId, apiHash }` |
| POST | `/integrations/telegram/code` | `{ phone }` — Telegram присылает код |
| POST | `/integrations/telegram/signin` | `{ code }` → `{ account }` или `{ password: true }` |
| POST | `/integrations/telegram/password` | `{ password }` — облачный пароль → `{ account }` |
| POST | `/integrations/telegram/import` | забрать музыку профиля (`users.getSavedMusic`) в фоне; ход — в `running` |
| DELETE | `/integrations/telegram` | выйти из Telegram и забыть сессию |

## Клиент синхронизации (`musich-sync`)

```
musich-sync init --server http://pi5.local:2290 --folder "C:\Users\me\Music\Musich" --name "Домашний ПК" [--token ...]
musich-sync run            # один проход синхронизации
musich-sync watch          # демон: следит за папкой + опрашивает /changes раз в N секунд
musich-sync status         # что на устройстве, что в очереди, курсор
musich-sync remove <id> --local | --everywhere
```

- Конфиг и состояние — в папке пользователя (`%APPDATA%\musich` / `~/.config/musich`):
  сервер, токен, deviceId, курсор, карта `путь ↔ id`, список «удалено только здесь».
- **Новый файл в папке** (после того как он перестал расти) → посчитать хэш → `HEAD by-hash` →
  если нет, `POST /tracks`.
- **Новый трек на сервере** (из `/changes`) → скачать `GET /tracks/:id/file` во временный файл
  рядом, потом переименовать в `<Артист> - <Название>.<формат>` (без запрещённых символов),
  если его нет в «удалено только здесь». Режим «качать всё / только по запросу» — в конфиге.
- **Надгробие из `/changes`** → удалить локальный файл и запись в карте.
- **Файл удалили из папки руками** → считать это «удалить только с устройства» (сервер не трогать).
- Ошибки сети — повтор с паузой, следующий проход продолжает с того же курсора.


## Общие плейлисты (server/src/shares.ts, миграция 21)

| Метод | Путь | Что |
|---|---|---|
| GET | `/users/directory` | все пользователи, кроме меня: `{ id, login, name }[]` |
| GET | `/playlists/:id/shares` | с кем хозяин поделился: `{ userIds }` |
| PUT | `/playlists/:id/shares` | `{ userIds }` — заменить список получателей; чужой плейлист — 404 |
| GET | `/shared` | чем поделились со мной: `{ id, name, description, owner, items: { artist, title, trackId? }[] }[]`; `trackId` — такой трек есть в моей библиотеке (артист + название) |

## Скробблинг: ListenBrainz и Last.fm (server/src/scrobble.ts)

Отправляет сервер, раз в минуту: прослушивания пользователя после момента подключения, пачками до 50, треки короче 30 с — нет. Ключи хранятся в `user_settings` (`scrobble`, состояние — `scrobble:<service>`), в ответах не отдаются.

| Метод | Путь | Что |
|---|---|---|
| GET | `/scrobble` | `{ listenbrainz, lastfm }`: `{ connected, user, sent, lastSentAt, error, waiting? }` |
| PUT | `/scrobble/listenbrainz` | `{ token }` — проверяется через ListenBrainz `validate-token` |
| POST | `/scrobble/lastfm/start` | `{ apiKey, secret }` (свои ключи приложения Last.fm) → `{ authUrl }` — открыть и разрешить доступ |
| POST | `/scrobble/lastfm/finish` | забрать ключ сессии после «Allow access» |
| DELETE | `/scrobble/:service` | отключить |
| POST | `/scrobble/now` | отправить сейчас, не ждать минуты |

## Безопасность (server/src/security.ts)

- Ответы сервера несут CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS при https.
- Медиа-ключ: `GET /auth/media-key` → `{ key, expiresAt }` (14 дней). В адресах аудио/картинок/скачиваний — `?mk=<key>` вместо ключа входа; открывает только GET файлов, обложек, выгрузки и расширения VK. Смена пароля, сброс пароля владельцем и «выйти везде» его отзывают.
- Вход без дела 90 дней истекает. `POST /auth/logout-all` — выйти на всех других устройствах. Смена пароля сбрасывает остальные входы.
- Двухэтапный вход (TOTP): `GET /auth/2fa`, `POST /auth/2fa/setup` → `{ secret, uri }`, `POST /auth/2fa/enable { code }` → `{ recovery[8] }`, `POST /auth/2fa/disable { password }`. Вход: без `code` — 401 `totp_required`, неверный — 401 `totp_wrong`; подходит и запасной код (один раз).
- Бэкап: `POST /backup { password? }` — с паролем файл зашифрован (AES-256-GCM, ключ scrypt; начинается с `MUSICHENC1`). Восстановление: multipart, поле `password` перед `file`; 400 `password_required` / `password_wrong`.
- Обновления: `GET /server/update` → `{ current, check, latest|null }` (раз в сутки GitHub releases), `PUT /server/update { check }` — владелец.
- Домашний адрес: `GET /server/lan` → `{ manual, found[] }`, `PUT /server/lan { manual }` (пусто — сброс; без порта — порт сервера) — владелец. В `GET /api/health` поле `lan[]`: сначала адрес из настроек, потом адреса, по которым сервер открывали напрямую (Host без прокси), потом сетевые карты. Телефон дома пробует их и ходит напрямую, если ответил тот же `node`.

## Качество потока и домашняя сеть

- `GET /tracks/:id/file?q=128|192|320` — пережатая MP3-копия (ffmpeg, кэш `<DATA_DIR>/transcode`, до 3 ГБ), с Range. Пережимается только без потерь или если битрейт файла заметно выше; нет ffmpeg — оригинал. `&warm=1` — подготовить заранее, ответ 204.
- `GET /health` → ещё `lan: string[]` — адреса сервера в домашней сети. Телефон, когда главный адрес — домен и он на Wi-Fi, пробует их (1,2 с) и при совпадении `node` ходит напрямую; иначе — по домену.
