const MODELS_DEV_API_URL = "https://models.dev/api.json"
const MODELS_DEV_CACHE_TTL_MS = 1000 * 60 * 10

type JsonRecord = Record<string, unknown>

export type ModelsDevProviderSummary = {
  id: string
  name: string
  npm: string | null
  env: string[]
  doc: string | null
  api: string | null
  modelCount: number
}

export type ModelsDevModel = {
  id: string
  name: string
  config: JsonRecord
}

export type ModelsDevProvider = {
  id: string
  name: string
  npm: string | null
  env: string[]
  doc: string | null
  api: string | null
  config: JsonRecord
  models: ModelsDevModel[]
}

let modelsDevCache:
  | {
      expiresAt: number
      providers: ModelsDevProvider[]
      providersById: Map<string, ModelsDevProvider>
    }
  | null = null

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : []
}

async function loadModelsDevCatalog() {
  if (modelsDevCache && modelsDevCache.expiresAt > Date.now()) {
    return modelsDevCache
  }

  const response = await fetch(MODELS_DEV_API_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": "OpenWork Den API",
    },
  })

  if (!response.ok) {
    throw new Error(`models.dev returned ${response.status}`)
  }

  const payload = await response.json()
  if (!isRecord(payload)) {
    throw new Error("models.dev returned an invalid payload")
  }

  const providers = Object.entries(payload)
    .map(([providerKey, rawProvider]) => {
      if (!isRecord(rawProvider)) {
        return null
      }

      const providerId = asString(rawProvider.id) ?? providerKey
      const name = asString(rawProvider.name) ?? providerId
      const modelsRecord = isRecord(rawProvider.models) ? rawProvider.models : {}
      const { models: _models, ...providerConfig } = rawProvider
      const models = Object.entries(modelsRecord)
        .map(([modelKey, rawModel]) => {
          if (!isRecord(rawModel)) {
            return null
          }

          const modelId = asString(rawModel.id) ?? modelKey
          const modelName = asString(rawModel.name) ?? modelId
          return {
            id: modelId,
            name: modelName,
            config: rawModel,
          } satisfies ModelsDevModel
        })
        .filter((entry): entry is ModelsDevModel => entry !== null)
        .sort((left, right) => left.name.localeCompare(right.name))

      return {
        id: providerId,
        name,
        npm: asString(rawProvider.npm),
        env: asStringList(rawProvider.env),
        doc: asString(rawProvider.doc),
        api: asString(rawProvider.api),
        config: providerConfig,
        models,
      } satisfies ModelsDevProvider
    })
    .filter((entry): entry is ModelsDevProvider => entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name))

  const nextCache = {
    expiresAt: Date.now() + MODELS_DEV_CACHE_TTL_MS,
    providers,
    providersById: new Map(providers.map((provider) => [provider.id, provider])),
  }

  modelsDevCache = nextCache
  return nextCache
}

export async function listModelsDevProviders(): Promise<ModelsDevProviderSummary[]> {
  const catalog = await loadModelsDevCatalog()
  return catalog.providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    npm: provider.npm,
    env: provider.env,
    doc: provider.doc,
    api: provider.api,
    modelCount: provider.models.length,
  }))
}

export async function getModelsDevProvider(providerId: string): Promise<ModelsDevProvider | null> {
  const catalog = await loadModelsDevCatalog()
  return catalog.providersById.get(providerId) ?? null
}
