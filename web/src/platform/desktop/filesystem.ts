import { Channel, invoke } from '@tauri-apps/api/core'
import type { PluginListenerHandle } from './core'

/**
 * @capacitor/filesystem на ПК. Папки: External — папка приложения (%LOCALAPPDATA%\app.musich.desktop),
 * Cache — временная. Данные без encoding — base64, как у Capacitor
 */

export enum Directory {
  Documents = 'DOCUMENTS',
  Data = 'DATA',
  Library = 'LIBRARY',
  Cache = 'CACHE',
  External = 'EXTERNAL',
  ExternalStorage = 'EXTERNAL_STORAGE',
}
export enum Encoding {
  UTF8 = 'utf8',
  ASCII = 'ascii',
  UTF16 = 'utf16',
}

type At = { path: string; directory?: Directory }
type Progress = { url: string; bytes: number; contentLength: number }
const progressSubs = new Set<(e: Progress) => void>()

const write = (o: At & { data: string; encoding?: Encoding }, append: boolean) =>
  invoke<string>('fs_write', { path: o.path, dir: o.directory ?? null, data: o.data, utf8: !!o.encoding, append }).then((uri) => ({ uri }))

export const Filesystem = {
  writeFile: (o: At & { data: string; encoding?: Encoding; recursive?: boolean }) => write(o, false),
  appendFile: (o: At & { data: string; encoding?: Encoding }) => write(o, true).then(() => {}),
  readFile: (o: At & { encoding?: Encoding }) => invoke<string>('fs_read', { path: o.path, dir: o.directory ?? null, utf8: !!o.encoding }).then((data) => ({ data })),
  deleteFile: (o: At) => invoke<void>('fs_delete', { path: o.path, dir: o.directory ?? null }),
  mkdir: (o: At & { recursive?: boolean }) => invoke<void>('fs_mkdir', { path: o.path, dir: o.directory ?? null }),
  rmdir: (o: At & { recursive?: boolean }) => invoke<void>('fs_rmdir', { path: o.path, dir: o.directory ?? null, recursive: !!o.recursive }),
  rename: (o: { from: string; to: string; directory?: Directory; toDirectory?: Directory }) =>
    invoke<void>('fs_move', { from: o.from, to: o.to, dir: o.directory ?? null, toDir: o.toDirectory ?? o.directory ?? null, copy: false }),
  copy: (o: { from: string; to: string; directory?: Directory; toDirectory?: Directory }) =>
    invoke<void>('fs_move', { from: o.from, to: o.to, dir: o.directory ?? null, toDir: o.toDirectory ?? o.directory ?? null, copy: true }).then(() => ({ uri: '' })),
  stat: (o: At) => invoke<{ type: string; size: number; mtime: number; uri: string }>('fs_stat', { path: o.path, dir: o.directory ?? null }),
  getUri: (o: At) => invoke<string>('fs_uri', { path: o.path, dir: o.directory ?? null }).then((uri) => ({ uri })),
  /** Качает Rust: большой flac не проходит через память страницы */
  async downloadFile(o: At & { url: string; progress?: boolean; recursive?: boolean; readTimeout?: number; connectTimeout?: number }) {
    const ch = new Channel<{ bytes: number; total: number }>()
    ch.onmessage = (m) => progressSubs.forEach((fn) => fn({ url: o.url, bytes: m.bytes, contentLength: m.total }))
    const path = await invoke<string>('fs_download', { url: o.url, path: o.path, dir: o.directory ?? null, onProgress: ch })
    return { path }
  },
  async addListener(_e: 'progress', fn: (e: Progress) => void): Promise<PluginListenerHandle> {
    progressSubs.add(fn)
    return { remove: async () => void progressSubs.delete(fn) }
  },
}
