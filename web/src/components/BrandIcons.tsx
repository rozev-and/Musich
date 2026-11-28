// Значки «плееров» в «Интеграциях» — свои, нарисованные с нуля: круг цвета сервиса и простой знак.
// Чужие логотипы не используем (товарные знаки): жёлтый — звезда, зелёный — волны, синий — буквы VK, красный — «играть»,
// Telegram — бумажный самолётик

export type PlayerId = 'yandex' | 'spotify' | 'vk' | 'youtube' | 'telegram'

/** Звезда с неровными лучами: длинные и короткие через один, чуть повёрнута */
const STAR = (() => {
  const rays = 9
  const pts: string[] = []
  for (let i = 0; i < rays * 2; i++) {
    const a = (Math.PI * i) / rays - Math.PI / 2 + 0.18
    const r = i % 2 ? 3.1 : i % 4 === 0 ? 8.6 : 7.2
    pts.push(`${(12 + r * Math.cos(a)).toFixed(2)},${(12 + r * Math.sin(a)).toFixed(2)}`)
  }
  return pts.join(' ')
})()

/** Значок плеера: всегда круглый, size×size */
export function PlayerIcon({ id, size = 28 }: { id: PlayerId; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className="shrink-0">
      {id === 'yandex' && (
        <>
          <circle cx="12" cy="12" r="12" fill="#222222" />
          <polygon points={STAR} fill="#fcbc2d" strokeLinejoin="round" stroke="#fcbc2d" strokeWidth="0.6" />
        </>
      )}
      {id === 'spotify' && (
        <>
          <circle cx="12" cy="12" r="12" fill="#1ed760" />
          {/* три волны, как сигнал: сверху длинная, внизу короткая */}
          <g fill="none" stroke="#111111" strokeLinecap="round">
            <path d="M5.6 9.3c4.2-1.4 8.8-1.1 12.8 1" strokeWidth="2.1" />
            <path d="M6.6 12.7c3.5-1 7.2-.7 10.4.9" strokeWidth="1.8" />
            <path d="M7.6 15.9c2.7-.7 5.4-.5 7.8.7" strokeWidth="1.5" />
          </g>
        </>
      )}
      {id === 'vk' && (
        <>
          <circle cx="12" cy="12" r="12" fill="#0077ff" />
          <text
            x="12"
            y="12.4"
            textAnchor="middle"
            dominantBaseline="middle"
            fill="#ffffff"
            fontSize="10"
            fontWeight="900"
            fontStyle="italic"
            fontFamily="'Arial Black', 'Segoe UI', Inter, sans-serif"
            letterSpacing="-0.4"
          >
            VK
          </text>
        </>
      )}
      {id === 'telegram' && (
        <>
          <circle cx="12" cy="12" r="12" fill="#2aabee" />
          {/* бумажный самолётик */}
          <path d="M5.3 11.6l11.8-4.6c.55-.2 1.05.15.9.85l-2 9.5c-.15.65-.85.85-1.3.5l-3.1-2.3-1.6 1.5c-.2.2-.55.1-.55-.2l.2-2.7 5.1-4.6c.25-.2-.05-.35-.35-.2l-6.2 3.9-2.7-.9c-.6-.2-.6-.55.0-.75z" fill="#ffffff" />
        </>
      )}
      {id === 'youtube' && (
        <>
          <circle cx="12" cy="12" r="12" fill="#ff0000" />
          <path d="M9.6 7.6v8.8l7.2-4.4z" fill="#ffffff" strokeLinejoin="round" stroke="#ffffff" strokeWidth="1" />
        </>
      )}
    </svg>
  )
}
