// models.dev provider catalog (src/models/base.json), read once and exposed as
// npm/api/env per provider id. The gateway classifies protocols from `npm`.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { BEDROCK_MANTLE_PROVIDER_ID, bedrockMantleApiPathsFromCatalog, withBedrockMantleProvider } from "@openwork-ee/utils/bedrock-mantle-catalog"

export type CatalogProvider = {
  npm: string | null
  api: string | null
  env: string[]
  /** Upstream API path per model id (Bedrock Mantle serves models under /v1 or /openai/v1). */
  modelApiPaths?: ReadonlyMap<string, string>
}

export type ProviderCatalog = {
  getCatalogProvider(providerId: string): CatalogProvider | null
}

const baseJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "models", "base.json")

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readCatalogProvider(value: unknown): CatalogProvider | null {
  if (!isRecord(value)) return null
  return {
    npm: typeof value.npm === "string" ? value.npm : null,
    api: typeof value.api === "string" ? value.api : null,
    env: Array.isArray(value.env) ? value.env.filter((name): name is string => typeof name === "string") : [],
  }
}

export function createProviderCatalog(raw: unknown): ProviderCatalog {
  const providers = new Map<string, CatalogProvider>()
  if (isRecord(raw)) {
    // Same derivation as Den's catalog, so both see one amazon-bedrock-mantle provider.
    for (const [id, value] of Object.entries(withBedrockMantleProvider(raw))) {
      const provider = readCatalogProvider(value)
      if (!provider) continue
      providers.set(id, id === BEDROCK_MANTLE_PROVIDER_ID ? { ...provider, modelApiPaths: bedrockMantleApiPathsFromCatalog(raw) } : provider)
    }
  }
  return {
    getCatalogProvider(providerId) {
      return providers.get(providerId) ?? null
    },
  }
}

let fileCatalog: ProviderCatalog | null = null

export function loadProviderCatalogFromFile(): ProviderCatalog {
  if (!fileCatalog) {
    const parsed: unknown = JSON.parse(readFileSync(baseJsonPath, "utf8"))
    fileCatalog = createProviderCatalog(parsed)
  }
  return fileCatalog
}

export function getCatalogProvider(providerId: string) {
  return loadProviderCatalogFromFile().getCatalogProvider(providerId)
}
