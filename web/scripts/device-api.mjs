// Описание мобильной части для открытого кода: src/lib/device.ts → src/lib/device-api.d.ts.
// Только имена функций и типы, без реализации: веб и стор проверяются по нему, а сам device.ts (офлайн-библиотека,
// загрузки, хранение на телефоне) в открытый репозиторий не попадает (scripts/publish.mjs).
// Запускается сам перед сборкой приложения (npm run build:app); вручную — npm run device:api
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = join(dirname(fileURLToPath(import.meta.url)), '..')
if (!existsSync(join(web, 'src', 'lib', 'device.ts'))) {
  console.log('device.ts нет (открытая копия) — описание остаётся как есть')
  process.exit(0)
}
const tmp = join(web, '.device-api-tmp')
const cfg = join(web, 'tsconfig.device-api.json')
writeFileSync(
  cfg,
  JSON.stringify({
    extends: './tsconfig.json',
    compilerOptions: { declaration: true, emitDeclarationOnly: true, noEmit: false, removeComments: true, outDir: '.device-api-tmp', rootDir: 'src', paths: {} },
    include: ['src/lib/device.ts'],
  }),
)
try {
  execSync('npx tsc -p tsconfig.device-api.json', { cwd: web, stdio: 'inherit' })
  const dts = readFileSync(join(tmp, 'lib', 'device.d.ts'), 'utf8')
  const head = '// Сгенерировано из src/lib/device.ts (scripts/device-api.mjs) — не править руками.\n// Мобильная часть MUSICH: только описание, сама реализация — в закрытом коде приложения для Android.\n'
  writeFileSync(join(web, 'src', 'lib', 'device-api.d.ts'), head + dts)
  console.log('src/lib/device-api.d.ts обновлён')
} finally {
  rmSync(tmp, { recursive: true, force: true })
  rmSync(cfg, { force: true })
}
