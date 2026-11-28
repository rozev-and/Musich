import { useStore } from '../store'

/** Тонкая бегущая полоска сверху, пока библиотека грузится с сервера — видно на любой странице */
export function LoadingBar() {
  const on = useStore((s) => s.libLoading)
  if (!on) return null
  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5 overflow-hidden">
      <div className="h-full w-2/5 animate-[load-slide_1.1s_ease-in-out_infinite] bg-sel" />
    </div>
  )
}
