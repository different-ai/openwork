import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, text, type Call } from "./harness.js"

// Apps built in OpenWork are on by default in den-api; the eval harness turns them off.
const den = await bootDen({ env: { DEN_APP_MCP_SERVERS_ENABLED: "true" } })
after(() => den.close())

const org = await den.createOrg(await den.signUp("Public App Owner"), "Public App workspace")
const mcp = await den.mintMcpToken(org.owner, org.orgId)
const setFeature = async (on: boolean) => assert.equal((await den.setFeature(org.orgId, "publicApps", on)).status, 200)
await setFeature(true)

const source = (title: string) => ({
  title,
  description: `${title} for visitors.`,
  reactSource: `export default function App() { return <main><h1>${title}</h1></main> }`,
  textFallback: `${title}.`,
})
const whoAmI = [{ name: "who_am_i", description: "Read the current member.", capability: "getMe" }]

async function createApp(title: string, extra: Record<string, unknown> = {}) {
  const created = await den.callMcpTool(mcp, "create_app", { ...source(title), tools: [], ...extra })
  assert.equal(created.isError, false, created.raw)
  return {
    appId: text(field(created.structured, "app", "appId"), "app id"),
    revisionId: text(field(created.structured, "app", "revisionId"), "revision id"),
    raw: created.raw,
  }
}

async function updateApp(app: { appId: string; revisionId: string }, title: string, extra: Record<string, unknown>) {
  const updated = await den.callMcpTool(mcp, "update_app", { ...source(title), appId: app.appId, expectedRevisionId: app.revisionId, ...extra })
  return { ...updated, revisionId: updated.isError ? app.revisionId : text(field(updated.structured, "app", "revisionId"), "revision id") }
}

/** One JSON-RPC request with no credentials at all, as an outside MCP client sends it. */
async function anonymous(appId: string, method: string, params: Record<string, unknown> = {}): Promise<{ call: Call; result: unknown; error: unknown }> {
  const call = await den.request(null, "POST", `/mcp/public/apps/${appId}`, {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 7, method, params },
  })
  const line = call.text.split("\n").find((entry) => entry.startsWith("data:"))
  const envelope: unknown = line ? JSON.parse(line.slice(5)) : call.body
  return { call, result: field(envelope, "result"), error: field(envelope, "error") }
}

const unavailable = async (appId: string, why: string) => {
  const refused = await anonymous(appId, "tools/list")
  assert.equal(field(refused.error, "message"), "This App is not available.", `${why}: ${refused.call.text}`)
}
const available = async (appId: string, why: string) => {
  const served = await anonymous(appId, "tools/list")
  assert.deepEqual(list(field(served.result, "tools")).map((tool) => tool.name), ["open_app"], `${why}: ${served.call.text}`)
}

test("an App marked public opens without signing in, and nothing else is exposed", async () => {
  const app = await createApp("Coffee with the team", { public: true })
  const path = `/mcp/public/apps/${app.appId}`
  assert.ok(app.raw.includes(path), "create_app returns the public URL")

  const init = await anonymous(app.appId, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "public-app-test", version: "1.0.0" } })
  assert.equal(init.call.status, 200, init.call.text)
  assert.equal(init.call.headers.get("www-authenticate"), null, "no sign-in is asked for")
  await available(app.appId, "marked public")

  const opened = await anonymous(app.appId, "tools/call", { name: "open_app", arguments: {} })
  assert.equal(field(opened.result, "isError"), undefined, opened.call.text)
  assert.equal(field(opened.result, "structuredContent", "app", "serverPath"), path)
  const resourceUri = text(field(opened.result, "structuredContent", "app", "resourceUri"), "resource uri")
  const resource = await anonymous(app.appId, "resources/read", { uri: resourceUri })
  assert.match(text(list(field(resource.result, "contents"))[0]?.text, "App HTML"), /<html/i)

  // Another App's revision is never served through this one.
  const other = await createApp("Private board")
  const foreign = await anonymous(app.appId, "resources/read", { uri: resourceUri.replace(app.appId, other.appId) })
  assert.notEqual(foreign.error, undefined, foreign.call.text)
  await unavailable(other.appId, "never marked public")
})

test("an App with tools cannot be public, and the mark needs the feature", async () => {
  const withTools = await den.callMcpTool(mcp, "create_app", { ...source("Lookup"), tools: whoAmI, public: true })
  assert.equal(withTools.isError, true, withTools.raw)
  assert.match(withTools.raw, /public_app_has_tools/)

  const app = await createApp("Office hours", { public: true })
  const addTool = await updateApp(app, "Office hours", { tools: whoAmI })
  assert.equal(addTool.isError, true, "a public App cannot gain a tool")
  assert.match(addTool.raw, /public_app_has_tools/)
  await available(app.appId, "the refused update changed nothing")

  await setFeature(false)
  try {
    const off = await den.callMcpTool(mcp, "create_app", { ...source("Off"), tools: [], public: true })
    assert.equal(off.isError, true, off.raw)
    assert.match(off.raw, /public_apps_off/)
    await unavailable(app.appId, "feature off")
  } finally {
    await setFeature(true)
  }
  await available(app.appId, "feature back on")
})

test("an update keeps the mark unless it says otherwise, and unmarking stops the URL at once", async () => {
  const app = await createApp("Visitor sign-up")
  await unavailable(app.appId, "private by default")

  const marked = await updateApp(app, "Visitor sign-up", { public: true })
  assert.equal(marked.isError, false, marked.raw)
  await available(app.appId, "marked by update_app")

  const edited = await updateApp({ appId: app.appId, revisionId: marked.revisionId }, "Visitor sign-up 2", {})
  assert.equal(edited.isError, false, edited.raw)
  await available(app.appId, "an edit that omits public keeps it")

  const unmarked = await updateApp({ appId: app.appId, revisionId: edited.revisionId }, "Visitor sign-up 2", { public: false })
  assert.equal(unmarked.isError, false, unmarked.raw)
  await unavailable(app.appId, "unmarked")
})

test("unknown ids, other methods and oversized requests are refused", async () => {
  for (const id of ["no-such-app", "cob_00000000000000000000000000"]) await unavailable(id, id)
  assert.equal((await den.request(null, "GET", "/mcp/public/apps/no-such-app")).status, 405)
  const huge = await den.request(null, "POST", "/mcp/public/apps/no-such-app", {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { padding: "x".repeat(70 * 1024) } },
  })
  assert.equal(huge.status, 413, "oversized requests are refused unread")
})
