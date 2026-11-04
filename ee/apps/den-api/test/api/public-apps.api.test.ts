import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text, type Call } from "./harness.js"

// Apps built in OpenWork are on by default in den-api; the eval harness turns them off.
const den = await bootDen({ env: { DEN_APP_MCP_SERVERS_ENABLED: "true" } })
after(() => den.close())

const org = await den.createOrg(await den.signUp("Public App Owner"), "Public App workspace")
const admin = await den.newMember(org.owner, org.orgId, "Public App Admin", "admin")
const member = await den.newMember(org.owner, org.orgId, "Public App Member")
assert.equal((await den.setFeature(org.orgId, "publicApps", true)).status, 200)

const ownerMcp = await den.mintMcpToken(org.owner, org.orgId)

async function createApp(title: string, tools: unknown[] = []): Promise<{ appId: string; revisionId: string }> {
  const created = await den.callMcpTool(ownerMcp, "create_app", {
    title,
    description: `${title} for visitors.`,
    reactSource: `export default function App() { return <main><h1>${title}</h1></main> }`,
    textFallback: `${title}.`,
    tools,
  })
  assert.equal(created.isError, false, created.raw)
  return {
    appId: text(field(created.structured, "app", "appId"), "app id"),
    revisionId: text(field(created.structured, "app", "revisionId"), "revision id"),
  }
}

/** One JSON-RPC request to a public App with no credentials at all, as an outside MCP client sends it. */
async function anonymous(path: string, method: string, params: Record<string, unknown> = {}): Promise<{ call: Call; result: unknown; error: unknown }> {
  const call = await den.request(null, "POST", path, {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 7, method, params },
  })
  const line = call.text.split("\n").find((entry) => entry.startsWith("data:"))
  const envelope: unknown = line ? JSON.parse(line.slice(5)) : call.body
  return { call, result: field(envelope, "result"), error: field(envelope, "error") }
}

const initialize = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "public-app-test", version: "1.0.0" } }
const publish = (token: string, appId: string, body: Record<string, unknown> = {}, orgId = org.orgId) =>
  den.request(token, "PUT", `/v1/public-apps/${appId}`, { orgId, body })
const unpublish = (token: string, appId: string) => den.request(token, "DELETE", `/v1/public-apps/${appId}`, { orgId: org.orgId })

function publicPath(call: Call): string {
  return new URL(text(field(call.body, "url"), "public URL")).pathname
}

test("an owner publishes an App that anyone opens without signing in, and nothing else is exposed", async () => {
  const app = await createApp("Coffee with the team")
  const published = await publish(org.owner.token, app.appId)
  assert.equal(published.status, 200, summary(published))
  assert.equal(field(published.body, "revisionId"), app.revisionId)
  const path = publicPath(published)
  assert.equal(path, "/mcp/public/apps/coffee-with-the-team", "the URL is named after the App")

  const init = await anonymous(path, "initialize", initialize)
  assert.equal(init.call.status, 200, init.call.text)
  assert.equal(init.call.headers.get("www-authenticate"), null, "no sign-in is asked for")
  assert.match(text(field(init.result, "instructions"), "instructions"), /needs no sign-in and runs no other tools/)

  const tools = await anonymous(path, "tools/list")
  assert.deepEqual(list(field(tools.result, "tools")).map((tool) => tool.name), ["open_app"])

  const opened = await anonymous(path, "tools/call", { name: "open_app", arguments: {} })
  assert.equal(field(opened.result, "isError"), undefined, opened.call.text)
  const resourceUri = text(field(opened.result, "structuredContent", "app", "resourceUri"), "resource uri")
  assert.equal(field(opened.result, "structuredContent", "app", "serverPath"), path)

  const resource = await anonymous(path, "resources/read", { uri: resourceUri })
  const contents = list(field(resource.result, "contents"))
  assert.match(text(contents[0]?.text, "App HTML"), /<html/i)

  // Only the pinned revision of this App is served.
  const other = await createApp("Private board")
  const foreign = await anonymous(path, "resources/read", { uri: resourceUri.replace(app.appId, other.appId) })
  assert.notEqual(foreign.error, undefined, foreign.call.text)
})

test("publishing needs an owner or admin with the feature on, and Apps with tools are refused", async () => {
  const app = await createApp("Office hours")
  const asMember = await publish(member.token, app.appId)
  assert.equal(asMember.status, 403, summary(asMember))
  assert.equal((await den.request(null, "PUT", `/v1/public-apps/${app.appId}`, { orgId: org.orgId, body: {} })).status, 401)

  const withTools = await createApp("Lookup", [{ name: "who_am_i", description: "Read the current member.", capability: "getMe" }])
  const refused = await publish(org.owner.token, withTools.appId)
  assert.equal(refused.status, 409, summary(refused))
  assert.equal(field(refused.body, "error"), "public_app_has_tools")

  assert.equal((await den.setFeature(org.orgId, "publicApps", false)).status, 200)
  try {
    const off = await publish(org.owner.token, app.appId)
    assert.equal(off.status, 404, summary(off))
    assert.equal(field(off.body, "error"), "feature_disabled")
  } finally {
    assert.equal((await den.setFeature(org.orgId, "publicApps", true)).status, 200)
  }
})

test("the public URL stops answering when the App is unpublished or the feature is turned off, and stays the same when published again", async () => {
  const app = await createApp("Visitor sign-up")
  const first = await publish(admin.token, app.appId)
  assert.equal(first.status, 200, summary(first))
  const path = publicPath(first)

  const listed = await den.request(admin.token, "GET", "/v1/public-apps", { orgId: org.orgId })
  assert.ok(list(field(listed.body, "apps")).some((entry) => entry.appId === app.appId), summary(listed))

  assert.equal((await unpublish(admin.token, app.appId)).status, 200)
  const gone = await anonymous(path, "tools/list")
  assert.equal(field(gone.error, "message"), "This App is not available.", gone.call.text)
  assert.equal((await unpublish(admin.token, app.appId)).status, 404, "already unpublished")

  const again = await publish(admin.token, app.appId)
  assert.equal(publicPath(again), path, "the same URL comes back")
  assert.equal(field((await anonymous(path, "tools/list")).error, "message"), undefined)

  assert.equal((await den.setFeature(org.orgId, "publicApps", false)).status, 200)
  try {
    const off = await anonymous(path, "tools/list")
    assert.equal(field(off.error, "message"), "This App is not available.", off.call.text)
  } finally {
    assert.equal((await den.setFeature(org.orgId, "publicApps", true)).status, 200)
  }
})

test("unknown and malformed public names are refused the same way", async () => {
  for (const slug of ["no-such-app", "pma_00000000000000000000000000", "x"]) {
    const refused = await anonymous(`/mcp/public/apps/${slug}`, "tools/list")
    assert.equal(field(refused.error, "message"), "This App is not available.", refused.call.text)
  }
  const get = await den.request(null, "GET", "/mcp/public/apps/no-such-app")
  assert.equal(get.status, 405)
  const huge = await den.request(null, "POST", "/mcp/public/apps/no-such-app", {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { padding: "x".repeat(70 * 1024) } },
  })
  assert.equal(huge.status, 413, "oversized requests are refused unread")
})

test("a chosen slug is unique across organizations, invalid names are refused, and renaming retires the old URL", async () => {
  const app = await createApp("Front desk")
  const named = await publish(org.owner.token, app.appId, { slug: "visit-us" })
  assert.equal(named.status, 200, summary(named))
  assert.equal(publicPath(named), "/mcp/public/apps/visit-us")

  const elsewhere = await den.createOrg(await den.signUp("Other Owner"), "Other public workspace")
  assert.equal((await den.setFeature(elsewhere.orgId, "publicApps", true)).status, 200)
  const otherMcp = await den.mintMcpToken(elsewhere.owner, elsewhere.orgId)
  const created = await den.callMcpTool(otherMcp, "create_app", {
    title: "Visit us", reactSource: "export default function App() { return <p>Hi</p> }", textFallback: "Hi.", tools: [],
  })
  const otherAppId = text(field(created.structured, "app", "appId"), "other app id")
  const taken = await publish(elsewhere.owner.token, otherAppId, { slug: "visit-us" }, elsewhere.orgId)
  assert.equal(taken.status, 409, summary(taken))
  assert.equal(field(taken.body, "error"), "public_app_slug_taken")
  // The title-based default collides too, and is refused the same way rather than taking the URL.
  const defaulted = await publish(elsewhere.owner.token, otherAppId, {}, elsewhere.orgId)
  assert.equal(field(defaulted.body, "error"), "public_app_slug_taken", summary(defaulted))
  assert.equal((await publish(elsewhere.owner.token, otherAppId, { slug: "visit-us-too" }, elsewhere.orgId)).status, 200)

  for (const slug of ["Bad Name", "x", "-leading"]) {
    const invalid = await publish(org.owner.token, app.appId, { slug })
    assert.equal(invalid.status, 400, `${slug}: ${summary(invalid)}`)
  }

  const renamed = await publish(org.owner.token, app.appId, { slug: "front-desk" })
  assert.equal(publicPath(renamed), "/mcp/public/apps/front-desk")
  assert.equal(field((await anonymous("/mcp/public/apps/visit-us", "tools/list")).error, "message"), "This App is not available.")
  assert.equal(field((await anonymous("/mcp/public/apps/front-desk", "tools/list")).error, "message"), undefined)
})
