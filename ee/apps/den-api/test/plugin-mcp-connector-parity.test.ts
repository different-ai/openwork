import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_plugin_mcp_parity"
process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
// Plugin-declared server URLs in this file resolve nowhere; skip the public-DNS guard.
process.env.DEN_ALLOW_PRIVATE_MCP_URLS = "1"

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let session: typeof import("../src/session.js")

const organizationId = createDenTypeId("organization")
const adminUserId = createDenTypeId("user")
const memberUserId = createDenTypeId("user")
const adminMemberId = createDenTypeId("member")
const memberId = createDenTypeId("member")
const adminSessionId = createDenTypeId("session")
const memberSessionId = createDenTypeId("session")
const adminToken = `plugin-mcp-parity-admin-${adminSessionId}`
const memberToken = `plugin-mcp-parity-member-${memberSessionId}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

beforeAll(async () => {
  mock.restore()
  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL ?? "",
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const [appMod, dbMod, schemaMod, drizzleMod, sessionMod] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/session.js"),
  ])
  app = appMod.default
  db = dbMod.db
  schema = schemaMod
  drizzle = drizzleMod
  session = sessionMod

  await db.insert(schema.AuthUserTable).values([
    { id: adminUserId, name: "Plugin MCP Admin", email: `plugin-mcp-admin+${adminUserId}@test.local` },
    { id: memberUserId, name: "Plugin MCP Member", email: `plugin-mcp-member+${memberUserId}@test.local` },
  ])
  await db.insert(schema.OrganizationTable).values({ id: organizationId, name: "Plugin MCP Org", slug: `plugin-mcp-${organizationId}` })
  await db.insert(schema.MemberTable).values([
    { id: adminMemberId, organizationId, userId: adminUserId, role: "admin" },
    { id: memberId, organizationId, userId: memberUserId, role: "member" },
  ])
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  await db.insert(schema.AuthSessionTable).values([
    { id: adminSessionId, userId: adminUserId, activeOrganizationId: organizationId, token: adminToken, expiresAt },
    { id: memberSessionId, userId: memberUserId, activeOrganizationId: organizationId, token: memberToken, expiresAt },
  ])
})

afterAll(async () => {
  const { eq, inArray } = drizzle
  await db.delete(schema.PluginMcpRequirementBindingTable).where(eq(schema.PluginMcpRequirementBindingTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(eq(schema.ExternalMcpConnectionAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.OrgOAuthClientTable).where(eq(schema.OrgOAuthClientTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionTable).where(eq(schema.ExternalMcpConnectionTable.organizationId, organizationId))
  await db.delete(schema.ConfigObjectVersionTable).where(eq(schema.ConfigObjectVersionTable.organizationId, organizationId))
  await db.delete(schema.ConfigObjectAccessGrantTable).where(eq(schema.ConfigObjectAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.PluginConfigObjectTable).where(eq(schema.PluginConfigObjectTable.organizationId, organizationId))
  await db.delete(schema.ConfigObjectTable).where(eq(schema.ConfigObjectTable.organizationId, organizationId))
  await db.delete(schema.PluginAccessGrantTable).where(eq(schema.PluginAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.PluginTable).where(eq(schema.PluginTable.organizationId, organizationId))
  await db.delete(schema.AuthSessionTable).where(inArray(schema.AuthSessionTable.id, [adminSessionId, memberSessionId]))
  await db.delete(schema.MemberTable).where(eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(inArray(schema.AuthUserTable.id, [adminUserId, memberUserId]))
  mock.restore()
})

function request(path: string, init: { method?: string; token?: string; body?: unknown; agent?: boolean } = {}) {
  const headers: Record<string, string> = {}
  if (init.agent) {
    headers["x-den-internal-mcp-principal"] = session.createInternalMcpPrincipalHeader({ userId: adminUserId, organizationId })
  } else {
    headers.authorization = `Bearer ${init.token ?? adminToken}`
  }
  if (init.body !== undefined) headers["content-type"] = "application/json"
  return app.fetch(new Request(`http://den-api.local${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  }))
}

async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json()
  if (!isRecord(body)) throw new Error("Expected a JSON object response")
  return body
}

async function manageableConnections(): Promise<Record<string, unknown>[]> {
  const response = await request("/v1/mcp-connections?scope=manageable")
  expect(response.status).toBe(200)
  const body = await responseRecord(response)
  if (!Array.isArray(body.connections)) throw new Error("MCP connection list response was incomplete")
  return body.connections.filter(isRecord)
}

function pluginNames(row: Record<string, unknown> | undefined, field: "identityManagedBy" | "requiredBy"): string[] {
  const entries = row?.[field]
  if (!Array.isArray(entries)) return []
  return entries.flatMap((entry) => isRecord(entry) && typeof entry.name === "string" ? [entry.name] : []).sort()
}

async function seedPlugin(name: string): Promise<DenTypeId<"plugin">> {
  const now = new Date()
  const pluginId = createDenTypeId("plugin")
  await db.insert(schema.PluginTable).values({
    id: pluginId,
    organizationId,
    name,
    description: null,
    status: "active",
    createdByOrgMembershipId: adminMemberId,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  })
  return pluginId
}

async function seedConnection(input: { name: string; url: string; directOrgWide: boolean }): Promise<DenTypeId<"externalMcpConnection">> {
  const connectionId = createDenTypeId("externalMcpConnection")
  await db.insert(schema.ExternalMcpConnectionTable).values({
    id: connectionId,
    organizationId,
    name: input.name,
    url: input.url,
    authType: "oauth",
    credentialMode: "per_member",
    connectedAt: null,
    createdByOrgMembershipId: adminMemberId,
  })
  if (input.directOrgWide) {
    await db.insert(schema.ExternalMcpConnectionAccessGrantTable).values({
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId,
      externalMcpConnectionId: connectionId,
      orgMembershipId: null,
      teamId: null,
      orgWide: true,
      createdByOrgMembershipId: adminMemberId,
    })
  }
  return connectionId
}

async function seedBinding(input: { pluginId: DenTypeId<"plugin">; connectionId: DenTypeId<"externalMcpConnection">; owned: boolean }) {
  const now = new Date()
  await db.insert(schema.PluginMcpRequirementBindingTable).values({
    id: createDenTypeId("pluginMcpRequirementBinding"),
    organizationId,
    pluginId: input.pluginId,
    configObjectId: createDenTypeId("configObject"),
    serverName: "crm",
    externalMcpConnectionId: input.connectionId,
    requiredAuthType: "oauth",
    connectionOwnedByPlugin: input.owned,
    createdByOrgMembershipId: adminMemberId,
    createdAt: now,
    updatedAt: now,
  })
}

async function setPluginLifecycle(pluginId: string, action: "archive" | "restore") {
  const response = await request(`/v1/plugins/${pluginId}/${action}`, { method: "POST" })
  expect(response.status).toBe(200)
}

describe.serial("plugin-owned MCP connections follow the plugin lifecycle in the Connectors list", () => {
  test("archiving every plugin that owns a connection hides it until a restore, while shared and direct connectors stay", async () => {
    const ownerPluginId = await seedPlugin("Owner Plugin")
    const reusingPluginId = await seedPlugin("Reusing Plugin")
    const ownedConnectionId = await seedConnection({ name: "Owner Plugin / crm", url: "https://crm.plugin-owned.test/mcp", directOrgWide: false })
    const directConnectionId = await seedConnection({ name: "Direct CRM", url: "https://crm.direct.test/mcp", directOrgWide: true })
    await seedBinding({ pluginId: ownerPluginId, connectionId: ownedConnectionId, owned: true })
    await seedBinding({ pluginId: reusingPluginId, connectionId: ownedConnectionId, owned: false })
    await seedBinding({ pluginId: ownerPluginId, connectionId: directConnectionId, owned: false })

    const before = await manageableConnections()
    expect(pluginNames(before.find((row) => row.id === ownedConnectionId), "identityManagedBy")).toEqual(["Owner Plugin"])
    expect(pluginNames(before.find((row) => row.id === ownedConnectionId), "requiredBy")).toEqual(["Owner Plugin", "Reusing Plugin"])
    expect(before.some((row) => row.id === directConnectionId)).toBe(true)

    // Another active plugin still depends on the connection, so it stays listed under that plugin.
    await setPluginLifecycle(ownerPluginId, "archive")
    const afterOwnerArchived = await manageableConnections()
    expect(pluginNames(afterOwnerArchived.find((row) => row.id === ownedConnectionId), "identityManagedBy")).toEqual([])
    expect(pluginNames(afterOwnerArchived.find((row) => row.id === ownedConnectionId), "requiredBy")).toEqual(["Reusing Plugin"])
    expect(afterOwnerArchived.some((row) => row.id === directConnectionId)).toBe(true)

    // The last active plugin is gone: the plugin-owned connector disappears, the admin-created one does not.
    await setPluginLifecycle(reusingPluginId, "archive")
    const afterAllArchived = await manageableConnections()
    expect(afterAllArchived.some((row) => row.id === ownedConnectionId)).toBe(false)
    const directRow = afterAllArchived.find((row) => row.id === directConnectionId)
    expect(directRow).toBeDefined()
    expect(pluginNames(directRow, "requiredBy")).toEqual([])

    // Hidden, not deleted: restoring the owner brings it back with its provenance.
    const storedRows = await db
      .select({ id: schema.ExternalMcpConnectionTable.id })
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, ownedConnectionId))
    expect(storedRows).toHaveLength(1)

    await setPluginLifecycle(ownerPluginId, "restore")
    const afterRestore = await manageableConnections()
    expect(pluginNames(afterRestore.find((row) => row.id === ownedConnectionId), "identityManagedBy")).toEqual(["Owner Plugin"])
  })
})

describe.serial("creating a plugin configures its MCP server with the same connector setup as the Connections page", () => {
  const mcpComponent = (url: string, connection?: Record<string, unknown>) => ({
    type: "mcp",
    input: {
      normalizedPayloadJson: { mcpServers: { crm: { type: "remote", url } } },
      metadata: { name: "CRM" },
    },
    ...(connection ? { connection } : {}),
  })

  test("an inline connection setup binds a plugin-owned connection immediately", async () => {
    const url = "https://crm.inline-setup.test/mcp"
    const response = await request("/v1/plugins", {
      method: "POST",
      body: {
        name: "Inline Setup Plugin",
        orgWide: true,
        components: [mcpComponent(url, { authType: "oauth", credentialMode: "shared" })],
      },
    })
    expect(response.status).toBe(201)
    const body = await responseRecord(response)
    const plugin = isRecord(body.item) ? body.item : null
    expect(plugin?.status).toBe("active")

    const connections = await manageableConnections()
    const connection = connections.find((row) => row.url === url)
    expect(connection).toMatchObject({ authType: "oauth", credentialMode: "shared", name: "Inline Setup Plugin / crm" })
    expect(pluginNames(connection, "identityManagedBy")).toEqual(["Inline Setup Plugin"])

    const bindings = await db
      .select({ connectionOwnedByPlugin: schema.PluginMcpRequirementBindingTable.connectionOwnedByPlugin, serverName: schema.PluginMcpRequirementBindingTable.serverName })
      .from(schema.PluginMcpRequirementBindingTable)
      .where(drizzle.eq(schema.PluginMcpRequirementBindingTable.pluginId, String(plugin?.id)))
    expect(bindings).toEqual([{ connectionOwnedByPlugin: true, serverName: "crm" }])
  })

  test("a plugin without an inline connection setup still creates only the declaration", async () => {
    const url = "https://crm.declaration-only.test/mcp"
    const response = await request("/v1/plugins", {
      method: "POST",
      body: { name: "Declaration Only Plugin", components: [mcpComponent(url)] },
    })
    expect(response.status).toBe(201)
    const connections = await manageableConnections()
    expect(connections.some((row) => row.url === url)).toBe(false)
  })

  test("a failed inline setup leaves no active plugin, connection, or binding behind", async () => {
    const url = "https://user:secret@crm.rejected.test/mcp"
    const response = await request("/v1/plugins", {
      method: "POST",
      body: { name: "Rejected Setup Plugin", components: [mcpComponent(url, { authType: "oauth" })] },
    })
    expect(response.status).toBe(400)
    expect(await responseRecord(response)).toMatchObject({ error: "invalid_mcp_url" })

    const plugins = await db
      .select({ status: schema.PluginTable.status })
      .from(schema.PluginTable)
      .where(drizzle.eq(schema.PluginTable.name, "Rejected Setup Plugin"))
    expect(plugins).toEqual([{ status: "archived" }])
    const connections = await manageableConnections()
    expect(connections.some((row) => typeof row.url === "string" && row.url.includes("crm.rejected.test"))).toBe(false)

    // The name is free again for the corrected retry.
    const retry = await request("/v1/plugins", {
      method: "POST",
      body: { name: "Rejected Setup Plugin", components: [mcpComponent("https://crm.rejected.test/mcp", { authType: "oauth" })] },
    })
    expect(retry.status).toBe(201)
  })

  test("an inline connection setup is refused for non-admins, agents holding secrets, and non-mcp components", async () => {
    const memberResponse = await request("/v1/plugins", {
      method: "POST",
      token: memberToken,
      body: { name: "Member Plugin", components: [mcpComponent("https://crm.member.test/mcp", { authType: "oauth" })] },
    })
    expect(memberResponse.status).toBe(403)

    const agentResponse = await request("/v1/plugins", {
      method: "POST",
      agent: true,
      body: { name: "Agent Plugin", components: [mcpComponent("https://crm.agent.test/mcp", { authType: "apikey", credentialMode: "shared", apiKey: "agent-secret-must-not-pass" })] },
    })
    expect(agentResponse.status).toBe(400)
    expect(JSON.stringify(await responseRecord(agentResponse))).not.toContain("agent-secret-must-not-pass")

    const skillResponse = await request("/v1/plugins", {
      method: "POST",
      body: {
        name: "Skill Connection Plugin",
        components: [{
          type: "skill",
          input: { rawSourceText: "---\nname: skill-connection\ndescription: Not an MCP server.\n---\nInstructions." },
          connection: { authType: "oauth" },
        }],
      },
    })
    expect(skillResponse.status).toBe(400)

    const plugins = await db
      .select({ name: schema.PluginTable.name })
      .from(schema.PluginTable)
      .where(drizzle.inArray(schema.PluginTable.name, ["Member Plugin", "Agent Plugin", "Skill Connection Plugin"]))
    expect(plugins).toEqual([])
  })
})
