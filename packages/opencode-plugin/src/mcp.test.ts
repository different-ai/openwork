import assert from "node:assert/strict"
import { test } from "node:test"
import { directServerName, fetchDirectServers, mcpServerEntries, mcpTokenNeedsRenewal, mintMcpToken, parseServerIndex } from "./mcp.ts"
import { API, createFakeDen, MCP_TOKEN, SESSION_TOKEN } from "./test-den.ts"

test("names direct servers exactly like the desktop", () => {
  // slug of the name + first 6 hex chars of sha256(connectionId)
  assert.match(directServerName({ connectionId: "mcn_slack", name: "Slack" }), /^openwork-direct-slack-[0-9a-f]{6}$/)
  assert.match(directServerName({ connectionId: "c", name: "Google  Drive (Team)!" }), /^openwork-direct-google-drive-team-[0-9a-f]{6}$/)
  assert.match(directServerName({ connectionId: "c", name: "!!!" }), /^openwork-direct-[0-9a-f]{6}$/)
  assert.equal(directServerName({ connectionId: "c", name: "x".repeat(60) }).length, "openwork-direct-".length + 40 + 1 + 6)
})

test("mints the first-party MCP token with the member's session", async () => {
  const den = createFakeDen()
  const token = await mintMcpToken(den.fetch, { apiBaseUrl: API, token: SESSION_TOKEN, orgId: "org_01m2" })
  assert.equal(token.token, MCP_TOKEN)
  assert.equal(token.expiresAt, Date.parse("2026-10-15T00:00:00.000Z"))
  assert.equal(mcpTokenNeedsRenewal(token, token.expiresAt - 2 * 24 * 60 * 60 * 1000), false)
  assert.equal(mcpTokenNeedsRenewal(token, token.expiresAt - 60 * 60 * 1000), true, "re-minted inside the last day")
  assert.equal(mcpTokenNeedsRenewal(null, 0), true)
})

test("reads the connection index over Streamable HTTP and keeps only safe, directly exposed servers", async () => {
  const den = createFakeDen()
  const servers = await fetchDirectServers(den.fetch, API, MCP_TOKEN)
  assert.deepEqual(servers, [{ connectionId: "mcn_slack", name: "Slack", url: `${API}/mcp/agent/connections/mcn_slack` }])
  assert.deepEqual(den.calls, ["POST /mcp/agent", "POST /mcp/agent", "POST /mcp/agent"])
})

test("rejects an unrecognized index", () => {
  assert.throws(() => parseServerIndex(JSON.stringify({ schemaVersion: "other", servers: [] }), API))
})

test("builds remote MCP entries that never start OpenCode's own OAuth", () => {
  const entries = mcpServerEntries({
    apiBaseUrl: `${API}/`,
    token: MCP_TOKEN,
    servers: [{ connectionId: "mcn_slack", name: "Slack", url: `${API}/mcp/agent/connections/mcn_slack` }],
  })
  const names = Object.keys(entries)
  assert.equal(names[0], "openwork-cloud")
  assert.match(names[1]!, /^openwork-direct-slack-/)
  assert.deepEqual(entries["openwork-cloud"], {
    type: "remote",
    url: `${API}/mcp/agent`,
    headers: { Authorization: `Bearer ${MCP_TOKEN}` },
    oauth: false,
  })
  assert.equal(entries[names[1]!]?.url, `${API}/mcp/agent/connections/mcn_slack`)
  assert.equal(entries[names[1]!]?.oauth, false)
})

test("never hands OpenCode a bearer for a plain-HTTP remote Den", () => {
  assert.deepEqual(mcpServerEntries({ apiBaseUrl: "http://den.example.com", token: MCP_TOKEN, servers: [] }), {})
  assert.ok(mcpServerEntries({ apiBaseUrl: "http://127.0.0.1:8790", token: MCP_TOKEN, servers: [] })["openwork-cloud"])
})
