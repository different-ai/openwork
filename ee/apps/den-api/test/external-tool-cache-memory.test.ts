import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import {
  cachedExternalToolCatalog, externalToolCatalogCacheUsage, forgetExternalToolCatalog,
  EXTERNAL_TOOL_CATALOG_TTL_MS, EXTERNAL_TOOL_CATALOG_MAX_ENTRIES, type ExternalToolCatalogKey,
} from "../src/mcp/external-tool-catalog-cache.js"
import {
  getExternalToolsSearchCache, setExternalToolsSearchCache, clearExternalToolsSearchCache,
  externalToolsSearchCacheUsage, EXTERNAL_TOOLS_SEARCH_CACHE_MAX_ENTRIES, type ExternalToolsSearchCacheKey,
} from "../src/mcp/external-tools-search-cache.js"
import { TOOL_CACHE_PAYLOAD_BUDGET_BYTES } from "../src/mcp/tool-cache-budget.js"

type Tools = Awaited<ReturnType<Parameters<typeof cachedExternalToolCatalog>[1]>>
const tools: Tools = [{ name: "example", inputSchema: { type: "object" } }]
const key = (connectionId = "same", orgMembershipId = "member-a", credentialIdentity = "grant-a"): ExternalToolCatalogKey => ({
  organizationId: "organization", connectionId, updatedAt: new Date(0), orgMembershipId, credentialIdentity,
})
const searchKey = (connectionId = "same", orgMembershipId = "member-a"): ExternalToolsSearchCacheKey => ({
  organizationId: "organization", connectionId, updatedAt: new Date(0), credentialMode: "per_member", orgMembershipId,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
afterEach(() => {
  externalToolCatalogCacheUsage(Number.MAX_SAFE_INTEGER)
  clearExternalToolsSearchCache()
})

test("concurrent calls share discovery without sharing members or credentials", async () => {
  let loads = 0
  const pending = deferred<Tools>()
  const first = cachedExternalToolCatalog(key(), () => { loads++; return pending.promise })
  const second = cachedExternalToolCatalog(key(), () => { loads++; return Promise.resolve([]) })
  assert.strictEqual(first, second)
  assert.equal(loads, 1)
  pending.resolve(tools)
  assert.strictEqual(await first, tools)
  assert.strictEqual(await cachedExternalToolCatalog(key(), () => { throw Error("cache missed") }), tools)
  await cachedExternalToolCatalog(key("same", "member-b"), () => { loads++; return Promise.resolve(tools) })
  await cachedExternalToolCatalog(key("same", "member-a", "grant-b"), () => { loads++; return Promise.resolve(tools) })
  assert.equal(loads, 3)
})

test("failed and obsolete loads cannot poison or overwrite a newer catalog", async () => {
  await assert.rejects(cachedExternalToolCatalog(key(), () => Promise.reject(Error("unavailable"))), /unavailable/)
  assert.strictEqual(await cachedExternalToolCatalog(key(), () => Promise.resolve(tools)), tools)
  const fresh: Tools = [{ name: "fresh", inputSchema: { type: "object" } }]
  const outcomes: Array<"resolve" | "reject"> = ["resolve", "reject"]
  for (const outcome of outcomes) {
    const pending = deferred<Tools>()
    const old = cachedExternalToolCatalog(key(outcome), () => pending.promise)
    const handled = outcome === "reject" ? assert.rejects(old, /late failure/) : old
    forgetExternalToolCatalog(key(outcome))
    await cachedExternalToolCatalog(key(outcome), () => Promise.resolve(fresh))
    if (outcome === "reject") pending.reject(Error("late failure"))
    else pending.resolve(tools)
    await handled
    assert.strictEqual(await cachedExternalToolCatalog(key(outcome), () => { throw Error("new result lost") }), fresh)
  }
})

test("large catalogs evict older entries from both caches before exceeding their payload budget", async () => {
  const large: Tools = [{ name: "large", description: "x".repeat(2 * 1024 * 1024), inputSchema: { type: "object" } }]
  for (let n = 0; n < 35; n++) {
    assert.strictEqual(await cachedExternalToolCatalog(key(String(n)), () => Promise.resolve(large)), large)
    setExternalToolsSearchCache(searchKey(String(n)), { outcome: "success", tools: large })
    for (const usage of [externalToolCatalogCacheUsage(), externalToolsSearchCacheUsage()]) {
      assert.ok(usage.payload_bytes <= TOOL_CACHE_PAYLOAD_BUDGET_BYTES)
    }
  }
  assert.equal(getExternalToolsSearchCache(searchKey("0")), undefined)
  assert.equal(getExternalToolsSearchCache(searchKey("34", "other-member")), undefined)
  assert.ok(externalToolCatalogCacheUsage().evictions > 0)
  assert.ok(externalToolsSearchCacheUsage().evictions > 0)
  let reloaded = false
  await cachedExternalToolCatalog(key("0"), () => { reloaded = true; return Promise.resolve(tools) })
  assert.equal(reloaded, true)
})

test("idle expiry releases entries and preserves success, failure and credential freshness rules", async () => {
  let clock = Date.now()
  const now = () => clock
  const failure = new Error("same failure instance")
  await cachedExternalToolCatalog(key(), () => Promise.resolve(tools), now)
  const result = { outcome: "success", tools } satisfies Parameters<typeof setExternalToolsSearchCache>[1]
  setExternalToolsSearchCache(searchKey(), result, now)
  setExternalToolsSearchCache(searchKey("failure"), { outcome: "failure", error: failure }, now)
  const cachedFailure = getExternalToolsSearchCache(searchKey("failure"), now)
  assert.equal(cachedFailure?.outcome, "failure")
  if (cachedFailure?.outcome !== "failure") throw Error("Failure was lost")
  assert.strictEqual(cachedFailure.error, failure)
  clock += EXTERNAL_TOOL_CATALOG_TTL_MS + 1
  assert.equal(externalToolCatalogCacheUsage(clock).entries, 0)
  assert.equal(getExternalToolsSearchCache(searchKey("failure"), now), undefined)
  assert.strictEqual(getExternalToolsSearchCache(searchKey(), now), result)
  clock += 600_001
  assert.equal(externalToolsSearchCacheUsage(clock).entries, 0)
  const shared: ExternalToolsSearchCacheKey = { ...searchKey("shared"), credentialMode: "shared" }
  setExternalToolsSearchCache(shared, result, now)
  assert.strictEqual(getExternalToolsSearchCache({ ...shared, orgMembershipId: "another-member" }, now), result)
  assert.throws(() => getExternalToolsSearchCache({ ...searchKey(), orgMembershipId: undefined }, now), /membership id/)
})

test("oversized results are served unchanged but are not retained", async () => {
  const oversized: Tools = [{ name: "oversized", description: "x".repeat(65 * 1024 * 1024), inputSchema: { type: "object" } }]
  assert.strictEqual(await cachedExternalToolCatalog(key(), () => Promise.resolve(oversized)), oversized)
  setExternalToolsSearchCache(searchKey(), { outcome: "success", tools: oversized })
  assert.equal(externalToolCatalogCacheUsage().entries, 0)
  assert.equal(externalToolsSearchCacheUsage().entries, 0)
})

test("small catalogs still respect the existing entry-count limit", async () => {
  for (let n = 0; n < 505; n++) {
    await cachedExternalToolCatalog(key(String(n)), () => Promise.resolve(tools))
    setExternalToolsSearchCache(searchKey(String(n)), { outcome: "success", tools })
  }
  assert.equal(externalToolCatalogCacheUsage().entries, EXTERNAL_TOOL_CATALOG_MAX_ENTRIES)
  assert.equal(externalToolsSearchCacheUsage().entries, EXTERNAL_TOOLS_SEARCH_CACHE_MAX_ENTRIES)
})
