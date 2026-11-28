import type { Lang } from '../i18n'
import type { Page } from './about'

// «Конфиденциальность» и «Лицензия» в подвале. Есть русский и английский; остальные языки показывают английский.
// Копия политики для Google Play и GitHub — PRIVACY.md в корне репозитория: меняешь здесь — поменяй и там (и дату)

const REPO = 'https://github.com/rozev-and/Musich'
const TELEGRAM = 'https://t.me/andropov_ai'

export const privacy: Partial<Record<Lang, Page>> = {
  ru: {
    title: 'Конфиденциальность',
    sections: [
      {
        title: 'Коротко',
        paragraphs: [
          'MUSICH не собирает данные о тебе: нет аналитики, рекламы и трекеров. Автор MUSICH не получает ни твою музыку, ни твои данные — у него нет к ним доступа.',
          'Политика действует с 28 ноября 2026 года для сервера MUSICH, приложений для Android и ПК и веб-интерфейса.',
        ],
      },
      {
        title: 'Кто отвечает за данные',
        paragraphs: [
          'MUSICH — программа, которую каждый ставит себе сам. Твои данные хранит владелец сервера MUSICH: ты сам или тот, кто тебя пригласил. Автор программы не держит серверов для пользователей и данные не обрабатывает.',
        ],
      },
      {
        title: 'Какие данные и где лежат',
        paragraphs: [
          'На сервере: аккаунт (логин, имя, фото, пароль — только в виде хэша), музыка и обложки, лайки, плейлисты, история прослушиваний, настройки и список твоих устройств (название, модель, когда были на связи).',
          'На телефоне и ПК: своя копия библиотеки и скачанные треки, чтобы слушать без сети. Без сервера всё хранится только на устройстве.',
        ],
      },
      {
        title: 'Что видит владелец сервера',
        paragraphs: [
          'Если сервером пользуются несколько человек, владелец и администраторы видят список пользователей и сколько места занимает библиотека каждого, могут сбросить пароль, удалить аккаунт и открыть чужую библиотеку только для просмотра.',
          'Общий плейлист видят только те, с кем им поделились.',
        ],
      },
      {
        title: 'Что уходит за пределы сервера',
        paragraphs: [
          'Только то, что ты включил сам:',
          '• Интеграции (Spotify, YouTube Music, VK и другие) — сервер от твоего имени забирает списки треков. Ключи и токены хранятся на твоём сервере.',
          '• Telegram — сервер входит в твой аккаунт как ещё одно устройство и хранит этот вход у себя. Он нужен только чтобы забрать музыку из профиля; «Отключить» завершает его и в Telegram.',
          '• Скробблинг (Last.fm, ListenBrainz) — сервер отправляет туда, что и когда ты слушал.',
          '• Картинка по ссылке загружается с сайта, который ты указал.',
          '• Раз в сутки сервер спрашивает у GitHub номер последней версии MUSICH. О тебе и сервере ничего не передаётся; проверку можно выключить.',
          '• «Поддержать» открывает страницу доната в браузере. MUSICH туда ничего не передаёт.',
          'Что эти сервисы делают с данными — в их собственных правилах.',
        ],
      },
      {
        title: 'Разрешения на Android',
        paragraphs: [
          '• Интернет и состояние сети — связь с сервером и «качать только по Wi‑Fi».',
          '• Поиск в сети Wi‑Fi — найти сервер дома без ввода адреса.',
          '• Доступ к аудио и памяти — только если ты сам выберешь хранить музыку в общей или своей папке.',
          '• Воспроизведение в фоне — чтобы музыка играла с выключенным экраном.',
          'Камеру, микрофон, контакты и местоположение MUSICH не запрашивает.',
        ],
      },
      {
        title: 'Удаление',
        paragraphs: [
          'Аккаунт и его данные на сервере удаляет владелец сервера. Интеграции и Telegram отключаются кнопкой «Отключить». Удалишь приложение с устройства — оно забудет всё, кроме музыки в общей или своей папке, если ты выбрал её не трогать.',
        ],
      },
      {
        title: 'Дети',
        paragraphs: ['MUSICH не рассчитан специально на детей и не собирает данных ни о ком, в том числе о детях.'],
      },
      {
        title: 'Изменения и связь',
        paragraphs: ['Если политика изменится, новая версия с новой датой появится здесь и в репозитории (PRIVACY.md). Вопросы — автору в Telegram.'],
        links: [
          { label: 'Telegram', url: TELEGRAM },
          { label: 'PRIVACY.md', url: `${REPO}/blob/main/PRIVACY.md` },
        ],
      },
    ],
  },
  en: {
    title: 'Privacy',
    sections: [
      {
        title: 'In short',
        paragraphs: [
          'MUSICH collects nothing about you: no analytics, ads or trackers. The author of MUSICH gets neither your music nor your data and has no access to them.',
          'This policy applies from 28 November 2026 to the MUSICH server, the Android and PC apps and the web interface.',
        ],
      },
      {
        title: 'Who is responsible for the data',
        paragraphs: [
          'MUSICH is software that everyone installs for themselves. Your data is kept by the owner of the MUSICH server: you, or whoever invited you. The author runs no servers for users and does not process their data.',
        ],
      },
      {
        title: 'What data and where',
        paragraphs: [
          'On the server: your account (login, name, photo, password — only as a hash), music and covers, likes, playlists, listening history, settings and the list of your devices (name, model, when they were last online).',
          'On the phone and PC: their own copy of the library and downloaded tracks, to listen offline. Without a server everything stays on the device only.',
        ],
      },
      {
        title: 'What the server owner sees',
        paragraphs: [
          'If several people use one server, the owner and admins see the list of users and how much space each library takes, can reset a password, delete an account and open someone’s library read-only.',
          'A shared playlist is visible only to the people it was shared with.',
        ],
      },
      {
        title: 'What leaves the server',
        paragraphs: [
          'Only what you turn on yourself:',
          '• Integrations (Spotify, YouTube Music, VK and others) — the server fetches your track lists on your behalf. Keys and tokens are stored on your server.',
          '• Telegram — the server signs in to your account as one more device and keeps that session. It is used only to fetch the music from your profile; “Disconnect” ends it in Telegram too.',
          '• Scrobbling (Last.fm, ListenBrainz) — the server sends what you listened to and when.',
          '• A picture from a link is loaded from the site you entered.',
          '• Once a day the server asks GitHub for the latest MUSICH version number. Nothing about you or the server is sent; you can turn this off.',
          '• “Support” opens a donation page in your browser. MUSICH sends nothing there.',
          'What those services do with data is covered by their own policies.',
        ],
      },
      {
        title: 'Android permissions',
        paragraphs: [
          '• Internet and network state — to reach the server and for “download over Wi‑Fi only”.',
          '• Wi‑Fi network discovery — to find the server at home without typing an address.',
          '• Audio and storage access — only if you choose to keep music in the shared or your own folder.',
          '• Background playback — so music keeps playing with the screen off.',
          'MUSICH does not ask for the camera, microphone, contacts or location.',
        ],
      },
      {
        title: 'Deleting',
        paragraphs: [
          'The server owner deletes an account and its data on the server. Integrations and Telegram are turned off with “Disconnect”. Uninstall the app from a device and it forgets everything except the music in the shared or your own folder, if you chose to keep it.',
        ],
      },
      {
        title: 'Children',
        paragraphs: ['MUSICH is not made specifically for children and collects no data about anyone, children included.'],
      },
      {
        title: 'Changes and contact',
        paragraphs: ['If this policy changes, the new version with a new date will appear here and in the repository (PRIVACY.md). Questions — message the author on Telegram.'],
        links: [
          { label: 'Telegram', url: TELEGRAM },
          { label: 'PRIVACY.md', url: `${REPO}/blob/main/PRIVACY.md` },
        ],
      },
    ],
  },
}

export const license: Partial<Record<Lang, Page>> = {
  ru: {
    title: 'Лицензия',
    sections: [
      {
        title: 'MUSICH',
        paragraphs: [
          'Код MUSICH открыт под лицензией PolyForm Noncommercial 1.0.0.',
          '• Можно: пользоваться, изучать и менять код, собирать и раздавать бесплатно — для себя, друзей и некоммерческих организаций.',
          '• Нельзя: продавать MUSICH или изменённые версии, брать деньги за доступ к нему и использовать его в коммерческих целях без разрешения автора.',
          '• Нужно: сохранять имя автора и текст лицензии.',
          'Официальные сборки — в Google Play и в релизах на GitHub — подписывает только автор.',
        ],
        links: [
          { label: 'LICENSE', url: `${REPO}/blob/main/LICENSE` },
          { label: 'GitHub', url: REPO },
        ],
      },
      {
        title: 'Открытые библиотеки',
        paragraphs: [
          'MUSICH построен на чужом открытом коде — спасибо авторам:',
          '• React, Zustand, Fastify, Capacitor, mtcute, music-metadata, multicast-dns, yazl, uqr — MIT',
          '• Tauri — MIT или Apache-2.0',
          '• sharp — Apache-2.0, внутри libvips — LGPL-3.0',
          '• node-taglib-sharp — LGPL-2.1',
          '• capacitor-share-target — MPL-2.0',
          '• FFmpeg в образе Docker — LGPL/GPL',
          '• Значки Lucide — ISC',
          '• Шрифты Inter, Doto, JetBrains Mono, IBM Plex Mono, Roboto, Rubik, Manrope, Montserrat, Nunito, Comfortaa, Golos Text, Unbounded, Press Start 2P — SIL Open Font License 1.1',
          'Полные тексты лицензий лежат в самих пакетах.',
        ],
      },
      {
        title: 'Названия сервисов',
        paragraphs: [
          'Названия музыкальных сервисов в интеграциях и темах принадлежат их владельцам. MUSICH с ними не связан и ими не одобрен; значки и цвета нарисованы заново.',
        ],
      },
    ],
  },
  en: {
    title: 'License',
    sections: [
      {
        title: 'MUSICH',
        paragraphs: [
          'MUSICH’s code is open under the PolyForm Noncommercial License 1.0.0.',
          '• You may: use it, study and change the code, build and share it for free — for yourself, friends and non-profit organisations.',
          '• You may not: sell MUSICH or modified versions, charge for access to it or use it commercially without the author’s permission.',
          '• You must: keep the author’s name and the license text.',
          'Official builds — on Google Play and in GitHub releases — are signed only by the author.',
        ],
        links: [
          { label: 'LICENSE', url: `${REPO}/blob/main/LICENSE` },
          { label: 'GitHub', url: REPO },
        ],
      },
      {
        title: 'Open-source libraries',
        paragraphs: [
          'MUSICH is built on other people’s open code — thanks to their authors:',
          '• React, Zustand, Fastify, Capacitor, mtcute, music-metadata, multicast-dns, yazl, uqr — MIT',
          '• Tauri — MIT or Apache-2.0',
          '• sharp — Apache-2.0, with libvips inside — LGPL-3.0',
          '• node-taglib-sharp — LGPL-2.1',
          '• capacitor-share-target — MPL-2.0',
          '• FFmpeg in the Docker image — LGPL/GPL',
          '• Lucide icons — ISC',
          '• Fonts Inter, Doto, JetBrains Mono, IBM Plex Mono, Roboto, Rubik, Manrope, Montserrat, Nunito, Comfortaa, Golos Text, Unbounded, Press Start 2P — SIL Open Font License 1.1',
          'The full license texts ship with the packages themselves.',
        ],
      },
      {
        title: 'Service names',
        paragraphs: [
          'Names of music services in integrations and themes belong to their owners. MUSICH is not affiliated with or endorsed by them; icons and colours are drawn from scratch.',
        ],
      },
    ],
  },
}
