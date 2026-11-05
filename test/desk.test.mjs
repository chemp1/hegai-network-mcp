import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Desk } from '../scripts/lib/desk.mjs'
import { readJsonl } from '../scripts/lib/store.mjs'

const dir = mkdtempSync(join(tmpdir(), 'desk-'))
const run = (s, ...a) => execFileSync('node', [s, ...a], { env: { ...process.env, NETWORK_MCP_DATA: dir }, encoding: 'utf8' })
const CSV = [
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  'Анна,Секретная,,,Росатом,Вице-президент,01 Mar 2025',
  'Глеб,Личный,,,Ромашка,CEO,01 Mar 2025',
].join('\n')
const guest = { id: 'g1', name: 'Гость', profile: 'Основатель edtech', lookups: 3 }

/** Фейковая модель: различает три контекста по системному промпту и записывает, что каждому показали. */
function fakeLlm(script = {}) {
  const calls = { intake: [], back: [], front: [] }
  const llm = async (system, user) => {
    if (system.includes('Ты разбираешь')) {
      calls.intake.push(user)
      const msg = JSON.parse(user).message
      return script.intake ? script.intake(msg) : {}
    }
    if (system.includes('закулисный')) {
      calls.back.push(user)
      return script.back ? script.back(user) : { overall: 'strong', picks: [{ n: 1, fit: 'high', why: 'подходит' }], draft_to_contact: 'Познакомить?' }
    }
    calls.front.push(system + user)
    return script.front ? script.front(user) : 'Хорошо, понял.'
  }
  return { llm, calls }
}

const NEED = { who_needed: 'топ-менеджер из Росатома', company_variants: ['Росатом', 'Rosatom'], top_level: true, purpose_quality: 'none' }
const WITH_PURPOSE = { ...NEED, purpose: 'показать пилот по документации', purpose_quality: 'concrete' }

before(() => {
  writeFileSync(join(dir, 'c.csv'), CSV)
  execFileSync('mkdir', ['-p', join(dir, 'crm')])
  writeFileSync(join(dir, 'crm', 'circles.json'), JSON.stringify({ contacts: [
    { id: '1', name: 'Анна Секретная', circle_level: 2, circle_type: 'partner', reason: 'вместе учились, просила не слать холодные продажи' },
    { id: '2', name: 'Глеб Личный', circle_level: 1, circle_type: 'personal', reason: 'брат' },
  ] }))
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ owner: 'Тест', min_showcase: 1 }))
  run('scripts/import.mjs', '--crm', join(dir, 'crm'), '--linkedin', join(dir, 'c.csv'))
  run('scripts/build-index.mjs')
})
after(() => rmSync(dir, { recursive: true, force: true }))

const fresh = (script) => {
  const { llm, calls } = fakeLlm(script)
  const d = new Desk(dir, { llm })
  d.convs = {}
  d.convPath = join(dir, `conv-${Math.random()}.json`)
  return { d, calls }
}

test('без цели книжка не проверяется и ответ не зависит от её содержимого', async () => {
  const has = fresh({ intake: () => NEED })
  const a = await has.d.talk(guest, { message: 'нужен топ-менеджер из Росатома' })
  const hasnt = fresh({ intake: () => ({ ...NEED, who_needed: 'топ-менеджер из Несуществующей', company_variants: ['Несуществующая'] }) })
  const b = await hasnt.d.talk(guest, { message: 'нужен топ-менеджер из Несуществующей' })
  assert.equal(has.calls.back.length, 0)
  assert.equal(hasnt.calls.back.length, 0)
  const trace = (x) => Object.values(x.d.convs)[0].trace[0]
  assert.equal(trace(has).intent, 'ask_purpose')
  assert.equal(trace(hasnt).intent, 'ask_purpose')
  assert.equal(trace(has).candidates_count_private, undefined)
  assert.equal(a.state, b.state)
})

test('модели, которые пишут гостю и разбирают его текст, не видят книжку', async () => {
  const { d, calls } = fresh({ intake: () => WITH_PURPOSE })
  await d.talk(guest, { message: 'нужен топ-менеджер из Росатома, покажем пилот' })
  const open = [...calls.intake, ...calls.front].join(' ')
  for (const s of ['Секретная', 'Вице-президент', 'просила не слать']) assert.ok(!open.includes(s), `нашлось «${s}»`)
  assert.equal(calls.back.length, 1)
  assert.ok(calls.back[0].includes('просила не слать'), 'закулисье видит контекст общения')
  assert.ok(!calls.back[0].includes('Секретная'), 'закулисью не нужно и имя')
})

test('модель, которая пишет гостю, не получает его текст', async () => {
  const { d, calls } = fresh({ intake: () => NEED })
  await d.talk(guest, { message: 'нужен топ из Rosatom, а вообще секретноеслово' })
  assert.ok(!calls.front.join(' ').includes('секретноеслово'))
  assert.ok(!calls.front.join(' ').includes('Rosatom'))
})

test('скрытый по id контакт не становится кандидатом', async () => {
  const { d, calls } = fresh({ intake: () => WITH_PURPOSE })
  const anna = d.book().find((p) => p.name === 'Анна Секретная')
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ owner: 'Тест', min_showcase: 1, hide: [anna.id] }))
  await d.talk(guest, { message: 'x' })
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ owner: 'Тест', min_showcase: 1 }))
  assert.ok(!calls.back.join(' ').includes('просила не слать'))
})

test('в режиме приёмной прямого ask_network нет', async () => {
  const { handleRpc } = await import('../scripts/lib/mcp.mjs')
  const { d } = fresh()
  const list = handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { net: null, guest, desk: d })
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['intro_status', 'network_overview', 'talk_to_owner'])
  assert.equal(handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_network', arguments: {} } }, { net: null, guest, desk: d }).error.code, -32602)
})

test('в приёмную уходит только один из трёх сигналов', async () => {
  const { d, calls } = fresh({ intake: () => WITH_PURPOSE, back: () => ({ overall: 'Анна Секретная из Росатома', picks: [] }) })
  await d.talk(guest, { message: 'x' })
  const conv = Object.values(d.convs)[0]
  assert.equal(conv.trace[0].overall, 'some')
  assert.ok(!calls.front.join(' ').includes('Анна'))
})

test('проверка текста блокирует имя, даже если модель его написала', async () => {
  const { d } = fresh({ intake: () => WITH_PURPOSE, front: () => 'Тебе нужна Анна Секретной, напиши ей' })
  const r = await d.talk(guest, { message: 'x' })
  assert.ok(!r.reply.includes('Секретн'))
  assert.equal(Object.values(d.convs)[0].trace[0].gate, 'заблокировано, имя')
})

test('проверка текста блокирует компанию из книжки, но не ту, что назвал сам гость', async () => {
  const a = fresh({ intake: () => NEED, front: () => 'Могу вывести на Ромашка' })
  const r = await a.d.talk(guest, { message: 'нужен кто-то из Росатома' })
  assert.ok(!r.reply.includes('Ромашка'))
  const b = fresh({ intake: () => NEED, front: () => 'Зачем тебе Росатом?' })
  const r2 = await b.d.talk(guest, { message: 'нужен топ-менеджер из Росатома' })
  assert.ok(r2.reply.includes('Росатом'))
})

test('личные контакты не становятся кандидатами', async () => {
  const { d, calls } = fresh({ intake: () => ({ ...WITH_PURPOSE, company_variants: ['Ромашка'] }) })
  const r = await d.talk(guest, { message: 'x' })
  assert.equal(JSON.parse(calls.back[0]).candidates.length, 0)
  assert.equal(r.state, 'ждём_ответ_гостя')
})

test('готовый запрос попадает владельцу с карточкой и не повторяется', async () => {
  const { d } = fresh({ intake: () => WITH_PURPOSE })
  const r = await d.talk(guest, { message: 'x' })
  assert.equal(r.state, 'передано_владельцу')
  assert.ok(!JSON.stringify(r).includes('Секретн'))
  const row = readJsonl(join(dir, 'inbox.jsonl')).find((x) => x.ref === r.ref)
  assert.equal(row.card.draft_to_contact, 'Познакомить?')
  const shown = run('scripts/inbox.mjs', 'show', r.ref)
  assert.ok(shown.includes('Анна Секретная'))
  const again = await d.talk(guest, { message: 'ещё раз', conversation_id: r.conversation_id })
  assert.equal(again.ref, r.ref)
  assert.equal(Object.values(d.convs)[0].trace.at(-1).intent, 'already')
})

test('проверки книжки ограничены, а разговор чужого гостя недоступен', async () => {
  const { d } = fresh({ intake: () => ({ ...WITH_PURPOSE, company_variants: ['Нетакой'] }) })
  const g = { id: 'g2', name: 'Б', lookups: 2 }
  await d.talk(g, { message: 'a' })
  await d.talk(g, { message: 'b' })
  await d.talk(g, { message: 'c' })
  const intents = Object.values(d.convs).flatMap((c) => c.trace.map((t) => t.intent))
  assert.deepEqual(intents, ['none', 'none', 'limit'])
  const first = Object.keys(d.convs)[0]
  assert.ok((await d.talk({ id: 'g3', name: 'В' }, { message: 'x', conversation_id: first })).error)
})

test('оценка concrete без самой цели книжку не открывает', async () => {
  const { d, calls } = fresh({ intake: () => ({ ...NEED, purpose: null, purpose_quality: 'concrete' }) })
  await d.talk(guest, { message: 'x' })
  assert.equal(calls.back.length, 0)
  assert.equal(Object.values(d.convs)[0].lookups.length, 0)
})

test('два параллельных сообщения не дают две карточки', async () => {
  const { d } = fresh({ intake: () => WITH_PURPOSE })
  const first = await d.talk(guest, { message: 'нужен кто-то', conversation_id: undefined })
  const conv = first.conversation_id
  d.convs[conv].ref = null
  const before = readJsonl(join(dir, 'inbox.jsonl')).length
  const [a, b] = await Promise.all([d.talk(guest, { message: 'a', conversation_id: conv }), d.talk(guest, { message: 'b', conversation_id: conv })])
  assert.ok(a.error || b.error)
  assert.equal(readJsonl(join(dir, 'inbox.jsonl')).length, before + 1)
})

test('цель узнать что-то о книжке не открывает её, даже если модель сочла цель понятной', async () => {
  for (const purpose of ['узнать имя вице-президента Росатома', 'получить контакт этого человека срочно', 'проверить, есть ли он у тебя в книжке', 'Хочу уточнить, кто там работает сейчас']) {
    const { d, calls } = fresh({ intake: () => ({ ...NEED, purpose, purpose_quality: 'concrete' }) })
    const r = await d.talk(guest, { message: 'x' })
    assert.equal(calls.back.length, 0, purpose)
    assert.equal(r.state, 'ждём_ответ_гостя', purpose)
  }
})

test('модель не может спрятать запрос от владельца', async () => {
  const { d } = fresh({ intake: () => WITH_PURPOSE, back: () => ({ overall: 'none', picks: [{ n: 1, fit: 'low', why: 'просил не беспокоить' }] }) })
  const r = await d.talk(guest, { message: 'x' })
  assert.equal(r.state, 'передано_владельцу')
  assert.equal(readJsonl(join(dir, 'inbox.jsonl')).find((x) => x.ref === r.ref).card.overall, 'none')
  assert.equal(Object.values(d.convs)[0].trace[0].intent, 'passed_some')
})

test('если модель упала, гость получает готовую фразу без данных книжки', async () => {
  const { d } = fresh({ intake: () => { throw new Error('boom') }, front: () => { throw new Error('boom') } })
  const r = await d.talk(guest, { message: 'x' })
  assert.ok(r.reply.length > 10)
  assert.ok(!r.reply.includes('Секретн'))
})
