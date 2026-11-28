// PRIVACY.md из текста политики в приложении (web/src/content/legal.ts): node scripts/privacy.mjs
// Ссылку на PRIVACY.md на GitHub просит Google Play. Правишь политику — правь legal.ts и запусти этот скрипт
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { privacy } = await import(new URL('../web/src/content/legal.ts', import.meta.url).href)

const block = (page) =>
  [
    `## ${page.title}`,
    ...page.sections.flatMap((s) => [
      `### ${s.title}`,
      // пункты «• …» — списком подряд, остальное — абзацами через пустую строку
      s.paragraphs.reduce((out, p, i) => {
        const item = p.startsWith('• ')
        const sep = i === 0 ? '' : item && s.paragraphs[i - 1].startsWith('• ') ? '\n' : '\n\n'
        return out + sep + (item ? `- ${p.slice(2)}` : p)
      }, ''),
      ...(s.links?.length ? [s.links.map((l) => `[${l.label}](${l.url})`).join(' · ')] : []),
    ]),
  ].join('\n\n')

const md = `# MUSICH — политика конфиденциальности / Privacy policy\n\n${block(privacy.ru)}\n\n---\n\n${block(privacy.en)}\n`
writeFileSync(fileURLToPath(new URL('../PRIVACY.md', import.meta.url)), md)
console.log('PRIVACY.md')
