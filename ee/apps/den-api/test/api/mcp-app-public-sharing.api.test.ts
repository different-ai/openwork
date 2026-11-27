import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

const den = await bootDen()
after(() => den.close())

const readAsMcp = async (path: string, method: string, params: Record<string, unknown> = {}) => {
  const response = await den.request(null, "POST", path, {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method, params },
  })
  assert.equal(response.status, 200, summary(response))
  const line = response.text.split("\n").find((entry) => entry.startsWith("data:"))
  return line ? JSON.parse(line.slice(5)) : response.body
}

test("a manager can publish and revoke a self-contained artifact without sharing its Plugin or tools", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Artifact Owner"), "Artifact sharing")
  const viewer = await den.newMember(owner, orgId, "Artifact Viewer")
  const created = await den.callMcpTool(await den.mintMcpToken(owner, orgId), "create_app", {
    title: "Public calculator",
    reactSource: `export default function Calculator() { return <main>Calculator for everyone</main> }`,
    textFallback: "Calculator for everyone",
    tools: [],
  })
  assert.equal(created.isError, false, created.raw)
  const appId = text(field(created.structured, "app", "appId"), "artifact ID")
  const pluginId = text(field(created.structured, "app", "pluginId"), "Plugin ID")
  const revisionId = text(field(created.structured, "app", "revisionId"), "artifact revision")
  const path = `/v1/mcp-apps/${appId}/public-sharing`
  const publicPath = `/mcp/public/apps/${appId}`
  const ownerRequest = den.as(owner, orgId)
  const browser = () => den.request(null, "GET", publicPath, { headers: { accept: "text/html" } })
  const state = await ownerRequest("GET", path)
  assert.equal(state.status, 200, summary(state))
  assert.deepEqual(state.body, { revisionId, publicUrl: null, canPublish: true })
  assert.equal((await browser()).status, 405)
  assert.equal(field(await readAsMcp(publicPath, "tools/list"), "error", "data", "error"), "public_app_unavailable")

  const grant = await ownerRequest("POST", `/v1/plugins/${pluginId}/access`, { orgMembershipId: viewer.memberId, role: "viewer" })
  assert.equal(grant.status, 201, summary(grant))
  const publish = { public: true, expectedRevisionId: revisionId }
  const refused = await den.as(viewer, orgId)("PUT", path, publish)
  assert.equal(refused.status, 403, summary(refused))

  const published = await ownerRequest("PUT", path, publish)
  assert.equal(published.status, 200, summary(published))
  assert.equal(new URL(text(field(published.body, "publicUrl"), "public URL")).pathname, publicPath)
  const publishedRevision = text(field(published.body, "revisionId"), "published revision")
  assert.notEqual(publishedRevision, revisionId)
  const page = await browser()
  assert.equal(page.status, 200, summary(page))
  assert.match(page.text, /data-mode="public"/)
  assert.equal(page.headers.get("cache-control"), "no-store")

  const toolList = list(field(await readAsMcp(publicPath, "tools/list"), "result", "tools"))
  assert.deepEqual(toolList.map((tool) => tool.name), ["open_app"])
  const uri = text(field(toolList[0], "_meta", "ui", "resourceUri"), "public resource URI")
  const contents = list(field(await readAsMcp(publicPath, "resources/read", { uri }), "result", "contents"))
  assert.match(text(contents[0]?.text, "public HTML"), /Calculator for everyone/)

  const stale = await ownerRequest("PUT", path, { public: false, expectedRevisionId: revisionId })
  assert.equal(stale.status, 409, summary(stale))
  const revoked = await ownerRequest("PUT", path, { public: false, expectedRevisionId: publishedRevision })
  assert.equal(revoked.status, 200, summary(revoked))
  assert.equal(field(revoked.body, "publicUrl"), null)
  assert.equal((await browser()).status, 405)
  assert.equal(field(await readAsMcp(publicPath, "resources/read", { uri }), "error", "data", "error"), "public_app_unavailable")
})

test("an artifact with a bound data tool cannot be published from Share", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Connected Artifact Owner"), "Connected artifacts")
  const token = await den.mintMcpToken(owner, orgId)
  const matches = await den.callMcpTool(token, "search_capabilities", { query: "get active organization", type: "api" })
  const lookup = list(field(matches.body, "matches")).find((match) => match.path === "/v1/org" && match.method === "GET")
  const capability = text(lookup?.name, "organization lookup capability")
  const created = await den.callMcpTool(token, "create_app", {
    title: "Organization details",
    reactSource: `export default function Organization() { return <main>Organization details</main> }`,
    textFallback: "Organization details",
    tools: [{ name: "get_organization", description: "Read the active organization", capability }],
  })
  assert.equal(created.isError, false, created.raw)
  const appId = text(field(created.structured, "app", "appId"), "artifact ID")
  const revisionId = text(field(created.structured, "app", "revisionId"), "artifact revision")
  const path = `/v1/mcp-apps/${appId}/public-sharing`
  const ownerRequest = den.as(owner, orgId)
  assert.deepEqual((await ownerRequest("GET", path)).body, { revisionId, publicUrl: null, canPublish: false })
  const refused = await ownerRequest("PUT", path, { public: true, expectedRevisionId: revisionId })
  assert.equal(refused.status, 409, summary(refused))
  assert.equal(field(refused.body, "error"), "public_app_has_tools")
  assert.equal(field(await readAsMcp(`/mcp/public/apps/${appId}`, "tools/list"), "error", "data", "error"), "public_app_unavailable")
})
