export interface Log {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
  debug(msg: string): void
}

const time = () => new Date().toLocaleTimeString('ru-RU', { hour12: false })

export function consoleLog(verbose = false): Log {
  return {
    info: (m) => console.log(`${time()} ${m}`),
    warn: (m) => console.warn(`${time()} ! ${m}`),
    error: (m) => console.error(`${time()} ✗ ${m}`),
    debug: (m) => {
      if (verbose) console.log(`${time()} · ${m}`)
    },
  }
}

export const silentLog: Log = { info() {}, warn() {}, error() {}, debug() {} }
