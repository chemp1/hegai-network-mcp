#!/usr/bin/env node
/**
 * Готовит партии для /book-tag: что знаем о человеке плюс кусок переписки из Личной CRM.
 *   node scripts/tag-batches.mjs [--size 40] [--only-untagged] [--limit 200]
 * Партии лежат в data/tag-batches/. Модель пишет ответы в data/tag-verdicts/ с тем же именем файла.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, readJson, readJsonl, writeJson } from './lib/store.mjs'
import { FACETS } from './lib/text.mjs'

const args = process.argv.slice(2)
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : d
}
const dir = dataDir(opt('data'))
const size = Number(opt('size', 40))
const limit = Number(opt('limit', 100000))
const onlyUntagged = args.includes('--only-untagged')
const meta = readJson(join(dir, 'book-meta.json'), {})
const book = readJsonl(join(dir, 'book.jsonl'))
const overrides = readJson(join(dir, 'book-overrides.json'), {})

const hasTags = (p) => FACETS.some((f) => f !== 'company' && p.tags?.[f]?.length)
const queue = book
  .filter((p) => p.type !== 'personal' && p.share !== 'no' && !overrides[p.id]?.tags)
  .filter((p) => !onlyUntagged || !hasTags(p))
  .slice(0, limit)

function corpus(p) {
  if (!meta.crm_dir || !p.crm_id) return null
  const path = join(meta.crm_dir, 'corpus', `${p.crm_id}.txt`)
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  return text.length > 3000 ? `${text.slice(0, 800)}\n…\n${text.slice(-2200)}` : text
}

const out = join(dir, 'tag-batches')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
mkdirSync(join(dir, 'tag-verdicts'), { recursive: true })
let n = 0
for (let i = 0; i < queue.length; i += size) {
  n++
  const rows = queue.slice(i, i + size).map((p) => ({
    id: p.id,
    name: p.name,
    title: p.title,
    company: p.company,
    city: p.city,
    about: p.about,
    circle: p.circle,
    reason: p.reason,
    conversation: corpus(p),
  }))
  writeJson(join(out, `batch-${String(n).padStart(3, '0')}.json`), rows)
}
console.log(`Партий: ${n}, людей: ${queue.length}. Лежат в data/tag-batches/.`)
