import { Buffer } from "node:buffer"

/** Serialized catalog bytes, not a measurement of the V8 heap. Applied per cache. */
export const TOOL_CACHE_PAYLOAD_BUDGET_BYTES = 64 * 1024 * 1024

type Entry = { expiresAt: number; payloadBytes: number }
export type ToolCacheCounters = {
  hits: number
  misses: number
  evictions: number
  expirations: number
  oversized: number
}

export function toolCatalogPayloadBytes(tools: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(tools), "utf8")
  } catch {
    // A result that cannot be measured can still be served without retaining it.
    return Number.POSITIVE_INFINITY
  }
}

/** Drop expired entries first, then keep the existing oldest-entry eviction policy. */
export function toolCacheUsage<T extends Entry>(
  entries: Map<string, T>,
  maxEntries: number,
  counters: ToolCacheCounters,
  now: number,
) {
  let payloadBytes = 0
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) {
      entries.delete(key)
      counters.expirations += 1
    } else {
      payloadBytes += entry.payloadBytes
    }
  }
  while (entries.size > maxEntries || payloadBytes > TOOL_CACHE_PAYLOAD_BUDGET_BYTES) {
    const oldest = entries.entries().next().value
    if (!oldest) break
    entries.delete(oldest[0])
    payloadBytes -= oldest[1].payloadBytes
    counters.evictions += 1
  }
  return { entries: entries.size, payload_bytes: payloadBytes, budget_bytes: TOOL_CACHE_PAYLOAD_BUDGET_BYTES, ...counters }
}
