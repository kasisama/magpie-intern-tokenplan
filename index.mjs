import { BASE, SDK, createTransport, requireKey } from './transport.mjs'
import { parseOptions, configModels, createModelDiscovery } from './models.mjs'

export const TokenPlanPlugin = async (_input, rawOptions) => {
  const options = parseOptions(rawOptions)
  return {
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider.tokenplan ??= {
        name: '书生 TokenPlan', npm: SDK, api: BASE, models: configModels(options),
      }
    },
    auth: {
      provider: 'tokenplan',
      methods: [{ type: 'api', label: 'TokenPlan API Key', prompts: [{
        type: 'text', key: 'email', message: 'Account label (optional)', placeholder: 'Personal / Work',
        validate: value => typeof value === 'string' && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value)
          ? undefined : 'Use up to 100 characters without control characters',
      }] }],
      async loader(getAuth) {
        const key = requireKey(await getAuth())
        return { baseURL: BASE, apiKey: key, fetch: createTransport(key) }
      },
    },
    provider: { id: 'tokenplan', models: createModelDiscovery(options) },
  }
}
export default { id: 'tokenplan', server: TokenPlanPlugin }
