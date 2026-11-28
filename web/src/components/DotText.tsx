import { useEffect, useState } from 'react'

/*
 * Текст из точек — как логотип MUSICH. Логотип набран шрифтом Doto: это матрица 5×7 точек,
 * каждая буква занимает 6 клеток по ширине. Кириллицы в Doto нет, поэтому:
 *  - латиницу, цифры и знаки берём из самого Doto (растеризуем и снимаем сетку точек);
 *  - кириллицу рисуем сами на той же сетке 5×7. Буквы, совпадающие с латинскими, берём у Doto.
 * Всё выводится заглавными, как логотип. Арабский и иероглифы — обычным текстом.
 */

const U = 10 // размер клетки сетки при растеризации Doto (em у Doto — 10 клеток)
const FONT = `900 ${10 * U}px Doto`
const ACCENT = 2 // строк над буквой — под диакритику (É, Ü, Ё, Й)
const ROWS = ACCENT + 7
const ADV = 6 // шаг букв в клетках: 5 точек + промежуток

// Кириллица 5×7 («#» — точка). Совпадающие по форме с латиницей — в LATIN_TWIN
const CYR: Record<string, string> = {
  Б: '##### #.... #.... ####. #...# #...# ####.',
  Г: '##### #.... #.... #.... #.... #.... #....',
  Д: '..##. .#.#. .#.#. .#.#. .#.#. ##### #...#',
  Ж: '#.#.# #.#.# .###. ..#.. .###. #.#.# #.#.#',
  З: '.###. #...# ....# ..##. ....# #...# .###.',
  И: '#...# #...# #..## #.#.# ##..# #...# #...#',
  Л: '..### .#..# .#..# .#..# .#..# .#..# #...#',
  П: '##### #...# #...# #...# #...# #...# #...#',
  У: '#...# #...# #...# .#### ....# #...# .###.',
  Ф: '..#.. .###. #.#.# #.#.# #.#.# .###. ..#..',
  Ц: '#..#. #..#. #..#. #..#. #..#. ##### ....#',
  Ч: '#...# #...# #...# .#### ....# ....# ....#',
  Ш: '#.#.# #.#.# #.#.# #.#.# #.#.# #.#.# #####',
  Щ: '#.#.# #.#.# #.#.# #.#.# #.#.# ##### ....#',
  Ъ: '##... .#... .#... .###. .#..# .#..# .###.',
  Ы: '#...# #...# #...# ###.# #.#.# #.#.# ###.#',
  Ь: '#.... #.... #.... ####. #...# #...# ####.',
  Э: '.###. #...# ....# ..### ....# #...# .###.',
  Ю: '#..#. #.#.# #.#.# ###.# #.#.# #.#.# #..#.',
  Я: '.#### #...# #...# .#### ..#.# .#..# #...#',
  // с надстрочными знаками: первая строка — над буквой
  Й: '.#.#. ..... #...# #..## #.#.# ##..# #...# #...#',
  Ё: '.#.#. ..... ##### #.... ####. #.... #####',
}
const LATIN_TWIN: Record<string, string> = { А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', І: 'I' }

const SUPPORTED = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{N}\p{P}\p{S}\p{Zs}]*$/u

type Cell = [number, number] // [колонка, строка]
const glyphCache = new Map<string, Cell[]>()

function fromPattern(p: string): Cell[] {
  const lines = p.split(' ')
  const offset = ROWS - lines.length // прижимаем к низу: 7 строк — буква, лишние — надстрочные
  const cells: Cell[] = []
  lines.forEach((line, r) => [...line].forEach((ch, c) => ch === '#' && cells.push([c, r + offset])))
  return cells
}

// Снимаем точки буквы Doto: рисуем крупно и смотрим центры клеток сетки
function fromDoto(ch: string): Cell[] {
  const canvas = document.createElement('canvas')
  canvas.width = ADV * U
  canvas.height = (ROWS + 2) * U
  const g = canvas.getContext('2d')!
  g.font = FONT
  const baseline = ROWS * U
  g.fillText(ch, 0, baseline)
  const data = g.getImageData(0, 0, canvas.width, canvas.height).data
  const cells: Cell[] = []
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < ADV; c++) {
      const x = c * U + U / 2
      const y = r * U + U / 2
      if (data[(y * canvas.width + x) * 4 + 3] > 127) cells.push([c, r])
    }
  return cells
}

function glyph(ch: string): Cell[] {
  const hit = glyphCache.get(ch)
  if (hit) return hit
  const cells = CYR[ch] ? fromPattern(CYR[ch]) : fromDoto(LATIN_TWIN[ch] ?? ch)
  glyphCache.set(ch, cells)
  return cells
}

type Layout = { cols: number; cells: Cell[]; top: number }

function layout(text: string): Layout {
  const cells: Cell[] = []
  const chars = [...text.toUpperCase()]
  chars.forEach((ch, i) => glyph(ch).forEach(([c, r]) => cells.push([c + i * ADV, r])))
  const top = cells.reduce((m, [, r]) => Math.min(m, r), ACCENT)
  return { cols: Math.max(1, chars.length * ADV - 1), cells, top }
}

export function DotText({
  text,
  size = 26,
  trimTop,
  className,
}: {
  text: string
  size?: number // как font-size: высота заглавной буквы ≈ 0.7 от него (у логотипа 26px)
  trimTop?: boolean // срезать пустые строки над буквами, если в тексте нет É, Й и т.п.
  className?: string
}) {
  const dotty = SUPPORTED.test(text)
  const [ready, setReady] = useState(() => document.fonts.check(FONT))

  useEffect(() => {
    if (ready || !dotty) return
    let alive = true
    document.fonts.load(FONT, 'MUSICH').then(() => alive && setReady(true))
    return () => {
      alive = false
    }
  }, [ready, dotty])

  if (!dotty || !ready) return <span className={className}>{text}</span>

  const { cols, cells, top } = layout(text)
  const pitch = size / 10
  const skip = trimTop ? top : 0
  const rows = ROWS - skip

  return (
    <span className={className} role="img" aria-label={text}>
      <svg
        width={cols * pitch}
        height={rows * pitch}
        viewBox={`0 ${skip} ${cols} ${rows}`}
        // если места мало — ужимается пропорционально, а не налезает
        className="block h-auto max-w-full overflow-visible"
        aria-hidden
      >
        {cells.map(([c, r]) => (
          // точка 0.9 клетки — как у Doto в самом жирном начертании (логотип)
          <circle key={`${c}.${r}`} cx={c + 0.5} cy={r + 0.5} r={0.45} fill="currentColor" />
        ))}
      </svg>
    </span>
  )
}
