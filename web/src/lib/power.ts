// Экран и батарея: видит ли человек приложение и сколько осталось заряда.
// По этому store решает, как часто ходить на сервер, перерисовывать ли плеер и включать ли «Экономию заряда»

export type Power = {
  visible: boolean // экран включён и MUSICH на нём (а не в фоне)
  battery: number | null // 0–1; null — браузер не говорит
  charging: boolean // неизвестно — считаем, что на зарядке: экономить без причины не надо
}

type BatteryManager = EventTarget & { level: number; charging: boolean }

let appActive = true
let state: Power = { visible: typeof document === 'undefined' || !document.hidden, battery: null, charging: true }
let started = false
const subs = new Set<(p: Power) => void>()

const emit = () => {
  state = { ...state, visible: !document.hidden && appActive }
  for (const fn of subs) fn(state)
}

export const power = () => state

/** Подписка на изменения. native — приложение на телефоне: там «в фоне» сообщает ещё и сама система */
export function watchPower(fn: (p: Power) => void, native: boolean) {
  subs.add(fn)
  if (started || typeof document === 'undefined') return
  started = true
  document.addEventListener('visibilitychange', emit)
  if (native)
    void import('@capacitor/app')
      .then(({ App }) =>
        App.addListener('appStateChange', ({ isActive }) => {
          appActive = isActive
          emit()
        }),
      )
      .catch(() => {})
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> }
  nav
    .getBattery?.()
    .then((b) => {
      const update = () => {
        state = { ...state, battery: b.level, charging: b.charging }
        emit()
      }
      update()
      b.addEventListener('levelchange', update)
      b.addEventListener('chargingchange', update)
    })
    .catch(() => {})
}
