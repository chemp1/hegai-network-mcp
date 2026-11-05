#!/usr/bin/env node
/**
 * Принимает ответы модели из data/tag-verdicts/*.json и кладёт в data/book-overrides.json.
 * Формат ответа: [{ "id", "role":[], "industry":[], "geo":[], "skill":[], "other":[], "can_intro": true|false|null, "share": "no"|null }]
 * Правки живут отдельно от книжки, поэтому повторный импорт их не теряет.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, readJson, readJsonl, writeJson, writeJsonl } from './lib/store.mjs'
import { emptyTags, loadVocabEntries, makeMatcher, norm } from './lib/text.mjs'

const dir = dataDir(process.argv[2])
const vdir = join(dir, 'tag-verdicts')
const find = makeMatcher(loadVocabEntries())
const overrides = readJson(join(dir, 'book-overrides.json'), {})
const book = readJsonl(join(dir, 'book.jsonl'))
const byId = new Map(book.map((p) => [p.id, p]))

// Модель может написать лишнее. Эти темы не становятся тегами, что бы она ни решила.
const SENSITIVE = /здоров|болезн|диагноз|развод|долг|банкрот|уволен|увольн|беремен|религи|политик|ориентац|судим|алког|наркот|депресс|psycholog|health issue|divorce|debt/i

let applied = 0
let droppedSensitive = 0
let droppedNames = 0
for (const file of readdirSync(vdir).filter((f) => f.endsWith('.json'))) {
  const rows = JSON.parse(readFileSync(join(vdir, file), 'utf8'))
  for (const r of rows) {
    const p = byId.get(r.id)
    if (!p) continue
    const tags = { ...emptyTags(), company: p.tags?.company || [] }
    const nameBits = norm(p.name).split(' ').filter((x) => x.length > 2)
    for (const facet of ['role', 'industry', 'geo', 'skill', 'other']) {
      for (const raw of r[facet] || []) {
        const value = String(raw).trim().slice(0, 40)
        if (!value) continue
        if (SENSITIVE.test(value)) { droppedSensitive++; continue }
        const company = norm(p.company)
        if (company && (norm(value).includes(company) || company.includes(norm(value)))) { droppedNames++; continue }
        if (nameBits.some((b) => norm(value).split(' ').includes(b))) { droppedNames++; continue }
        // Сводим к словарю. Что не свелось, идёт в other, а other в индекс без allow_custom_tags не попадает.
        const hit = find(value)[0]
        const [f, t] = hit ? [hit.facet, hit.tag] : ['other', value.toLowerCase()]
        if (!tags[f].includes(t)) tags[f].push(t)
      }
    }
    overrides[r.id] = {
      ...overrides[r.id],
      tags,
      ...(r.can_intro === true || r.can_intro === false ? { can_intro: r.can_intro } : {}),
      ...(r.share === 'no' ? { share: 'no' } : {}),
    }
    Object.assign(p, overrides[r.id])
    applied++
  }
}
writeJson(join(dir, 'book-overrides.json'), overrides)
writeJsonl(join(dir, 'book.jsonl'), book)
console.log(`Применено: ${applied}. Отброшено чувствительных тегов: ${droppedSensitive}, тегов с именем человека: ${droppedNames}.`)
console.log('Дальше: node scripts/build-index.mjs')
