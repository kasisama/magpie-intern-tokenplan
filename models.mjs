import { createHash } from 'node:crypto'
import { BASE, SDK, boundedJSON, createTransport, requireKey, safeError, inspectError } from './transport.mjs'

const SNAPSHOT = {
  'intern-s2': [262144, true], 'Atria-Dawn': [524288, false],
  'Agents-A1': [262144, true], 'Sage-A1.5': [262144, true],
  'deepseek-v4.1-flash-1017': [1048576, false], 'deepseek-v4-pro-0813': [1048576, true],
  'glm-5.3': [1048576, false], 'kimi-k2.6': [262144, true],
  'minimax-m3': [1048576, false], 'qwen3.8-27b': [262144, true],
}
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const positive = value => Number.isSafeInteger(value) && value > 0
function invalid() { throw new Error('TokenPlan options: unknown field, invalid type or token budget (output must not exceed context)') }
export function parseOptions(raw = {}) {
  if (!plain(raw) || Object.keys(raw).some(k => !['defaultOutputTokens', 'unknownContextTokens', 'defaultToolCall', 'modelOverrides'].includes(k))) invalid()
  const options = { defaultOutputTokens: 8192, unknownContextTokens: 32768, defaultToolCall: false, modelOverrides: {}, ...raw }
  if (typeof options.defaultToolCall !== 'boolean' || !positive(options.defaultOutputTokens) || !positive(options.unknownContextTokens) || options.defaultOutputTokens > options.unknownContextTokens || !plain(options.modelOverrides)) invalid()
  for (const [id, override] of Object.entries(options.modelOverrides)) {
    if (!id || !plain(override) || Object.keys(override).some(k => !['contextTokens', 'outputTokens', 'toolCall', 'image'].includes(k))) invalid()
    for (const k of ['contextTokens', 'outputTokens']) if (Object.hasOwn(override, k) && !positive(override[k])) invalid()
    for (const k of ['toolCall', 'image']) if (Object.hasOwn(override, k) && typeof override[k] !== 'boolean') invalid()
  }
  for (const id of new Set([...Object.keys(SNAPSHOT), ...Object.keys(options.modelOverrides)])) resolveModel(id, options)
  return structuredClone(options)
}
function resolveModel(id, options, base = {}) {
  const known = Object.hasOwn(SNAPSHOT, id) ? SNAPSHOT[id] : undefined
  const override = Object.hasOwn(options.modelOverrides, id) ? options.modelOverrides[id] : {}
  const context = override.contextTokens ?? base.limit?.context ?? known?.[0] ?? options.unknownContextTokens
  // Only the local default is clamped; explicit model budgets must be valid.
  const output = override.outputTokens ?? base.limit?.output ?? Math.min(options.defaultOutputTokens, context)
  if (!positive(context) || !positive(output) || output > context) invalid()
  return { context, output, image: override.image ?? base.capabilities?.input?.image ?? known?.[1] ?? false,
    toolCall: override.toolCall ?? base.capabilities?.toolcall ?? options.defaultToolCall }
}
function model(id, options, normalized, metadata = {}) {
  const base = structuredClone(metadata)
  const r = resolveModel(id, options, base)
  const common = { id, name: id, limit: { context: r.context, output: r.output } }
  if (!normalized) return { ...common, reasoning: false, tool_call: r.toolCall, modalities: { input: r.image ? ['text', 'image'] : ['text'], output: ['text'] } }
  return { options: {}, headers: {}, variants: {}, status: 'active', release_date: '', ...common, ...base,
    // Discovery controls membership and identity; transport stays on the official Chat API.
    id, providerID: 'tokenplan', api: { id, url: BASE, npm: SDK },
    limit: { ...base.limit, context: r.context, output: r.output },
    capabilities: { temperature: true, reasoning: false, ...base.capabilities, toolcall: r.toolCall,
      attachment: Object.hasOwn(options.modelOverrides[id] ?? {}, 'image') ? r.image : base.capabilities?.attachment ?? r.image,
      input: { text: true, audio: false, video: false, pdf: false, ...base.capabilities?.input, image: r.image },
      output: { text: true, image: false, audio: false, video: false, pdf: false, ...base.capabilities?.output } } }
}
export function configModels(options) {
  return Object.fromEntries(Object.keys(SNAPSHOT).map(id => [id, model(id, options, false)]))
}

// Only successful account catalogues are cached; no raw credentials or disk writes.
// Cap entries and lifetime so removed accounts cannot accumulate indefinitely.
export function createModelDiscovery(options) {
  const cache = new Map()
  const ttl = 15 * 60 * 1000
  return async (provider, { auth } = {}) => {
    const materialize = ids => Object.fromEntries(ids.map(id => [id, model(id, options, true,
      Object.hasOwn(provider?.models ?? {}, id) ? provider.models[id] : {})]))
    const key = requireKey(auth)
    const account = createHash('sha256').update(key).digest('hex')
    const now = Date.now()
    for (const [id, value] of cache) if (now - value.at >= ttl) cache.delete(id)
    try {
      const response = await createTransport(key)(`${BASE}/models`, { signal: AbortSignal.timeout(15000) })
      if (!response.ok) {
        const { code, signIn } = await inspectError(response)
        void response.body?.cancel().catch(() => {})
        throw safeError(`model discovery HTTP ${response.status}${code ? ` (${code})` : ''}`, signIn, response.status === 408 || (response.status === 429 && code !== 'quota_exceeded' && code !== 'insufficient_balance') || response.status >= 500)
      }
      const json = await boundedJSON(response, 1024 * 1024, 5000)
      if (!Array.isArray(json?.data) || json.data.some(row => !row || typeof row.id !== 'string' || !row.id || row.id.length > 256 || /[\x00-\x1f\x7f]/.test(row.id))) throw safeError('invalid model catalogue')
      const ids = [...new Set(json.data.map(row => row.id))].filter(id => !/^(system[-_ ]?one(?:$|[-_ ])|jev-|intern-decision(?:$|-))/i.test(id))
      const result = materialize(ids)
      cache.delete(account)
      cache.set(account, { at: Date.now(), ids })
      while (cache.size > 64) cache.delete(cache.keys().next().value)
      return result
    } catch (error) {
      // Discovery's private timeout is transient; caller cancellation is not exposed here.
      const transient = error?.transient || error?.name === 'AbortError'
      if (!transient) cache.delete(account)
      const previous = cache.get(account)
      if (transient && previous) {
        const result = materialize(previous.ids)
        result[Symbol.for('magpie.fellBack')] = true
        return result
      }
      if (error?.message?.startsWith('TokenPlan:')) throw error
      throw safeError('model discovery failed', 'kept', transient)
    }
  }
}
