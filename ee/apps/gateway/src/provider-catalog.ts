// models.dev provider catalog (src/models/base.json), read once and exposed as
// npm/api/env per provider id. The gateway classifies protocols from `npm`.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type CatalogProvider = {
  npm: string | null
  api: string | null
  env: string[]
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
    for (const [id, value] of Object.entries(raw)) {
      const provider = readCatalogProvider(value)
      if (provider) providers.set(id, provider)
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
