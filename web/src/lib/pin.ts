// PIN-код телефона (по желанию, Настройки → Защита). Храним не сам код, а SHA-256 с солью и длину —
// по длине экран ввода проверяет сам, без кнопки «ОК». Восстановления нет: забыли — переустановить приложение

const PIN_KEY = 'musich-pin'
type Stored = { salt: string; hash: string; len: number }

const read = (): Stored | null => {
  try {
    return JSON.parse(localStorage.getItem(PIN_KEY) ?? 'null') as Stored | null
  } catch {
    return null
  }
}

async function digest(salt: string, pin: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const hasPin = () => !!read()
export const pinLength = () => read()?.len ?? 4

export async function setPin(pin: string) {
  const salt = crypto.randomUUID()
  localStorage.setItem(PIN_KEY, JSON.stringify({ salt, hash: await digest(salt, pin), len: pin.length } satisfies Stored))
}

export const clearPin = () => localStorage.removeItem(PIN_KEY)

export async function checkPin(pin: string): Promise<boolean> {
  const s = read()
  return !s || (await digest(s.salt, pin)) === s.hash
}
