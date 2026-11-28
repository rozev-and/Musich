import { ArrowLeft, Search, X } from 'lucide-react'
import { groupByArtist } from '../lib/artists'
import { albumCover, artistImage } from '../lib/covers'
import { t as tx, tn } from '../i18n'
import { useState } from 'react'
import { usePick, useStore } from '../store'
import { matcher } from '../views/Library'
import { TrackRow } from './TrackRow'
import { Cover, IconBtn } from './ui'

/**
 * Поиск на телефоне — отдельным окном на весь экран: поле сверху, «Назад» слева; ниже — найденные артисты,
 * альбомы и треки. Открывается лупой в полосе над списком, закрывается «Назад» (и кнопкой, и системной)
 */
export function SearchSheet() {
  const open = useStore((s) => s.searchOpen)
  // своё поле, не общий поиск библиотеки: закрыл окно — список «Треков» не остаётся отфильтрованным
  return open ? <SearchBody /> : null
}

function SearchBody() {
  const { setSearchOpen, tracks, covers, openScope } = usePick('setSearchOpen', 'tracks', 'covers', 'openScope')
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const found = q ? tracks.filter(matcher(q)) : []
  const artists = q ? groupByArtist(tracks).filter(([name]) => name.toLowerCase().includes(q)).slice(0, 8) : []
  const albums = q ? [...new Set(tracks.map((x) => x.album))].filter((a) => a.toLowerCase().includes(q)).slice(0, 8) : []
  const queue = found.map((x) => x.id)
  const go = (type: 'artist' | 'album', value: string) => {
    setSearchOpen(false)
    openScope({ type, value })
  }

  return (
    <div className="rise page-layer fixed inset-0 z-50 flex flex-col" style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}>
      <div className="flex shrink-0 items-center gap-2 p-3">
        <IconBtn title={tx('common.back')} onClick={() => setSearchOpen(false)} className="h-11 w-11">
          <ArrowLeft size={20} className="rtl:rotate-180" />
        </IconBtn>
        <label className="widget flex min-w-0 flex-1 items-center gap-3 rounded-full px-4 py-2.5">
          <Search size={16} strokeWidth={1.6} className="shrink-0 text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tx('lib.search')}
            enterKeyHint="search"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted"
          />
          {query && (
            <button onClick={() => setQuery('')} title={tx('common.clear')} className="shrink-0 text-muted">
              <X size={16} />
            </button>
          )}
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {!q && <div className="px-6 pt-10 text-center text-sm text-muted">{tx('search.hint')}</div>}
        {q && !found.length && !artists.length && !albums.length && <div className="px-6 pt-10 text-center text-sm text-muted">{tx('search.nothing')}</div>}

        {artists.length > 0 && (
          <section className="mb-4">
            <div className="label px-4 pb-2 text-muted">{tx('nav.artists')}</div>
            <div className="flex gap-3 overflow-x-auto px-4 pb-1">
              {artists.map(([name, list]) => (
                <button key={name} onClick={() => go('artist', name)} className="flex w-20 shrink-0 flex-col items-center gap-1.5">
                  <Cover seed={name + '#a'} src={artistImage(name, list, covers)} size={320} className="h-20 w-20" rounded="rounded-full" />
                  <span className="w-full truncate text-center text-xs">{name}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {albums.length > 0 && (
          <section className="mb-4">
            <div className="label px-4 pb-2 text-muted">{tx('nav.albums')}</div>
            <div className="flex gap-3 overflow-x-auto px-4 pb-1">
              {albums.map((a) => (
                <button key={a} onClick={() => go('album', a)} className="flex w-24 shrink-0 flex-col gap-1.5 text-start">
                  <Cover seed={a} src={albumCover(a, tracks.filter((x) => x.album === a), covers)} size={320} className="h-24 w-24" rounded="rounded-2xl" />
                  <span className="w-full truncate text-xs">{a}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {found.length > 0 && (
          <section>
            <div className="label px-4 pb-1 text-muted">{tn('n.tracks', found.length)}</div>
            {found.slice(0, 200).map((x, i) => (
              <TrackRow key={x.id} t={x} i={i} queue={queue} source={tx('search.source', { q: query.trim() })} />
            ))}
          </section>
        )}
      </div>
    </div>
  )
}
