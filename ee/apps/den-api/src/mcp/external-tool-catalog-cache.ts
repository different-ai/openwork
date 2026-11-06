import type { listExternalMcpTools } from "../capability-sources/external-mcp-client-runtime.js"
import { TOOL_CACHE_PAYLOAD_BUDGET_BYTES, toolCacheUsage, toolCatalogPayloadBytes, type ToolCacheCounters } from "./tool-cache-budget.js"

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

type Entry = { expiresAt: number; tools: Promise<ExternalMcpTools>; payloadBytes: number }

// Only successful lists are kept, and only in this process. Concurrent calls
// share one in-flight list.
const entries = new Map<string, Entry>()
const counters: ToolCacheCounters = { hits: 0, misses: 0, evictions: 0, expirations: 0, oversized: 0 }

/** Also releases expired catalogs whose keys are never requested again. */
export function externalToolCatalogCacheUsage(now = Date.now()) {
  return toolCacheUsage(entries, EXTERNAL_TOOL_CATALOG_MAX_ENTRIES, counters, now)
}

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
  if (cached && cached.expiresAt > now()) {
    counters.hits += 1
    return cached.tools
  }
  counters.misses += 1
  const tools = load()
  const entry: Entry = { expiresAt: now() + EXTERNAL_TOOL_CATALOG_TTL_MS, tools, payloadBytes: 0 }
  // Count an expired replaced entry before deleting it below.
  externalToolCatalogCacheUsage(now())
  entries.delete(serialized)
  entries.set(serialized, entry)
  tools.then((loaded) => {
    if (entries.get(serialized) !== entry) return
    const bytes = toolCatalogPayloadBytes(loaded)
    if (bytes > TOOL_CACHE_PAYLOAD_BUDGET_BYTES) {
      entries.delete(serialized)
      counters.oversized += 1
      return
    }
    entry.payloadBytes = bytes
    externalToolCatalogCacheUsage(now())
  }, () => {
    if (entries.get(serialized) === entry) entries.delete(serialized)
  })
  externalToolCatalogCacheUsage(now())
  return tools
}

/** Forget a member's list, e.g. after a call through it failed or named a tool it lacks. */
export function forgetExternalToolCatalog(key: ExternalToolCatalogKey): void {
  entries.delete(serialize(key))
}
