import type { listExternalMcpTools } from "../capability-sources/external-mcp-client-runtime.js"

type ExternalMcpTools = Awaited<ReturnType<typeof listExternalMcpTools>>

/**
 * How long a tool call may trust a member's provider tool list (names, input
 * schemas and read-only labels) before listing it again. A provider that
 * drops a read-only label is noticed within this window; the call itself
 * still needs mcp:write, the member's grant and the tool policy every time.
 */
export const EXTERNAL_TOOL_CATALOG_TTL_MS = 60_000
export const EXTERNAL_TOOL_CATALOG_MAX_ENTRIES = 500

export type ExternalToolCatalogKey = {
  organizationId: string
  connectionId: string
  updatedAt: Date
  orgMembershipId: string
  /** Changes when the connection's or member's credential is replaced or re-authorized. */
  credentialIdentity: string
}

type Entry = { expiresAt: number; tools: Promise<ExternalMcpTools> }

// Only successful lists are kept, and only in this process. Concurrent calls
// share one in-flight list.
const entries = new Map<string, Entry>()

function serialize(key: ExternalToolCatalogKey): string {
  return JSON.stringify([key.organizationId, key.connectionId, key.updatedAt.getTime(), key.orgMembershipId, key.credentialIdentity])
}

export function cachedExternalToolCatalog(
  key: ExternalToolCatalogKey,
  load: () => Promise<ExternalMcpTools>,
  now: () => number = Date.now,
): Promise<ExternalMcpTools> {
  const serialized = serialize(key)
  const cached = entries.get(serialized)
  if (cached && cached.expiresAt > now()) return cached.tools
  const tools = load()
  const entry: Entry = { expiresAt: now() + EXTERNAL_TOOL_CATALOG_TTL_MS, tools }
  entries.delete(serialized)
  entries.set(serialized, entry)
  tools.catch(() => {
    if (entries.get(serialized) === entry) entries.delete(serialized)
  })
  while (entries.size > EXTERNAL_TOOL_CATALOG_MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
  return tools
}

/** Forget a member's list, e.g. after a call through it failed or named a tool it lacks. */
export function forgetExternalToolCatalog(key: ExternalToolCatalogKey): void {
  entries.delete(serialize(key))
}
