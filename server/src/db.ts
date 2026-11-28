import { DatabaseSync } from 'node:sqlite'

// Миграции по порядку; номер последней применённой лежит в PRAGMA user_version.
// Новую схему — только новым элементом в конце, старые не править.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE counters (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  INSERT INTO counters (name, value) VALUES ('seq', 0);

  CREATE TABLE tracks (
    id             TEXT PRIMARY KEY,         -- первые 16 hex sha256 содержимого
    title          TEXT NOT NULL,
    artist         TEXT NOT NULL,
    album          TEXT NOT NULL,
    year           INTEGER,
    duration       INTEGER NOT NULL,
    size           INTEGER NOT NULL,
    format         TEXT NOT NULL,
    file_name      TEXT NOT NULL,            -- исходное имя файла
    path           TEXT,                     -- путь внутри MUSIC_DIR (posix), NULL у надгробий
    tag_cover_mime TEXT,                     -- есть картинка из тегов (лежит в covers/tag/<id>)
    added_at       TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('available', 'deleted')),
    seq            INTEGER NOT NULL
  );
  CREATE INDEX tracks_seq ON tracks (seq);
  CREATE INDEX tracks_path ON tracks (path);
  CREATE INDEX tracks_album ON tracks (album);

  CREATE TABLE likes (
    track_id TEXT PRIMARY KEY REFERENCES tracks (id),
    liked_at TEXT NOT NULL
  );

  CREATE TABLE playlists (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    track_ids   TEXT NOT NULL DEFAULT '[]',  -- JSON-массив, порядок важен
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted     INTEGER NOT NULL DEFAULT 0,
    seq         INTEGER NOT NULL
  );
  CREATE INDEX playlists_seq ON playlists (seq);

  -- Свои картинки. kind: track | album | artist | playlist (у playlist key = id плейлиста)
  CREATE TABLE covers (
    kind       TEXT NOT NULL,
    key        TEXT NOT NULL,
    mime       TEXT,
    file       TEXT,                         -- имя файла в covers/custom
    updated_at TEXT NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    seq        INTEGER NOT NULL,
    PRIMARY KEY (kind, key)
  );
  CREATE INDEX covers_seq ON covers (seq);

  CREATE TABLE devices (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('desktop', 'laptop', 'phone')),
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  `,
  // Настройки живут в базе и меняются из веб-морды: папки с музыкой, пароль, токены устройств.
  // tracks.path с этой версии — абсолютный путь (старые относительные переводит Library.init).
  `
  CREATE TABLE folders (
    path     TEXT PRIMARY KEY,               -- абсолютный путь, как его видит сервер
    uploads  INTEGER NOT NULL DEFAULT 0,     -- сюда кладутся загрузки; такая папка ровно одна
    added_at TEXT NOT NULL
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Токены доступа: вход из браузера и устройства. Храним только sha256 от токена
  CREATE TABLE tokens (
    id           TEXT PRIMARY KEY,
    hash         TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_used_at TEXT NOT NULL
  );

  -- 1 — надгробие из-за того, что папку убрали из библиотеки: файл цел, и если папку
  -- вернут, скан трек воскресит (обычное надгробие скан не трогает)
  ALTER TABLE tracks ADD COLUMN unlinked INTEGER NOT NULL DEFAULT 0;
  `,
  // Откуда пришёл трек: имя устройства или входа, приславшего файл. NULL — нашёлся сканом папки
  `
  ALTER TABLE tracks ADD COLUMN source TEXT;
  CREATE INDEX tracks_added ON tracks (added_at);
  `,
  // Номер трека из тегов («№» в проводнике). tags_v — какой версией разбора читались теги:
  // у старых строк 0, их теги один раз дочитываются в фоне (Library.backfillTags)
  `
  ALTER TABLE tracks ADD COLUMN track_no INTEGER;
  ALTER TABLE tracks ADD COLUMN tags_v INTEGER NOT NULL DEFAULT 0;
  `,
  // История прослушиваний: строка — трек дослушали хотя бы до половины (или 4 минут).
  // Без внешнего ключа: история остаётся, даже если трек потом удалили
  `
  CREATE TABLE plays (
    id        INTEGER PRIMARY KEY,
    track_id  TEXT NOT NULL,
    played_at TEXT NOT NULL,
    source    TEXT                           -- с какого устройства или входа слушали
  );
  CREATE INDEX plays_at ON plays (played_at);
  CREATE INDEX plays_track ON plays (track_id);
  `,
  // Порядок плейлистов задаёт владелец перетаскиванием; старые встают по дате создания
  `
  ALTER TABLE playlists ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
  UPDATE playlists SET position = (
    SELECT COUNT(*) FROM playlists p2
    WHERE p2.created_at < playlists.created_at OR (p2.created_at = playlists.created_at AND p2.id < playlists.id)
  );
  `,
  // Во что превратился трек после переписывания тегов (у надгробия): старую версию файла
  // при повторной заливке или скане узнаём и не заводим дубль
  `
  ALTER TABLE tracks ADD COLUMN replaced_by TEXT;
  `,
  // Что у устройства ждёт синхронизации — оно само сообщает при каждой отметке «на связи»
  `
  ALTER TABLE devices ADD COLUMN pending_up INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE devices ADD COLUMN pending_down INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE devices ADD COLUMN synced_at TEXT;
  `,
  // Когда файл трека последний раз менялся на диске (мс): скан по нему замечает правки тегов мимо MUSICH
  `
  ALTER TABLE tracks ADD COLUMN mtime REAL;
  `,
  // Корзина: удалённый трек — надгробие, а файл ещё лежит в .musich-trash своей папки, пока не истёк срок
  `
  CREATE TABLE trash (
    track_id   TEXT PRIMARY KEY,
    file       TEXT NOT NULL,              -- где файл лежит сейчас (абсолютный путь)
    orig_path  TEXT NOT NULL,              -- куда вернуть
    deleted_at TEXT NOT NULL
  );
  `,
  // ReplayGain из тегов (дБ и пик) — клиент по ним выравнивает громкость
  `
  ALTER TABLE tracks ADD COLUMN rg_track REAL;
  ALTER TABLE tracks ADD COLUMN rg_album REAL;
  ALTER TABLE tracks ADD COLUMN rg_peak REAL;
  `,
  // Правки «только в MUSICH»: JSON { title?, artist?, album?, year? } поверх тегов файла (сам файл не трогаем)
  `
  ALTER TABLE tracks ADD COLUMN ov TEXT;
  `,
  // Постоянный ID: до этого id был отпечатком (хэшем) файла и менялся при каждой правке тегов.
  // Теперь id не меняется, а отпечатки живут отдельно: hash — нынешний, orig_hash — каким файл пришёл,
  // таблица hashes — все отпечатки, которые когда-либо были у трека (по ним узнаём старые копии файла).
  // Нынешние id остаются как есть; отпечатки старых версий (надгробия с replaced_by) привязываем к живому треку
  `
  ALTER TABLE tracks ADD COLUMN hash TEXT;
  ALTER TABLE tracks ADD COLUMN orig_hash TEXT;
  UPDATE tracks SET hash = id, orig_hash = id;
  CREATE TABLE hashes (
    hash     TEXT PRIMARY KEY,
    track_id TEXT NOT NULL,
    seen_at  TEXT NOT NULL
  );
  CREATE INDEX hashes_track ON hashes (track_id);
  INSERT INTO hashes (hash, track_id, seen_at) SELECT id, id, added_at FROM tracks;
  WITH RECURSIVE chain (start, cur, depth) AS (
    SELECT id, replaced_by, 1 FROM tracks WHERE replaced_by IS NOT NULL
    UNION ALL
    SELECT c.start, t.replaced_by, c.depth + 1 FROM chain c JOIN tracks t ON t.id = c.cur
    WHERE t.replaced_by IS NOT NULL AND c.depth < 100
  )
  UPDATE hashes SET track_id = (SELECT cur FROM chain WHERE chain.start = hashes.hash ORDER BY depth DESC LIMIT 1)
  WHERE hash IN (SELECT start FROM chain);
  UPDATE tracks SET orig_hash = COALESCE((
    SELECT h.hash FROM hashes h JOIN tracks t0 ON t0.id = h.hash
    WHERE h.track_id = tracks.id AND h.hash <> tracks.id
      AND NOT EXISTS (SELECT 1 FROM tracks p WHERE p.replaced_by = h.hash)
    ORDER BY t0.added_at LIMIT 1
  ), id) WHERE replaced_by IS NULL;
  `,
  // Громкость, которую клиент измерил сам (трек без ReplayGain): на сколько дБ убавить/прибавить
  `
  ALTER TABLE tracks ADD COLUMN auto_gain REAL;
  `,
  // Конфликты: удалённый в MUSICH трек снова прислали с устройства — файл ждёт решения «вернуть» или «не нужен»
  `
  CREATE TABLE conflicts (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,          -- 'returned'
    track_id   TEXT NOT NULL,
    file       TEXT NOT NULL,          -- присланный файл (лежит в .musich-conflicts папки для загрузок)
    file_name  TEXT NOT NULL,
    source     TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // Исходные теги трека — как в файле, когда он пришёл: по ним видно, что поменяли (теги, номер), а cover_embedded —
  // вшивали ли обложку. Для старых треков берём их первую версию (надгробие с id = orig_hash)
  `
  ALTER TABLE tracks ADD COLUMN orig_title TEXT;
  ALTER TABLE tracks ADD COLUMN orig_artist TEXT;
  ALTER TABLE tracks ADD COLUMN orig_album TEXT;
  ALTER TABLE tracks ADD COLUMN orig_year INTEGER;
  ALTER TABLE tracks ADD COLUMN orig_track_no INTEGER;
  ALTER TABLE tracks ADD COLUMN cover_embedded INTEGER NOT NULL DEFAULT 0;
  UPDATE tracks SET (orig_title, orig_artist, orig_album, orig_year, orig_track_no) =
    (SELECT o.title, o.artist, o.album, o.year, o.track_no FROM tracks o WHERE o.id = tracks.orig_hash)
  WHERE orig_hash IS NOT NULL;
  `,
  // Журнал событий (docs/SYNC.md): каждое изменение библиотеки — событие узла. Триггеры складывают сырые изменения
  // в journal_pending, Journal.flush превращает их в события. Узел-автор и его номер — без пропусков
  `
  CREATE TABLE events (
    id    TEXT PRIMARY KEY,            -- <узел>:<n>
    node  TEXT NOT NULL,
    n     INTEGER NOT NULL,
    hlc   TEXT NOT NULL,               -- гибридные часы: время/счётчик, сравниваются как строки
    type  TEXT NOT NULL,
    key   TEXT NOT NULL,
    field TEXT NOT NULL DEFAULT '',
    value TEXT,                        -- JSON
    base  TEXT,                        -- последнее событие по key+field, которое автор видел
    UNIQUE (node, n)
  );
  CREATE INDEX events_key ON events (key, field, hlc);
  CREATE TABLE journal_pending (
    id     INTEGER PRIMARY KEY,
    entity TEXT NOT NULL,              -- track | like | playlist | cover | play | trash | setting
    key    TEXT NOT NULL,
    op     TEXT NOT NULL,              -- insert | update | delete
    old    TEXT,
    new    TEXT,
    at     TEXT NOT NULL
  );
  -- старые надгробия версий (replaced_by) — не треки, а прошлые файлы: их не пишем
  CREATE TRIGGER j_tracks_ins AFTER INSERT ON tracks WHEN NEW.replaced_by IS NULL BEGIN
    INSERT INTO journal_pending (entity, key, op, old, new, at) VALUES ('track', NEW.id, 'insert', NULL, json_object('title', NEW.title, 'artist', NEW.artist, 'album', NEW.album, 'year', NEW.year, 'trackNo', NEW.track_no,
      'duration', NEW.duration, 'size', NEW.size, 'format', NEW.format, 'fileName', NEW.file_name, 'hash', NEW.hash,
      'origHash', NEW.orig_hash, 'status', NEW.status, 'unlinked', NEW.unlinked, 'ov', NEW.ov, 'autoGain', NEW.auto_gain,
      'source', NEW.source, 'addedAt', NEW.added_at, 'tagsV', NEW.tags_v, 'hasFile', NEW.path IS NOT NULL), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_tracks_upd AFTER UPDATE ON tracks WHEN NEW.replaced_by IS NULL AND (
    OLD.hash IS NOT NEW.hash OR OLD.ov IS NOT NEW.ov OR OLD.status IS NOT NEW.status OR OLD.unlinked IS NOT NEW.unlinked
    OR OLD.auto_gain IS NOT NEW.auto_gain OR OLD.file_name IS NOT NEW.file_name OR OLD.track_no IS NOT NEW.track_no
    OR OLD.tags_v IS NOT NEW.tags_v OR (OLD.path IS NULL) IS NOT (NEW.path IS NULL)
  ) BEGIN
    INSERT INTO journal_pending (entity, key, op, old, new, at) VALUES ('track', NEW.id, 'update', json_object('title', OLD.title, 'artist', OLD.artist, 'album', OLD.album, 'year', OLD.year, 'trackNo', OLD.track_no,
      'duration', OLD.duration, 'size', OLD.size, 'format', OLD.format, 'fileName', OLD.file_name, 'hash', OLD.hash,
      'origHash', OLD.orig_hash, 'status', OLD.status, 'unlinked', OLD.unlinked, 'ov', OLD.ov, 'autoGain', OLD.auto_gain,
      'source', OLD.source, 'addedAt', OLD.added_at, 'tagsV', OLD.tags_v, 'hasFile', OLD.path IS NOT NULL), json_object('title', NEW.title, 'artist', NEW.artist, 'album', NEW.album, 'year', NEW.year, 'trackNo', NEW.track_no,
      'duration', NEW.duration, 'size', NEW.size, 'format', NEW.format, 'fileName', NEW.file_name, 'hash', NEW.hash,
      'origHash', NEW.orig_hash, 'status', NEW.status, 'unlinked', NEW.unlinked, 'ov', NEW.ov, 'autoGain', NEW.auto_gain,
      'source', NEW.source, 'addedAt', NEW.added_at, 'tagsV', NEW.tags_v, 'hasFile', NEW.path IS NOT NULL), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_tracks_del AFTER DELETE ON tracks WHEN OLD.replaced_by IS NULL BEGIN
    INSERT INTO journal_pending (entity, key, op, old, new, at) VALUES ('track', OLD.id, 'delete', json_object('title', OLD.title, 'artist', OLD.artist, 'album', OLD.album, 'year', OLD.year, 'trackNo', OLD.track_no,
      'duration', OLD.duration, 'size', OLD.size, 'format', OLD.format, 'fileName', OLD.file_name, 'hash', OLD.hash,
      'origHash', OLD.orig_hash, 'status', OLD.status, 'unlinked', OLD.unlinked, 'ov', OLD.ov, 'autoGain', OLD.auto_gain,
      'source', OLD.source, 'addedAt', OLD.added_at, 'tagsV', OLD.tags_v, 'hasFile', OLD.path IS NOT NULL), NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_likes_ins AFTER INSERT ON likes BEGIN
    INSERT INTO journal_pending (entity, key, op, old, new, at) VALUES ('like', NEW.track_id, 'insert', NULL, json_object('at', NEW.liked_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_likes_del AFTER DELETE ON likes BEGIN
    INSERT INTO journal_pending (entity, key, op, old, new, at) VALUES ('like', OLD.track_id, 'delete', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_playlists_ins AFTER INSERT ON playlists BEGIN
    INSERT INTO journal_pending (entity, key, op, old, new, at) VALUES ('playlist', NEW.id, 'insert', NULL, json_object('name', NEW.name, 'description', NEW.description, 'trackIds', NEW.track_ids, 'deleted', NEW.deleted, 'position', NEW.position), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_playlists_upd AFTER UPDATE ON playlists WHEN
    OLD.name IS NOT NEW.name OR OLD.description IS NOT NEW.description OR OLD.track_ids IS NOT NEW.track_ids
    OR OLD.deleted IS NOT NEW.deleted OR OLD.position IS NOT NEW.position
  BEGIN
    INSERT INTO journal_pending (entity, key, op, old, new, at) VALUES ('playlist', NEW.id, 'update', json_object('name', OLD.name, 'description', OLD.description, 'trackIds', OLD.track_ids, 'deleted', OLD.deleted, 'position', OLD.position), json_object('name', NEW.name, 'description', NEW.description, 'trackIds', NEW.track_ids, 'deleted', NEW.deleted, 'position', NEW.position), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_playlists_del AFTER DELETE ON playlists BEGIN
    INSERT INTO journal_pending (entity, key, op, old, new, at) VALUES ('playlist', OLD.id, 'delete', json_object('name', OLD.name, 'description', OLD.description, 'trackIds', OLD.track_ids, 'deleted', OLD.deleted, 'position', OLD.position), NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_covers_ins AFTER INSERT ON covers BEGIN
    INSERT INTO journal_pending (entity, key, op, old, new, at) VALUES ('cover', NEW.kind || ':' || NEW.key, 'insert', NULL, json_object('kind', NEW.kind, 'key', NEW.key, 'mime', NEW.mime, 'file', NEW.file, 'deleted', NEW.deleted), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_covers_upd AFTER UPDATE ON covers WHEN OLD.file IS NOT NEW.file OR OLD.deleted IS NOT NEW.deleted OR OLD.mime IS NOT NEW.mime BEGIN
    INSERT INTO journal_pending (entity, key, op, old, new, at) VALUES ('cover', NEW.kind || ':' || NEW.key, 'update', json_object('kind', OLD.kind, 'key', OLD.key, 'mime', OLD.mime, 'file', OLD.file, 'deleted', OLD.deleted), json_object('kind', NEW.kind, 'key', NEW.key, 'mime', NEW.mime, 'file', NEW.file, 'deleted', NEW.deleted), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_plays_ins AFTER INSERT ON plays BEGIN
    INSERT INTO journal_pending (entity, key, op, old, new, at) VALUES ('play', NEW.track_id, 'insert', NULL, json_object('at', NEW.played_at, 'source', NEW.source), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_trash_del AFTER DELETE ON trash BEGIN
    INSERT INTO journal_pending (entity, key, op, old, new, at) VALUES ('trash', OLD.track_id, 'delete', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  -- общие настройки библиотеки и снимки интеграций; пароль, токены, ключи сервисов — свои у узла, не пишем
  CREATE TRIGGER j_settings_ins AFTER INSERT ON settings WHEN (NEW.key IN ('prefs', 'dupIgnored') OR NEW.key GLOB 'integration:*:tracks') BEGIN
    INSERT INTO journal_pending (entity, key, op, old, new, at) VALUES ('setting', NEW.key, 'insert', NULL, NEW.value, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_settings_upd AFTER UPDATE ON settings WHEN (NEW.key IN ('prefs', 'dupIgnored') OR NEW.key GLOB 'integration:*:tracks') AND OLD.value IS NOT NEW.value BEGIN
    INSERT INTO journal_pending (entity, key, op, old, new, at) VALUES ('setting', NEW.key, 'update', OLD.value, NEW.value, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  `,
  // Постоянный номер устройства (у Android — свой у приложения, переживает переустановку):
  // по нему сервер узнаёт телефон, а не заводит новый после каждой установки или входа
  `
  ALTER TABLE devices ADD COLUMN hw_id TEXT;
  CREATE UNIQUE INDEX devices_hw ON devices (hw_id) WHERE hw_id IS NOT NULL;
  `,
  // Несколько пользователей (docs/USERS.md). Всё, что было, — владельцу: он создаётся с login = NULL (логин придумает
  // при первом входе), паролем и профилем из settings. Id треков владельца прежние. Таблицы, где ключ должен стать
  // своим у пользователя (обложки альбомов, отпечатки, журнал), пересобираются; триггеры журнала — заново, с user_id
  `
  CREATE TABLE users (
    id           TEXT PRIMARY KEY,
    login        TEXT COLLATE NOCASE UNIQUE,  -- NULL — владелец после обновления, логин ещё не придуман
    name         TEXT NOT NULL DEFAULT '',
    email        TEXT NOT NULL DEFAULT '',
    avatar       TEXT,
    password     TEXT,                        -- scrypt; NULL — пароль ещё не задан
    role         TEXT NOT NULL CHECK (role IN ('owner', 'user')),
    created_at   TEXT NOT NULL,
    last_seen_at TEXT
  );
  CREATE UNIQUE INDEX users_one_owner ON users (role) WHERE role = 'owner';

  INSERT INTO users (id, login, name, email, avatar, password, role, created_at)
  SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-'
      || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
    NULL,
    COALESCE((SELECT CAST(json_extract(value, '$.name') AS TEXT) FROM settings WHERE key = 'profile' AND json_valid(value)), ''),
    COALESCE((SELECT CAST(json_extract(value, '$.email') AS TEXT) FROM settings WHERE key = 'profile' AND json_valid(value)), ''),
    (SELECT CAST(json_extract(value, '$.avatar') AS TEXT) FROM settings WHERE key = 'profile' AND json_valid(value)),
    (SELECT value FROM settings WHERE key = 'password'),
    'owner',
    COALESCE((SELECT MIN(created_at) FROM tokens), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  WHERE EXISTS (SELECT 1 FROM settings WHERE key IN ('password', 'profile', 'prefs', 'dupIgnored') OR key GLOB 'integration:*')
    OR EXISTS (SELECT 1 FROM tracks) OR EXISTS (SELECT 1 FROM playlists) OR EXISTS (SELECT 1 FROM covers)
    OR EXISTS (SELECT 1 FROM plays) OR EXISTS (SELECT 1 FROM devices) OR EXISTS (SELECT 1 FROM tokens)
    OR EXISTS (SELECT 1 FROM events) OR EXISTS (SELECT 1 FROM trash) OR EXISTS (SELECT 1 FROM conflicts);

  -- старые триггеры журнала — без user_id; новые ставятся в конце, когда данные уже перенесены
  DROP TRIGGER j_tracks_ins;
  DROP TRIGGER j_tracks_upd;
  DROP TRIGGER j_tracks_del;
  DROP TRIGGER j_likes_ins;
  DROP TRIGGER j_likes_del;
  DROP TRIGGER j_playlists_ins;
  DROP TRIGGER j_playlists_upd;
  DROP TRIGGER j_playlists_del;
  DROP TRIGGER j_covers_ins;
  DROP TRIGGER j_covers_upd;
  DROP TRIGGER j_plays_ins;
  DROP TRIGGER j_trash_del;
  DROP TRIGGER j_settings_ins;
  DROP TRIGGER j_settings_upd;

  ALTER TABLE tracks ADD COLUMN user_id TEXT;
  ALTER TABLE likes ADD COLUMN user_id TEXT;
  ALTER TABLE playlists ADD COLUMN user_id TEXT;
  ALTER TABLE plays ADD COLUMN user_id TEXT;
  ALTER TABLE trash ADD COLUMN user_id TEXT;
  ALTER TABLE conflicts ADD COLUMN user_id TEXT;
  ALTER TABLE devices ADD COLUMN user_id TEXT;
  ALTER TABLE folders ADD COLUMN user_id TEXT;
  ALTER TABLE tokens ADD COLUMN user_id TEXT;
  ALTER TABLE journal_pending ADD COLUMN user_id TEXT;
  UPDATE tracks SET user_id = (SELECT id FROM users WHERE role = 'owner');
  UPDATE likes SET user_id = (SELECT id FROM users WHERE role = 'owner');
  UPDATE playlists SET user_id = (SELECT id FROM users WHERE role = 'owner');
  UPDATE plays SET user_id = (SELECT id FROM users WHERE role = 'owner');
  UPDATE trash SET user_id = (SELECT id FROM users WHERE role = 'owner');
  UPDATE conflicts SET user_id = (SELECT id FROM users WHERE role = 'owner');
  UPDATE devices SET user_id = (SELECT id FROM users WHERE role = 'owner');
  UPDATE folders SET user_id = (SELECT id FROM users WHERE role = 'owner');
  UPDATE tokens SET user_id = (SELECT id FROM users WHERE role = 'owner');
  UPDATE journal_pending SET user_id = (SELECT id FROM users WHERE role = 'owner');
  CREATE INDEX tracks_user ON tracks (user_id, status);
  CREATE INDEX likes_user ON likes (user_id);
  CREATE INDEX playlists_user ON playlists (user_id);
  CREATE INDEX plays_user ON plays (user_id, played_at);
  CREATE INDEX tokens_user ON tokens (user_id);
  -- один телефон под двумя аккаунтами (вышли и вошли другим) — две записи устройства
  DROP INDEX devices_hw;
  CREATE UNIQUE INDEX devices_hw ON devices (user_id, hw_id) WHERE hw_id IS NOT NULL;

  -- обложки: у двух пользователей может быть альбом с одним названием
  CREATE TABLE covers_new (
    user_id    TEXT NOT NULL,
    kind       TEXT NOT NULL,
    key        TEXT NOT NULL,
    mime       TEXT,
    file       TEXT,
    updated_at TEXT NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    seq        INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, key)
  );
  INSERT INTO covers_new (user_id, kind, key, mime, file, updated_at, deleted, seq)
    SELECT (SELECT id FROM users WHERE role = 'owner'), kind, key, mime, file, updated_at, deleted, seq FROM covers;
  DROP TABLE covers;
  ALTER TABLE covers_new RENAME TO covers;
  CREATE INDEX covers_seq ON covers (seq);

  -- отпечатки: один и тот же файл у двух пользователей — два разных трека
  CREATE TABLE hashes_new (
    user_id  TEXT NOT NULL,
    hash     TEXT NOT NULL,
    track_id TEXT NOT NULL,
    seen_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, hash)
  );
  INSERT INTO hashes_new (user_id, hash, track_id, seen_at)
    SELECT (SELECT id FROM users WHERE role = 'owner'), hash, track_id, seen_at FROM hashes;
  DROP TABLE hashes;
  ALTER TABLE hashes_new RENAME TO hashes;
  CREATE INDEX hashes_track ON hashes (track_id);

  -- журнал у каждого свой: номера узла идут без пропусков внутри журнала пользователя
  CREATE TABLE events_new (
    user_id TEXT NOT NULL,
    id      TEXT NOT NULL,
    node    TEXT NOT NULL,
    n       INTEGER NOT NULL,
    hlc     TEXT NOT NULL,
    type    TEXT NOT NULL,
    key     TEXT NOT NULL,
    field   TEXT NOT NULL DEFAULT '',
    value   TEXT,
    base    TEXT,
    PRIMARY KEY (user_id, id),
    UNIQUE (user_id, node, n)
  );
  INSERT INTO events_new (user_id, id, node, n, hlc, type, key, field, value, base)
    SELECT (SELECT id FROM users WHERE role = 'owner'), id, node, n, hlc, type, key, field, value, base FROM events;
  DROP TABLE events;
  ALTER TABLE events_new RENAME TO events;
  CREATE INDEX events_key ON events (user_id, key, field, hlc);
  CREATE INDEX events_hlc ON events (hlc);

  -- настройки библиотеки, «это не дубли» и интеграции — свои у каждого
  CREATE TABLE user_settings (
    user_id TEXT NOT NULL,
    key     TEXT NOT NULL,
    value   TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  INSERT INTO user_settings (user_id, key, value)
    SELECT (SELECT id FROM users WHERE role = 'owner'), key, value FROM settings
    WHERE (key IN ('prefs', 'dupIgnored') OR key GLOB 'integration:*') AND EXISTS (SELECT 1 FROM users WHERE role = 'owner');
  DELETE FROM settings WHERE (key IN ('prefs', 'dupIgnored', 'password', 'profile') OR key GLOB 'integration:*')
    AND EXISTS (SELECT 1 FROM users WHERE role = 'owner');

  CREATE TRIGGER j_tracks_ins AFTER INSERT ON tracks WHEN NEW.replaced_by IS NULL BEGIN
    INSERT INTO journal_pending (user_id, entity, key, op, old, new, at) VALUES (NEW.user_id, 'track', NEW.id, 'insert', NULL, json_object('title', NEW.title, 'artist', NEW.artist, 'album', NEW.album, 'year', NEW.year, 'trackNo', NEW.track_no,
      'duration', NEW.duration, 'size', NEW.size, 'format', NEW.format, 'fileName', NEW.file_name, 'hash', NEW.hash,
      'origHash', NEW.orig_hash, 'status', NEW.status, 'unlinked', NEW.unlinked, 'ov', NEW.ov, 'autoGain', NEW.auto_gain,
      'source', NEW.source, 'addedAt', NEW.added_at, 'tagsV', NEW.tags_v, 'hasFile', NEW.path IS NOT NULL), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_tracks_upd AFTER UPDATE ON tracks WHEN NEW.replaced_by IS NULL AND (
    OLD.hash IS NOT NEW.hash OR OLD.ov IS NOT NEW.ov OR OLD.status IS NOT NEW.status OR OLD.unlinked IS NOT NEW.unlinked
    OR OLD.auto_gain IS NOT NEW.auto_gain OR OLD.file_name IS NOT NEW.file_name OR OLD.track_no IS NOT NEW.track_no
    OR OLD.tags_v IS NOT NEW.tags_v OR (OLD.path IS NULL) IS NOT (NEW.path IS NULL)
  ) BEGIN
    INSERT INTO journal_pending (user_id, entity, key, op, old, new, at) VALUES (NEW.user_id, 'track', NEW.id, 'update', json_object('title', OLD.title, 'artist', OLD.artist, 'album', OLD.album, 'year', OLD.year, 'trackNo', OLD.track_no,
      'duration', OLD.duration, 'size', OLD.size, 'format', OLD.format, 'fileName', OLD.file_name, 'hash', OLD.hash,
      'origHash', OLD.orig_hash, 'status', OLD.status, 'unlinked', OLD.unlinked, 'ov', OLD.ov, 'autoGain', OLD.auto_gain,
      'source', OLD.source, 'addedAt', OLD.added_at, 'tagsV', OLD.tags_v, 'hasFile', OLD.path IS NOT NULL), json_object('title', NEW.title, 'artist', NEW.artist, 'album', NEW.album, 'year', NEW.year, 'trackNo', NEW.track_no,
      'duration', NEW.duration, 'size', NEW.size, 'format', NEW.format, 'fileName', NEW.file_name, 'hash', NEW.hash,
      'origHash', NEW.orig_hash, 'status', NEW.status, 'unlinked', NEW.unlinked, 'ov', NEW.ov, 'autoGain', NEW.auto_gain,
      'source', NEW.source, 'addedAt', NEW.added_at, 'tagsV', NEW.tags_v, 'hasFile', NEW.path IS NOT NULL), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_tracks_del AFTER DELETE ON tracks WHEN OLD.replaced_by IS NULL BEGIN
    INSERT INTO journal_pending (user_id, entity, key, op, old, new, at) VALUES (OLD.user_id, 'track', OLD.id, 'delete', json_object('title', OLD.title, 'artist', OLD.artist, 'album', OLD.album, 'year', OLD.year, 'trackNo', OLD.track_no,
      'duration', OLD.duration, 'size', OLD.size, 'format', OLD.format, 'fileName', OLD.file_name, 'hash', OLD.hash,
      'origHash', OLD.orig_hash, 'status', OLD.status, 'unlinked', OLD.unlinked, 'ov', OLD.ov, 'autoGain', OLD.auto_gain,
      'source', OLD.source, 'addedAt', OLD.added_at, 'tagsV', OLD.tags_v, 'hasFile', OLD.path IS NOT NULL), NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_likes_ins AFTER INSERT ON likes BEGIN
    INSERT INTO journal_pending (user_id, entity, key, op, old, new, at) VALUES (NEW.user_id, 'like', NEW.track_id, 'insert', NULL, json_object('at', NEW.liked_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_likes_del AFTER DELETE ON likes BEGIN
    INSERT INTO journal_pending (user_id, entity, key, op, old, new, at) VALUES (OLD.user_id, 'like', OLD.track_id, 'delete', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_playlists_ins AFTER INSERT ON playlists BEGIN
    INSERT INTO journal_pending (user_id, entity, key, op, old, new, at) VALUES (NEW.user_id, 'playlist', NEW.id, 'insert', NULL, json_object('name', NEW.name, 'description', NEW.description, 'trackIds', NEW.track_ids, 'deleted', NEW.deleted, 'position', NEW.position), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_playlists_upd AFTER UPDATE ON playlists WHEN
    OLD.name IS NOT NEW.name OR OLD.description IS NOT NEW.description OR OLD.track_ids IS NOT NEW.track_ids
    OR OLD.deleted IS NOT NEW.deleted OR OLD.position IS NOT NEW.position
  BEGIN
    INSERT INTO journal_pending (user_id, entity, key, op, old, new, at) VALUES (NEW.user_id, 'playlist', NEW.id, 'update', json_object('name', OLD.name, 'description', OLD.description, 'trackIds', OLD.track_ids, 'deleted', OLD.deleted, 'position', OLD.position), json_object('name', NEW.name, 'description', NEW.description, 'trackIds', NEW.track_ids, 'deleted', NEW.deleted, 'position', NEW.position), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_playlists_del AFTER DELETE ON playlists BEGIN
    INSERT INTO journal_pending (user_id, entity, key, op, old, new, at) VALUES (OLD.user_id, 'playlist', OLD.id, 'delete', json_object('name', OLD.name, 'description', OLD.description, 'trackIds', OLD.track_ids, 'deleted', OLD.deleted, 'position', OLD.position), NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_covers_ins AFTER INSERT ON covers BEGIN
    INSERT INTO journal_pending (user_id, entity, key, op, old, new, at) VALUES (NEW.user_id, 'cover', NEW.kind || ':' || NEW.key, 'insert', NULL, json_object('kind', NEW.kind, 'key', NEW.key, 'mime', NEW.mime, 'file', NEW.file, 'deleted', NEW.deleted), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_covers_upd AFTER UPDATE ON covers WHEN OLD.file IS NOT NEW.file OR OLD.deleted IS NOT NEW.deleted OR OLD.mime IS NOT NEW.mime BEGIN
    INSERT INTO journal_pending (user_id, entity, key, op, old, new, at) VALUES (NEW.user_id, 'cover', NEW.kind || ':' || NEW.key, 'update', json_object('kind', OLD.kind, 'key', OLD.key, 'mime', OLD.mime, 'file', OLD.file, 'deleted', OLD.deleted), json_object('kind', NEW.kind, 'key', NEW.key, 'mime', NEW.mime, 'file', NEW.file, 'deleted', NEW.deleted), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_plays_ins AFTER INSERT ON plays BEGIN
    INSERT INTO journal_pending (user_id, entity, key, op, old, new, at) VALUES (NEW.user_id, 'play', NEW.track_id, 'insert', NULL, json_object('at', NEW.played_at, 'source', NEW.source), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_trash_del AFTER DELETE ON trash BEGIN
    INSERT INTO journal_pending (user_id, entity, key, op, old, new, at) VALUES (OLD.user_id, 'trash', OLD.track_id, 'delete', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_usettings_ins AFTER INSERT ON user_settings WHEN (NEW.key IN ('prefs', 'dupIgnored') OR NEW.key GLOB 'integration:*:tracks') BEGIN
    INSERT INTO journal_pending (user_id, entity, key, op, old, new, at) VALUES (NEW.user_id, 'setting', NEW.key, 'insert', NULL, NEW.value, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_usettings_upd AFTER UPDATE ON user_settings WHEN (NEW.key IN ('prefs', 'dupIgnored') OR NEW.key GLOB 'integration:*:tracks') AND OLD.value IS NOT NEW.value BEGIN
    INSERT INTO journal_pending (user_id, entity, key, op, old, new, at) VALUES (NEW.user_id, 'setting', NEW.key, 'update', OLD.value, NEW.value, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  `,
  // Администраторы: управляют сервером, как владелец (пользователи, папки, скан, бэкап, просмотр библиотек).
  // В CHECK роли нет 'admin' — пересобираем таблицу. И запоминаем, у кого id треков = отпечаток файла (у первого
  // владельца): после передачи владения это не должно переехать к новому — иначе id его новых треков совпали бы со старыми
  `
  CREATE TABLE users_new (
    id           TEXT PRIMARY KEY,
    login        TEXT COLLATE NOCASE UNIQUE,
    name         TEXT NOT NULL DEFAULT '',
    email        TEXT NOT NULL DEFAULT '',
    avatar       TEXT,
    password     TEXT,
    role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'user')),
    created_at   TEXT NOT NULL,
    last_seen_at TEXT
  );
  INSERT INTO users_new (id, login, name, email, avatar, password, role, created_at, last_seen_at)
    SELECT id, login, name, email, avatar, password, role, created_at, last_seen_at FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;
  CREATE UNIQUE INDEX users_one_owner ON users (role) WHERE role = 'owner';
  INSERT OR IGNORE INTO settings (key, value) SELECT 'plainIdUser', id FROM users WHERE role = 'owner';
  `,
  // 21: общие плейлисты — хозяин делится своим плейлистом с другими пользователями сервера (server/src/shares.ts)
  `
  CREATE TABLE playlist_shares (
    playlist_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (playlist_id, user_id)
  );
  CREATE INDEX playlist_shares_user ON playlist_shares (user_id);
  `,
  // 22: снимки интеграций (списки VK/Яндекса — мегабайты) больше не пишем в журнал: телефоны берут их у сервера по API,
  // а в журнале они копились навсегда и уходили на каждое устройство. Старые события оставляем (номера узла не рвём),
  // но без содержимого
  `
  DROP TRIGGER IF EXISTS j_usettings_ins;
  DROP TRIGGER IF EXISTS j_usettings_upd;
  CREATE TRIGGER j_usettings_ins AFTER INSERT ON user_settings WHEN NEW.key IN ('prefs', 'dupIgnored') BEGIN
    INSERT INTO journal_pending (user_id, entity, key, op, old, new, at) VALUES (NEW.user_id, 'setting', NEW.key, 'insert', NULL, NEW.value, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  CREATE TRIGGER j_usettings_upd AFTER UPDATE ON user_settings WHEN NEW.key IN ('prefs', 'dupIgnored') AND OLD.value IS NOT NEW.value BEGIN
    INSERT INTO journal_pending (user_id, entity, key, op, old, new, at) VALUES (NEW.user_id, 'setting', NEW.key, 'update', OLD.value, NEW.value, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  END;
  UPDATE events SET value = NULL WHERE type = 'integration.snapshot';
  `,
  // 23: индексы под частые запросы — файл по отпечатку (/sync/file), обложка альбома, следующий номер трека
  `
  CREATE INDEX IF NOT EXISTS tracks_user_hash ON tracks (user_id, hash);
  CREATE INDEX IF NOT EXISTS tracks_user_album ON tracks (user_id, album);
  CREATE INDEX IF NOT EXISTS tracks_user_number ON tracks (user_id, status, track_no);
  `,
  // 24: «Экосистема» на странице сервера — что устройство сообщает о себе при отметке (JSON, library.ts DeviceInfo)
  `
  ALTER TABLE devices ADD COLUMN info TEXT;
  `,
]

export function getSetting(db: Db, key: string): string | undefined {
  return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value
}

export function setSetting(db: Db, key: string, value: string) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
}

/** Своя настройка пользователя (настройки библиотеки, интеграции, «это не дубли») */
export function getUserSetting(db: Db, userId: string, key: string): string | undefined {
  return (db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key) as { value: string } | undefined)?.value
}

export function setUserSetting(db: Db, userId: string, key: string, value: string) {
  db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value').run(userId, key, value)
}

export type Db = DatabaseSync

// upTo — до какой версии довести схему (тест миграции собирает базу «как раньше»); по умолчанию — до последней
export function openDb(file: string, upTo = MIGRATIONS.length): Db {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  migrate(db, upTo)
  return db
}

export const SCHEMA_VERSION = MIGRATIONS.length

function migrate(db: Db, upTo: number) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = current; v < Math.min(upTo, MIGRATIONS.length); v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
    })
  }
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

// Глобальный монотонный счётчик изменений. Звать внутри транзакции вместе с самим изменением.
export function nextSeq(db: Db): number {
  const row = db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'seq' RETURNING value").get() as { value: number }
  return row.value
}

export function currentSeq(db: Db): number {
  return (db.prepare("SELECT value FROM counters WHERE name = 'seq'").get() as { value: number }).value
}
