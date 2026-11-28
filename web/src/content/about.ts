import type { Lang } from '../i18n'
import { license, privacy } from './legal'

// Тексты для подвала: «Об авторе» (вместе с манифестом); «Конфиденциальность» и «Лицензия» — в legal.ts.
// Есть русский и английский; остальные языки показывают английский.

export interface Section {
  title: string
  paragraphs: string[]
  video?: string // зацикленное видео без звука, как гифка (из web/public)
  links?: { label: string; url: string }[] // кнопки-ссылки под текстом
}

export interface Page {
  title: string
  // шапка автора: квадратное фото (пока файла нет — заглушка), имя и ссылки
  author?: { photo: string; name: string; links: { label: string; url: string }[] }
  sections: Section[]
  sign?: string
}

// фото автора: положи квадратную картинку в web/public/media/author.jpg — подхватится само
const AUTHOR = {
  photo: '/media/author.jpg',
  name: 'rozev',
  links: [
    { label: 'GitHub', url: 'https://github.com/rozev-and' },
    { label: 'MUSICH', url: 'https://github.com/rozev-and/Musich' },
    { label: 'Telegram', url: 'https://t.me/andropov_ai' },
  ],
}

// исходный код MUSICH
export const REPO = 'https://github.com/rozev-and/Musich'

// «Поддержать MUSICH» — впиши адреса своих страниц. Пустой адрес — кнопки нет; все пустые — нет и пункта в подвале.
// В сборке для Google Play (VITE_STORE=play) пункта нет: приложение там уже куплено, а чужие ссылки на оплату Play не пропускает
export const SUPPORT: { label: string; url: string }[] = [
  { label: 'Boosty', url: 'https://boosty.to/andropov_ai' },
  { label: 'CloudTips', url: '' },
].filter((l) => l.url && import.meta.env.VITE_STORE !== 'play')

const about: Partial<Record<Lang, Page>> = {
  ru: {
    title: 'Об авторе',
    author: AUTHOR,
    sections: [
      {
        title: 'Что это',
        paragraphs: [
          'MUSICH — самописный сервис для своей музыки. Как Immich, только для треков: файлы лежат на твоих устройствах, общий архив — на твоём сервере, а синхронизация между ними работает сама.',
          'Делаю его для себя: хотелось, чтобы музыка жила у меня, а не в чужой подписке, и чтобы интерфейс выглядел как Nothing. Идеи, баги, пожелания — пиши в Telegram.',
        ],
      },
      {
        title: 'Манифест',
        paragraphs: [
          'Я не компания и не стартап, а просто энтузиаст. Я не согласен с политикой бигтехов и выступаю против законов о пропаганде.',
          'Музыка вдохновляла людей во все времена. Она должна быть свободной, что бы ни происходило вокруг.',
          'Поэтому своей музыкой мы должны владеть сами — чтобы никто не мог лишить нас права её слушать.',
        ],
      },
    ],
    sign: '— rozev',
  },
  en: {
    title: 'About the author',
    author: AUTHOR,
    sections: [
      {
        title: 'What it is',
        paragraphs: [
          'MUSICH is a self-hosted service for your own music. Like Immich, but for tracks: files live on your devices, the shared archive lives on your server, and sync between them just works.',
          'I make it for myself first: I wanted my music to stay with me rather than inside someone else’s subscription, and I wanted the interface to look like Nothing. Ideas, bugs, wishes — message me on Telegram.',
        ],
      },
      {
        title: 'Manifesto',
        paragraphs: [
          'I’m not a company or a startup, just an enthusiast. I disagree with how big tech operates, and I stand against propaganda laws.',
          'Music has inspired people throughout history. It should stay free, whatever is happening around us.',
          'That’s why we should own our music ourselves — so that no one can take away our right to listen to it.',
        ],
      },
    ],
    sign: '— rozev',
  },
}

export type InfoPage = 'about' | 'privacy' | 'license'

export const infoPage = (page: InfoPage, lang: Lang): Page => {
  const src = page === 'about' ? about : page === 'privacy' ? privacy : license
  return src[lang] ?? src.en!
}
