import { GitBranch, Heart, Send, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { infoPage, SUPPORT, type InfoPage, type Page } from '../content/about'
import { t } from '../i18n'
import { api } from '../lib/api'
import { useStore } from '../store'
import { Modal } from './Dialogs'
import { Cover, cx, IconBtn } from './ui'

// Подвал живёт отдельно от «Настроек»: его показывает и «Главная», а «Настройки» грузятся, только когда их открывают

/** «MUSICH · web 0.1.0 · Об авторе · Манифест» — внизу «Настроек» и «Главной»; ссылки открывают окна с текстом */
export function AppFooter({ className }: { className?: string }) {
  const [info, setInfo] = useState<InfoPage | null>(null)
  const [support, setSupport] = useState(false)
  // новая версия MUSICH — сервер сам смотрит раз в сутки (выключается в настройках)
  const online = useStore((s) => s.conn === 'online')
  const [upd, setUpd] = useState<{ version: string; url: string } | null>(null)
  useEffect(() => {
    if (online) api<{ latest: { version: string; url: string } | null }>('/server/update').then((r) => setUpd(r.latest), () => {})
  }, [online])
  return (
    <>
      <div className={cx('label flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-ink-muted', className)}>
        <span>MUSICH · web 0.1.0</span>
        {upd && (
          <a href={upd.url} target="_blank" rel="noopener noreferrer" className="rounded-full bg-sel px-2 py-0.5 text-on-sel">
            {t('upd.new', { v: upd.version })}
          </a>
        )}
        <span>·</span>
        <button onClick={() => setInfo('about')} className="underline-offset-4 hover:text-ink hover:underline">
          {t('footer.about')}
        </button>
        <span>·</span>
        <button onClick={() => setInfo('privacy')} className="underline-offset-4 hover:text-ink hover:underline">
          {t('footer.privacy')}
        </button>
        <span>·</span>
        <button onClick={() => setInfo('license')} className="underline-offset-4 hover:text-ink hover:underline">
          {t('footer.license')}
        </button>
        {SUPPORT.length > 0 && (
          <>
            <span>·</span>
            <button onClick={() => setSupport(true)} className="flex items-center gap-1 underline-offset-4 hover:text-ink hover:underline">
              <Heart size={12} className="fill-current text-red" />
              {t('footer.support')}
            </button>
          </>
        )}
      </div>
      {info && <InfoDialog page={info} onClose={() => setInfo(null)} />}
      {support && <SupportDialog onClose={() => setSupport(false)} />}
    </>
  )
}

function InfoDialog({ page, onClose }: { page: InfoPage; onClose: () => void }) {
  const lang = useStore((s) => s.lang)
  const p = infoPage(page, lang)
  return (
    <Modal onClose={onClose} wide>
      <div className="mb-4 flex items-start justify-between gap-4">
        <h2 className="text-xl font-medium">{p.title}</h2>
        <IconBtn title={t('common.close')} onClick={onClose} className="-mt-1 -me-2">
          <X size={18} />
        </IconBtn>
      </div>
      <div className="flex max-h-[80vh] flex-col gap-5 overflow-y-auto text-sm leading-snug text-fg/85">
        {p.author && <AuthorCard author={p.author} />}
        {p.sections.map((sec) => (
          <section key={sec.title} className="flex flex-col gap-1.5">
            <h3 className="label text-muted">{sec.title}</h3>
            {/* видео как гифка: само, по кругу, без звука */}
            {sec.video && <video src={sec.video} autoPlay loop muted playsInline className="mx-auto mb-1 max-h-[42vh] w-auto max-w-full rounded-2xl" />}
            {sec.paragraphs.map((text, i) => (
              <p key={i}>{text}</p>
            ))}
            {sec.links && (
              <div className="mt-1 flex flex-wrap gap-2">
                {sec.links.map((l) => (
                  <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="rounded-full border border-ink/20 px-3.5 py-1.5 text-xs text-fg transition-colors hover:border-ink/50">
                    {l.label}
                  </a>
                ))}
              </div>
            )}
          </section>
        ))}
        {/* подпись — всегда точечным шрифтом, как логотип, какой бы шрифт ни выбрали в настройках */}
        {p.sign && <p className="font-logo text-base font-bold text-fg">{p.sign}</p>}
      </div>
    </Modal>
  )
}

/** «Поддержать MUSICH»: пара слов и кнопки на страницы доната (адреса — SUPPORT в content/about.ts) */
function SupportDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <h2 className="text-xl font-medium">{t('support.title')}</h2>
        <IconBtn title={t('common.close')} onClick={onClose} className="-mt-1 -me-2">
          <X size={18} />
        </IconBtn>
      </div>
      <p className="mb-5 text-sm text-fg/85">{t('support.text')}</p>
      <div className="flex flex-col gap-2">
        {SUPPORT.map((l) => (
          <a
            key={l.url}
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-full bg-card-3 py-3 text-sm font-medium transition-colors hover:bg-sel hover:text-on-sel"
          >
            <Heart size={15} /> {l.label}
          </a>
        ))}
      </div>
    </Modal>
  )
}

/** Шапка «Об авторе»: квадратное фото (файла пока нет — точечная заглушка), имя, ссылки */
function AuthorCard({ author }: { author: NonNullable<Page['author']> }) {
  const [noPhoto, setNoPhoto] = useState(false)
  return (
    <div className="flex items-center gap-4">
      {noPhoto ? (
        <Cover seed={author.name} className="h-24 w-24" rounded="rounded-2xl" />
      ) : (
        <img src={author.photo} alt="" onError={() => setNoPhoto(true)} className="h-24 w-24 shrink-0 rounded-2xl object-cover" />
      )}
      <div className="min-w-0">
        {/* имя — всегда точечным шрифтом логотипа, как и подпись */}
        <div className="font-logo text-2xl font-black text-fg">{author.name}</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {author.links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-full border border-ink/20 px-3.5 py-1.5 text-xs text-fg transition-colors hover:border-ink/50"
            >
              {l.label === 'Telegram' ? <Send size={14} /> : <GitBranch size={14} />} {l.label === 'MUSICH' ? t('footer.source') : l.label}
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}
