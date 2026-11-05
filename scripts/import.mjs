#!/usr/bin/env node
/**
 * Собирает data/book.jsonl из того, что уже есть после прошлых воркшопов:
 *   --crm <папка out/ Личной CRM>     круги и типы из /circles
 *   --linkedin <Connections.csv>      выгрузка LinkedIn
 *   --enriched <enriched.json>        обогащение из воркшопа 03
 *   --csv <файл>                      любой CSV с колонками name,title,company,city,tags,circle,tg
 * Повторный запуск не теряет твои правки и теги модели: они лежат в data/book-overrides.json.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { dataDir, readJson, readJsonl, writeJson, writeJsonl } from './lib/store.mjs'
import { loadVocabEntries, makeMatcher, norm, tagByRules, FACETS } from './lib/text.mjs'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const dir = dataDir(opt('data'))
const find = makeMatcher(loadVocabEntries())
const people = new Map()
let crmDir

const nameKey = (name) => norm(name).split(' ').sort().join(' ')
const idFor = (key) => 'c_' + createHash('sha256').update(key).digest('hex').slice(0, 12)

function upsert(rec) {
  if (!rec.name || !norm(rec.name)) return
  const key = nameKey(rec.name)
  const cur = people.get(key) || { id: idFor(key), name: rec.name.trim(), sources: [] }
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'sources' || v === undefined || v === null || v === '') continue
    if (cur[k] === undefined) cur[k] = v
  }
  cur.sources = [...new Set([...cur.sources, ...(rec.sources || [])])]
  people.set(key, cur)
}

/** CSV без зависимостей: кавычки, запятые внутри кавычек, переводы строк внутри кавычек. */
function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row) }
  return rows
}

function importLinkedin(path) {
  const rows = parseCsv(readFileSync(path, 'utf8').replace(/^﻿/, ''))
  // Перед шапкой LinkedIn кладёт несколько строк пояснений: ищем саму шапку.
  const h = rows.findIndex((r) => r.includes('First Name') && r.includes('Last Name'))
  if (h < 0) throw new Error(`${path}: не нашёл шапку с First Name и Last Name. Это точно Connections.csv?`)
  const col = (name) => rows[h].indexOf(name)
  let n = 0
  for (const r of rows.slice(h + 1)) {
    const name = `${r[col('First Name')] || ''} ${r[col('Last Name')] || ''}`.trim()
    if (!name) continue
    upsert({
      name,
      title: r[col('Position')],
      company: r[col('Company')],
      linkedin: r[col('URL')],
      sources: ['linkedin'],
    })
    n++
  }
  return n
}

function importCrm(path) {
  const circles = readJson(join(path, 'circles.json'), null)
  const rows = circles?.contacts || readJsonl(join(path, 'contacts.jsonl'))
  if (!rows.length) throw new Error(`${path}: нет ни circles.json, ни contacts.jsonl. Сначала /crm-import и /circles в Личной CRM.`)
  let n = 0
  for (const c of rows) {
    upsert({
      name: c.name,
      circle: c.circle_level ?? undefined,
      type: c.circle_type ?? undefined,
      reason: c.reason,
      crm_id: c.id,
      tg: c.username || c.tg_username,
      sources: ['telegram'],
    })
    n++
  }
  return n
}

function importEnriched(path) {
  const rows = JSON.parse(readFileSync(path, 'utf8'))
  let n = 0
  for (const e of Array.isArray(rows) ? rows : Object.values(rows)) {
    const name = e.name || e.full_name || [e.first_name, e.last_name].filter(Boolean).join(' ')
    upsert({
      name,
      title: e.title || e.headline,
      company: e.company,
      city: e.location || e.city,
      about: e.about,
      linkedin: e.url || e.linkedin,
      sources: ['enriched'],
    })
    n++
  }
  return n
}

function importCsv(path) {
  const rows = parseCsv(readFileSync(path, 'utf8').replace(/^﻿/, ''))
  const head = rows[0].map((h) => h.trim().toLowerCase())
  const col = (name) => head.indexOf(name)
  let n = 0
  for (const r of rows.slice(1)) {
    const get = (name) => (col(name) >= 0 ? r[col(name)] : undefined)
    upsert({
      name: get('name'),
      title: get('title'),
      company: get('company'),
      city: get('city'),
      tg: get('tg'),
      about: get('about') || get('tags'),
      circle: get('circle') ? Number(get('circle')) : undefined,
      sources: ['csv'],
    })
    n++
  }
  return n
}

for (const p of [opt('crm'), opt('linkedin'), opt('enriched'), opt('csv')]) {
  if (p && !existsSync(p)) throw new Error(`Нет такого пути: ${p}`)
}

const report = []
if (opt('crm')) { crmDir = opt('crm') }
if (opt('crm')) report.push(['Личная CRM', importCrm(opt('crm'))])
if (opt('enriched')) report.push(['обогащение', importEnriched(opt('enriched'))])
if (opt('linkedin')) report.push(['LinkedIn', importLinkedin(opt('linkedin'))])
if (opt('csv')) report.push(['CSV', importCsv(opt('csv'))])

if (!report.length) {
  console.error('Укажи хотя бы один источник: --crm <out Личной CRM>, --linkedin <Connections.csv>, --enriched <файл>, --csv <файл>')
  process.exit(1)
}
// Прошлые запуски дополняют текущий: добавил LinkedIn, а круги и «личное» из Личной CRM остались.
for (const { tags, ...old } of readJsonl(join(dir, 'book.jsonl'))) upsert(old)

const overrides = readJson(join(dir, 'book-overrides.json'), {})
const book = [...people.values()].map((p) => {
  const tags = tagByRules([p.title, p.company ? '' : null, p.city, p.about], find)
  if (p.company) tags.company = [p.company.trim()]
  const o = overrides[p.id] || {}
  const merged = { ...p, tags, ...o }
  if (o.tags) {
    merged.tags = { ...tags }
    for (const f of FACETS) if (o.tags[f]) merged.tags[f] = o.tags[f]
    if (p.company && !o.tags.company) merged.tags.company = [p.company.trim()]
  }
  return merged
})

writeJsonl(join(dir, 'book.jsonl'), book)
writeJson(join(dir, 'book-meta.json'), { crm_dir: crmDir ? resolve(crmDir) : (readJson(join(dir, 'book-meta.json'), {}).crm_dir ?? null), imported_at: new Date().toISOString() })

const tagged = book.filter((b) => FACETS.some((f) => f !== 'company' && b.tags[f]?.length)).length
for (const [src, n] of report) console.log(`${src}: ${n}`)
console.log(`В книжке: ${book.length} человек, с тегами: ${tagged}. Файл data/book.jsonl, он приватный и никуда не уходит.`)
console.log('Дальше: node scripts/build-index.mjs (быстро, по правилам) или /book-tag (точнее, модель читает контекст).')
