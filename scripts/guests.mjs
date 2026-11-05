#!/usr/bin/env node
/**
 * Гости книжки: у каждого свой токен, отозвать можно любого отдельно.
 *   node scripts/guests.mjs add "Андрей" [--url https://адрес/mcp] [--expires 8h] [--queries 30] [--intros 3]
 *   node scripts/guests.mjs list
 *   node scripts/guests.mjs revoke "Андрей"
 * На диске лежит только sha256 от токена: сам токен показывается один раз.
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { dataDir, hashToken, readJson, writeJson } from './lib/store.mjs'

const [cmd, name, ...rest] = process.argv.slice(2)
const opt = (key) => {
  const i = rest.indexOf(`--${key}`)
  return i >= 0 ? rest[i + 1] : undefined
}
const dir = dataDir(opt('data'))
const path = join(dir, 'guests.json')
const guests = readJson(path, {})

function parseExpires(s) {
  if (!s) return undefined
  const m = /^(\d+)([hd])$/.exec(s)
  if (!m) throw new Error('Срок: 8h или 30d')
  return new Date(Date.now() + Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 86_400_000)).toISOString()
}

if (cmd === 'add' && name) {
  const token = `nb_${randomBytes(32).toString('base64url')}`
  const id = `g_${randomBytes(6).toString('base64url')}`
  guests[hashToken(token)] = {
    id,
    name,
    created: new Date().toISOString(),
    expires: parseExpires(opt('expires')),
    queries: opt('queries') ? Number(opt('queries')) : undefined,
    intros: opt('intros') ? Number(opt('intros')) : undefined,
  }
  writeJson(path, guests)
  const url = opt('url') || readJson(join(dir, 'public-url.json'), {}).url || 'https://АДРЕС_ТУННЕЛЯ/mcp'
  const server = (process.env.NETWORK_MCP_NAME || 'book').replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  console.log(`Гость «${name}» добавлен. Токен показан один раз. Перешли ему эту команду лично:\n`)
  console.log(`claude mcp add --transport http ${server} "${url}" --header "Authorization: Bearer ${token}"\n`)
} else if (cmd === 'list') {
  const rows = Object.values(guests)
  if (!rows.length) console.log('Гостей пока нет.')
  for (const g of rows) {
    const state = g.revoked ? 'отозван' : g.expires && Date.parse(g.expires) < Date.now() ? 'истёк' : 'активен'
    console.log(`${g.name}  ·  ${state}  ·  ${g.id}${g.expires ? `  ·  до ${g.expires}` : ''}`)
  }
} else if (cmd === 'revoke' && name) {
  const hit = Object.values(guests).filter((g) => (g.name === name || g.id === name) && !g.revoked)
  if (!hit.length) {
    console.error(`Активного гостя «${name}» нет.`)
    process.exit(1)
  }
  for (const g of hit) g.revoked = new Date().toISOString()
  writeJson(path, guests)
  console.log(`Отозвано: ${hit.length}. Токен перестал работать сразу, сервер перезапускать не нужно.`)
} else {
  console.error('Команды: add "Имя" [--url ...] [--expires 8h], list, revoke "Имя"')
  process.exit(1)
}
