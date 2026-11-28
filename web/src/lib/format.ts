export const fmtTime = (sec: number) => {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Размеры и числительные — в i18n (fmtSize, tn), они зависят от языка

export const hue = (s: string) => {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

export const isOnDevice = (status: string) => status === 'synced' || status === 'uploading'
