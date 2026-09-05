import { INFERENCE_MODEL_ALIASES, inferenceModelCapabilities } from "@openwork/types/den/inference"

const OPENWORK_PROVIDER_ID = "openwork"

export type ModelCatalogEntry = {
  alias: string
  upstreamModel: string
  displayName: string
  enabled: boolean
  usageFactor: number
  capabilities: NonNullable<ReturnType<typeof inferenceModelCapabilities>>
}

const models: ModelCatalogEntry[] = Object.entries(INFERENCE_MODEL_ALIASES).flatMap(([alias, model]) => {
  const capabilities = inferenceModelCapabilities(alias)
  if (!capabilities) return []
  return [{
  alias,
  upstreamModel: model.upstreamModel,
  displayName: model.displayName,
  enabled: model.enabled,
  usageFactor: model.usageFactor,
  capabilities,
}]})

const enabledModels = models.filter((model) => model.enabled)

export function resolveModelAlias(alias: string) {
  const normalizedAlias = alias.startsWith(`${OPENWORK_PROVIDER_ID}/`)
    ? alias.slice(OPENWORK_PROVIDER_ID.length + 1)
    : alias
  return enabledModels.find((model) => model.alias === normalizedAlias) ?? null
}

export function resolveModelByUpstreamModel(upstreamModel: string) {
  // Retired models can still settle requests that started while available.
  return models.find((model) => model.upstreamModel === upstreamModel) ?? null
}

export function listModelCatalog() {
  return enabledModels
}
