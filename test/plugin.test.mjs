import { test } from 'node:test'
import assert from 'node:assert/strict'

const entry = await import('../index.mjs').catch(() => ({}))
test('entry exports one async factory and the v1 descriptor', async () => {
  assert.equal(typeof entry.TokenPlanPlugin, 'function')
  assert.equal(entry.default.id, 'tokenplan')
  assert.equal(entry.default.server, entry.TokenPlanPlugin)
  assert.equal(Object.values(entry).filter(x => typeof x === 'function').length, 1)
})
test('config, simple auth and loader honor the host contract', async () => {
  const hooks = await entry.TokenPlanPlugin({})
  const cfg = {}
  await hooks.config(cfg)
  assert.equal(cfg.provider.tokenplan.npm, '@ai-sdk/openai-compatible')
  assert.equal(Object.keys(cfg.provider.tokenplan.models).length, 10)
  assert.equal(cfg.provider.tokenplan.models['intern-s2'].tool_call, false)
  const existing = { custom: true }; cfg.provider.tokenplan = existing
  await hooks.config(cfg); assert.equal(cfg.provider.tokenplan, existing)
  assert.equal(hooks.auth.provider, 'tokenplan')
  assert.deepEqual(hooks.auth.methods, [{ type: 'api', label: 'TokenPlan API Key' }])
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'fake-secret' }))
  assert.equal(loader.apiKey, 'fake-secret')
  assert.equal(loader.baseURL, 'https://discovery-api.intern-ai.org.cn/v1')
  assert.equal(typeof loader.fetch, 'function')
  assert.ok(!JSON.stringify(cfg).includes('fake-secret'))
  await assert.rejects(hooks.auth.loader(async () => ({})), { signIn: 'expired' })
})
test('options reject unknown keys, invalid budgets and loosely typed overrides', async () => {
  for (const options of [null, [], { apiKey: 'secret' }, { defaultOutputTokens: '4096' },
    { unknownContextTokens: 1 }, { defaultOutputTokens: 0 },
    { modelOverrides: { x: { image: 1 } } }, { modelOverrides: { x: { contextTokens: 2, outputTokens: 3 } } },
    { modelOverrides: { x: { typo: true } } }]) {
    await assert.rejects(entry.TokenPlanPlugin({}, options), /TokenPlan options/)
  }
})
