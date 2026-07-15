import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  EnterpriseMcpProtocolCache,
  MCP_CURRENT_PROTOCOL_VERSION,
  type McpCacheContext,
} from "../src/index.js"

function context(overrides: Partial<McpCacheContext> = {}): McpCacheContext {
  return {
    organizationId: "org-1",
    connectionId: "connection-1",
    credentialOwner: "shared",
    credentialRevision: "credential-1",
    protocolVersion: MCP_CURRENT_PROTOCOL_VERSION,
    capabilityHash: "capability-1",
    method: "tools/list",
    ...overrides,
  }
}

describe("enterprise MCP protocol cache", () => {
  it("separates entries by tenant, member, credential revision, protocol, and capability hash", () => {
    const cache = new EnterpriseMcpProtocolCache<string>()
    cache.set({ context: context(), value: "shared-org-1", ttlMs: 60_000, scope: "private" })

    assert.equal(cache.get(context()), "shared-org-1")
    assert.equal(cache.get(context({ organizationId: "org-2" })), undefined)
    assert.equal(cache.get(context({ credentialOwner: "member:user-1" })), undefined)
    assert.equal(cache.get(context({ credentialRevision: "credential-2" })), undefined)
    assert.equal(cache.get(context({ capabilityHash: "capability-2" })), undefined)
  })

  it("expires within the server TTL and supports tenant-scoped invalidation", () => {
    let now = 1_000
    const cache = new EnterpriseMcpProtocolCache<string>({ clock: { now: () => now } })
    cache.set({ context: context(), value: "catalog", ttlMs: 100, scope: "private" })
    assert.equal(cache.get(context()), "catalog")
    now = 1_100
    assert.equal(cache.get(context()), undefined)

    cache.set({ context: context(), value: "catalog", ttlMs: 100, scope: "private" })
    cache.set({
      context: context({ organizationId: "org-2" }),
      value: "other-catalog",
      ttlMs: 100,
      scope: "private",
    })
    assert.equal(cache.invalidate({ organizationId: "org-1", connectionId: "connection-1" }), 1)
    assert.equal(cache.get(context({ organizationId: "org-2" })), "other-catalog")
  })
})
