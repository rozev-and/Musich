import { Preferences } from '@capacitor/preferences'

/**
 * Надёжное хранение на телефоне. localStorage встроенного браузера Android пишется на диск с задержкой:
 * поменял настройку (скругление, тему…) и сразу смахнул приложение — она пропадает. Поэтому каждое наше
 * значение (ключи tunich-* и musich-*) дублируется в Preferences — нативное хранилище, которое пишется на диск
 * сразу, — а при запуске восстанавливается оттуда, до того как стор прочитает localStorage
 */
// tunich-player (очередь и позиция, пишется каждые 2–5 с) — только в localStorage: Preferences на каждую запись
// переписывает весь файл с историей и кэшами — батарея и износ памяти. После очистки данных просто начнём с начала очереди
const ours = (k: string) => (k.startsWith('tunich-') || k.startsWith('musich-')) && k !== 'tunich-player'

export async function restoreDurable() {
  try {
    const keys = (await Preferences.keys()).keys.filter(ours)
    if (!keys.length) {
      // первый запуск с надёжным хранилищем: переносим туда то, что уже лежит в localStorage
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && ours(k)) await Preferences.set({ key: k, value: localStorage.getItem(k) ?? '' })
      }
    } else {
      // все ключи разом, а не по одному: это до первого кадра, и ~35 последовательных вызовов моста заметно тормозили старт
      const got = await Promise.all(keys.map((k) => Preferences.get({ key: k }).then((r) => [k, r.value] as const)))
      for (const [k, value] of got) if (value !== null) localStorage.setItem(k, value)
    }
  } catch {
    /* плагина нет (интерфейс открыт в браузере при разработке) — обычный localStorage */
  }
  mirror()
}

/** Дальше каждая запись и удаление наших ключей уходит и в Preferences */
function mirror() {
  const proto = Storage.prototype
  const setItem = proto.setItem
  const removeItem = proto.removeItem
  proto.setItem = function (k: string, v: string) {
    setItem.call(this, k, v)
    if (this === localStorage && ours(k)) void Preferences.set({ key: k, value: String(v) }).catch(() => {})
  }
  proto.removeItem = function (k: string) {
    removeItem.call(this, k)
    if (this === localStorage && ours(k)) void Preferences.remove({ key: k }).catch(() => {})
  }
}
