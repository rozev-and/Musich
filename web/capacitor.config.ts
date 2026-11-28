import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Приложение MUSICH для Android: тот же интерфейс, собранный в режиме устройства (npm run build:app → dist-app).
 * Музыка лежит на телефоне и играет без сети; с сервером синхронизируется, когда он доступен.
 */
const config: CapacitorConfig = {
  appId: 'app.musich',
  appName: 'MUSICH',
  webDir: 'dist-app',
  server: {
    // страница открывается как http://localhost: сервер в домашней сети — обычный http, и https-страница
    // не пустила бы к нему запросы (смешанное содержимое)
    androidScheme: 'http',
    // и сам Android по умолчанию запрещает незашифрованный http — разрешаем (свой сервер в своей сети)
    cleartext: true,
  },
  android: {
    // фон до загрузки интерфейса — как у темы Nothing, без белой вспышки
    backgroundColor: '#000000',
  },
}

export default config
