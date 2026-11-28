// В каком качестве собран интерфейс:
//  host   — веб-морда на сервере (docker): музыка лежит здесь же, синхронизировать нечего;
//  device — приложение на телефоне/компьютере: своя копия музыки, папка синхронизации, «держать на устройстве».
// По умолчанию — host. Приложение для устройств собирается с VITE_MUSICH_MODE=device.
export const MODE: 'host' | 'device' = import.meta.env.VITE_MUSICH_MODE === 'device' ? 'device' : 'host'

export const isHost = MODE === 'host'
