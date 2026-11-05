/** Любой OpenAI-совместимый чат. Без зависимостей. */
export function makeLlm({ baseUrl, key, model, timeoutMs = 60_000 }) {
  return async function llm(system, user, { json = false, maxTokens = 900 } = {}) {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    })
    if (!res.ok) throw new Error(`LLM ${res.status}`)
    const data = await res.json()
    const text = data.choices?.[0]?.message?.content ?? ''
    return json ? parseJson(text) : text.trim()
  }
}

export function llmFromEnv() {
  const { NETWORK_LLM_BASE_URL: baseUrl, NETWORK_LLM_KEY: key, NETWORK_LLM_MODEL: model } = process.env
  if (!baseUrl || !key || !model) return null
  return makeLlm({ baseUrl, key, model })
}

export function parseJson(text) {
  const s = String(text)
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('LLM вернула не JSON')
  return JSON.parse(s.slice(a, b + 1))
}
