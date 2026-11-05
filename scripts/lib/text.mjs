/**
 * Нормализация и поиск тегов в тексте. Без морфологии: основа слова плюс короткое окончание.
 * Этого хватает, потому что основной вход сервера - теги из витрины, которые выбирает модель гостя.
 */
import { readFileSync } from 'node:fs'

export const FACETS = ['role', 'industry', 'geo', 'skill', 'company', 'other']

export function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}&+]+/gu, ' ')
    .trim()
}

const STRIP = /[аяыиоеуюьйъ]+$/u

function stem(token) {
  if (!/^[а-я-]+$/u.test(token)) return token
  if (token.length < 6) return token
  const s = token.replace(STRIP, '')
  return s.length >= 4 ? s : token
}

function tokenMatches(tok, aliasTok) {
  if (tok === aliasTok) return true
  const st = stem(aliasTok)
  if (st.length < 5 && aliasTok.length < 5) return false
  return tok.startsWith(st) && tok.length - st.length <= 4
}

/** Матчер: длинные алиасы раньше коротких, чтобы «холодные продажи» не съелись «продажами». */
export function makeMatcher(entries) {
  const list = entries
    .map((e) => ({ ...e, toks: norm(e.alias).split(' ').filter(Boolean) }))
    .filter((e) => e.toks.length)
    .sort((a, b) => b.toks.length - a.toks.length || b.alias.length - a.alias.length)

  return function find(text) {
    const toks = norm(text).split(' ').filter(Boolean)
    const used = new Array(toks.length).fill(false)
    const out = new Map()
    for (const e of list) {
      for (let i = 0; i + e.toks.length <= toks.length; i++) {
        if (used.slice(i, i + e.toks.length).some(Boolean)) continue
        if (e.toks.every((a, j) => tokenMatches(toks[i + j], a))) {
          out.set(`${e.facet}:${e.tag}`, { facet: e.facet, tag: e.tag })
          for (let j = 0; j < e.toks.length; j++) used[i + j] = true
        }
      }
    }
    return [...out.values()]
  }
}

export function loadVocabEntries() {
  const vocab = JSON.parse(readFileSync(new URL('./vocab.json', import.meta.url), 'utf8'))
  const entries = []
  for (const [facet, tags] of Object.entries(vocab)) {
    for (const [tag, aliases] of Object.entries(tags)) {
      entries.push({ facet, tag, alias: tag })
      for (const alias of aliases) entries.push({ facet, tag, alias })
    }
  }
  return entries
}

export function emptyTags() {
  return { role: [], industry: [], geo: [], skill: [], company: [], other: [] }
}

/** Теги по открытым полям контакта: должность, компания, город, «о себе». Для первого прогона без модели. */
export function tagByRules(fields, find) {
  const tags = emptyTags()
  for (const { facet, tag } of find(fields.filter(Boolean).join(' . '))) {
    if (!tags[facet].includes(tag)) tags[facet].push(tag)
  }
  return tags
}
