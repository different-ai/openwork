import type { listExternalMcpTools } from "../capability-sources/external-mcp-client-runtime.js"
import { TOOL_CACHE_PAYLOAD_BUDGET_BYTES, toolCacheUsage, toolCatalogPayloadBytes, type ToolCacheCounters } from "./tool-cache-budget.js"

type ExternalMcpTools = Awaited<ReturnType<typeof listExternalMcpTools>>

export const EXTERNAL_TOOL_CATALOG_TTL_MS = 60_000
export const EXTERNAL_TOOL_CATALOG_MAX_ENTRIES = 500

export type ExternalToolCatalogKey = {
  organizationId: string
  connectionId: string
  updatedAt: Date
  orgMembershipId: string
  credentialIdentity: string
}

type Entry = { expiresAt: number; tools: Promise<ExternalMcpTools>; payloadBytes: number }

const entries = new Map<string, Entry>()
const counters: ToolCacheCounters = { hits: 0, misses: 0, evictions: 0, expirations: 0, oversized: 0 }

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

export function forgetExternalToolCatalog(key: ExternalToolCatalogKey): void {
  entries.delete(serialize(key))
}
