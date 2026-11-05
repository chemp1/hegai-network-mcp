#!/usr/bin/env node
/**
 * Из приватной книжки делает то, что читает сервер: data/index.jsonl и data/showcase.json.
 * В индексе только теги и теплота. Перед записью проверяет, что имён внутри нет, и падает, если есть.
 */
import { join } from 'node:path'
import { randomInt } from 'node:crypto'
import { dataDir, indexKey, readJsonl, readPolicy, secretFor, writeJson, writeJsonl } from './lib/store.mjs'
import { FACETS, loadVocabEntries, norm } from './lib/text.mjs'

const dir = dataDir(process.argv[2])
const policy = readPolicy(dir)
const book = readJsonl(join(dir, 'book.jsonl'))
if (!book.length) {
  console.error('Книжка пуста. Сначала node scripts/import.mjs или /book-import.')
  process.exit(1)
}

const secret = secretFor(dir)
const stop = new Set(policy.stop_tags.map(norm))
const nameKey = (x) => norm(x).split(' ').sort().join(' ')
const hide = new Set(policy.hide.flatMap((h) => [h, nameKey(h)]))
const vocab = new Set(loadVocabEntries().map((e) => `${e.facet}:${e.tag}`))
const excludeTypes = new Set(policy.exclude_types)
const reasons = { 'скрыт вручную': 0, 'личное': 0, 'без тегов': 0 }
const index = []

for (const p of book) {
  if (p.share === 'no' || hide.has(nameKey(p.name)) || hide.has(p.id)) { reasons['скрыт вручную']++; continue }
  if (excludeTypes.has(p.type)) { reasons['личное']++; continue }
  const row = { k: indexKey(secret, p.id) }
  for (const f of FACETS) {
    if (f === 'company' && !policy.share_companies) continue
    // Вне словаря может оказаться что угодно: чужое имя, компания, ник. Такие теги только по явному решению.
    if (f === 'other' && !policy.allow_custom_tags) continue
    const vals = (p.tags?.[f] || []).filter((t) => !stop.has(norm(t)) && (f === 'company' || f === 'other' || vocab.has(`${f}:${t}`)))
    if (vals.length) row[f] = vals
  }
  const hasMeaning = FACETS.some((f) => f !== 'company' && f !== 'geo' && row[f]?.length) || (policy.share_companies && row.company?.length)
  if (!hasMeaning) { reasons['без тегов']++; continue }
  const warm = p.can_intro === true || (p.can_intro !== false && policy.warm_circles.includes(p.circle))
  row.warmth = warm ? 'warm' : 'known'
  index.push(row)
}

// Порядок строк не должен выдавать порядок книжки.
for (let i = index.length - 1; i > 0; i--) {
  const j = randomInt(i + 1)
  ;[index[i], index[j]] = [index[j], index[i]]
}

// Предохранитель: полные имена не должны попасть в индекс ни при каких тегах.
const blob = norm(JSON.stringify(index))
const leaked = book.filter((p) => norm(p.name).includes(' ') && blob.includes(norm(p.name)))
if (leaked.length) {
  console.error(`СТОП. В индексе нашлись имена из книжки: ${leaked.slice(0, 5).map((p) => p.name).join(', ')}.`)
  console.error('Похоже, имя попало в теги. Индекс не записан. Поправь теги этих людей.')
  process.exit(2)
}

// Свои теги живут, только если их разделяют несколько человек: редкая строка почти всегда указывает на одного.
if (policy.allow_custom_tags) {
  const seen = new Map()
  for (const row of index) for (const t of row.other || []) seen.set(t, (seen.get(t) || 0) + 1)
  for (const row of index) {
    if (!row.other) continue
    row.other = row.other.filter((t) => seen.get(t) >= policy.min_showcase)
    if (!row.other.length) delete row.other
  }
}

const counts = new Map()
for (const row of index) {
  for (const f of FACETS) for (const t of row[f] || []) {
    const key = `${f}:${t}`
    counts.set(key, (counts.get(key) || 0) + 1)
  }
}
const FLOORS = [1000, 500, 250, 100, 50, 25, 10, 5]
const bucket = (n) => `${FLOORS.find((x) => n >= x) ?? n}+`
const hideShow = new Set(policy.showcase_hide.map(norm))
const showcase = [...counts.entries()]
  .filter(([key, n]) => n >= policy.min_showcase && !hideShow.has(norm(key.split(':').slice(1).join(':'))))
  .filter(([key]) => !key.startsWith('company:'))
  .sort((a, b) => b[1] - a[1])
  .map(([key, n]) => {
    const [facet, ...rest] = key.split(':')
    return { facet, tag: rest.join(':'), approx: bucket(n) }
  })

writeJsonl(join(dir, 'index.jsonl'), index)
writeJson(join(dir, 'showcase.json'), showcase)

const warm = index.filter((r) => r.warmth === 'warm').length
console.log(`В книжке ${book.length}, в индекс вошли ${index.length} (тёплых ${warm}).`)
for (const [why, n] of Object.entries(reasons)) if (n) console.log(`  не вошли, ${why}: ${n}`)
console.log(`Компании в индексе: ${policy.share_companies ? 'да' : 'нет'}. Витрина, которую увидят гости:`)
for (const s of showcase.slice(0, 25)) console.log(`  ${s.tag.padEnd(22)} ${s.approx}`)
if (showcase.length > 25) console.log(`  ...и ещё ${showcase.length - 25}`)
if (!showcase.length) console.log(`  (пусто: ни один тег не набрал ${policy.min_showcase} человек)`)
