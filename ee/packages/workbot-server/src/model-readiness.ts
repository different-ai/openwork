import type { HeadlessModelCatalog } from "@openwork-ee/headless-protocol"

/** A configured fallback or an old runner is not proof that the shared key can serve this model. */
export function workbotModelReady(model: string | null, catalog: HeadlessModelCatalog | null): boolean {
  return Boolean(model && catalog?.verified === true && catalog.models.some((entry) => entry.id === model))
}
