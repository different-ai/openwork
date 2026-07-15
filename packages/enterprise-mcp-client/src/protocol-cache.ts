import type { EnterpriseMcpClock, McpSupportedProtocolVersion } from "./contracts.js"

const DEFAULT_MAX_ENTRIES = 512
const DEFAULT_MAX_TTL_MS = 15 * 60_000

export type McpCacheScope = "private" | "public"

export type McpCacheContext = {
  organizationId: string
  connectionId: string
  credentialOwner: "shared" | `member:${string}`
  credentialRevision: string
  protocolVersion: McpSupportedProtocolVersion
  capabilityHash: string
  method: string
  variant?: string
}

type CacheEntry<T> = {
  context: McpCacheContext
  value: T
  scope: McpCacheScope
  expiresAt: number
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty.`)
}

function cacheKey(context: McpCacheContext): string {
  assertNonEmpty(context.organizationId, "The MCP cache organization id")
  assertNonEmpty(context.connectionId, "The MCP cache connection id")
  assertNonEmpty(context.credentialOwner, "The MCP cache credential owner")
  assertNonEmpty(context.credentialRevision, "The MCP cache credential revision")
  assertNonEmpty(context.capabilityHash, "The MCP cache capability hash")
  assertNonEmpty(context.method, "The MCP cache method")
  return JSON.stringify([
    context.organizationId,
    context.connectionId,
    context.credentialOwner,
    context.credentialRevision,
    context.protocolVersion,
    context.capabilityHash,
    context.method,
    context.variant ?? "",
  ])
}

export class EnterpriseMcpProtocolCache<T> {
  readonly #entries = new Map<string, CacheEntry<T>>()
  readonly #clock: EnterpriseMcpClock
  readonly #maxEntries: number
  readonly #maxTtlMs: number

  constructor(input: {
    clock?: EnterpriseMcpClock
    maxEntries?: number
    maxTtlMs?: number
  } = {}) {
    this.#clock = input.clock ?? { now: () => Date.now() }
    this.#maxEntries = input.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.#maxTtlMs = input.maxTtlMs ?? DEFAULT_MAX_TTL_MS
    if (!Number.isInteger(this.#maxEntries) || this.#maxEntries <= 0) {
      throw new Error("The MCP cache entry limit must be a positive integer.")
    }
    if (!Number.isFinite(this.#maxTtlMs) || this.#maxTtlMs <= 0) {
      throw new Error("The MCP cache TTL limit must be positive and finite.")
    }
  }

  get(context: McpCacheContext): T | undefined {
    const key = cacheKey(context)
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.#clock.now()) {
      this.#entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(input: {
    context: McpCacheContext
    value: T
    ttlMs: number
    scope: McpCacheScope
  }): void {
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) return
    const key = cacheKey(input.context)
    this.pruneExpired()
    if (!this.#entries.has(key) && this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value
      if (typeof oldest === "string") this.#entries.delete(oldest)
    }
    this.#entries.set(key, {
      context: input.context,
      value: input.value,
      scope: input.scope,
      expiresAt: this.#clock.now() + Math.min(input.ttlMs, this.#maxTtlMs),
    })
  }

  invalidate(input: {
    organizationId: string
    connectionId?: string
    credentialOwner?: McpCacheContext["credentialOwner"]
    method?: string
  }): number {
    let removed = 0
    for (const [key, entry] of this.#entries) {
      if (entry.context.organizationId !== input.organizationId) continue
      if (input.connectionId && entry.context.connectionId !== input.connectionId) continue
      if (input.credentialOwner && entry.context.credentialOwner !== input.credentialOwner) continue
      if (input.method && entry.context.method !== input.method) continue
      this.#entries.delete(key)
      removed += 1
    }
    return removed
  }

  clear(): void {
    this.#entries.clear()
  }

  private pruneExpired(): void {
    const now = this.#clock.now()
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key)
    }
  }
}
