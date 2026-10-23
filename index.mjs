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
      methods: [{ type: 'api', label: 'TokenPlan API Key' }],
      async loader(getAuth) {
        const key = requireKey(await getAuth())
        return { baseURL: BASE, apiKey: key, fetch: createTransport(key) }
      },
    },
    provider: { id: 'tokenplan', models: createModelDiscovery(options) },
  }
}
export default { id: 'tokenplan', server: TokenPlanPlugin }
