import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { bootDen, field, isRecord, list, summary, text, type Json, type Member } from "./harness.js"

/**
 * Artifact storage as an MCP client meets it: a member builds an artifact that
 * saves data with create_app, and members read and change its rows through the
 * artifact's own MCP server. Who may do what is decided by Den on every call.
 */
const directory = await mkdtemp(join(tmpdir(), "artifact-storage-api-"))
const den = await bootDen({ env: { DEN_DEPLOYMENT: "cloud", DEN_ARTIFACT_STORAGE_BACKEND: "local", DEN_ARTIFACT_STORAGE_LOCAL_DIR: directory, DEN_ARTIFACT_STORAGE_MAX_ROWS: "6" } })
after(async () => {
  await den.close()
  await rm(directory, { force: true, recursive: true })
})

const main = await den.createOrg(await den.signUp("Request owner"), "Requests organization")
const other = await den.createOrg(await den.signUp("Outside owner"), "Outside organization")
const teammate = await den.newMember(main.owner, main.orgId, "Request teammate")
const stranger = await den.newMember(main.owner, main.orgId, "Unshared member")

async function setStorage(orgId: string, enabled: boolean) {
  const change = await den.setFeature(orgId, "artifactStorage", enabled)
  assert.equal(change.status, 200, summary(change))
}

type Rpc = { result: unknown; error: unknown; raw: string }

async function rpc(token: string, path: string, method: string, params: Record<string, unknown> = {}): Promise<Rpc> {
  const response = await den.request(token, "POST", path, {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method, params },
  })
  const line = response.text.split("\n").find((entry) => entry.startsWith("data:"))
  const envelope: Json = line ? JSON.parse(line.slice(5)) : response.body
  return { result: field(envelope, "result"), error: field(envelope, "error"), raw: response.text }
}

function toolNames(listed: Rpc): string[] {
  return list(field(listed.result, "tools")).map((tool) => text(tool.name, "tool name"))
}

type ToolAnswer = { isError: boolean; structured: unknown; body: unknown; meta: unknown }

async function call(token: string, path: string, name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const answer = await rpc(token, path, "tools/call", { name, arguments: args })
  assert.equal(answer.error, undefined, answer.raw.slice(0, 400))
  const first = list(field(answer.result, "content")).find((part) => part.type === "text")
  let body: unknown = null
  try { body = typeof first?.text === "string" ? JSON.parse(first.text) : null } catch { body = first?.text }
  return { isError: field(answer.result, "isError") === true, structured: field(answer.result, "structuredContent"), body, meta: field(answer.result, "_meta") }
}

const REACT = "export default function View() { return <p>Requests</p> }"
const STORAGE = {
  collections: [
    { name: "requests", fields: [{ name: "title", type: "text", required: true }, { name: "status", type: "text", options: ["new", "approved"] }] },
    { name: "drafts", scope: "personal", fields: [{ name: "body", type: "text", required: true }] },
    { name: "claims", edit: "creator", fields: [{ name: "item", type: "text", required: true }] },
  ],
}

async function build(owner: Member, orgId: string, title: string, extra: Record<string, unknown> = {}) {
  const token = await den.mintMcpToken(owner, orgId)
  const created = await den.callMcpTool(token, "create_app", { title, reactSource: REACT, textFallback: `${title} saves requests.`, storage: STORAGE, ...extra })
  return { token, created }
}

async function share(owner: Member, orgId: string, pluginId: string, memberId: string) {
  const shared = await den.as(owner, orgId)("POST", `/v1/plugins/${pluginId}/access`, { orgMembershipId: memberId, role: "viewer" })
  assert.ok(shared.status < 300, summary(shared))
}

function appOf(created: Awaited<ReturnType<typeof den.callMcpTool>>) {
  assert.equal(created.isError, false, created.raw.slice(0, 600))
  const appId = text(field(created.structured, "app", "appId"), "app id")
  return { appId, pluginId: text(field(created.structured, "app", "pluginId"), "plugin id"), revisionId: text(field(created.structured, "app", "revisionId"), "revision id"), path: `/mcp/agent/connections/${appId}` }
}

test("with the feature off, the authoring tools are what they were and storage cannot be declared", async () => {
  const token = await den.mintMcpToken(main.owner, main.orgId)
  const listed = await rpc(token, "/mcp/agent", "tools/list")
  const tools = list(field(listed.result, "tools"))
  assert.ok(!toolNames(listed).includes("read_app_data") && !toolNames(listed).includes("write_app_data"), "no data tools while off")
  for (const name of ["prepare_app", "create_app", "update_app"]) {
    const tool = tools.find((entry) => entry.name === name)
    assert.ok(tool, `${name} is listed`)
    assert.ok(!JSON.stringify(tool).toLowerCase().includes("storage"), `${name} does not mention storage while off`)
  }
  const refused = await den.callMcpTool(token, "create_app", { title: "Off requests", reactSource: REACT, textFallback: "Off.", storage: STORAGE })
  assert.equal(refused.isError, true)
  assert.match(refused.text, /Unrecognized key: "storage"/u)
})

test("an artifact that declares storage gets a read and a write tool, and two members see the same rows", async () => {
  await setStorage(main.orgId, true)
  const { token: ownerToken, created } = await build(main.owner, main.orgId, "Shared requests")
  const app = appOf(created)
  const opensWith = async (token: string, name: string, args: Record<string, unknown>) =>
    field((await rpc(token, "/mcp/agent", "tools/call", { name, arguments: args })).result, "_meta", "openwork/storage")
  const launched = await rpc(ownerToken, "/mcp/agent", "tools/call", { name: "create_app", arguments: { title: "Launch check", reactSource: REACT, textFallback: "Launch check.", storage: STORAGE } })
  assert.deepEqual(field(launched.result, "_meta", "openwork/storage"), { available: true, collections: ["requests", "drafts", "claims"] }, "the artifact a chat opens right after building it is told its data is available")
  const launchedId = text(field(launched.result, "structuredContent", "app", "appId"), "launched app id")
  const launchedName = `plugin:${text(field(launched.result, "structuredContent", "app", "pluginId"), "plugin id")}:${launchedId}`
  assert.deepEqual(await opensWith(ownerToken, "execute_capability", { name: launchedName }), { available: true, collections: ["requests", "drafts", "claims"] })
  const plain = await rpc(ownerToken, "/mcp/agent", "tools/call", { name: "create_app", arguments: { title: "Plain launch", reactSource: REACT, textFallback: "Plain." } })
  assert.equal(field(plain.result, "_meta", "openwork/storage"), undefined, "an artifact without storage launches exactly as before")
  await share(main.owner, main.orgId, app.pluginId, teammate.memberId)
  const teammateToken = await den.mintMcpToken(teammate, main.orgId)

  const served = await rpc(ownerToken, app.path, "tools/list")
  assert.deepEqual(toolNames(served), ["open_app", "storage_read", "storage_write"])
  assert.deepEqual(list(field(served.result, "tools")).map((tool) => field(tool, "_meta", "openwork/storage")), [undefined, "read", "write"])
  const opened = await call(ownerToken, app.path, "open_app", {})
  assert.deepEqual(field(opened.meta, "openwork/storage"), { available: true, collections: ["requests", "drafts", "claims"] })

  const added = await call(ownerToken, app.path, "storage_write", { collection: "requests", action: "insert", values: { title: "Standing desk", status: "new" } })
  assert.equal(added.isError, false, JSON.stringify(added.body))
  const rowId = text(field(added.structured, "id"), "row id")

  const seen = await call(teammateToken, app.path, "storage_read", { collection: "requests" })
  assert.equal(field(seen.structured, "total"), 1)
  const row = list(field(seen.structured, "rows"))[0]
  assert.equal(field(row, "values", "title"), "Standing desk")
  assert.equal(row?.createdBy, "Request owner")
  assert.equal(row?.mine, false)

  const approved = await call(teammateToken, app.path, "storage_write", { collection: "requests", action: "update", id: rowId, values: { status: "approved" } })
  assert.equal(approved.isError, false, JSON.stringify(approved.body))
  const again = await call(ownerToken, app.path, "storage_read", { collection: "requests", where: { status: "approved" } })
  assert.equal(field(again.structured, "total"), 1)
  assert.equal(list(field(again.structured, "rows"))[0]?.updatedBy, "Request teammate")

  const invalid = await call(teammateToken, app.path, "storage_write", { collection: "requests", action: "update", id: rowId, values: { status: "maybe" } })
  assert.equal(invalid.isError, true)
  assert.equal(field(invalid.body, "error"), "invalid_value")

  await test("the platform keeps personal rows private and creator-only rows protected", async () => {
    const draft = await call(ownerToken, app.path, "storage_write", { collection: "drafts", action: "insert", values: { body: "Only mine" } })
    assert.equal(draft.isError, false)
    assert.equal(field((await call(teammateToken, app.path, "storage_read", { collection: "drafts" })).structured, "total"), 0)
    const peek = await call(teammateToken, app.path, "storage_write", { collection: "drafts", action: "delete", id: text(field(draft.structured, "id"), "draft id") })
    assert.equal(field(peek.body, "error"), "row_not_found")
    const claim = await call(ownerToken, app.path, "storage_write", { collection: "claims", action: "insert", values: { item: "Taxi" } })
    const taken = await call(teammateToken, app.path, "storage_write", { collection: "claims", action: "delete", id: text(field(claim.structured, "id"), "claim id") })
    assert.equal(field(taken.body, "error"), "not_allowed")
    assert.equal(field((await call(ownerToken, app.path, "storage_read", { collection: "claims" })).structured, "total"), 1)
  })

  await test("a member the artifact is not shared with, and another organization, reach nothing", async () => {
    const strangerToken = await den.mintMcpToken(stranger, main.orgId)
    const refused = await rpc(strangerToken, app.path, "tools/call", { name: "storage_read", arguments: { collection: "requests" } })
    assert.equal(field(refused.error, "data", "error"), "mcp_app_not_found", refused.raw.slice(0, 300))
    const viaAgent = await den.callMcpTool(strangerToken, "read_app_data", { appId: app.appId, collection: "requests" })
    assert.equal(viaAgent.isError, true)
    assert.equal(field(viaAgent.body, "error"), "no_saved_data")
    await setStorage(other.orgId, true)
    const outsideToken = await den.mintMcpToken(other.owner, other.orgId)
    const outside = await rpc(outsideToken, app.path, "tools/call", { name: "storage_read", arguments: { collection: "requests" } })
    assert.ok(outside.error, "another organization's member gets an error, not rows")
    const outsideAgent = await den.callMcpTool(outsideToken, "read_app_data", { appId: app.appId, collection: "requests" })
    assert.equal(field(outsideAgent.body, "error"), "no_saved_data")
  })

  await test("the agent's data tools check the token's scope before they say whether an artifact exists", async () => {
    const issued = await den.request(stranger.token, "POST", "/v1/mcp/token", { orgId: main.orgId, body: { scopes: ["mcp:read"] } })
    const readOnly = text(field(issued.body, "token"), "read-only token")
    for (const appId of [app.appId, "cob_01kq0000000000000000000000"]) {
      const refused = await den.callMcpTool(readOnly, "write_app_data", { appId, collection: "requests", action: "insert", values: { title: "Probe" } })
      assert.equal(field(refused.body, "error"), "insufficient_mcp_scope", appId)
    }
    const strangerToken = await den.mintMcpToken(stranger, main.orgId)
    const wrote = await den.callMcpTool(strangerToken, "write_app_data", { appId: app.appId, collection: "requests", action: "insert", values: { title: "Intruder" } })
    assert.equal(field(wrote.body, "error"), "no_saved_data")
    assert.equal(field((await call(ownerToken, app.path, "storage_read", { collection: "requests", where: { title: "Intruder" } })).structured, "total"), 0)
  })

  await test("a read-only token reads and cannot write", async () => {
    const issued = await den.request(teammate.token, "POST", "/v1/mcp/token", { orgId: main.orgId, body: { scopes: ["mcp:read"] } })
    const readOnly = text(field(issued.body, "token"), "read-only token")
    assert.equal((await call(readOnly, app.path, "storage_read", { collection: "requests" })).isError, false)
    const refused = await call(readOnly, app.path, "storage_write", { collection: "requests", action: "insert", values: { title: "Nope" } })
    assert.equal(field(refused.body, "error"), "insufficient_mcp_scope")
  })

  await test("the agent reads and adds rows without opening the artifact", async () => {
    const listed = toolNames(await rpc(teammateToken, "/mcp/agent", "tools/list"))
    assert.ok(listed.includes("read_app_data") && listed.includes("write_app_data"))
    const read = await den.callMcpTool(teammateToken, "read_app_data", { appId: app.appId, collection: "requests" })
    assert.equal(read.isError, false, read.raw.slice(0, 400))
    assert.equal(field(read.structured, "total"), 1)
    const wrote = await den.callMcpTool(teammateToken, "write_app_data", { appId: app.appId, collection: "requests", action: "insert", values: { title: "Second monitor" } })
    assert.equal(wrote.isError, false, wrote.raw.slice(0, 400))
    assert.equal(field((await call(ownerToken, app.path, "storage_read", { collection: "requests" })).structured, "total"), 2)
  })

  await test("update_app keeps the rows, and read_app returns what the artifact saves", async () => {
    const read = await den.callMcpTool(ownerToken, "read_app", { appId: app.appId })
    assert.deepEqual(field(read.structured, "storage"), STORAGE)
    const updated = await den.callMcpTool(ownerToken, "update_app", {
      appId: app.appId, expectedRevisionId: app.revisionId, title: "Shared requests", reactSource: `${REACT}\n`, textFallback: "Requests, second revision.",
    })
    assert.equal(updated.isError, false, updated.raw.slice(0, 400))
    assert.notEqual(field(updated.structured, "app", "revisionId"), app.revisionId)
    const kept = await call(teammateToken, app.path, "storage_read", { collection: "requests", orderBy: "title", order: "asc" })
    assert.deepEqual(list(field(kept.structured, "rows")).map((entry) => field(entry, "values", "title")), ["Second monitor", "Standing desk"])
  })

  await test("the artifact stops taking rows at its cap", async () => {
    let refused: ToolAnswer | null = null
    for (let index = 0; index < 8 && !refused; index += 1) {
      const answer = await call(ownerToken, app.path, "storage_write", { collection: "requests", action: "insert", values: { title: `Filler ${index}` } })
      if (answer.isError) refused = answer
    }
    assert.equal(field(refused?.body, "error"), "storage_full")
  })

  await test("turning the feature off hides the tools, says the data is unavailable, and keeps the data", async () => {
    await setStorage(main.orgId, false)
    assert.deepEqual(toolNames(await rpc(ownerToken, app.path, "tools/list")), ["open_app"])
    const opened = await call(ownerToken, app.path, "open_app", {})
    assert.deepEqual(field(opened.meta, "openwork/storage"), { available: false, collections: ["requests", "drafts", "claims"] })
    const blocked = await call(ownerToken, app.path, "storage_read", { collection: "requests" })
    assert.equal(blocked.isError, true)
    assert.equal(field(blocked.body, "error"), "storage_unavailable")
    const blockedWrite = await call(ownerToken, app.path, "storage_write", { collection: "requests", action: "delete", id: rowId })
    assert.equal(field(blockedWrite.body, "error"), "storage_unavailable")
    assert.ok(!toolNames(await rpc(ownerToken, "/mcp/agent", "tools/list")).includes("read_app_data"))
    assert.deepEqual(await opensWith(ownerToken, "execute_capability", { name: launchedName }), { available: false, collections: ["requests", "drafts", "claims"] })
    assert.ok(existsSync(join(directory, main.orgId, `${app.appId}.sqlite`)), "the database file is still there")
    await setStorage(main.orgId, true)
    const back = await call(teammateToken, app.path, "storage_read", { collection: "requests", where: { title: "Standing desk" } })
    assert.equal(field(back.structured, "total"), 1)
  })
})

test("a public artifact cannot save data, so nobody writes without signing in", async () => {
  await setStorage(main.orgId, true)
  const { created } = await build(main.owner, main.orgId, "Public requests", { public: true })
  assert.equal(created.isError, true)
  assert.equal(field(created.body, "error"), "public_app_has_storage")

  const { token, created: made } = await build(main.owner, main.orgId, "Private requests")
  const app = appOf(made)
  const published = await den.callMcpTool(token, "update_app", { appId: app.appId, expectedRevisionId: app.revisionId, title: "Private requests", reactSource: REACT, textFallback: "Requests.", public: true })
  assert.equal(field(published.body, "error"), "public_app_has_storage")
  const sharingPath = `/v1/mcp-apps/${app.appId}/public-sharing`
  const sharing = await den.as(main.owner, main.orgId)("GET", sharingPath)
  assert.deepEqual(sharing.body, { revisionId: app.revisionId, publicUrl: null, canPublish: false, blockedBy: "storage" })
  const linked = await den.as(main.owner, main.orgId)("PUT", sharingPath, { public: true, expectedRevisionId: app.revisionId })
  assert.equal(linked.status, 409)
  assert.equal(field(linked.body, "error"), "public_app_has_storage")
  const anonymous = await den.request(null, "POST", `/mcp/public/apps/${app.appId}`, {
    headers: { accept: "application/json, text/event-stream" },
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "storage_write", arguments: { collection: "requests", action: "insert", values: { title: "Anonymous" } } } },
  })
  assert.ok(anonymous.text.includes("public_app_unavailable"), anonymous.text.slice(0, 300))
  assert.equal(field((await call(token, app.path, "storage_read", { collection: "requests" })).structured, "total"), 0)
})

test("a tool cannot take the name of a storage tool, and the storage tools do not exist without storage", async () => {
  await setStorage(main.orgId, true)
  const token = await den.mintMcpToken(main.owner, main.orgId)
  const plain = appOf(await den.callMcpTool(token, "create_app", { title: "No storage", reactSource: REACT, textFallback: "Plain." }))
  assert.deepEqual(toolNames(await rpc(token, plain.path, "tools/list")), ["open_app"])
  const opened = await call(token, plain.path, "open_app", {})
  assert.equal(isRecord(opened.meta) ? opened.meta["openwork/storage"] : undefined, undefined)
  const missing = await rpc(token, plain.path, "tools/call", { name: "storage_read", arguments: { collection: "requests" } })
  assert.ok(missing.error, "an artifact without storage has no storage tool")
  const reserved = await den.callMcpTool(token, "create_app", {
    title: "Reserved name", reactSource: REACT, textFallback: "Reserved.", storage: STORAGE,
    tools: [{ name: "storage_write", description: "Pretends to be the storage tool.", capability: "getOrg" }],
  })
  assert.equal(reserved.isError, true)
  assert.equal(field(reserved.body, "error"), "invalid_mcp_app_input")
  assert.match(text(field(reserved.body, "message"), "message"), /storage_write is the name of a tool OpenWork gives/u)
})
