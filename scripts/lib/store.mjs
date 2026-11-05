/**
 * Файлы книжки. Граница приватности проходит здесь:
 *   приватное (только у владельца): data/book.jsonl, data/secret
 *   то, что читает сервер:          data/index.jsonl, data/showcase.json, data/policy.json, data/guests.json
 * Серверу незачем открывать book.jsonl: в его файлах нет ни имён, ни контактов.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function dataDir(explicit) {
  return resolve(explicit || process.env.NETWORK_MCP_DATA || join(ROOT, 'data'))
}

export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function writeJson(path, value, mode) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: mode ?? 0o600 })
  renameSync(tmp, path)
}

export function readJsonl(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export function writeJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 })
  renameSync(tmp, path)
}

export function appendJsonl(path, row) {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(row) + '\n', { mode: 0o600 })
}

export function readPolicy(dir) {
  const example = JSON.parse(readFileSync(join(ROOT, 'policy.example.json'), 'utf8'))
  return { ...example, ...readJson(join(dir, 'policy.json'), {}) }
}

export function secretFor(dir) {
  const path = join(dir, 'secret')
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600 })
    chmodSync(path, 0o600)
  }
  return readFileSync(path, 'utf8').trim()
}

/** Непрозрачный ключ контакта в индексе. Обратно в имя его переводит только владелец: нужен secret и book.jsonl. */
export function indexKey(secret, id) {
  return createHmac('sha256', secret).update(String(id)).digest('base64url').slice(0, 16)
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}
