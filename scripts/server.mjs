#!/usr/bin/env node
/**
 * MCP-сервер записной книжки.
 *   node scripts/server.mjs                  HTTP на 127.0.0.1:8787, токены гостей обязательны
 *   node scripts/server.mjs --port 9000      другой порт
 *   node scripts/server.mjs --stdio          для проверки у себя: гость «я сам», без сети
 * Наружу сервер выводит туннель (см. КАК-НАЧАТЬ.md). Сам он слушает только локальный адрес.
 */
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { handleRpc } from './lib/mcp.mjs'
import { Network } from './lib/network.mjs'
import { dataDir, hashToken, readJson } from './lib/store.mjs'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const dir = dataDir(opt('data'))
if (!existsSync(join(dir, 'index.jsonl'))) {
  console.error('Нет data/index.jsonl. Сначала node scripts/build-index.mjs (или npm run demo).')
  process.exit(1)
}
const net = new Network(dir)

if (args.includes('--stdio')) {
  const guest = { id: 'local', name: 'Я сам (stdio)' }
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    if (!line.trim()) return
    let msg
    try { msg = JSON.parse(line) } catch { return }
    const res = handleRpc(msg, { net, guest })
    if (res) process.stdout.write(JSON.stringify(res) + '\n')
  })
} else {
  const port = Number(opt('port') || process.env.PORT || 8787)
  const MAX_BODY = 64 * 1024
  const MAX_PER_MINUTE = 60
  const failed = new Map()
  const perMinute = new Map()
  const allowedOrigins = (process.env.NETWORK_MCP_ORIGINS || '').split(',').filter(Boolean)

  const guestByToken = (token) => {
    const guests = readJson(join(dir, 'guests.json'), {})
    const g = guests[hashToken(token)]
    if (!g || g.revoked) return null
    if (g.expires && Date.parse(g.expires) < Date.now()) return null
    return g
  }

  const send = (res, code, body, headers = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body)
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
    res.end(text)
  }

  const server = createServer((req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://x')
    } catch {
      return send(res, 400, { error: 'bad request' })
    }
    if (url.pathname === '/health') return send(res, 200, { ok: true })
    if (url.pathname !== '/mcp') return send(res, 404, { error: 'not found' })

    // Защита от DNS rebinding из спецификации MCP: браузерная страница не должна достучаться до локального порта.
    const origin = req.headers.origin
    if (origin && !allowedOrigins.includes(origin)) return send(res, 403, { error: 'origin not allowed' })

    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, { Allow: 'POST' })

    // Слишком много неверных токенов с одного адреса: тормозим перебор.
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress
    const now = Date.now()
    const f = failed.get(ip)
    if (f && f.n >= 20 && now - f.t < 600_000) return send(res, 429, { error: 'too many attempts' })

    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    const guest = token ? guestByToken(token) : null
    if (!guest) {
      failed.set(ip, { n: (f && now - f.t < 600_000 ? f.n : 0) + 1, t: now })
      return send(res, 401, { error: 'Нужен токен гостя. Его выдаёт владелец книжки.' })
    }
    failed.delete(ip)

    // Один гость не должен положить сервер для остальных.
    const slot = perMinute.get(guest.id)
    if (slot && now - slot.t < 60_000 && slot.n >= MAX_PER_MINUTE) return send(res, 429, { error: 'Слишком часто. Подожди минуту.' })
    perMinute.set(guest.id, slot && now - slot.t < 60_000 ? { n: slot.n + 1, t: slot.t } : { n: 1, t: now })

    const chunks = []
    let size = 0
    let aborted = false
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        aborted = true
        send(res, 413, { error: 'too large' })
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (aborted) return
      let msg
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      }
      if (Array.isArray(msg)) {
        return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch is not supported' } })
      }
      let out
      try {
        out = handleRpc(msg, { net, guest })
      } catch (err) {
        console.error('[rpc]', err)
        return send(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } })
      }
      if (out === null) {
        res.writeHead(202)
        return res.end()
      }
      send(res, 200, out)
    })
  })

  server.requestTimeout = 30_000
  server.headersTimeout = 15_000
  server.listen(port, '127.0.0.1', () => {
    console.log(`Книжка отвечает на http://127.0.0.1:${port}/mcp. В индексе ${net.index.length} человек.`)
    console.log(`Открыть наружу: cloudflared tunnel --url http://127.0.0.1:${port}`)
  })
}
