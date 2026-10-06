import type { MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { env } from "../env.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

export type ManagedLlmProviderSourceId = "openwork"

/**
 * A product that delivers its key to the desktop through `llm_provider` rows it owns
 * (`source` column). The LLM provider routes serve these rows without importing the product.
 */
export type ManagedLlmProviderSource = {
  source: ManagedLlmProviderSourceId
  /** Self-heal the member's rows before their usable list is read. */
  beforeUsableList(input: { organizationId: OrgId; memberId: MemberId }): Promise<void>
  /** Whether rows with this source may be listed for the organization. */
  rowsAllowed(organizationId: OrgId): Promise<boolean>
  /** Throws `ManagedModelsPolicyError` when a row with this source must not be connected. */
  assertConnectable(organizationId: OrgId): Promise<void>
}

const sources = new Map<ManagedLlmProviderSourceId, ManagedLlmProviderSource>()

export function registerManagedLlmProviderSource(source: ManagedLlmProviderSource): void {
  sources.set(source.source, source)
}

function assertSourcesRegistered() {
  if (env.devMode && sources.size === 0) {
    throw new Error("managed_llm_provider_sources_not_registered")
  }
}

export function managedLlmProviderSources(): readonly ManagedLlmProviderSource[] {
  assertSourcesRegistered()
  return [...sources.values()]
}

/** With no registered source, its rows are treated as not allowed. */
export function managedLlmProviderSource(source: ManagedLlmProviderSourceId): ManagedLlmProviderSource | null {
  assertSourcesRegistered()
  return sources.get(source) ?? null
}
