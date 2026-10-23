export const BASE = 'https://discovery-api.intern-ai.org.cn/v1'
export const SDK = '@ai-sdk/openai-compatible'
const ERROR_BYTES = 65536
const ERROR_MS = 250
const EXPIRED_CODES = new Set(['api_key_disabled', 'user_disabled'])
const KNOWN_CODES = new Set([...EXPIRED_CODES, 'invalid_api_key', 'whitelist_required', 'quota_exceeded', 'rate_limit_exceeded', 'insufficient_balance', 'model_not_found', 'internal_error'])

export function safeError(message, signIn = 'kept', transient = false) {
  return Object.assign(new Error(`TokenPlan: ${message}`), { signIn, transient })
}
export function requireKey(auth) {
  if (auth?.type !== 'api' || typeof auth.key !== 'string' || !auth.key.trim() || /[\r\n\x00-\x1f\x7f]/.test(auth.key)) {
    throw safeError('API Key missing or invalid; sign in again', 'expired')
  }
  return auth.key
}

// Cancel without awaiting: cancelling one tee branch can wait for its sibling.
// The caller still owns that sibling and must be able to consume/cancel it.
export async function boundedJSON(response, maxBytes = ERROR_BYTES, timeoutMs = ERROR_MS) {
  const reader = response.body?.getReader()
  if (!reader) throw safeError('empty catalogue')
  let timer
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(safeError('body read timed out', 'kept', true)), timeoutMs) })
  let total = 0
  const chunks = []
  try {
    while (true) {
      let chunk
      try { chunk = await Promise.race([reader.read(), deadline]) }
      catch { throw safeError('upstream body read failed or timed out', 'kept', true) }
      const { done, value } = chunk
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw safeError('body exceeds local inspection limit')
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { throw safeError('invalid JSON catalogue') }
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
  }
}

export async function inspectError(response) {
  let code
  if (/\bjson\b/i.test(response.headers.get('content-type') ?? '')) {
    try {
      const json = await boundedJSON(response.clone())
      const candidate = json?.error?.code ?? json?.code
      // Never repeat arbitrary server text (which may echo credentials).
      if (KNOWN_CODES.has(candidate)) code = candidate
    } catch { /* Status is authoritative when inspection cannot complete. */ }
  }
  return { code, signIn: response.status === 401 || (response.status === 403 && EXPIRED_CODES.has(code)) ? 'expired' : 'kept' }
}

function normalizeBody(text) {
  let body
  try { body = JSON.parse(text) } catch { throw safeError('chat body must be JSON') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw safeError('chat body must be an object')
  delete body.reasoning
  delete body.reasoning_effort
  delete body.thinking
  if (body.output_config && typeof body.output_config === 'object' && !Array.isArray(body.output_config)) delete body.output_config.effort
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      if (part?.type === 'image_url' && part.image_url && typeof part.image_url === 'object' && !Array.isArray(part.image_url) && part.image_url.detail === undefined) part.image_url.detail = 'auto'
    }
  }
  return JSON.stringify(body)
}

export function createTransport(key, upstream = (...args) => globalThis.fetch(...args)) {
  requireKey({ type: 'api', key })
  return async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined
    let url
    try { url = new URL(request ? request.url : input) } catch { throw safeError('unsupported request destination') }
    const method = (init.method ?? request?.method ?? 'GET').toUpperCase()
    const allowed = (url.pathname === '/v1/models' && method === 'GET') || (url.pathname === '/v1/chat/completions' && method === 'POST')
    if (url.origin !== new URL(BASE).origin || url.username || url.password || url.search || url.hash || !allowed) throw safeError('unsupported request destination or method')
    const headers = new Headers(request?.headers)
    new Headers(init.headers).forEach((value, name) => headers.set(name, value))
    for (const name of ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'proxy-authorization', 'cookie', 'cookie2', 'host', 'content-length']) headers.delete(name)
    headers.set('authorization', `Bearer ${key}`)
    let body = init.body
    if (body === undefined && request && method === 'POST') body = await request.text()
    if (method === 'POST') {
      if (body instanceof ArrayBuffer) body = new TextDecoder().decode(body)
      else if (ArrayBuffer.isView(body)) body = new TextDecoder().decode(body)
      if (typeof body !== 'string') throw safeError('chat body must be JSON text or bytes')
      body = normalizeBody(body)
      headers.set('content-type', 'application/json')
      headers.delete('content-encoding')
    }
    const signal = init.signal ?? request?.signal
    let response
    try {
      response = await upstream(url.href, { ...init, method, headers, body, signal, redirect: 'manual', credentials: 'omit' })
    } catch {
      if (signal?.aborted) throw new DOMException('TokenPlan request cancelled', 'AbortError')
      throw safeError('upstream network request failed', 'kept', true)
    }
    if (response.ok) return response // No successful-body reads, clones or buffering.
    const { signIn } = await inspectError(response)
    const resultHeaders = new Headers(response.headers)
    resultHeaders.set('x-magpie-sign-in', signIn)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: resultHeaders })
  }
}
