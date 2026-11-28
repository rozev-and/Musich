import { Integrations } from '../components/Integrations'
import { t } from '../i18n'
import { PageTitle } from './Library'

/** «Интеграции» — своим разделом в меню: Spotify, YouTube Music, Яндекс Музыка, VK и сравнение с библиотекой */
export function IntegrationsPage() {
  return (
    <div>
      <PageTitle>{t('nav.integrations')}</PageTitle>
      <div className="max-w-3xl">
        <Integrations section={(_title, children) => <section className="widget flex flex-col gap-3 p-5">{children}</section>} />
      </div>
    </div>
  )
}
