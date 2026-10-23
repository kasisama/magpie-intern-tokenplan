import { test } from 'node:test'
import assert from 'node:assert/strict'
const entry = await import('../index.mjs').catch(() => ({}))
const auth = key => ({ auth: { type: 'api', key } })
const catalogue = ids => Response.json({ data: ids.map(id => ({ id })), models: [{ id: 'decision-only' }] })
async function withFetch(fn, work) { const old = globalThis.fetch; globalThis.fetch = fn; try { await work() } finally { globalThis.fetch = old } }

test('account models are normalized, deduplicated, case-sensitive and conservative', async () => {
  await withFetch(async () => catalogue(['Atria-Dawn', 'Atria-Dawn', 'intern-s2', 'New-ID', 'SystemOne', 'jev-x', 'intern-decision-4b']), async () => {
    const h = await entry.TokenPlanPlugin({}, { modelOverrides: { 'New-ID': { contextTokens: 65536, outputTokens: 8192, toolCall: true, image: true } } })
    const list = await h.provider.models({ models: {} }, auth('fake-a'))
    assert.deepEqual(Object.keys(list), ['Atria-Dawn', 'intern-s2', 'New-ID'])
    assert.equal(list['Atria-Dawn'].limit.context, 524288)
    assert.equal(list['intern-s2'].capabilities.input.image, true)
    assert.equal(list['intern-s2'].capabilities.toolcall, false)
    assert.equal(list['New-ID'].capabilities.toolcall, true)
    assert.equal(list['New-ID'].api.npm, '@ai-sdk/openai-compatible')
    assert.equal(list['New-ID'].api.id, 'New-ID')
    assert.equal(list['New-ID'].limit.output, 8192)
    assert.ok(!JSON.stringify(list).includes('fake-a'))
    assert.equal(list['New-ID'].cost, undefined)
  })
})
test('unknown model budgets and config overrides use the same resolver', async () => {
  await withFetch(async () => catalogue(['unknown']), async () => {
    const h = await entry.TokenPlanPlugin({})
    const m = (await h.provider.models({}, auth('fake-a'))).unknown
    assert.deepEqual(m.limit, { context: 32768, output: 4096 })
    assert.equal(m.capabilities.reasoning, false)
    assert.equal(m.capabilities.input.image, false)
    const custom = await entry.TokenPlanPlugin({}, { modelOverrides: { 'intern-s2': { toolCall: true, outputTokens: 8000 } } })
    const cfg = {}; await custom.config(cfg)
    assert.equal(cfg.provider.tokenplan.models['intern-s2'].tool_call, true)
    assert.equal(cfg.provider.tokenplan.models['intern-s2'].limit.output, 8000)
  })
})
test('interrupted successful response bodies preserve the account cache', async () => {
  let broken = false
  await withFetch(async () => broken ? new Response(new ReadableStream({ start(c) { c.error(new TypeError('terminated private account data')) } })) : catalogue(['intern-s2']), async () => {
    const h = await entry.TokenPlanPlugin({})
    await h.provider.models({}, auth('fake-body'))
    broken = true
    const result = await h.provider.models({}, auth('fake-body'))
    assert.equal(result[Symbol.for('magpie.fellBack')], true)
    assert.deepEqual(Object.keys(result), ['intern-s2'])
  })
})

test('cache expires after fifteen minutes and rate/server failures may fall back', async () => {
  let status = 200
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    await withFetch(async () => status === 200 ? catalogue(['intern-s2']) : new Response('error', { status }), async () => {
      const h = await entry.TokenPlanPlugin({})
      await h.provider.models({}, auth('fake-ttl'))
      for (status of [429, 500, 503]) assert.equal((await h.provider.models({}, auth('fake-ttl')))[Symbol.for('magpie.fellBack')], true)
      now += 15 * 60 * 1000
      await assert.rejects(h.provider.models({}, auth('fake-ttl')))
    })
  } finally { Date.now = realNow }
})

test('fallback is account isolated, cloned, bounded and only for transient failures', async () => {
  let mode = 'ok'
  await withFetch(async () => {
    if (mode === 'network') throw new Error('private fake-a')
    if (mode === 'empty') return catalogue([])
    if (mode === 'bad') return Response.json({ secret: 'private fake-a' })
    if (mode === '401') return Response.json({ error: { message: 'fake-a', code: 'invalid_api_key' } }, { status: 401 })
    if (mode === 'quota') return Response.json({ error: { code: 'quota_exceeded' } }, { status: 429 })
    if (mode === '403') return Response.json({ error: { code: 'whitelist_required' } }, { status: 403 })
    return catalogue(['intern-s2'])
  }, async () => {
    const h = await entry.TokenPlanPlugin({})
    const first = await h.provider.models({}, auth('fake-a')); first['intern-s2'].name = 'changed'
    mode = 'network'
    const fallback = await h.provider.models({}, auth('fake-a'))
    assert.equal(fallback[Symbol.for('magpie.fellBack')], true)
    assert.equal(fallback['intern-s2'].name, 'intern-s2')
    await assert.rejects(h.provider.models({}, auth('fake-b')), e => e.signIn === 'kept' && !e.message.includes('fake-a'))
    mode = 'bad'; await assert.rejects(h.provider.models({}, auth('fake-a')), /catalogue/)
    mode = 'ok'; await h.provider.models({}, auth('fake-a'))
    mode = 'quota'; await assert.rejects(h.provider.models({}, auth('fake-a')), { signIn: 'kept' })
    mode = '403'; await assert.rejects(h.provider.models({}, auth('fake-a')), { signIn: 'kept' })
    mode = '401'; await assert.rejects(h.provider.models({}, auth('fake-a')), { signIn: 'expired' })
    mode = 'network'; await assert.rejects(h.provider.models({}, auth('fake-a')))
    mode = 'empty'; assert.deepEqual(await h.provider.models({}, auth('fake-a')), {})
    mode = 'network'; assert.deepEqual(Object.keys(await h.provider.models({}, auth('fake-a'))), [])
    mode = 'ok'
    for (let i = 0; i < 65; i++) await h.provider.models({}, auth(`account-${i}`))
    mode = 'network'; await assert.rejects(h.provider.models({}, auth('fake-a')))
  })
})
