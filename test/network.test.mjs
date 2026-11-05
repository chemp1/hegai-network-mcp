import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Network, ANSWERS, TOOLS } from '../scripts/lib/network.mjs'
import { handleRpc } from '../scripts/lib/mcp.mjs'
import { readJsonl } from '../scripts/lib/store.mjs'
import { loadVocabEntries, makeMatcher } from '../scripts/lib/text.mjs'

const dir = mkdtempSync(join(tmpdir(), 'book-'))
const run = (script, ...args) => execFileSync('node', [script, ...args], { env: { ...process.env, NETWORK_MCP_DATA: dir }, encoding: 'utf8' })

const CSV = [
  'Notes:', '"explanation line"', '',
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  'Анна,Секретная,https://www.linkedin.com/in/anna,,Ромашка,"Венчурный инвестор, Дубай",01 Mar 2025',
  'Борис,Закрытый,https://www.linkedin.com/in/boris,,Ромашка,"Директолог, Москва",01 Mar 2025',
  'Вера,Приватная,https://www.linkedin.com/in/vera,,Вектор,"Юрист, финтех, Берлин",01 Mar 2025',
  'Глеб,Личный,https://www.linkedin.com/in/gleb,,Вектор,"Инвестор, Дубай",01 Mar 2025',
  'Дарья,Скрытая,,,,"",01 Mar 2025',
].join('\n')
const SECRET_STRINGS = ['Анна', 'Секретная', 'Борис', 'Закрытый', 'Вера', 'Приватная', 'Глеб', 'Личный', 'Ромашка', 'Вектор', 'linkedin.com', 'c_']

let net
const guest = { id: 'g_test', name: 'Гость' }

before(() => {
  writeFileSync(join(dir, 'c.csv'), CSV)
  run('dev/make-fixture.mjs', join(dir, 'demo'))
  const crm = join(dir, 'crm')
  execFileSync('mkdir', ['-p', crm])
  writeFileSync(join(crm, 'circles.json'), JSON.stringify({ contacts: [
    { id: '1', name: 'Анна Секретная', circle_level: 1, circle_type: 'partner', reason: 'работаем' },
    { id: '2', name: 'Глеб Личный', circle_level: 1, circle_type: 'personal', reason: 'брат' },
  ] }))
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ owner: 'Тест', min_showcase: 1 }))
  run('scripts/import.mjs', '--crm', crm, '--linkedin', join(dir, 'c.csv'))
  run('scripts/build-index.mjs')
  net = new Network(dir)
})
after(() => rmSync(dir, { recursive: true, force: true }))

test('индекс не содержит имён, компаний и ссылок', () => {
  const blob = readFileSync(join(dir, 'index.jsonl'), 'utf8') + readFileSync(join(dir, 'showcase.json'), 'utf8')
  for (const s of SECRET_STRINGS.filter((x) => x !== 'c_')) assert.ok(!blob.includes(s), `в индексе нашлось «${s}»`)
})

test('личное и пустое в индекс не попадают', () => {
  const index = readJsonl(join(dir, 'index.jsonl'))
  assert.equal(index.length, 3) // Анна, Борис, Вера. Глеб личный, Дарья без тегов.
})

test('четыре ответа', () => {
  assert.equal(net.ask(guest, { need: 'нужен венчурный инвестор в Дубае' }).answer, ANSWERS.yes) // Анна, круг 1
  assert.equal(net.ask(guest, { need: 'ищу директолога в Москве' }).answer, ANSWERS.similar) // Борис, только LinkedIn
  assert.equal(net.ask(guest, { need: 'инвестор', tags: ['инвестор', 'сша'] }).answer, ANSWERS.similar) // роль есть, города нет
  assert.equal(net.ask(guest, { need: 'нужен кто-нибудь хороший' }).answer, ANSWERS.clarify)
  assert.equal(net.ask(guest, { need: 'кто есть в Дубае' }).answer, ANSWERS.clarify)
  assert.equal(net.ask(guest, { need: 'нужен дизайнер' }).answer, ANSWERS.no)
})

test('поиск по имени и компании не работает', () => {
  assert.equal(net.ask(guest, { need: 'Анна Секретная' }).answer, ANSWERS.clarify)
  assert.equal(net.ask(guest, { need: 'кто работает в Ромашке' }).answer, ANSWERS.clarify)
  assert.equal(net.ask(guest, { need: 'x', tags: ['Ромашка'] }).answer, ANSWERS.clarify)
})

test('ни один ответ не содержит имён и ключей контактов', () => {
  const index = readJsonl(join(dir, 'index.jsonl'))
  const a = net.ask(guest, { need: 'венчурный инвестор в Дубае' })
  const blob = JSON.stringify([
    a,
    net.overview(),
    net.requestIntro(guest, { ref: a.ref, who_i_am: 'Фаундер сервиса для юристов', why: 'Ищу инвестора на посевной раунд в ОАЭ, нужен совет', offer: 'интересная сделка' }),
    net.introStatus(guest, {}),
  ])
  for (const s of SECRET_STRINGS.filter((x) => x !== 'c_')) assert.ok(!blob.includes(s), `в ответе нашлось «${s}»`)
  for (const row of index) assert.ok(!blob.includes(row.k), 'в ответе нашёлся ключ контакта')
})

test('ref чужого гостя не работает', () => {
  const a = net.ask(guest, { need: 'венчурный инвестор в Дубае' })
  const other = { id: 'g_other', name: 'Другой' }
  assert.ok(net.requestIntro(other, { ref: a.ref, who_i_am: 'Кто-то очень важный', why: 'Хочу чужой запрос на интро перехватить целиком' }).error)
})

test('короткое описание не принимается, повтор не дублирует', () => {
  const a = net.ask(guest, { need: 'венчурный инвестор в Дубае' })
  assert.ok(net.requestIntro(guest, { ref: a.ref, who_i_am: 'я', why: 'надо' }).error)
  const args = { ref: a.ref, who_i_am: 'Фаундер сервиса для юристов', why: 'Ищу инвестора на посевной раунд в ОАЭ, нужен совет' }
  net.requestIntro(guest, args)
  net.requestIntro(guest, args)
  assert.equal(readJsonl(join(dir, 'inbox.jsonl')).filter((r) => r.ref === a.ref).length, 1)
})

test('лимит вопросов в сутки', () => {
  const g = { id: 'g_limit', name: 'Лимит', queries: 2 }
  net.ask(g, { need: 'юрист' })
  net.ask(g, { need: 'юрист' })
  assert.ok(net.ask(g, { need: 'юрист' }).error)
})

test('решение владельца видно гостю', () => {
  const g = { id: 'g_dec', name: 'Решение' }
  const a = net.ask(g, { need: 'венчурный инвестор в Дубае' })
  net.requestIntro(g, { ref: a.ref, who_i_am: 'Фаундер сервиса для юристов', why: 'Ищу инвестора на посевной раунд в ОАЭ, нужен совет' })
  run('scripts/inbox.mjs', 'decide', a.ref, 'yes', '--message', 'спрошу его сегодня')
  const s = net.introStatus(g, { ref: a.ref }).requests[0]
  assert.equal(s.status, 'согласовано')
  assert.equal(s.message, 'спрошу его сегодня')
  const shown = run('scripts/inbox.mjs', 'show', a.ref)
  assert.ok(shown.includes('Анна Секретная'), 'владелец видит имя')
  assert.ok(shown.includes('<guest_text>'), 'текст гостя в рамке')
})

test('сервер не читает приватную книжку', () => {
  for (const f of ['server.mjs', 'lib/network.mjs', 'lib/mcp.mjs']) {
    const code = readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
    assert.ok(!code.includes('book.jsonl'), `${f} упоминает book.jsonl`)
    assert.ok(!code.includes("'secret'"), `${f} упоминает secret`)
  }
})

test('словарь ловит падежи и не цепляет лишнее', () => {
  const find = makeMatcher(loadVocabEntries())
  const tags = (s) => find(s).map((x) => x.tag).sort()
  assert.deepEqual(tags('ищу инвесторов в Германии'), ['германия', 'инвестор'])
  assert.deepEqual(tags('нужен директолог'), ['трафик'])
  assert.deepEqual(tags('холодные продажи'), ['холодные продажи'])
  assert.deepEqual(tags('Product Manager в финтехе'), ['продакт', 'финтех'])
  assert.deepEqual(tags('просто человек'), [])
})

test('управляющие символы гостя вырезаются', () => {
  const g = { id: 'g_ansi', name: 'ANSI' }
  const a = net.ask(g, { need: 'венчурный инвестор в Дубае' })
  net.requestIntro(g, { ref: a.ref, who_i_am: 'Фаундер \u001b[2Jсервиса', why: 'Ищу инвестора на посевной раунд \u001b]52;c;AAAA\u0007 в ОАЭ сейчас' })
  const row = readJsonl(join(dir, 'inbox.jsonl')).find((r) => r.ref === a.ref)
  assert.ok(!/\u001b|\u0007/.test(row.who_i_am + row.why))
})

test('свои теги и правка книжки не протаскивают чужое имя и редкий признак', () => {
  const d2 = mkdtempSync(join(tmpdir(), 'book2-'))
  const run2 = (script, ...args) => execFileSync('node', [script, ...args], { env: { ...process.env, NETWORK_MCP_DATA: d2 }, encoding: 'utf8' })
  writeFileSync(join(d2, 'c.csv'), CSV)
  writeFileSync(join(d2, 'policy.json'), JSON.stringify({ owner: 'Тест', min_showcase: 1, hide: ['Закрытый Борис'] }))
  run2('scripts/import.mjs', '--linkedin', join(d2, 'c.csv'))
  const book = readJsonl(join(d2, 'book.jsonl'))
  const anna = book.find((b) => b.name === 'Анна Секретная')
  execFileSync('mkdir', ['-p', join(d2, 'tag-verdicts')])
  writeFileSync(join(d2, 'tag-verdicts', 'b.json'), JSON.stringify([{ id: anna.id, role: ['инвестор', 'Партнёр Елисея Загадкина'], geo: ['клиника Блохина'], other: ['ромашка'] }]))
  run2('scripts/tag-apply.mjs')
  run2('scripts/build-index.mjs')
  const blob = readFileSync(join(d2, 'index.jsonl'), 'utf8')
  for (const x of ['Загадкин', 'Блохин', 'ромашка', 'Ромашка']) assert.ok(!blob.includes(x), `в индексе нашлось «${x}»`)
  assert.equal(readJsonl(join(d2, 'index.jsonl')).length, 3, 'Борис скрыт по имени в другом порядке слов, Дарья без тегов')
  const n2 = new Network(d2)
  assert.equal(n2.ask(guest, { need: 'клиника Блохина' }).answer, ANSWERS.clarify)
  rmSync(d2, { recursive: true, force: true })
})

test('повторный импорт не теряет круг и личное', () => {
  const d3 = mkdtempSync(join(tmpdir(), 'book3-'))
  const run3 = (script, ...args) => execFileSync('node', [script, ...args], { env: { ...process.env, NETWORK_MCP_DATA: d3 }, encoding: 'utf8' })
  execFileSync('mkdir', ['-p', join(d3, 'crm')])
  writeFileSync(join(d3, 'crm', 'circles.json'), JSON.stringify({ contacts: [{ id: '2', name: 'Глеб Личный', circle_level: 1, circle_type: 'personal' }] }))
  writeFileSync(join(d3, 'c.csv'), CSV)
  run3('scripts/import.mjs', '--crm', join(d3, 'crm'))
  run3('scripts/import.mjs', '--linkedin', join(d3, 'c.csv'))
  const gleb = readJsonl(join(d3, 'book.jsonl')).find((b) => b.name === 'Глеб Личный')
  assert.equal(gleb.type, 'personal')
  assert.equal(gleb.circle, 1)
  rmSync(d3, { recursive: true, force: true })
})

test('MCP: протокол', () => {
  const ctx = { net, guest }
  const init = handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, ctx)
  assert.equal(init.result.protocolVersion, '2025-06-18')
  assert.equal(handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null)
  const list = handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx)
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name))
  const call = handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ask_network', arguments: { need: 'нужен дизайнер' } } }, ctx)
  assert.equal(JSON.parse(call.result.content[0].text).answer, ANSWERS.no)
  assert.equal(handleRpc({ jsonrpc: '2.0', id: 4, method: 'nope' }, ctx).error.code, -32601)
})

test('HTTP: токен, Origin, отзыв', async () => {
  const out = run('scripts/guests.mjs', 'add', 'Тестовый гость', '--url', 'http://x/mcp')
  const token = /Bearer (nb_[\w-]+)/.exec(out)[1]
  const port = 18000 + Math.floor(Math.random() * 1000)
  const proc = spawn('node', ['scripts/server.mjs', '--port', String(port)], { env: { ...process.env, NETWORK_MCP_DATA: dir }, stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((res) => proc.stdout.once('data', res))
  const url = `http://127.0.0.1:${port}/mcp`
  const rpc = { jsonrpc: '2.0', id: 1, method: 'ping' }
  const post = (headers) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(rpc) })
  try {
    assert.equal((await post({})).status, 401)
    assert.equal((await post({ Authorization: 'Bearer nb_wrong' })).status, 401)
    assert.equal((await post({ Authorization: `Bearer ${token}` })).status, 200)
    assert.equal((await post({ Authorization: `Bearer ${token}`, Origin: 'https://evil.example' })).status, 403)
    assert.equal((await fetch(url)).status, 405)
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const bad = await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: { toString: 1 } } }) })
    assert.equal(bad.status, 200)
    assert.equal((await post({ Authorization: `Bearer ${token}` })).status, 200, 'сервер пережил кривой вызов')
    run('scripts/guests.mjs', 'revoke', 'Тестовый гость')
    assert.equal((await post({ Authorization: `Bearer ${token}` })).status, 401)
  } finally {
    proc.kill()
  }
})
