import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Desk } from '../scripts/lib/desk.mjs'
import { readJsonl } from '../scripts/lib/store.mjs'

const dir = mkdtempSync(join(tmpdir(), 'owner-'))
const run = (s, ...a) => execFileSync('node', [s, ...a], { env: { ...process.env, NETWORK_MCP_DATA: dir }, encoding: 'utf8' })
let platform, ui, port, ref, refFresh
let platformUp = true
const ORIGIN = 'https://hegai.example'
const get = (path, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: 'manual' })
const owner = { Cookie: 'other=1; session=owner-token' }
const decide = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...owner, ...headers }, body: JSON.stringify(body) })

before(async () => {
  writeFileSync(join(dir, 'c.csv'), 'First Name,Last Name,URL,Email Address,Company,Position,Connected On\nАнна,Секретная,,,Росатом,Вице-президент,01 Mar 2025\n')
  execFileSync('mkdir', ['-p', join(dir, 'crm')])
  writeFileSync(join(dir, 'crm', 'circles.json'), JSON.stringify({ contacts: [{ id: '1', name: 'Анна Секретная', circle_level: 2, circle_type: 'partner', reason: 'вместе учились' }] }))
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ owner: 'Тест', min_showcase: 1 }))
  run('scripts/import.mjs', '--crm', join(dir, 'crm'), '--linkedin', join(dir, 'c.csv'))
  run('scripts/build-index.mjs')
  const llm = async (system) => {
    if (system.includes('Ты разбираешь')) return { who_needed: 'топ из Росатома', company_variants: ['Росатом'], purpose: 'показать пилот по документации за две недели', purpose_quality: 'concrete' }
    if (system.includes('закулисный')) return { overall: 'strong', picks: [{ n: 1, fit: 'high', why: 'подходит' }], draft_to_contact: 'Познакомить?' }
    return 'Передал.'
  }
  ref = (await new Desk(dir, { llm }).talk({ id: 'g1', name: 'Гость' }, { message: '<script>alert(1)</script>' })).ref
  refFresh = (await new Desk(dir, { llm }).talk({ id: 'g2', name: 'Гость 2' }, { message: 'x' })).ref

  platform = createServer((req, res) => {
    if (!platformUp) { res.writeHead(500); return res.end('{}') }
    const c = req.headers.cookie || ''
    if (c === 'session=owner-token') { res.writeHead(200); return res.end(JSON.stringify({ id: 'owner-id' })) }
    if (c === 'session=member-token') { res.writeHead(200); return res.end(JSON.stringify({ id: 'member-id' })) }
    res.writeHead(401); res.end('{}')
  })
  await new Promise((r) => platform.listen(0, '127.0.0.1', r))
  port = 17000 + Math.floor(Math.random() * 1000)
  ui = spawn('node', ['scripts/owner-ui.mjs', '--port', String(port)], {
    env: { ...process.env, NETWORK_MCP_DATA: dir, NETWORK_OWNER_ID: 'owner-id', NETWORK_OWNER_VERIFY_URL: `http://127.0.0.1:${platform.address().port}/me`, NETWORK_OWNER_COOKIE: 'session', NETWORK_OWNER_ORIGIN: ORIGIN },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((r) => ui.stdout.once('data', r))
})
after(() => {
  ui?.kill()
  platform?.close()
  rmSync(dir, { recursive: true, force: true })
})

test('без куки, с чужой и с неверной кукой данных нет', async () => {
  for (const [headers, code] of [[{}, 401], [{ Cookie: 'session=bad' }, 401], [{ Cookie: 'session=member-token' }, 403]]) {
    const page = await get('/', headers)
    assert.equal(page.status, code)
    const html = await page.text()
    assert.ok(!html.includes('fetch('), 'закрытая страница без кода приложения')
    assert.equal((await get('/state', headers)).status, code)
  }
})

test('владелец видит имена и карточку', async () => {
  assert.equal((await get('/', owner)).status, 200)
  const s = await (await get('/state', owner)).json()
  const r = s.requests.find((x) => x.ref === ref)
  assert.equal(r.candidates[0].name, 'Анна Секретная')
  assert.equal(r.draft, 'Познакомить?')
})

test('страница защищена от кода в тексте гостя', async () => {
  const res = await get('/', owner)
  const csp = res.headers.get('content-security-policy')
  const html = await res.text()
  const nonce = /nonce="([^"]+)"/.exec(html)[1]
  assert.ok(csp.includes(`script-src 'nonce-${nonce}'`))
  assert.ok(!/script-src[^;]*unsafe/.test(csp))
  assert.ok(csp.includes("frame-ancestors 'none'"))
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(html))
  const again = /nonce="([^"]+)"/.exec(await (await get('/', owner)).text())[1]
  assert.notEqual(nonce, again)
})

test('изменения только с нашего адреса и только в JSON', async () => {
  assert.equal((await decide({ ref, decision: 'yes' }, { Origin: 'https://evil.example' })).status, 403)
  const noOrigin = await fetch(`http://127.0.0.1:${port}/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...owner }, body: '{}' })
  assert.equal(noOrigin.status, 403)
  assert.equal((await decide({ ref, decision: 'yes' }, { 'Content-Type': 'text/plain' })).status, 415)
  assert.equal((await decide({ ref, decision: 'yes' }, { Cookie: 'session=member-token' })).status, 403)
  assert.equal((await decide({ ref: 'q_nope', decision: 'yes' })).status, 404)
  assert.equal((await decide({ ref, decision: 'maybe' })).status, 400)
})

test('второе решение не переписывает первое', async () => {
  const g = await decide({ ref, decision: 'yes', message: 'Спрошу сегодня' })
  assert.equal(g.status, 200)
  assert.equal((await decide({ ref, decision: 'yes', message: '' })).status, 200)
  assert.equal((await decide({ ref, decision: 'no', message: 'другое' })).status, 410)
  assert.equal(readJsonl(join(dir, 'decisions.jsonl')).at(-1).message, 'Спрошу сегодня')
})

test('имя контакта гостю только после подтверждения', async () => {
  const blocked = await decide({ ref: refFresh, decision: 'yes', message: 'Спрошу Анна сегодня' })
  assert.equal(blocked.status, 409)
  assert.deepEqual((await blocked.json()).names, ['Анна Секретная'])
  assert.equal(readJsonl(join(dir, 'decisions.jsonl')).filter((d) => d.ref === refFresh).length, 0)
  const s = await (await get('/state', owner)).json()
  assert.equal(s.requests.find((x) => x.ref === ref).status, 'согласовано')
})

test('платформа упала: экран закрыт, а не открыт', async () => {
  platformUp = false
  const fresh = { Cookie: 'session=owner-token-unseen' }
  assert.equal((await get('/state', fresh)).status, 503)
  assert.equal((await get('/', fresh)).status, 503)
  platformUp = true
})

test('имя в падеже тоже ловится', async () => {
  for (const message of ['Передам Анне', 'Спрошу у Анны Секретной', 'Спрошу кого-нибудь в Росатоме']) {
    assert.equal((await decide({ ref: refFresh, decision: 'no', message })).status, 409, message)
  }
})

test('выход из платформы закрывает экран сразу', async () => {
  const before = { Cookie: 'session=owner-token' }
  assert.equal((await get('/state', before)).status, 200)
  platformUp = false
  assert.equal((await get('/state', before)).status, 503)
  platformUp = true
})

test('кука не уходит на чужой адрес', () => {
  let code = 0
  try {
    execFileSync('node', ['scripts/owner-ui.mjs', '--port', '1'], { env: { ...process.env, NETWORK_MCP_DATA: dir, NETWORK_OWNER_ID: 'x', NETWORK_OWNER_VERIFY_URL: 'http://evil.example/me', NETWORK_OWNER_COOKIE: 'session', NETWORK_OWNER_ORIGIN: ORIGIN }, stdio: 'ignore' })
  } catch (e) {
    code = e.status
  }
  assert.equal(code, 1)
})

test('режим без id: платформа сама отвечает 200 только владельцу', async () => {
  const verifySrv = createServer((req, res) => {
    const c = req.headers.cookie || ''
    res.writeHead(c === 'session=owner-token' ? 200 : c === 'session=member-token' ? 403 : 401)
    res.end('ok')
  })
  await new Promise((r) => verifySrv.listen(0, '127.0.0.1', r))
  const p2 = 16000 + Math.floor(Math.random() * 900)
  const env = { ...process.env, NETWORK_MCP_DATA: dir, NETWORK_OWNER_VERIFY_URL: `http://127.0.0.1:${verifySrv.address().port}/verify`, NETWORK_OWNER_COOKIE: 'session', NETWORK_OWNER_ORIGIN: ORIGIN }
  delete env.NETWORK_OWNER_ID
  const proc = spawn('node', ['scripts/owner-ui.mjs', '--port', String(p2)], { env, stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((r) => proc.stdout.once('data', r))
  const at = (headers) => fetch(`http://127.0.0.1:${p2}/state`, { headers })
  try {
    assert.equal((await at({ Cookie: 'session=owner-token' })).status, 200)
    assert.equal((await at({ Cookie: 'session=member-token' })).status, 403)
    assert.equal((await at({ Cookie: 'session=bad' })).status, 401)
    assert.equal((await at({})).status, 401)
  } finally {
    proc.kill()
    verifySrv.close()
  }
})

test('сервис гостей про экран не знает, код экрана не отправляет сообщений', () => {
  const code = readFileSync(new URL('../scripts/owner-ui.mjs', import.meta.url), 'utf8')
  assert.ok(!/api\.telegram|sendMessage|smtp/i.test(code))
})
