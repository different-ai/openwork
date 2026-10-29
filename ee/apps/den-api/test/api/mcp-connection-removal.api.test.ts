/**
 * Removing an organization connection with an agent
 * (requestMcpConnectionRemoval): discoverable only with the rollout, the same
 * permissions as the dashboard, the exact connection named, plugin
 * dependencies refused unless the user agreed. The agent's call removes
 * nothing; the person confirms through the dashboard DELETE, which agents
 * cannot call, and the connection and its credentials are then gone.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { bootDen, field, list, startFakeMcpServer, summary, text, type McpToolResult, type Member } from "./harness.js"

const den = await bootDen()
const service = await startFakeMcpServer({ tools: [{ name: "list_projects", description: "List projects", text: "projects" }] })
after(async () => { await service.close(); await den.close() })
const { client } = await import("../../src/db.js")
if (!("getConnection" in client)) throw new Error("connection removal tests need MySQL")

const { orgId, owner } = await den.createOrg(await den.signUp("Removal Owner"), "Connection removal")
const teammate = await den.newMember(owner, orgId, "Removal Teammate")
const ownerApi = den.as(owner, orgId)
const ownerToken = await den.mintMcpToken(owner, orgId)
const teammateToken = await den.mintMcpToken(teammate, orgId)

/** Owners add a shared-key connection for everyone; members add a no-sign-in one for themselves. */
async function addConnection(person: Member, name: string): Promise<string> {
  const created = await den.as(person, orgId)("POST", "/v1/mcp-connections", person === owner
    ? { name, url: `${service.url}/mcp`, authType: "apikey", credentialMode: "shared", apiKey: `key-for-${name.toLowerCase().replace(/\W+/g, "-")}`, access: { orgWide: true } }
    : { name, url: `${service.url}/mcp`, authType: "none", credentialMode: "shared", access: { orgWide: false, memberIds: [person.memberId], teamIds: [] } })
  assert.equal(created.status, 200, summary(created))
  return text(field(created.body, "id"), "connection id")
}

async function listedIds(): Promise<string[]> {
  const listed = await ownerApi("GET", "/v1/mcp-connections?scope=manageable")
  assert.equal(listed.status, 200, summary(listed))
  return list(field(listed.body, "connections")).map((row) => String(row.id))
}

async function storedRows(connectionId: string): Promise<{ accounts: number; grants: number; connections: number }> {
  const count = async (sql: string) => {
    const [rows] = await client.query(sql, [connectionId])
    return Number(list(rows)[0]?.total ?? 0)
  }
  return {
    accounts: await count("SELECT COUNT(*) AS total FROM connected_account WHERE provider_id = ?"),
    grants: await count("SELECT COUNT(*) AS total FROM external_mcp_connection_access_grant WHERE external_mcp_connection_id = ?"),
    connections: await count("SELECT COUNT(*) AS total FROM external_mcp_connection WHERE id = ?"),
  }
}

function matchNames(result: McpToolResult): string[] {
  return list(field(result.body, "matches")).map((entry) => String(entry.name))
}

function requestRemoval(token: string, connectionId: string, body: Record<string, unknown>) {
  return den.callMcpTool(token, "execute_capability", { name: "requestMcpConnectionRemoval", path: { connectionId }, body })
}

test("an owner's agent prepares removing the exact connection; nothing is removed until the person confirms in Den", async () => {
  const id = await addConnection(owner, "Lab Deploys")
  const before = await storedRows(id)
  assert.equal(before.connections, 1)
  assert.ok(before.grants >= 1, "who can use it is stored before removal")

  const getConnections = await den.callMcpTool(ownerToken, "search_capabilities", { query: "list mcp connections", limit: 20 })
  assert.ok(matchNames(getConnections).includes("getMcpConnections"), getConnections.raw.slice(0, 400))
  for (const query of ["delete connection", "remove connector", "delete MCP connection"]) {
    const search = await den.callMcpTool(ownerToken, "search_capabilities", { query, limit: 20 })
    assert.ok(matchNames(search).includes("requestMcpConnectionRemoval"), `${query}: ${search.raw.slice(0, 400)}`)
  }

  const wrongName = await requestRemoval(ownerToken, id, { expectedName: "Lab Deploy" })
  assert.equal(wrongName.isError, true, wrongName.raw.slice(0, 400))
  assert.match(wrongName.raw, /connection_name_mismatch/)

  // Even a call claiming the user confirmed is refused: approval is not something the agent can send.
  const selfConfirmed = await requestRemoval(ownerToken, id, { expectedName: "Lab Deploys", confirm: true })
  assert.equal(selfConfirmed.isError, true, selfConfirmed.raw.slice(0, 400))

  const prepared = await requestRemoval(ownerToken, id, { expectedName: "Lab Deploys" })
  assert.equal(prepared.isError, false, prepared.raw.slice(0, 400))
  assert.equal(field(prepared.body, "status"), "confirmation_required")
  assert.equal(field(prepared.body, "connection", "id"), id)
  assert.equal(field(prepared.body, "handoff", "action"), "open_link")
  const link = new URL(text(field(prepared.body, "handoff", "url"), "handoff link"))
  assert.equal(link.pathname, `/dashboard/mcp-connections/${id}`)
  assert.equal(link.searchParams.get("remove"), "1")
  assert.deepEqual(await storedRows(id), before, "preparing removes nothing")
  assert.ok((await listedIds()).includes(id))

  // The agent cannot take the dashboard's delete path.
  const dashboardDelete = await den.callMcpTool(ownerToken, "execute_capability", { name: "deleteMcpConnectionsByConnectionId", path: { connectionId: id } })
  assert.equal(dashboardDelete.isError, true, dashboardDelete.raw.slice(0, 400))
  assert.ok((await listedIds()).includes(id))

  // The person opens the link and chooses Remove: Den sends the dashboard DELETE with their session.
  const confirmed = await ownerApi("DELETE", `/v1/mcp-connections/${id}`)
  assert.equal(confirmed.status, 200, summary(confirmed))
  assert.equal((await listedIds()).includes(id), false)
  assert.deepEqual(await storedRows(id), { accounts: 0, grants: 0, connections: 0 })

  const afterwards = await requestRemoval(ownerToken, id, { expectedName: "Lab Deploys" })
  assert.equal(afterwards.isError, true, afterwards.raw.slice(0, 400))
  assert.match(afterwards.raw, /connection_not_found/)
})

test("a member cannot prepare removing a connection someone else added, but can for their own", async () => {
  const ownersId = await addConnection(owner, "Owner Billing")
  const denied = await requestRemoval(teammateToken, ownersId, { expectedName: "Owner Billing" })
  assert.equal(denied.isError, true, denied.raw.slice(0, 400))
  assert.match(denied.raw, /forbidden/)

  const teammatesId = await addConnection(teammate, "Teammate Notes")
  const own = await requestRemoval(teammateToken, teammatesId, { expectedName: "Teammate Notes" })
  assert.equal(own.isError, false, own.raw.slice(0, 400))
  assert.equal(field(own.body, "status"), "confirmation_required")
  assert.ok((await listedIds()).includes(teammatesId))
})

test("an unknown connection is reported missing", async () => {
  const missing = await requestRemoval(ownerToken, createDenTypeId("externalMcpConnection"), { expectedName: "Ghost" })
  assert.equal(missing.isError, true, missing.raw.slice(0, 400))
  assert.match(missing.raw, /connection_not_found/)
})

test("a connection a plugin needs is refused until the user agrees it may leave that plugin", async () => {
  const id = await addConnection(owner, "Plugin Tracker")
  const pluginName = `Tracker Plugin ${den.stamp}`
  const plugin = await ownerApi("POST", "/v1/plugins", { name: pluginName })
  assert.equal(plugin.status, 201, summary(plugin))
  const pluginId = text(field(plugin.body, "item", "id"), "plugin id")
  // ARRANGE ONLY: bind the plugin's declared MCP server to this connection, as configuring the plugin's requirement does.
  await client.query(
    "INSERT INTO plugin_mcp_requirement_binding (id, organization_id, plugin_id, config_object_id, server_name, external_mcp_connection_id, created_by_org_membership_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [createDenTypeId("pluginMcpRequirementBinding"), orgId, pluginId, createDenTypeId("configObject"), "tracker", id, owner.memberId],
  )

  const blocked = await requestRemoval(ownerToken, id, { expectedName: "Plugin Tracker" })
  assert.equal(blocked.isError, true, blocked.raw.slice(0, 400))
  assert.match(blocked.raw, /connection_in_use/)
  assert.ok(blocked.raw.includes(pluginName), "the error names the plugin that needs it")

  const agreed = await requestRemoval(ownerToken, id, { expectedName: "Plugin Tracker", detachFromPlugins: true })
  assert.equal(agreed.isError, false, agreed.raw.slice(0, 400))
  assert.deepEqual(list(field(agreed.body, "requiredBy")).map((entry) => entry.pluginId), [pluginId])
  assert.ok((await listedIds()).includes(id), "still nothing is removed before the person confirms")
})
