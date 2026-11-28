export type RangeResult = { start: number; end: number } | 'unsatisfiable' | null

/**
 * Разбор заголовка Range для одного диапазона: `bytes=a-b`, `bytes=a-`, `bytes=-n`.
 * null — отдать файл целиком (заголовка нет, он кривой или диапазонов несколько).
 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  if (!header) return null
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    // последние n байт
    const n = Number(m[2])
    if (n === 0) return 'unsatisfiable'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
    if (m[2] !== '' && Number(m[2]) < start) return null
  }
  if (start >= size || size === 0) return 'unsatisfiable'
  return { start, end }
}
