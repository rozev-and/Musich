// Забыли пароль владельца — задать новый прямо на машине с сервером:
//   cd server && node reset-password.ts
// Пароль вводится в терминале и не показывается. Сервер можно не останавливать.
// В базе хранится только отпечаток (scrypt), как и при обычной смене пароля

import { randomBytes, scrypt } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>
const DB = new URL('./.local/data/musich.db', import.meta.url)

/** Строка из терминала без эха: вместо символов — звёздочки */
function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt)
    const stdin = process.stdin
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode?.(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          return resolve(value)
        }
        if (c === '\u0003') process.exit(1) // Ctrl+C
        if (c === '\u007f' || c === '\b') {
          if (value) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
        } else {
          value += c
          process.stdout.write('*')
        }
      }
    }
    stdin.on('data', onData)
  })
}

const password = await ask('Новый пароль владельца (не короче 8): ')
if (password.length < 8) {
  console.log('Слишком короткий — ничего не поменял')
  process.exit(1)
}
if ((await ask('Ещё раз: ')) !== password) {
  console.log('Не совпало — ничего не поменял')
  process.exit(1)
}
const salt = randomBytes(16)
const hash = `scrypt:${salt.toString('hex')}:${(await scryptAsync(password, salt, 32)).toString('hex')}`
const db = new DatabaseSync(DB)
db.exec('PRAGMA busy_timeout = 5000')
const r = db.prepare("UPDATE users SET password = ? WHERE role = 'owner'").run(hash)
const owner = db.prepare("SELECT login, name FROM users WHERE role = 'owner'").get() as { login: string | null; name: string } | undefined
db.close()
console.log(r.changes ? `Готово. Владелец: ${owner?.name}${owner?.login ? `, логин ${owner.login}` : ' — логин придумаете при входе'}` : 'Владелец не найден')
