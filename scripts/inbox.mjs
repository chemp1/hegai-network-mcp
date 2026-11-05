#!/usr/bin/env node
/**
 * Рабочий стол владельца. Только здесь теги и запросы встречаются с именами.
 *   node scripts/inbox.mjs                       входящие запросы на интро
 *   node scripts/inbox.mjs show <ref>            запрос и кандидаты с именами
 *   node scripts/inbox.mjs decide <ref> yes|no [--message "что увидит гость"]
 *   node scripts/inbox.mjs log [--guest "Имя"]   кто и что спрашивал
 * Отправки здесь нет: написать контакту и познакомить людей ты решаешь и делаешь сам.
 */
import { join } from 'node:path'
import { appendJsonl, dataDir, indexKey, readJson, readJsonl, secretFor } from './lib/store.mjs'

const [cmd, a, b, ...rest] = process.argv.slice(2)
const all = process.argv.slice(2)
const opt = (key) => {
  const i = all.indexOf(`--${key}`)
  return i >= 0 ? all[i + 1] : undefined
}
const dir = dataDir(opt('data'))
const inbox = readJsonl(join(dir, 'inbox.jsonl'))
const decisions = readJsonl(join(dir, 'decisions.jsonl'))
const statusOf = (r) => decisions.filter((d) => d.ref === r.ref).at(-1)?.status || r.status

// Текст гостя показываем в явной рамке: это данные, а не инструкции для модели владельца.
const guestText = (s) => `<guest_text>${String(s ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replaceAll('<', '‹')}</guest_text>`

if (!cmd || cmd === 'list') {
  const open = inbox.filter((r) => statusOf(r) === 'ждёт_владельца')
  if (!open.length) console.log('Новых запросов нет.')
  for (const r of open) console.log(`${r.ref}  ·  ${r.guest_name}  ·  ${r.ts.slice(0, 16)}\n  ${guestText(r.why)}\n`)
} else if (cmd === 'show' && a) {
  const r = inbox.find((x) => x.ref === a)
  if (!r) { console.error('Нет такого ref.'); process.exit(1) }
  const q = readJsonl(join(dir, 'refs.jsonl')).find((x) => x.ref === a)
  const secret = secretFor(dir)
  const byKey = new Map(readJsonl(join(dir, 'book.jsonl')).map((p) => [indexKey(secret, p.id), p]))
  console.log(`Гость: ${r.guest_name}. Статус: ${statusOf(r)}. Ответ сервера: ${q?.answer}.`)
  console.log(`Кто: ${guestText(r.who_i_am)}`)
  console.log(`Зачем: ${guestText(r.why)}`)
  if (r.offer) console.log(`Что предлагает: ${guestText(r.offer)}`)
  console.log(`Вопрос: ${guestText(q?.need)}`)
  console.log(`Теги запроса: ${(q?.tags || []).map((t) => t.tag).join(', ')}\n\nКандидаты:`)
  for (const k of q?.keys || []) {
    const p = byKey.get(k)
    if (!p) continue
    const parts = [p.title, p.company, p.city].filter(Boolean).join(', ')
    console.log(`- ${p.name}${parts ? ` (${parts})` : ''}${p.circle ? `, круг ${p.circle}` : ''}${p.tg ? `, @${p.tg}` : ''}`)
  }
} else if (cmd === 'decide' && a && (b === 'yes' || b === 'no')) {
  if (!inbox.find((x) => x.ref === a)) { console.error('Нет такого ref.'); process.exit(1) }
  appendJsonl(join(dir, 'decisions.jsonl'), {
    ref: a,
    ts: new Date().toISOString(),
    status: b === 'yes' ? 'согласовано' : 'отказ',
    message: opt('message') || null,
  })
  console.log(`Записано. Гость увидит статус через intro_status${opt('message') ? ' и твоё сообщение' : ''}.`)
} else if (cmd === 'log') {
  const guests = Object.values(readJson(join(dir, 'guests.json'), {}))
  const nameOf = (id) => guests.find((g) => g.id === id)?.name || id
  const filter = opt('guest')
  const rows = readJsonl(join(dir, 'log.jsonl')).filter((r) => !filter || nameOf(r.guest) === filter)
  for (const r of rows.slice(-200)) {
    console.log(`${r.ts.slice(0, 16)}  ${nameOf(r.guest)}  ${r.tool}  ${r.answer || ''}  ${guestText(r.need || r.ref)}`)
  }
  const perGuest = {}
  for (const r of rows) if (r.tool === 'ask_network') perGuest[nameOf(r.guest)] = (perGuest[nameOf(r.guest)] || 0) + 1
  console.log('\nВопросов по гостям:', perGuest)
} else {
  console.error('Команды: list, show <ref>, decide <ref> yes|no [--message ...], log [--guest ...]')
  process.exit(1)
}
