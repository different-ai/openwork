import { StreamableHTTPTransport } from "@hono/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_mcp_edit"
process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
process.env.DEN_ALLOW_PRIVATE_MCP_URLS = "1"

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let session: typeof import("../src/session.js")
let connections: typeof import("../src/capability-sources/external-mcp-connections.js")
let genericOAuth: typeof import("../src/capability-sources/generic-oauth.js")
let oauthCredentials: typeof import("../src/capability-sources/oauth-credentials.js")
let fakeServer: ReturnType<typeof Bun.serve> | undefined

const adminUserId = createDenTypeId("user")
const memberUserId = createDenTypeId("user")
const otherAdminUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const otherOrganizationId = createDenTypeId("organization")
const adminMemberId = createDenTypeId("member")
const memberId = createDenTypeId("member")
const otherAdminMemberId = createDenTypeId("member")
const adminSessionId = createDenTypeId("session")
const memberSessionId = createDenTypeId("session")
const otherAdminSessionId = createDenTypeId("session")
const adminToken = `mcp-edit-admin-${adminSessionId}`
const memberToken = `mcp-edit-member-${memberSessionId}`
const otherAdminToken = `mcp-edit-other-admin-${otherAdminSessionId}`
const observedAuthorization: Array<string | null> = []

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

beforeAll(async () => {
  mock.restore()
  const fakeMcp = new Hono()
  fakeMcp.all("/mcp", async (c) => {
    observedAuthorization.push(c.req.header("authorization") ?? null)
    const server = new McpServer({ name: "editable-mcp", version: "1.0.0" })
    const transport = new StreamableHTTPTransport()
    await server.connect(transport)
    return await transport.handleRequest(c) ?? new Response(null, { status: 204 })
  })
  fakeServer = Bun.serve({ port: 0, fetch: fakeMcp.fetch })

  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL ?? "",
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const [appMod, dbMod, schemaMod, drizzleMod, sessionMod, connectionsMod, genericOAuthMod, oauthCredentialsMod] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/session.js"),
    import("../src/capability-sources/external-mcp-connections.js"),
    import("../src/capability-sources/generic-oauth.js"),
    import("../src/capability-sources/oauth-credentials.js"),
  ])
  app = appMod.default
  db = dbMod.db
  schema = schemaMod
  drizzle = drizzleMod
  session = sessionMod
  connections = connectionsMod
  genericOAuth = genericOAuthMod
  oauthCredentials = oauthCredentialsMod

  await db.insert(schema.AuthUserTable).values([
    { id: adminUserId, name: "MCP Edit Admin", email: `mcp-edit-admin+${adminUserId}@test.local` },
    { id: memberUserId, name: "MCP Edit Member", email: `mcp-edit-member+${memberUserId}@test.local` },
    { id: otherAdminUserId, name: "Other MCP Edit Admin", email: `mcp-edit-other+${otherAdminUserId}@test.local` },
  ])
  await db.insert(schema.OrganizationTable).values([
    { id: organizationId, name: "MCP Edit Org", slug: `mcp-edit-${organizationId}` },
    { id: otherOrganizationId, name: "Other MCP Edit Org", slug: `mcp-edit-${otherOrganizationId}` },
  ])
  await db.insert(schema.MemberTable).values([
    { id: adminMemberId, organizationId, userId: adminUserId, role: "admin" },
    { id: memberId, organizationId, userId: memberUserId, role: "member" },
    { id: otherAdminMemberId, organizationId: otherOrganizationId, userId: otherAdminUserId, role: "admin" },
  ])
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
  await db.insert(schema.AuthSessionTable).values([
    { id: adminSessionId, userId: adminUserId, activeOrganizationId: organizationId, token: adminToken, expiresAt },
    { id: memberSessionId, userId: memberUserId, activeOrganizationId: organizationId, token: memberToken, expiresAt },
    { id: otherAdminSessionId, userId: otherAdminUserId, activeOrganizationId: otherOrganizationId, token: otherAdminToken, expiresAt },
  ])
})

afterAll(async () => {
  fakeServer?.stop(true)
  if (!db || !schema || !drizzle) return
  await db.delete(schema.PluginMcpRequirementBindingTable).where(drizzle.inArray(
    schema.PluginMcpRequirementBindingTable.organizationId,
    [organizationId, otherOrganizationId],
  ))
  await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(drizzle.inArray(
    schema.ExternalMcpConnectionAccessGrantTable.organizationId,
    [organizationId, otherOrganizationId],
  ))
  await db.delete(schema.ConnectedAccountTable).where(drizzle.inArray(
    schema.ConnectedAccountTable.organizationId,
    [organizationId, otherOrganizationId],
  ))
  await db.delete(schema.OrgOAuthClientTable).where(drizzle.inArray(
    schema.OrgOAuthClientTable.organizationId,
    [organizationId, otherOrganizationId],
  ))
  await db.delete(schema.ExternalMcpConnectionTable).where(drizzle.inArray(
    schema.ExternalMcpConnectionTable.organizationId,
    [organizationId, otherOrganizationId],
  ))
  await db.delete(schema.PluginTable).where(drizzle.inArray(
    schema.PluginTable.organizationId,
    [organizationId, otherOrganizationId],
  ))
  await db.delete(schema.AuthSessionTable).where(drizzle.inArray(
    schema.AuthSessionTable.id,
    [adminSessionId, memberSessionId, otherAdminSessionId],
  ))
  await db.delete(schema.MemberTable).where(drizzle.inArray(
    schema.MemberTable.organizationId,
    [organizationId, otherOrganizationId],
  ))
  await db.delete(schema.OrganizationTable).where(drizzle.inArray(
    schema.OrganizationTable.id,
    [organizationId, otherOrganizationId],
  ))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(
    schema.AuthUserTable.id,
    [adminUserId, memberUserId, otherAdminUserId],
  ))
  mock.restore()
})

function workingUrl(path = "mcp") {
  if (!fakeServer) throw new Error("Fake MCP server did not start")
  return `http://127.0.0.1:${fakeServer.port}/${path}`
}

async function createConnection(input: {
  organizationId?: DenTypeId<"organization">
  memberId?: DenTypeId<"member">
  name: string
  authType: "oauth" | "apikey" | "none"
  credentialMode: "shared" | "per_member"
  url?: string
  apiKey?: string | null
}) {
  const orgId = input.organizationId ?? organizationId
  const creatorId = input.memberId ?? adminMemberId
  const created = await connections.createExternalMcpConnection({
    organizationId: orgId,
    name: input.name,
    url: input.url ?? workingUrl(),
    authType: input.authType,
    credentialMode: input.credentialMode,
    apiKey: input.apiKey ?? null,
    createdByOrgMembershipId: creatorId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  return created
}

async function currentConnection(
  connectionId: DenTypeId<"externalMcpConnection">,
  orgId: DenTypeId<"organization"> = organizationId,
) {
  const connection = await connections.getExternalMcpConnection({ organizationId: orgId, connectionId })
  if (!connection) throw new Error(`Missing external MCP connection ${connectionId}`)
  return connection
}

function humanRequest(input: {
  connectionId: string
  token?: string
  body: Record<string, unknown>
}) {
  return app.fetch(new Request(`http://den-api.local/v1/mcp-connections/${input.connectionId}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${input.token ?? adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input.body),
  }))
}

function updateBody(
  connection: Awaited<ReturnType<typeof currentConnection>>,
  changes: Record<string, unknown> = {},
) {
  return {
    expectedUpdatedAt: connection.updatedAt.toISOString(),
    name: connection.name,
    url: connection.url,
    authType: connection.authType,
    credentialMode: connection.credentialMode,
    access: { orgWide: true, memberIds: [], teamIds: [] },
    ...changes,
  }
}

async function responseRecord(response: Response) {
  const body: unknown = await response.json()
  if (!isRecord(body)) throw new Error("Expected an object response")
  return body
}

async function rawStoredApiKey(connectionId: string) {
  const result: unknown = await db.execute(drizzle.sql`select api_key from external_mcp_connection where id = ${connectionId}`)
  if (!Array.isArray(result) || !Array.isArray(result[0])) throw new Error("Unexpected raw API key result")
  const row = result[0][0]
  if (!isRecord(row) || typeof row.api_key !== "string") throw new Error("Missing raw API key")
  return row.api_key
}

function oauthConfigurationInApiOrder(
  connection: Awaited<ReturnType<typeof currentConnection>>,
) {
  const configuration = connection.oauthConfiguration
  if (!configuration) throw new Error("Expected an OAuth configuration")
  return {
    version: configuration.version,
    authorizationServerIssuer: configuration.authorizationServerIssuer,
    requestedScopes: [...configuration.requestedScopes],
    callbackMode: configuration.callbackMode,
    ...(configuration.discovery ? { discovery: configuration.discovery } : {}),
  }
}

describe.serial("PUT /v1/mcp-connections/:connectionId", () => {
  test("rename preserves a connected shared OAuth session and client registration", async () => {
    const created = await createConnection({ name: "Shared OAuth", authType: "oauth", credentialMode: "shared" })
    const connectedAt = new Date()
    await db.update(schema.ExternalMcpConnectionTable).set({
      accessToken: "shared-access",
      refreshToken: "shared-refresh",
      tokenType: "Bearer",
      scope: "read write",
      expiresAt: new Date(Date.now() + 60_000),
      connectedAt,
    }).where(drizzle.eq(schema.ExternalMcpConnectionTable.id, created.id))
    await oauthCredentials.upsertOrgOAuthClient({
      organizationId,
      providerId: created.id,
      clientId: "shared-client",
      clientSecret: "shared-secret",
      extra: { registrationAccessToken: "registration-secret" },
      createdByOrgMembershipId: adminMemberId,
    })
    const before = await currentConnection(created.id)

    const response = await humanRequest({
      connectionId: created.id,
      body: updateBody(before, { name: "Renamed Shared OAuth" }),
    })
    expect(response.status).toBe(200)
    const body = await responseRecord(response)
    expect(body).toMatchObject({ name: "Renamed Shared OAuth", connected: true, identityChanged: false, reconnectionRequired: false })
    expect(JSON.stringify(body)).not.toContain("shared-access")
    expect(JSON.stringify(body)).not.toContain("shared-refresh")
    expect(JSON.stringify(body)).not.toContain("shared-secret")
    expect(JSON.stringify(body)).not.toContain("registration-secret")

    const after = await currentConnection(created.id)
    expect(after).toMatchObject({
      accessToken: "shared-access",
      refreshToken: "shared-refresh",
      tokenType: "Bearer",
      scope: "read write",
    })
    expect(after.connectedAt?.getTime()).toBe(connectedAt.getTime())
    const client = await oauthCredentials.getOrgOAuthClient(organizationId, created.id)
    expect(client).toMatchObject({ clientId: "shared-client", clientSecret: "shared-secret", extra: { registrationAccessToken: "registration-secret" } })
  })

  test("assignment-only edit preserves API-key credentials and connected status", async () => {
    const created = await createConnection({ name: "Assigned API MCP", authType: "apikey", credentialMode: "shared", apiKey: "assignment-key" })
    const response = await humanRequest({
      connectionId: created.id,
      body: updateBody(created, {
        access: { orgWide: false, memberIds: [memberId], teamIds: [] },
      }),
    })
    expect(response.status).toBe(200)
    expect(await responseRecord(response)).toMatchObject({ connected: true, identityChanged: false, reconnectionRequired: false })
    expect((await currentConnection(created.id)).apiKey).toBe("assignment-key")
    const grants = await connections.listDirectExternalMcpConnectionAccess({ organizationId, connectionId: created.id })
    expect(grants.map((grant) => grant.orgMembershipId)).toEqual([memberId])
  })

  test("scope-only edits preserve discovery and connected OAuth credentials", async () => {
    const created = await createConnection({ name: "Scoped OAuth", authType: "oauth", credentialMode: "shared" })
    const issuer = "https://identity.example.test/tenant"
    const discovery = {
      authorizationServerUrl: issuer,
      authorizationServerMetadata: {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        scopes_supported: ["records.read", "records.write"],
      },
      resourceMetadata: {
        resource: created.url,
        authorization_servers: [issuer],
        scopes_supported: ["records.read", "records.write"],
      },
    }
    await db.update(schema.ExternalMcpConnectionTable).set({
      oauthConfiguration: {
        version: 1,
        authorizationServerIssuer: issuer,
        requestedScopes: ["records.read"],
        callbackMode: "shared-v1",
        discovery,
      },
      accessToken: "scoped-access-token",
      refreshToken: "scoped-refresh-token",
      connectedAt: new Date(),
    }).where(drizzle.eq(schema.ExternalMcpConnectionTable.id, created.id))
    const before = await currentConnection(created.id)

    const response = await humanRequest({
      connectionId: created.id,
      body: updateBody(before, { requestedScopes: ["records.read", "records.write"] }),
    })
    expect(response.status).toBe(200)
    expect(await responseRecord(response)).toMatchObject({ reconnectionRequired: false })
    expect(await currentConnection(created.id)).toMatchObject({
      accessToken: "scoped-access-token",
      refreshToken: "scoped-refresh-token",
      oauthConfiguration: {
        requestedScopes: ["records.read", "records.write"],
        discovery,
      },
    })
  })

  test("URL change clears shared and per-member OAuth identity state", async () => {
    const created = await createConnection({ name: "Personal OAuth", authType: "oauth", credentialMode: "per_member" })
    await db.update(schema.ExternalMcpConnectionTable).set({
      accessToken: "unexpected-shared-access",
      refreshToken: "unexpected-shared-refresh",
      tokenType: "Bearer",
      scope: "old-scope",
      expiresAt: new Date(Date.now() + 60_000),
      pendingCodeVerifier: "shared-pkce",
      connectedAt: new Date(),
    }).where(drizzle.eq(schema.ExternalMcpConnectionTable.id, created.id))
    for (const [owner, suffix] of [[adminMemberId, "admin"], [memberId, "member"]] as const) {
      await oauthCredentials.upsertConnectedAccount({
        organizationId,
        orgMembershipId: owner,
        providerId: created.id,
        externalAccountId: `old-${suffix}`,
        scopes: ["old-scope"],
        accessToken: `old-access-${suffix}`,
        refreshToken: `old-refresh-${suffix}`,
        tokenType: "Bearer",
        pendingCodeVerifier: `old-pkce-${suffix}`,
      })
    }
    await oauthCredentials.upsertOrgOAuthClient({
      organizationId,
      providerId: created.id,
      clientId: "old-client",
      clientSecret: "old-client-secret",
      extra: { registrationAccessToken: "old-registration-token" },
      createdByOrgMembershipId: adminMemberId,
    })
    const before = await currentConnection(created.id)

    const response = await humanRequest({
      connectionId: created.id,
      body: updateBody(before, { url: workingUrl("new-mcp") }),
    })
    expect(response.status).toBe(200)
    expect(await responseRecord(response)).toMatchObject({ identityChanged: true, reconnectionRequired: true })
    const after = await currentConnection(created.id)
    expect(after.id).toBe(created.id)
    expect(after).toMatchObject({
      accessToken: null,
      refreshToken: null,
      tokenType: null,
      scope: null,
      expiresAt: null,
      pendingCodeVerifier: null,
      connectedAt: null,
      apiKey: null,
    })
    const accounts = await db.select().from(schema.ConnectedAccountTable).where(drizzle.and(
      drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId),
      drizzle.eq(schema.ConnectedAccountTable.providerId, created.id),
    ))
    expect(accounts).toEqual([])
    expect(await oauthCredentials.getOrgOAuthClient(organizationId, created.id)).toBeNull()
  })

  test("authentication and both credential-mode changes clear incompatible credentials", async () => {
    const apiConnection = await createConnection({ name: "API to OAuth", authType: "apikey", credentialMode: "shared", apiKey: "old-api-key" })
    const apiResponse = await humanRequest({
      connectionId: apiConnection.id,
      body: updateBody(apiConnection, { authType: "oauth", credentialMode: "shared" }),
    })
    expect(apiResponse.status).toBe(200)
    expect(await responseRecord(apiResponse)).toMatchObject({ connected: false, identityChanged: true, reconnectionRequired: true })
    expect((await currentConnection(apiConnection.id)).apiKey).toBeNull()

    const shared = await createConnection({ name: "Shared to personal", authType: "oauth", credentialMode: "shared" })
    await db.update(schema.ExternalMcpConnectionTable).set({ accessToken: "shared-mode-token", connectedAt: new Date() })
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, shared.id))
    const sharedBefore = await currentConnection(shared.id)
    const sharedResponse = await humanRequest({
      connectionId: shared.id,
      body: updateBody(sharedBefore, { credentialMode: "per_member" }),
    })
    expect(sharedResponse.status).toBe(200)
    expect((await currentConnection(shared.id)).accessToken).toBeNull()

    const personal = await createConnection({ name: "Personal to shared", authType: "oauth", credentialMode: "per_member" })
    await oauthCredentials.upsertConnectedAccount({
      organizationId,
      orgMembershipId: memberId,
      providerId: personal.id,
      accessToken: "personal-mode-token",
    })
    const personalResponse = await humanRequest({
      connectionId: personal.id,
      body: updateBody(personal, { credentialMode: "shared" }),
    })
    expect(personalResponse.status).toBe(200)
    const accounts = await db.select().from(schema.ConnectedAccountTable).where(drizzle.eq(schema.ConnectedAccountTable.providerId, personal.id))
    expect(accounts).toEqual([])
  })

  test("API-key replacement is validated, encrypted, and never returned", async () => {
    const created = await createConnection({ name: "Replace API key", authType: "apikey", credentialMode: "shared", apiKey: "old-api-key" })
    observedAuthorization.length = 0
    const response = await humanRequest({
      connectionId: created.id,
      body: updateBody(created, { apiKey: "new-api-key" }),
    })
    expect(response.status).toBe(200)
    const body = await responseRecord(response)
    expect(body).toMatchObject({ connected: true, identityChanged: false, reconnectionRequired: false })
    expect(JSON.stringify(body)).not.toContain("new-api-key")
    expect(JSON.stringify(body)).not.toContain("old-api-key")
    expect(observedAuthorization).toContain("Bearer new-api-key")
    expect(observedAuthorization).not.toContain("Bearer old-api-key")
    expect((await currentConnection(created.id)).apiKey).toBe("new-api-key")
    const raw = await rawStoredApiKey(created.id)
    expect(raw.startsWith("enc:v1:")).toBe(true)
    expect(raw).not.toContain("new-api-key")
  })

  test("invalid URLs and failed API-key/no-auth validation leave the working rows unchanged", async () => {
    const unsafe = await createConnection({ name: "Unsafe URL", authType: "oauth", credentialMode: "shared" })
    const unsafeResponse = await humanRequest({
      connectionId: unsafe.id,
      body: updateBody(unsafe, { url: "https://mcp.example.test/mcp?access_token=secret" }),
    })
    expect(unsafeResponse.status).toBe(400)
    expect(await currentConnection(unsafe.id)).toMatchObject({ url: unsafe.url, name: unsafe.name })

    const api = await createConnection({ name: "API rollback", authType: "apikey", credentialMode: "shared", apiKey: "working-api-key" })
    const apiResponse = await humanRequest({
      connectionId: api.id,
      body: updateBody(api, { url: "http://127.0.0.1:9/mcp", apiKey: "replacement-that-fails" }),
    })
    expect(apiResponse.status).toBe(502)
    expect(await currentConnection(api.id)).toMatchObject({ url: api.url, apiKey: "working-api-key" })

    const noAuth = await createConnection({ name: "No-auth rollback", authType: "none", credentialMode: "shared" })
    const connectedAt = new Date()
    await db.update(schema.ExternalMcpConnectionTable).set({ connectedAt }).where(drizzle.eq(schema.ExternalMcpConnectionTable.id, noAuth.id))
    const noAuthBefore = await currentConnection(noAuth.id)
    const noAuthResponse = await humanRequest({
      connectionId: noAuth.id,
      body: updateBody(noAuthBefore, { url: "http://127.0.0.1:9/mcp" }),
    })
    expect(noAuthResponse.status).toBe(502)
    const noAuthAfter = await currentConnection(noAuth.id)
    expect(noAuthAfter.url).toBe(noAuth.url)
    expect(noAuthAfter.connectedAt?.getTime()).toBe(connectedAt.getTime())
  })

  test("tenant scope, admin authorization, and internal-agent secret boundaries are enforced", async () => {
    const other = await createConnection({
      organizationId: otherOrganizationId,
      memberId: otherAdminMemberId,
      name: "Other tenant MCP",
      authType: "oauth",
      credentialMode: "shared",
    })
    const crossOrg = await humanRequest({
      connectionId: other.id,
      body: updateBody(other, { name: "Cross-org overwrite" }),
    })
    expect(crossOrg.status).toBe(404)

    const own = await createConnection({ name: "Admin only MCP", authType: "oauth", credentialMode: "shared" })
    const memberResponse = await humanRequest({
      connectionId: own.id,
      token: memberToken,
      body: updateBody(own, { name: "Member overwrite" }),
    })
    expect(memberResponse.status).toBe(403)

    const agentResponse = await app.fetch(new Request(`http://den-api.local/v1/mcp-connections/${own.id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({ userId: adminUserId, organizationId }),
      },
      body: JSON.stringify(updateBody(own, {
        authType: "apikey",
        credentialMode: "shared",
        apiKey: "agent-secret-must-not-pass",
      })),
    }))
    expect(agentResponse.status).toBe(400)
    expect(JSON.stringify(await responseRecord(agentResponse))).not.toContain("agent-secret-must-not-pass")
  })

  test("marketplace bindings protect identity without treating OAuth key order as a change", async () => {
    const connection = await createConnection({ name: "Marketplace MCP", authType: "oauth", credentialMode: "per_member" })
    const pluginId = createDenTypeId("plugin")
    const bindingId = createDenTypeId("pluginMcpRequirementBinding")
    const now = new Date()
    await db.insert(schema.PluginTable).values({
      id: pluginId,
      organizationId,
      name: "Marketplace Support",
      description: null,
      status: "active",
      createdByOrgMembershipId: adminMemberId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })
    await db.insert(schema.PluginMcpRequirementBindingTable).values({
      id: bindingId,
      organizationId,
      pluginId,
      configObjectId: createDenTypeId("configObject"),
      serverName: "support",
      externalMcpConnectionId: connection.id,
      createdByOrgMembershipId: adminMemberId,
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(schema.ExternalMcpConnectionAccessGrantTable).values({
      id: createDenTypeId("externalMcpConnectionAccessGrant"),
      organizationId,
      externalMcpConnectionId: connection.id,
      pluginMcpRequirementBindingId: bindingId,
      sourceKey: bindingId,
      orgMembershipId: memberId,
      orgWide: false,
      createdByOrgMembershipId: adminMemberId,
    })

    const blocked = await humanRequest({
      connectionId: connection.id,
      body: updateBody(connection, { url: workingUrl("marketplace-change") }),
    })
    expect(blocked.status).toBe(409)
    expect(await responseRecord(blocked)).toMatchObject({ error: "marketplace_managed" })

    const beforeClientConfiguration = await currentConnection(connection.id)
    const configuredClient = await humanRequest({
      connectionId: connection.id,
      body: updateBody(beforeClientConfiguration, {
        oauthClient: { clientId: "marketplace-client", clientSecret: "marketplace-secret" },
      }),
    })
    expect(configuredClient.status).toBe(200)
    expect(JSON.stringify(await responseRecord(configuredClient))).not.toContain("marketplace-secret")
    expect(await oauthCredentials.getOrgOAuthClient(organizationId, connection.id)).toMatchObject({
      clientId: "marketplace-client",
      clientSecret: "marketplace-secret",
    })

    const fresh = await currentConnection(connection.id)
    const apiOrderedConfiguration = oauthConfigurationInApiOrder(fresh)
    expect(Object.keys(fresh.oauthConfiguration ?? {})).not.toEqual(Object.keys(apiOrderedConfiguration))
    const allowed = await humanRequest({
      connectionId: connection.id,
      body: updateBody(fresh, {
        name: "Renamed Marketplace MCP",
        access: { orgWide: false, memberIds: [adminMemberId], teamIds: [] },
      }),
    })
    expect(allowed.status).toBe(200)
    const body = await responseRecord(allowed)
    expect(body).toMatchObject({
      name: "Renamed Marketplace MCP",
      identityManagedBy: [{ pluginId, name: "Marketplace Support" }],
      access: { orgWide: false, memberIds: [adminMemberId], teamIds: [] },
    })
    const grants = await db.select().from(schema.ExternalMcpConnectionAccessGrantTable).where(drizzle.eq(
      schema.ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId,
      connection.id,
    ))
    expect(grants.some((grant) => grant.pluginMcpRequirementBindingId === bindingId && grant.orgMembershipId === memberId)).toBe(true)
    expect(grants.some((grant) => grant.pluginMcpRequirementBindingId === null && grant.orgMembershipId === adminMemberId)).toBe(true)
  })

  test("stale edits conflict, OAuth key order stays a no-op, and old-identity writes are rejected", async () => {
    const connection = await createConnection({ name: "Concurrent OAuth", authType: "oauth", credentialMode: "per_member" })
    const first = await humanRequest({
      connectionId: connection.id,
      body: updateBody(connection, { name: "Concurrent OAuth renamed" }),
    })
    expect(first.status).toBe(200)
    const stale = await humanRequest({
      connectionId: connection.id,
      body: updateBody(connection, { url: workingUrl("stale-sensitive-change") }),
    })
    expect(stale.status).toBe(409)
    expect(await responseRecord(stale)).toMatchObject({ error: "connection_conflict" })
    expect((await currentConnection(connection.id)).url).toBe(connection.url)

    const fresh = await currentConnection(connection.id)
    const apiOrderedConfiguration = oauthConfigurationInApiOrder(fresh)
    expect(Object.keys(fresh.oauthConfiguration ?? {})).not.toEqual(Object.keys(apiOrderedConfiguration))
    await oauthCredentials.upsertConnectedAccount({
      organizationId,
      orgMembershipId: memberId,
      providerId: fresh.id,
      accessToken: "no-op-token",
    })
    const noOp = await humanRequest({ connectionId: fresh.id, body: updateBody(fresh, { name: fresh.name }) })
    expect(noOp.status).toBe(200)
    const noOpBody = await responseRecord(noOp)
    expect(noOpBody).toMatchObject({ identityChanged: false, reconnectionRequired: false })
    expect(noOpBody.updatedAt).toBe(fresh.updatedAt.toISOString())
    expect((await oauthCredentials.getConnectedAccount({ organizationId, orgMembershipId: memberId, providerId: fresh.id }))?.accessToken).toBe("no-op-token")

    const identityChange = await humanRequest({
      connectionId: fresh.id,
      body: updateBody(fresh, { url: workingUrl("new-concurrent-identity") }),
    })
    expect(identityChange.status).toBe(200)
    const lateWrite = await connections.upsertConnectedAccountForExternalMcpIdentity({
      connection: fresh,
      orgMembershipId: memberId,
      changes: { accessToken: "late-old-token", pendingCodeVerifier: "late-old-pkce" },
    })
    expect(lateWrite).toBe(false)
    expect(await oauthCredentials.getConnectedAccount({ organizationId, orgMembershipId: memberId, providerId: fresh.id })).toBeNull()
  })

  test("OAuth callback state minted for an old identity cannot reach the replacement identity", async () => {
    const connection = await createConnection({ name: "Bound OAuth state", authType: "oauth", credentialMode: "shared" })
    const oldState = genericOAuth.createOAuthStateToken({
      organizationId,
      orgMembershipId: adminMemberId,
      providerId: connection.id,
      binding: connections.externalMcpIdentityBinding(connection),
      secret: process.env.BETTER_AUTH_SECRET ?? "",
    })
    const update = await humanRequest({
      connectionId: connection.id,
      body: updateBody(connection, { url: workingUrl("replacement-bound-identity") }),
    })
    expect(update.status).toBe(200)

    const callbackUrl = new URL(`http://den-api.local/v1/mcp-connections/${connection.id}/connect/callback`)
    callbackUrl.searchParams.set("error", "access_denied")
    callbackUrl.searchParams.set("state", oldState)
    const callback = await app.fetch(new Request(callbackUrl))
    expect(callback.status).toBe(400)
    expect(await responseRecord(callback)).toEqual({
      error: "invalid_request",
      message: "This connection changed after authorization started. Start the connection flow again.",
    })
  })
})

describe.serial("MCP connection disconnect", () => {
  function postDisconnect(connectionId: string, suffix = "/disconnect", token = adminToken) {
    return app.fetch(new Request(`http://den-api.local/v1/mcp-connections/${connectionId}${suffix}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }))
  }

  test("manageable lists expose safe creator attribution", async () => {
    const created = await createConnection({ name: "Creator Attribution MCP", authType: "oauth", credentialMode: "per_member" })
    const response = await app.fetch(new Request("http://den-api.local/v1/mcp-connections?scope=manageable", {
      headers: { authorization: `Bearer ${adminToken}` },
    }))
    expect(response.status).toBe(200)
    const body = await responseRecord(response)
    const list = body.connections
    if (!Array.isArray(list)) throw new Error("Manageable MCP list did not include connections")
    const row = list.find((entry) => isRecord(entry) && entry.id === created.id)
    if (!isRecord(row)) throw new Error("Created MCP connection was missing from manageable list")
    expect(row.createdByName).toBe("MCP Edit Admin")
  })

  test("admin disconnect clears credentials without removing configuration or grants", async () => {
    const shared = await createConnection({ name: "Disconnect Shared OAuth", authType: "oauth", credentialMode: "shared" })
    await db.update(schema.ExternalMcpConnectionTable).set({
      accessToken: "shared-access",
      refreshToken: "shared-refresh",
      tokenType: "Bearer",
      scope: "read write",
      expiresAt: new Date(Date.now() + 60_000),
      pendingCodeVerifier: "shared-pkce",
      connectedAt: new Date(),
    }).where(drizzle.eq(schema.ExternalMcpConnectionTable.id, shared.id))
    await oauthCredentials.upsertOrgOAuthClient({
      organizationId,
      providerId: shared.id,
      clientId: "disconnect-shared-client",
      clientSecret: "disconnect-shared-secret",
      extra: { enterpriseMcpRegistrationSource: "pre-registered" },
      createdByOrgMembershipId: adminMemberId,
    })

    const apiKey = await createConnection({ name: "Disconnect API Key", authType: "apikey", credentialMode: "shared", apiKey: "disconnect-api-key" })
    const perMember = await createConnection({ name: "Disconnect Members", authType: "oauth", credentialMode: "per_member" })
    await oauthCredentials.upsertConnectedAccount({
      organizationId,
      orgMembershipId: adminMemberId,
      providerId: perMember.id,
      accessToken: "admin-access",
      refreshToken: "admin-refresh",
      pendingCodeVerifier: "admin-pkce",
    })
    await oauthCredentials.upsertConnectedAccount({
      organizationId,
      orgMembershipId: memberId,
      providerId: perMember.id,
      accessToken: "member-access",
      refreshToken: "member-refresh",
      pendingCodeVerifier: "member-pkce",
    })

    expect((await postDisconnect(shared.id)).status).toBe(200)
    expect((await postDisconnect(apiKey.id)).status).toBe(200)
    expect((await postDisconnect(perMember.id)).status).toBe(200)

    const sharedAfter = await currentConnection(shared.id)
    expect(sharedAfter.accessToken).toBeNull()
    expect(sharedAfter.refreshToken).toBeNull()
    expect(sharedAfter.tokenType).toBeNull()
    expect(sharedAfter.scope).toBeNull()
    expect(sharedAfter.expiresAt).toBeNull()
    expect(sharedAfter.pendingCodeVerifier).toBeNull()
    expect(sharedAfter.connectedAt).toBeNull()
    expect(await oauthCredentials.getOrgOAuthClient(organizationId, shared.id)).toMatchObject({ clientId: "disconnect-shared-client" })

    expect((await currentConnection(apiKey.id)).apiKey).toBeNull()
    const accounts = await db.select().from(schema.ConnectedAccountTable).where(drizzle.and(
      drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId),
      drizzle.eq(schema.ConnectedAccountTable.providerId, perMember.id),
    ))
    expect(accounts).toEqual([])
    for (const connection of [shared, apiKey, perMember]) {
      const grants = await connections.listExternalMcpConnectionAccess({ organizationId, connectionId: connection.id })
      expect(grants.length).toBeGreaterThan(0)
      expect(await currentConnection(connection.id)).toMatchObject({ name: connection.name, url: connection.url })
    }
  })

  test("member disconnect removes only that member's per-member external MCP account", async () => {
    const connection = await createConnection({ name: "Disconnect Mine", authType: "oauth", credentialMode: "per_member" })
    await oauthCredentials.upsertConnectedAccount({
      organizationId,
      orgMembershipId: adminMemberId,
      providerId: connection.id,
      accessToken: "admin-stays",
    })
    await oauthCredentials.upsertConnectedAccount({
      organizationId,
      orgMembershipId: memberId,
      providerId: connection.id,
      accessToken: "member-goes",
    })

    const response = await postDisconnect(connection.id, "/disconnect-my-account", memberToken)
    expect(response.status).toBe(200)
    expect(await oauthCredentials.getConnectedAccount({ organizationId, orgMembershipId: memberId, providerId: connection.id })).toBeNull()
    expect(await oauthCredentials.getConnectedAccount({ organizationId, orgMembershipId: adminMemberId, providerId: connection.id })).toMatchObject({
      accessToken: "admin-stays",
    })
  })

  test("late OAuth callbacks cannot recreate credentials after disconnect clears pending authorization", async () => {
    const shared = await createConnection({ name: "Late Shared OAuth", authType: "oauth", credentialMode: "shared" })
    await db.update(schema.ExternalMcpConnectionTable).set({ pendingCodeVerifier: "shared-late-pkce" }).where(drizzle.eq(schema.ExternalMcpConnectionTable.id, shared.id))
    const staleShared = await currentConnection(shared.id)
    expect((await postDisconnect(shared.id)).status).toBe(200)
    await expect(connections.saveExternalMcpTokensForIdentity({
      connection: staleShared,
      accessToken: "late-shared-access",
      expectedPendingCodeVerifier: "shared-late-pkce",
    })).resolves.toBe(false)
    expect((await currentConnection(shared.id)).accessToken).toBeNull()

    const perMember = await createConnection({ name: "Late Member OAuth", authType: "oauth", credentialMode: "per_member" })
    await oauthCredentials.upsertConnectedAccount({
      organizationId,
      orgMembershipId: memberId,
      providerId: perMember.id,
      pendingCodeVerifier: "member-late-pkce",
    })
    const stalePerMember = await currentConnection(perMember.id)
    const disconnected = await connections.disconnectExternalMcpMemberAccount({
      organizationId,
      connectionId: perMember.id,
      orgMembershipId: memberId,
    })
    expect(disconnected).toEqual({ status: "disconnected" })
    await expect(connections.upsertConnectedAccountForExternalMcpIdentity({
      connection: stalePerMember,
      orgMembershipId: memberId,
      expectedPendingCodeVerifier: "member-late-pkce",
      changes: { accessToken: "late-member-access" },
    })).resolves.toBe(false)
    expect(await oauthCredentials.getConnectedAccount({ organizationId, orgMembershipId: memberId, providerId: perMember.id })).toBeNull()
  })
})
