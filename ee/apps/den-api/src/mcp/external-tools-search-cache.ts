import type { listExternalMcpTools } from "../capability-sources/external-mcp-client-runtime.js"
import { TOOL_CACHE_PAYLOAD_BUDGET_BYTES, toolCacheUsage, toolCatalogPayloadBytes, type ToolCacheCounters } from "./tool-cache-budget.js"

const SUCCESS_TTL_MS = 10 * 60_000
const FAILURE_TTL_MS = 60_000
export const EXTERNAL_TOOLS_SEARCH_CACHE_MAX_ENTRIES = 500
const SHARED_CREDENTIAL_IDENTITY = "shared"

export type ExternalToolsSearchCacheKey = {
  organizationId: string
  connectionId: string
  updatedAt: Date
  credentialMode: "shared" | "per_member"
  orgMembershipId?: string
}

export type ExternalToolsSearchProbeResult =
  | { outcome: "success"; tools: Awaited<ReturnType<typeof listExternalMcpTools>> }
  | { outcome: "failure"; error: unknown }

type CacheEntry = {
  expiresAt: number
  result: ExternalToolsSearchProbeResult
  payloadBytes: number
}

const entries = new Map<string, CacheEntry>()
const counters: ToolCacheCounters = { hits: 0, misses: 0, evictions: 0, expirations: 0, oversized: 0 }

/** Payload bytes cover successful tool catalogs; failures remain entry-count bounded. */
export function externalToolsSearchCacheUsage(now = Date.now()) {
  return toolCacheUsage(entries, EXTERNAL_TOOLS_SEARCH_CACHE_MAX_ENTRIES, counters, now)
}

function cacheKey(input: ExternalToolsSearchCacheKey): string {
  const identity = input.credentialMode === "per_member"
    ? input.orgMembershipId
    : SHARED_CREDENTIAL_IDENTITY
  if (!identity) throw new Error("Per-member external MCP search cache keys require an organization membership id.")
  return JSON.stringify([input.organizationId, input.connectionId, input.updatedAt.getTime(), identity])
}

export function getExternalToolsSearchCache(
  key: ExternalToolsSearchCacheKey,
  now: () => number = Date.now,
): ExternalToolsSearchProbeResult | undefined {
  const serializedKey = cacheKey(key)
  const entry = entries.get(serializedKey)
  if (!entry) {
    counters.misses += 1
    return undefined
  }
  if (entry.expiresAt <= now()) {
    entries.delete(serializedKey)
    counters.expirations += 1
    counters.misses += 1
    return undefined
  }
  counters.hits += 1
  return entry.result
}

export function setExternalToolsSearchCache(
  key: ExternalToolsSearchCacheKey,
  result: ExternalToolsSearchProbeResult,
  now: () => number = Date.now,
): void {
  const serializedKey = cacheKey(key)
  externalToolsSearchCacheUsage(now())
  entries.delete(serializedKey)
  const payloadBytes = result.outcome === "success" ? toolCatalogPayloadBytes(result.tools) : 0
  if (payloadBytes > TOOL_CACHE_PAYLOAD_BUDGET_BYTES) {
    counters.oversized += 1
    return
  }
  entries.set(serializedKey, {
    expiresAt: now() + (result.outcome === "success" ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
    result,
    payloadBytes,
  })
  externalToolsSearchCacheUsage(now())
}

export function clearExternalToolsSearchCache(): void {
  entries.clear()
}
