#!/usr/bin/env node
/**
 * Демо-книжка: выдуманные люди, чтобы прогнать весь цикл до своих данных.
 *   node dev/make-fixture.mjs [папка]   пишет data/demo/Connections.csv и data/demo/crm/circles.json
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] || 'data/demo'
let seed = 20261105
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = (a) => a[Math.floor(rnd() * a.length)]

const FIRST = ['Демид', 'Агата', 'Ростислав', 'Варвара', 'Мирон', 'Злата', 'Тихон', 'Ульяна', 'Прохор', 'Есения', 'Савва', 'Милана', 'Елисей', 'Таисия', 'Лука']
const LAST = ['Вымыслов', 'Придумкин', 'Небылицын', 'Сказочный', 'Условнов', 'Примеров', 'Фикционов', 'Тестовый', 'Образцов', 'Шаблонов', 'Демонстров', 'Заглушкин']
const ROLES = [
  'Founder', 'Основатель', 'CEO', 'Venture Partner', 'Венчурный инвестор', 'Business Angel', 'Performance Marketing Lead',
  'Директолог', 'CMO', 'Head of Sales', 'Product Manager', 'CTO', 'Senior Software Engineer', 'ML Engineer', 'UX Designer',
  'Юрист', 'CFO', 'HR Director', 'Журналист', 'Executive Coach',
]
const SPHERES = ['fintech', 'b2b saas', 'e-commerce', 'edtech', 'healthtech', 'логистика', 'ии', 'недвижимость', 'медиа']
const CITIES = ['Москва', 'Дубай', 'Берлин', 'Лондон', 'Сан-Франциско', 'Лимасол', 'Белград', 'Алматы', 'Ереван', 'Бали']
const COMPANIES = ['Ромашка', 'Рога и Копыта', 'Вектор Демо', 'Пример Групп', 'Сказка Капитал', 'Тестовые Системы', 'Заглушка Лабс']

const seen = new Set()
const people = []
for (let i = 0; i < 400 && people.length < 180; i++) {
  const first = pick(FIRST)
  const last = pick(LAST)
  if (seen.has(`${first} ${last}`)) continue
  seen.add(`${first} ${last}`)
  people.push({ first, last, title: `${pick(ROLES)}, ${pick(SPHERES)}, ${pick(CITIES)}`, company: pick(COMPANIES) })
}

// Истории для демо приёмной. Все люди выдуманы, совпадения случайны.
const STORIES = [
  { first: 'Тихон', last: 'Вымыслов', title: 'Вице-президент по цифровым продуктам', company: 'Росатом', circle: 2, reason: 'Учились вместе. Созваниваемся раз в пару месяцев. Занимается цифровыми продуктами и смотрит пилоты, но просил не присылать ему продажи и холодные питчи.' },
  { first: 'Ульяна', last: 'Придумкина', title: 'Менеджер проектов', company: 'Росатом', circle: 3, reason: 'Виделись один раз на конференции, больше не общались.' },
  { first: 'Мирон', last: 'Небылицын', title: 'Venture Partner, Дубай', company: 'Сказка Капитал', circle: 1, reason: 'Близкий партнёр, вместе смотрели сделки. Сейчас ищет AI-проекты на посевной стадии, сам просил присылать сильных фаундеров.' },
  { first: 'Злата', last: 'Условнова', title: 'Performance Marketing Lead, подписочные продукты', company: 'Ромашка', circle: 2, reason: 'Помогала нам с трафиком. Сейчас перегружена, но за интересный продукт берётся.' },
]
for (const st of STORIES) people.unshift(st)

mkdirSync(join(dir, 'crm'), { recursive: true })
const csv = [
  'Notes:',
  '"When exporting your connection data, you may notice that some of the email addresses are missing."',
  '',
  'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  ...people.map((p, i) => `${p.first},${p.last},https://www.linkedin.com/in/demo-${i},,"${p.company}","${p.title}",01 Mar 2025`),
].join('\n')
writeFileSync(join(dir, 'Connections.csv'), csv)

const crm = {
  owner: { name: 'Демо-владелец' },
  contacts: people.slice(0, 64).map((p, i) => ({
    id: String(1000 + i),
    name: `${p.first} ${p.last}`,
    circle_level: p.circle ?? 1 + (i % 3),
    circle_type: !p.circle && i % 15 === 0 ? 'personal' : 'partner',
    reason: p.reason || 'выдуманный диалог',
  })),
}
writeFileSync(join(dir, 'crm', 'circles.json'), JSON.stringify(crm, null, 2))
console.log(`Демо-книжка: ${people.length} выдуманных человек в ${dir}.`)
