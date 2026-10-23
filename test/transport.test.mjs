import { test } from 'node:test'
import assert from 'node:assert/strict'
const transport = await import('../transport.mjs').catch(() => ({}))
const BASE = 'https://discovery-api.intern-ai.org.cn/v1'
const encoder = new TextEncoder()
const key = 'fake-secret'

test('chat normalization preserves tools, history and image data in string and byte bodies', async () => {
  const payload = { model: 'intern-s2', reasoning: {}, reasoning_effort: 'high', thinking: {}, output_config: { effort: 'high', format: 'json' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'thinking' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }, { type: 'image_url', image_url: { url: 'https://example.com/a', detail: 'low' } }] },
      { role: 'assistant', reasoning: 'history', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call1', content: 'ok' }], tools: [{ type: 'function', function: { name: 'f', parameters: { properties: { thinking: { type: 'string' } } } } }], tool_choice: 'auto' }
  for (const body of [JSON.stringify(payload), encoder.encode(JSON.stringify(payload))]) {
    let calls = 0
    const ac = new AbortController()
    const f = transport.createTransport(key, async (url, init) => {
      calls++; assert.equal(url, `${BASE}/chat/completions`)
      assert.equal(init.signal, ac.signal); assert.equal(init.redirect, 'manual')
      assert.equal(init.headers.get('authorization'), `Bearer ${key}`)
      assert.equal(init.headers.get('x-api-key'), null)
      assert.equal(init.headers.get('x-goog-api-key'), null)
      assert.equal(init.headers.get('cookie'), null)
      assert.equal(init.headers.get('content-length'), null)
      const p = JSON.parse(init.body)
      assert.equal(p.reasoning, undefined); assert.equal(p.thinking, undefined); assert.equal(p.reasoning_effort, undefined)
      assert.deepEqual(p.output_config, { format: 'json' })
      assert.deepEqual(p.tools, payload.tools); assert.equal(p.tool_choice, 'auto')
      assert.deepEqual(p.messages.slice(1), payload.messages.slice(1))
      assert.equal(p.messages[0].content[1].image_url.detail, 'auto')
      assert.equal(p.messages[0].content[1].image_url.url, 'data:image/png;base64,abc')
      assert.equal(p.messages[0].content[2].image_url.detail, 'low')
      return Response.json({ ok: true })
    })
    await f(`${BASE}/chat/completions`, { method: 'POST', body, headers: new Headers({ authorization: 'bad', 'x-api-key': 'bad', 'x-goog-api-key': 'bad', cookie: 'bad', 'content-length': '10' }), signal: ac.signal })
    assert.equal(calls, 1)
  }
})
test('destination and method restrictions reject before fetching and redirects are not followed', async () => {
  let calls = 0
  const f = transport.createTransport(key, async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.test' } }) })
  for (const url of ['https://evil.test/v1/models', `${BASE}/responses`, `${BASE}/models?key=x`, 'https://u:p@discovery-api.intern-ai.org.cn/v1/models']) await assert.rejects(f(url))
  await assert.rejects(f(`${BASE}/models`, { method: 'POST' }))
  assert.equal(calls, 0)
  assert.equal((await f(`${BASE}/models`)).status, 302)
  assert.equal(calls, 1)
})
test('Request input headers and signal are preserved; invalid JSON errors are safe', async () => {
  const req = new Request(`${BASE}/chat/completions`, { method: 'POST', body: '{}', headers: { 'x-test': 'base' } })
  const f = transport.createTransport(key, async (_, init) => {
    assert.equal(init.headers.get('x-test'), 'base'); assert.equal(init.headers.get('x-other'), 'override')
    assert.equal(init.signal, req.signal)
    return Response.json({})
  })
  await f(req, { headers: { 'x-other': 'override' } })
  await assert.rejects(f(`${BASE}/chat/completions`, { method: 'POST', body: 'private fake-secret' }), e => !e.message.includes(key) && !e.message.includes('private'))
})
test('successful SSE is returned untouched, incrementally readable and cancellable', async () => {
  let cancelled = false
  const chunks = ['data: {"tool_calls":[', ']}\n\n', 'data: [DONE]\n\n']
  let index = 0
  const stream = new ReadableStream({ pull(c) { if (index < chunks.length) c.enqueue(encoder.encode(chunks[index++])); }, cancel() { cancelled = true } }, { highWaterMark: 0 })
  const original = new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  const f = transport.createTransport(key, async () => original)
  const r = await f(`${BASE}/chat/completions`, { method: 'POST', body: '{}' })
  assert.equal(r, original); assert.equal(index, 0)
  const reader = r.body.getReader()
  for (const chunk of chunks) assert.equal(new TextDecoder().decode((await reader.read()).value), chunk)
  await reader.cancel(); assert.equal(cancelled, true)
})
test('error classification preserves body, status and diagnostic headers', async () => {
  for (const [status, code, signIn] of [[401, 'invalid_api_key', 'expired'], [403, 'api_key_disabled', 'expired'], [403, 'user_disabled', 'expired'], [403, 'whitelist_required', 'kept'], [403, 'unknown', 'kept'], [429, 'quota_exceeded', 'kept'], [429, 'rate_limit_exceeded', 'kept'], [500, 'internal_error', 'kept']]) {
    const body = JSON.stringify({ error: { code, message: 'private' } })
    const f = transport.createTransport(key, async () => new Response(body, { status, headers: { 'content-type': 'application/json', 'retry-after': '30', 'x-request-id': 'req-1' } }))
    const r = await f(`${BASE}/models`)
    assert.equal(r.status, status); assert.equal(r.headers.get('x-magpie-sign-in'), signIn)
    assert.equal(r.headers.get('retry-after'), '30'); assert.equal(r.headers.get('x-request-id'), 'req-1')
    assert.equal(await r.text(), body)
  }
})
test('HTML, oversized and stalled error bodies never block error forwarding', { timeout: 4000 }, async () => {
  for (const body of ['<html>error</html>', 'x'.repeat(70000), new ReadableStream({ start(c) { c.enqueue(encoder.encode('{')); } })]) {
    const f = transport.createTransport(key, async () => new Response(body, { status: 403, headers: { 'content-type': 'application/json' } }))
    const start = Date.now(); const r = await f(`${BASE}/models`)
    assert.ok(Date.now() - start < 1500)
    assert.equal(r.status, 403); assert.equal(r.headers.get('x-magpie-sign-in'), 'kept')
    if (typeof body === 'string') assert.equal(await r.text(), body)
    else { void r.body.cancel().catch(() => {}) }
  }
})
test('network errors and missing credentials are sanitized; cancellation propagates', async () => {
  assert.throws(() => transport.createTransport(''), /TokenPlan/)
  const f = transport.createTransport(key, async (_, init) => { if (init.signal?.aborted) throw init.signal.reason; throw new Error(`leak ${key}`) })
  await assert.rejects(f(`${BASE}/models`), e => !e.message.includes(key))
  const ac = new AbortController(); ac.abort()
  await assert.rejects(f(`${BASE}/models`, { signal: ac.signal }), { name: 'AbortError' })
})
