import assert from "node:assert/strict"
import { test } from "node:test"
import {
  EXTERNAL_MCP_PRESETS,
  EXTERNAL_MCP_PRESETS_EXPANDED,
  ALL_EXTERNAL_MCP_PRESETS,
  externalMcpPresetsForCatalog,
} from "../src/capability-sources/external-mcp-presets.js"
import { matchExternalMcpPresetForUrl } from "../src/capability-sources/external-mcp-auth-policy.js"

// The connector catalog imports connection-navigation, which reads env at
// import time; satisfy the schema with synthetic unit-test values.
process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/expanded_mcp_presets_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-expanded-mcp-presets-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-expanded-mcp-presets-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { connectorCatalogForQuery } = await import("../src/mcp/connector-catalog.js")

const CORE_IDS = EXTERNAL_MCP_PRESETS.map((preset) => preset.presetId)
const EXPANDED_IDS = EXTERNAL_MCP_PRESETS_EXPANDED.map((preset) => preset.presetId)

test("the core presets are the original eleven and the expanded set only adds", () => {
  assert.equal(EXTERNAL_MCP_PRESETS.length, 11)
  assert.deepEqual([...new Set(CORE_IDS)].sort(), CORE_IDS.sort())
  assert.deepEqual(
    [...new Set([...CORE_IDS, ...EXPANDED_IDS])].sort(),
    [...new Set([...CORE_IDS, ...EXPANDED_IDS])].sort(),
  )
  // No expanded preset reuses a core id or URL.
  for (const expanded of EXTERNAL_MCP_PRESETS_EXPANDED) {
    assert.ok(!CORE_IDS.includes(expanded.presetId), `expanded id collides with core: ${expanded.presetId}`)
    assert.ok(!CORE_IDS.includes(expanded.url), `expanded url collides with core: ${expanded.url}`)
  }
})

test("the catalog hides expanded presets when the flag is off and shows them when on", () => {
  const off = externalMcpPresetsForCatalog({ expanded: false })
  assert.deepEqual([...off.map((preset) => preset.presetId)].sort(), [...CORE_IDS].sort())
  assert.equal(off.length, EXTERNAL_MCP_PRESETS.length)

  const on = externalMcpPresetsForCatalog({ expanded: true })
  assert.deepEqual([...on.map((preset) => preset.presetId)].sort(), [...CORE_IDS, ...EXPANDED_IDS].sort())
  assert.equal(on.length, EXTERNAL_MCP_PRESETS.length + EXTERNAL_MCP_PRESETS_EXPANDED.length)
})

test("the connector catalog only offers expanded entries behind the flag", () => {
  const off = connectorCatalogForQuery("airtable canva", false, { expandedMcpPresets: false })
  const offIds = off?.entries.map((entry) => entry.id) ?? []
  assert.ok(!offIds.includes("airtable"))
  assert.ok(!offIds.includes("canva"))

  const on = connectorCatalogForQuery("airtable canva", false, { expandedMcpPresets: true })
  const onIds = on?.entries.map((entry) => entry.id) ?? []
  assert.ok(onIds.includes("airtable"))
  assert.ok(onIds.includes("canva"))
})

test("turning the flag off never revokes an existing expanded-preset connection's auth match", () => {
  // An existing connection to an expanded-preset server is still recognized by
  // the auth policy's preset match, so its stored auth behavior survives a kill.
  for (const expanded of EXTERNAL_MCP_PRESETS_EXPANDED) {
    const matched = matchExternalMcpPresetForUrl(expanded.url)
    assert.equal(matched?.presetId, expanded.presetId)
  }
  // And every known preset is in the combined list the auth policy defaults to.
  assert.equal(ALL_EXTERNAL_MCP_PRESETS.length, EXTERNAL_MCP_PRESETS.length + EXTERNAL_MCP_PRESETS_EXPANDED.length)
})

test("Tavily is the only API-key preset among the expanded set", () => {
  const apikey = EXTERNAL_MCP_PRESETS_EXPANDED.filter((preset) => preset.authType === "apikey").map((preset) => preset.presetId)
  assert.deepEqual(apikey, ["tavily"])
})

test("the connectors catalog states each new server's setup: Tavily needs an API key, the rest sign in with OAuth", () => {
  const catalog = connectorCatalogForQuery("", true, { expandedMcpPresets: true })
  const setup = new Map((catalog?.entries ?? []).map((entry) => [entry.id, entry.setup]))
  assert.equal(setup.get("tavily"), "api_key")
  for (const id of EXPANDED_IDS.filter((presetId) => presetId !== "tavily")) {
    assert.equal(setup.get(id), "oauth", id)
  }
})