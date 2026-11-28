import { Fragment } from 'react'
import { artistsOf } from '../lib/artists'
import { useStore } from '../store'
import { cx } from './ui'

/** Артисты трека через запятую, каждый открывается отдельно. plain — просто текст, без ссылок */
export function ArtistLinks({ artist, className, onOpen, plain }: { artist: string; className?: string; onOpen?: () => void; plain?: boolean }) {
  if (plain) return <div className={cx('truncate', className)}>{artistsOf(artist).join(', ')}</div>
  return (
    <div className={cx('truncate', className)}>
      {artistsOf(artist).map((name, i) => (
        <Fragment key={name}>
          {i > 0 && ', '}
          <button
            onClick={() => {
              onOpen?.()
              useStore.getState().openScope({ type: 'artist', value: name })
            }}
            className="hover:text-fg hover:underline"
          >
            {name}
          </button>
        </Fragment>
      ))}
    </div>
  )
}
