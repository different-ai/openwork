import assert from "node:assert/strict"
import { test } from "node:test"
import {
  EXTERNAL_MCP_PRESETS,
  EXTERNAL_MCP_PRESETS_EXPANDED,
  ALL_EXTERNAL_MCP_PRESETS,
  externalMcpPresetForResponse,
  externalMcpPresetsForCatalog,
} from "../src/capability-sources/external-mcp-presets.js"
import { externalMcpOAuthConfigurationDefaults, matchExternalMcpPresetForUrl } from "../src/capability-sources/external-mcp-auth-policy.js"

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

test("the catalog includes all reviewed expanded presets", () => {
  const on = externalMcpPresetsForCatalog()
  assert.deepEqual([...on.map((preset) => preset.presetId)].sort(), [...CORE_IDS, ...EXPANDED_IDS].sort())
  assert.equal(on.length, EXTERNAL_MCP_PRESETS.length + EXTERNAL_MCP_PRESETS_EXPANDED.length)
})

test("the connector catalog offers expanded entries", () => {
  const on = connectorCatalogForQuery("airtable canva", false)
  const onIds = on?.entries.map((entry) => entry.id) ?? []
  assert.ok(onIds.includes("airtable"))
  assert.ok(onIds.includes("canva"))
})

test("every expanded-preset connection retains its auth match", () => {
  // Existing connections and new catalog entries use the same preset auth policy.
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
  const catalog = connectorCatalogForQuery("", true)
  const setup = new Map((catalog?.entries ?? []).map((entry) => [entry.id, entry.setup]))
  assert.equal(setup.get("tavily"), "api_key")
  for (const id of EXPANDED_IDS.filter((presetId) => presetId !== "tavily")) {
    assert.equal(setup.get(id), "oauth", id)
  }
})
test("presets that need an OAuth app carry the redirect URL to register; others never do", () => {
  const callback = "https://api.den.example/v1/mcp-connections/oauth/callback"
  const slack = EXTERNAL_MCP_PRESETS.find((preset) => preset.presetId === "slack")
  const notion = EXTERNAL_MCP_PRESETS.find((preset) => preset.presetId === "notion")
  assert.ok(slack && notion)
  assert.equal(externalMcpPresetForResponse(slack, { oauthCallbackUrl: callback }).oauthCallbackUrl, callback)
  assert.deepEqual(externalMcpPresetForResponse(slack, { oauthCallbackUrl: callback }).defaultOAuthScopes, slack.defaultOAuthScopes)
  assert.equal(externalMcpPresetForResponse(notion, { oauthCallbackUrl: callback }).oauthCallbackUrl, undefined)
  // A deployment without a public API URL omits it rather than inventing one.
  assert.equal(externalMcpPresetForResponse(slack, { oauthCallbackUrl: null }).oauthCallbackUrl, undefined)
  assert.equal(externalMcpPresetForResponse(slack, { registrationStatus: "unknown" }).registrationStatus, undefined)
  assert.equal(externalMcpPresetForResponse(slack, { registrationStatus: "requires_client" }).registrationStatus, "requires_client")
})

test("the Slack preset requests its original minimum by default; the rest of Slack's scopes are opt-in", () => {
  const slack = EXTERNAL_MCP_PRESETS.find((preset) => preset.presetId === "slack")
  assert.ok(slack)
  // Unchanged default: API- and agent-created connections request exactly this.
  assert.deepEqual(slack?.defaultOAuthScopes, [
    "search:read.public", "search:read.private", "search:read.im", "search:read.mpim", "search:read.files",
    "chat:write", "channels:history", "groups:history", "im:history", "mpim:history", "users:read",
  ])
  // Default plus optional is the full user-scope set Slack's MCP server advertises, with no overlap.
  const optional = [...(slack?.optionalOAuthScopes ?? [])]
  assert.equal(optional.some((scope) => slack?.defaultOAuthScopes?.includes(scope)), false)
  assert.deepEqual([...(slack?.defaultOAuthScopes ?? []), ...optional].sort(), [
    "canvases:read", "canvases:write", "channels:history", "channels:read", "channels:write", "chat:write",
    "emoji:read", "files:read", "files:write", "groups:history", "groups:read", "groups:write",
    "im:history", "im:read", "im:write", "lists:read", "lists:write", "mpim:history", "mpim:read", "mpim:write",
    "reactions:read", "reactions:write", "search:read.files", "search:read.im", "search:read.mpim",
    "search:read.private", "search:read.public", "search:read.users", "users:read", "users:read.email",
  ])
  // Only Slack carries explicit lists: every other preset keeps requesting what its server advertises.
  assert.deepEqual(ALL_EXTERNAL_MCP_PRESETS.filter((preset) => preset.defaultOAuthScopes || preset.optionalOAuthScopes).map((preset) => preset.presetId), ["slack"])
  // Den web reads the optional list from the catalog; the server's own default never includes it.
  assert.deepEqual(externalMcpPresetForResponse(slack, {}).optionalOAuthScopes, optional)
  const serverDefault = externalMcpOAuthConfigurationDefaults({ url: "https://mcp.slack.com/mcp" }).requestedScopes
  assert.deepEqual(serverDefault, slack.defaultOAuthScopes)
  assert.equal(serverDefault.some((scope) => optional.includes(scope)), false)
})
