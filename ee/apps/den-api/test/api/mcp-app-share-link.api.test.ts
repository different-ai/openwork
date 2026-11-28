import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen({ http: true, env: { DEN_DEPLOYMENT: "cloud", DEN_APP_MCP_SERVERS_ENABLED: "true" } })
after(() => den.close())

async function createApp(token: string, site = false) {
  const created = await den.callMcpTool(token, "create_app", {
    title: site ? "Artifact site" : "Internal artifact",
    reactSource: `export default function Artifact() { return <main>For teammates</main> }`,
    textFallback: "For teammates",
    tools: [],
    site,
  })
  assert.equal(created.isError, false, created.raw)
  const id = text(field(created.structured, "app", "appId"), "artifact ID")
  return {
    id,
    pluginId: text(field(created.structured, "app", "pluginId"), "Plugin ID"),
    sharePath: `/v1/mcp-apps/${id}/share-link`,
    mcpPath: `/mcp/agent/connections/${id}`,
  }
}

async function rpc(token: string, path: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const response = await den.request(token, "POST", path, {
    headers: { accept: "application/json, text/event-stream", "x-openwork-app-site": "1" },
    body: { jsonrpc: "2.0", id: 1, method, params },
  })
  assert.equal(response.status, 200, summary(response))
  const line = response.text.split("\n").find((entry) => entry.startsWith("data:"))
  return line ? JSON.parse(line.slice(5)) : response.body
}

test("with share links off, only site artifacts can open as member pages", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Rollout off owner"), "Rollout off")
  const token = await den.mintMcpToken(owner, orgId)
  const app = await createApp(token)
  const link = await den.as(owner, orgId)("GET", app.sharePath)
  assert.equal(link.status, 404, summary(link))
  assert.equal(field(link.body, "error"), "feature_disabled")
  assert.equal(field(await rpc(token, app.mcpPath, "tools/list"), "error", "data", "reason"), "not_found")

  const site = await createApp(token, true)
  const listed = await rpc(token, site.mcpPath, "tools/list")
  assert.deepEqual(list(field(listed, "result", "tools")).map((tool) => tool.name), ["open_app"])
})

test("a signed-in share link opens a non-site artifact only for its existing audience", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Share link owner"), "Share link audience")
  const viewer = await den.newMember(owner, orgId, "Share link viewer")
  const unshared = await den.newMember(owner, orgId, "Unshared teammate")
  const outside = await den.createOrg(await den.signUp("Outside member"), "Outside workspace")
  for (const id of [orgId, outside.orgId]) {
    const enabled = await den.setFeature(id, "artifactShareLinks", true)
    assert.equal(enabled.status, 200, summary(enabled))
  }
  const app = await createApp(await den.mintMcpToken(owner, orgId))
  const request = den.as(owner, orgId)
  const ownerLink = await request("GET", app.sharePath)
  assert.equal(ownerLink.status, 200, summary(ownerLink))
  const url = new URL(text(field(ownerLink.body, "url"), "artifact share link"))
  assert.equal(url.origin, "http://localhost:3005")
  assert.equal(url.pathname, "/artifact")
  assert.deepEqual([...url.searchParams], [["id", app.id], ["org", orgId]])

  const grant = await request("POST", `/v1/plugins/${app.pluginId}/access`, { orgMembershipId: viewer.memberId, role: "viewer" })
  assert.equal(grant.status, 201, summary(grant))
  const viewerLink = await den.as(viewer, orgId)("GET", app.sharePath)
  assert.equal(viewerLink.status, 200, summary(viewerLink))
  assert.deepEqual(viewerLink.body, ownerLink.body)

  const token = await den.mintMcpToken(viewer, orgId)
  const listed = await rpc(token, app.mcpPath, "tools/list")
  const launch = list(field(listed, "result", "tools")).find((tool) => tool.name === "open_app")
  const uri = text(field(launch, "_meta", "ui", "resourceUri"), "artifact resource URI")
  const opened = await rpc(token, app.mcpPath, "tools/call", { name: "open_app", arguments: { input: {} } })
  assert.equal(field(opened, "result", "structuredContent", "app", "appId"), app.id)
  const read = await rpc(token, app.mcpPath, "resources/read", { uri })
  const contents = list(field(read, "result", "contents"))
  assert.match(text(contents[0]?.text, "artifact HTML"), /For teammates/)

  for (const [member, organizationId] of [[unshared, orgId], [outside.owner, outside.orgId]] satisfies [typeof viewer, string][]) {
    const refused = await den.as(member, organizationId)("GET", app.sharePath)
    assert.equal(refused.status, 404, summary(refused))
    assert.equal(field(refused.body, "error"), "mcp_app_not_found")
    const refusedRpc = await rpc(await den.mintMcpToken(member, organizationId), app.mcpPath, "tools/list")
    assert.equal(field(refusedRpc, "error", "data", "reason"), "not_found")
  }

  const browser = await den.request(null, "GET", `${app.mcpPath}?org=${orgId}`, { headers: { accept: "text/html" } })
  assert.equal(browser.status, 200, summary(browser))
  assert.equal(browser.headers.get("cache-control"), "no-store")
  assert.match(browser.text, /data-mode="member"/u)
  assert.doesNotMatch(browser.text, /For teammates/u)
})

test("the browser cookie can scope a mint to another membership without switching active organization", async () => {
  const person = await den.signUp("Multi workspace member")
  const first = await den.createOrg(person, "First workspace")
  const second = await den.createOrg(person, "Second workspace")
  const foreign = await den.createOrg(await den.signUp("Foreign owner"), "Foreign workspace")
  assert.ok(person.cookie)
  const headers = { cookie: person.cookie }
  const active = await den.request(null, "POST", "/api/auth/organization/set-active", { headers, body: { organizationId: first.orgId } })
  assert.equal(active.status, 200, summary(active))
  const mint = (id?: string) => den.request(null, "POST", "/v1/mcp/token", {
    headers: { ...headers, ...(id ? { "x-openwork-org-id": id } : {}) },
    body: { scopes: ["mcp:read", "mcp:write"] },
  })

  const scoped = await mint(second.orgId)
  assert.equal(scoped.status, 200, summary(scoped))
  assert.equal(field(scoped.body, "organizationId"), second.orgId)
  assert.equal(field((await mint()).body, "organizationId"), first.orgId)

  const refused = await mint(foreign.orgId)
  assert.equal(refused.status, 404, summary(refused))
  assert.deepEqual(refused.body, { error: "organization_not_found" })
})
