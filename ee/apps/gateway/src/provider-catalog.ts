// The provider catalog the Gateway serves from: src/models/base.json from
// models.dev plus the custom providers in src/models/providers, read once.
import { createProviderCatalog, type ProviderCatalog } from "@openwork-ee/gateway-catalog"
import { readProviderCatalog } from "./models/catalog.js"

let fileCatalog: ProviderCatalog | null = null

export function loadProviderCatalogFromFile(): ProviderCatalog {
  if (!fileCatalog) {
    const parsed: unknown = readProviderCatalog()
    fileCatalog = createProviderCatalog(parsed)
  }
  return fileCatalog
}

export function getCatalogProvider(providerId: string) {
  return loadProviderCatalogFromFile().getCatalogProvider(providerId)
}
