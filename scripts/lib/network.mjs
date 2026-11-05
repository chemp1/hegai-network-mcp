/**
 * Логика ответов. Единственный файл, который решает, что увидит гость.
 * Читает только index.jsonl, showcase.json, policy и guests. В book.jsonl не ходит.
 * Наружу уходят: метка из четырёх, совпавшие теги самого запроса, ref. Ни счётчиков, ни ключей контактов.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { appendJsonl, readJson, readJsonl, readPolicy } from './store.mjs'
import { FACETS, loadVocabEntries, makeMatcher, norm } from './text.mjs'

export const ANSWERS = {
  yes: 'могу_познакомить',
  similar: 'есть_похожие',
  clarify: 'нужно_уточнить',
  no: 'нет',
}

const TEXT = {
  [ANSWERS.yes]: 'Есть подходящий человек, которого владелец знает лично. Можно запросить интро через request_intro.',
  [ANSWERS.similar]: 'Есть похожие, но совпадение неполное или связь слабая. Интро не обещано. Можно запросить, владелец решит сам.',
  [ANSWERS.clarify]: 'Запрос слишком общий или не распознан. Уточни и спроси ещё раз.',
  [ANSWERS.no]: 'В этой книжке такого не нашлось.',
}

const CLARIFY_NO_TAGS = 'Не понял, кого ищешь. Назови роль и, если важно, отрасль или город. Подходящие теги есть в network_overview. Имена здесь не ищутся.'
const CLARIFY_NO_ROLE = 'Город или отрасль без роли слишком широко. Кто нужен: инвестор, маркетолог, юрист?'
const CLARIFY_BROAD = 'Таких людей много. Чтобы выбрать одного, уточни отрасль, город или задачу.'

const MAX_TEXT = 1000
// Управляющие символы гостя не должны доехать до терминала владельца: ANSI умеет подменять вывод.
const clip = (s, n = MAX_TEXT) => String(s ?? '').replace(/[\p{Cc}\p{Cf}]+/gu, ' ').slice(0, n).trim()
const dayOf = (ts) => ts.slice(0, 10)
const STOP_REQUEST_DAYS = 30

export class Network {
  constructor(dir) {
    this.dir = dir
    this.loadedAt = 0
    this.reload()
  }

  path(name) {
    return join(this.dir, name)
  }

  /** Индекс перечитывается сам, когда владелец его пересобрал. Перезапускать сервер не нужно. */
  reload() {
    const p = this.path('index.jsonl')
    const m = existsSync(p) ? statSync(p).mtimeMs : 0
    if (m === this.loadedAt && this.index) return
    this.loadedAt = m
    this.index = readJsonl(p)
    this.policy = readPolicy(this.dir)
    this.showcase = readJson(this.path('showcase.json'), [])
    const entries = loadVocabEntries()
    // Распознаём словарь, витрину и компании, если владелец их открыл. Редкие теги вне витрины
    // не распознаём: иначе понятый или непонятый запрос сам подтверждал бы, что такой тег есть.
    const known = new Set(this.showcase.map((s) => `${s.facet}:${s.tag}`))
    for (const key of known) {
      const [facet, ...rest] = key.split(':')
      entries.push({ facet, tag: rest.join(':'), alias: rest.join(':') })
    }
    if (this.policy.share_companies) {
      const companies = new Set(this.index.flatMap((row) => row.company || []))
      for (const c of companies) entries.push({ facet: 'company', tag: c, alias: c })
    }
    this.find = makeMatcher(entries)
  }

  log(row) {
    appendJsonl(this.path('log.jsonl'), { ts: new Date().toISOString(), ...row })
  }

  /** Лимиты считаем по журналу, поэтому они переживают перезапуск сервера. */
  usedToday(guest, tool) {
    const today = dayOf(new Date().toISOString())
    return readJsonl(this.path('log.jsonl')).filter((r) => r.guest === guest.id && r.tool === tool && dayOf(r.ts) === today).length
  }

  overview() {
    this.reload()
    const { owner, about, rules } = this.policy
    return {
      owner: clip(owner, 80),
      about: clip(about, 400),
      rules: clip(rules, 400),
      tags: this.showcase,
      how_to_ask: 'Выбери подходящие теги из tags и передай их в ask_network вместе с одной фразой о задаче. Имена людей в этой книжке не ищутся. Владелец видит твои вопросы.',
    }
  }

  ask(guest, { need, tags } = {}) {
    this.reload()
    const limit = guest.queries ?? this.policy.daily_queries_per_guest
    if (this.usedToday(guest, 'ask_network') >= limit) {
      return { error: `На сегодня вопросы закончились: лимит ${limit} в сутки. Вернись завтра или попроси владельца поднять лимит.` }
    }
    const needText = clip(need, 500)
    const tagList = Array.isArray(tags) ? tags.map((t) => clip(t, 60)).slice(0, 12) : []
    const found = this.find([...tagList, needText].join(' . '))
    const byFacet = {}
    for (const { facet, tag } of found) (byFacet[facet] ||= []).push(tag)
    const facets = Object.keys(byFacet)
    const result = this.decide(byFacet, facets)

    let ref
    if (result.answer === ANSWERS.yes || result.answer === ANSWERS.similar) {
      ref = `q_${randomBytes(9).toString('base64url')}`
      appendJsonl(this.path('refs.jsonl'), {
        ref,
        guest: guest.id,
        ts: new Date().toISOString(),
        need: needText,
        tags: found,
        keys: result.keys,
        answer: result.answer,
      })
    }
    this.log({ guest: guest.id, tool: 'ask_network', need: needText, tags: found, answer: result.answer })

    return {
      answer: result.answer,
      meaning: TEXT[result.answer],
      understood: found.map((f) => f.tag),
      not_matched: result.missed || [],
      ...(result.question ? { question: result.question } : {}),
      ...(ref ? { ref } : {}),
    }
  }

  decide(byFacet, facets) {
    if (!facets.length) return { answer: ANSWERS.clarify, question: CLARIFY_NO_TAGS }

    // Город или отрасль сами по себе просто перечисляют книжку.
    const anchor = facets.some((f) => f === 'role' || f === 'skill' || f === 'company' || f === 'other')
    if (!anchor) return { answer: ANSWERS.clarify, question: CLARIFY_NO_ROLE }

    const hit = (row, f) => (row[f] || []).some((t) => byFacet[f].includes(t))
    const full = this.index.filter((row) => facets.every((f) => hit(row, f)))
    const warm = full.filter((r) => r.warmth === 'warm')

    if (warm.length) {
      const broad = facets.length === 1 && warm.length >= this.policy.broad_threshold
      return { answer: ANSWERS.yes, keys: warm.slice(0, 50).map((r) => r.k), ...(broad ? { question: CLARIFY_BROAD } : {}) }
    }
    if (full.length) return { answer: ANSWERS.similar, keys: full.slice(0, 50).map((r) => r.k) }

    // Неполное совпадение: роль есть, но город или отрасль другие.
    const anchors = facets.filter((f) => f === 'role' || f === 'skill' || f === 'company' || f === 'other')
    const partial = this.index.filter((row) => anchors.some((f) => hit(row, f)))
    if (partial.length && facets.length > anchors.length) {
      const missed = facets.filter((f) => !anchors.includes(f)).flatMap((f) => byFacet[f])
      return { answer: ANSWERS.similar, keys: partial.slice(0, 50).map((r) => r.k), missed }
    }
    return { answer: ANSWERS.no }
  }

  requestIntro(guest, { ref, who_i_am, why, offer } = {}) {
    this.reload()
    const refs = readJsonl(this.path('refs.jsonl'))
    const found = refs.find((r) => r.ref === ref && r.guest === guest.id)
    if (!found) return { error: 'Такого ref нет. Он выдаётся в ответе ask_network и работает только для того, кто спрашивал.' }
    const ageDays = (Date.now() - Date.parse(found.ts)) / 86_400_000
    if (ageDays > STOP_REQUEST_DAYS) return { error: 'Этот ref устарел. Спроси ещё раз через ask_network.' }

    const whoIAm = clip(who_i_am)
    const whyText = clip(why)
    if (whoIAm.length < 10 || whyText.length < 30) {
      return { error: 'Опиши, кто ты (who_i_am), и зачем нужен этот человек (why, от 30 знаков). Без этого владелец не сможет спросить контакт.' }
    }
    const inbox = readJsonl(this.path('inbox.jsonl'))
    const existing = inbox.find((r) => r.ref === ref)
    if (existing) return { status: existing.status, ref, note: 'Запрос уже передан владельцу.' }

    const limit = guest.intros ?? this.policy.daily_intros_per_guest
    if (this.usedToday(guest, 'request_intro') >= limit) {
      return { error: `На сегодня запросы на интро закончились: лимит ${limit} в сутки.` }
    }

    appendJsonl(this.path('inbox.jsonl'), {
      ref,
      guest: guest.id,
      guest_name: guest.name,
      ts: new Date().toISOString(),
      status: 'ждёт_владельца',
      who_i_am: whoIAm,
      why: whyText,
      offer: clip(offer),
    })
    this.log({ guest: guest.id, tool: 'request_intro', ref })
    return {
      status: 'ждёт_владельца',
      ref,
      note: 'Передано владельцу. Он сам решит, кого спросить. Контакт узнает о тебе только с согласия владельца, а ты о контакте только с согласия контакта.',
    }
  }

  introStatus(guest, { ref } = {}) {
    const decisions = readJsonl(this.path('decisions.jsonl'))
    const mine = readJsonl(this.path('inbox.jsonl')).filter((r) => r.guest === guest.id && (!ref || r.ref === ref))
    return {
      requests: mine.map((r) => {
        const d = decisions.filter((x) => x.ref === r.ref).at(-1)
        return { ref: r.ref, asked_at: r.ts, status: d?.status || r.status, message: d?.message || null }
      }),
    }
  }
}

export const TOOLS = [
  {
    name: 'network_overview',
    description: 'Что есть в этой записной книжке: кто владелец, его правила и теги с примерным числом людей. Имён нет. Начинай отсюда.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (net) => net.overview(),
  },
  {
    name: 'ask_network',
    description: 'Спросить, есть ли в книжке нужный человек. Ответ: могу_познакомить, есть_похожие, нужно_уточнить или нет. Имён и контактов инструмент не отдаёт. Передавай суть задачи, а не чужие имена и не приватные детали: владелец видит твой вопрос.',
    inputSchema: {
      type: 'object',
      properties: {
        need: { type: 'string', description: 'Одна фраза: кто нужен и зачем.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Теги из network_overview: роль, отрасль, город, навык.' },
      },
      required: ['need'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (net, guest, args) => net.ask(guest, args),
  },
  {
    name: 'request_intro',
    description: 'Запросить интро по ref из ask_network. Владелец получит твоё описание и решит сам; контакта спросит он, автоматически ничего не уходит. Покажи текст человеку, прежде чем вызывать.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        who_i_am: { type: 'string', description: 'Кто ты, коротко. Это прочитает контакт, если владелец согласится.' },
        why: { type: 'string', description: 'Зачем нужен этот человек, от 30 знаков.' },
        offer: { type: 'string', description: 'Что интересного для контакта в этом разговоре.' },
      },
      required: ['ref', 'who_i_am', 'why'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
    run: (net, guest, args) => net.requestIntro(guest, args),
  },
  {
    name: 'intro_status',
    description: 'Что с твоими запросами на интро: ждёт, согласовано или отказ, и сообщение владельца.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (net, guest, args) => net.introStatus(guest, args),
  },
]
