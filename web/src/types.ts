// Где физически лежит трек
export type TrackStatus =
  | 'synced'      // есть и на устройстве, и в хранилище
  | 'cloud'       // только в хранилище, на устройство не скачан
  | 'uploading'   // лежит в папке синхронизации, заливается на сервер
  | 'downloading' // качается с сервера на устройство

export interface Track {
  id: string
  title: string
  artist: string
  album: string
  year?: number
  trackNo?: number // номер трека из тегов («№» в проводнике)
  duration: number // секунды
  gain?: number // ReplayGain из тегов (дБ) — выравнивание громкости
  albumGain?: number
  peak?: number
  sizeMb: number
  status: TrackStatus
  progress?: number // 0..100 для uploading / downloading
  liked?: boolean
  likedAt?: number // когда лайкнули — порядок в «Избранном», свежие сверху
  addedAt: string
  from?: string  // кто прислал трек на сервер: устройство или вход из браузера
  file?: string  // исходное имя файла
  edited?: boolean // название/исполнитель/альбом/год исправлены только в MUSICH, в файле — по-старому
  hash?: string // отпечаток файла: другой — значит, файл прошили и его надо брать заново
  autoGain?: number // громкость, которую измерил сам MUSICH (у трека нет ReplayGain)
  fileChanged?: boolean // файл прошит: уже не тот, с которым трек пришёл
  fileChanges?: ('tags' | 'number' | 'cover')[] // что именно: теги, номер, обложка
  cover?: string // url картинки трека на сервере
}

export interface Device {
  id: string
  name: string
  kind: 'desktop' | 'laptop' | 'phone'
  current?: boolean
  online: boolean    // отмечалось на сервере последние пару минут
  lastSeenAt: number // timestamp
  pendingUp: number   // ждёт отправки на сервер
  pendingDown: number // ждёт скачивания на устройство
  syncedAt?: number   // когда синхронизация последний раз прошла до конца
}

// Хост: папка, которую сервер сканирует. Путь — как его видит сервер (внутри контейнера)
export interface MusicFolder {
  path: string
  tracks: number
  uploads: boolean   // сюда кладутся новые треки, присланные с устройств. Такая папка ровно одна
  scanning?: boolean
  scanDone?: number  // пока идёт скан: сколько файлов пройдено из scanTotal
  scanTotal?: number
  userId?: string    // чья папка: треки из неё — в библиотеке этого пользователя (у владельца приходят все)
}

// Свой «альбом»: просто список треков. Файлы не копируются, синхронизируется только список
export interface Playlist {
  id: string
  name: string
  description: string
  trackIds: string[]
  keepOffline: boolean // держать все треки плейлиста на этом устройстве
  coverUrl?: string
  updatedAt: string
  position?: number // порядок в списке плейлистов
  system?: boolean // «Избранное»: собирается из лайков, его нельзя удалить или переименовать
  smart?: boolean // умный: собирается сам по правилу (новое, любимое за год, давно не слушал) — без правки и удаления треков
}

export type View = 'home' | 'library' | 'albums' | 'artists' | 'history' | 'playlist' | 'remote' | 'sync' | 'integrations' | 'settings' | 'account'

export interface Account {
  login?: string // логин входа: только читается, у владельца после обновления может ещё не быть
  name: string
  email: string
  avatar?: string // data:-url, ужатый до квадрата; нет — в аватарке первая буква имени
}

export type AlbumsTab = 'albums' | 'mine'

export type PlaylistEditor = { mode: 'create'; addIds: string[]; name?: string } | { mode: 'edit'; id: string } | null

export type Filter = 'all' | 'liked' | 'device' | 'cloud' | 'syncing'

// Порядок треков в библиотеке: по какому полю и в какую сторону
export type SortKey = 'number' | 'added' | 'title' | 'artist' | 'album' | 'duration' | 'size'
export type Sort = { key: SortKey; desc: boolean }

export type Scope = { type: 'album' | 'artist'; value: string } | null

export type Theme = 'light' | 'dark'
