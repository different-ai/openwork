import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"

const RENDER_URL = "https://mcp.render.com/mcp"

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_mcp_preregistered"
process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
process.env.DEN_ALLOW_PRIVATE_MCP_URLS = "1"
// The deployment holds Render's pre-registered OpenWork client.
process.env.DEN_EXTERNAL_MCP_PREREGISTERED_OAUTH_CLIENTS = JSON.stringify({ [RENDER_URL]: { clientId: "openwork" } })

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let oauthCredentials: typeof import("../src/capability-sources/oauth-credentials.js")

const adminUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const adminMemberId = createDenTypeId("member")
const adminSessionId = createDenTypeId("session")
const adminToken = `mcp-preregistered-admin-${adminSessionId}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json()
  if (!isRecord(body)) throw new Error("Expected a JSON object response")
  return body
}

beforeAll(async () => {
  mock.restore()
  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL ?? "",
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const [appMod, dbMod, schemaMod, drizzleMod, oauthCredentialsMod] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/capability-sources/oauth-credentials.js"),
  ])
  app = appMod.default
  db = dbMod.db
  schema = schemaMod
  drizzle = drizzleMod
  oauthCredentials = oauthCredentialsMod

  await db.insert(schema.AuthUserTable).values([
    { id: adminUserId, name: "Preregistered Admin", email: `preregistered-admin+${adminUserId}@test.local` },
  ])
  await db.insert(schema.OrganizationTable).values([
    { id: organizationId, name: "Preregistered Org", slug: `preregistered-${organizationId}` },
  ])
  await db.insert(schema.MemberTable).values([
    { id: adminMemberId, organizationId, userId: adminUserId, role: "admin" },
  ])
  await db.insert(schema.AuthSessionTable).values([
    {
      id: adminSessionId,
      userId: adminUserId,
      activeOrganizationId: organizationId,
      token: adminToken,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  ])
})

afterAll(async () => {
  if (!db || !schema || !drizzle) return
  await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.OrgOAuthClientTable).where(drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionTable).where(drizzle.eq(schema.ExternalMcpConnectionTable.organizationId, organizationId))
  await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, adminSessionId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, adminUserId))
  mock.restore()
})

function adminRequest(path: string, init: { method?: string; body?: Record<string, unknown> } = {}) {
  return app.fetch(new Request(`http://den-api.local${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  }))
}

describe.serial("deployment-supplied pre-registered OAuth clients", () => {
  test("the Render preset no longer demands an admin OAuth app", async () => {
    const response = await adminRequest("/v1/mcp-connections/presets")
    expect(response.status).toBe(200)
    const body = await responseRecord(response)
    const presets = body.presets
    if (!Array.isArray(presets)) throw new Error("Presets response did not include presets")
    const render = presets.find((preset) => isRecord(preset) && preset.presetId === "render")
    expect(render).toMatchObject({ url: RENDER_URL, authType: "oauth", supportedAuthTypes: ["oauth", "apikey"] })
    expect(isRecord(render) && "requiresOAuthClient" in render).toBe(false)
    const slack = presets.find((preset) => isRecord(preset) && preset.presetId === "slack")
    expect(isRecord(slack) && slack.requiresOAuthClient).toBe(true)
  })

  test("creating an OAuth connection stores the deployment client as pre-registered", async () => {
    const response = await adminRequest("/v1/mcp-connections", {
      method: "POST",
      body: {
        name: "Render",
        url: RENDER_URL,
        authType: "oauth",
        credentialMode: "per_member",
      },
    })
    expect(response.status).toBe(200)
    const body = await responseRecord(response)
    expect(body).toMatchObject({
      authType: "oauth",
      oauthClientConfigured: true,
      oauthClientRequired: false,
      oauthClientId: "openwork",
      oauthRegistrationSource: "pre-registered",
      setupRequired: false,
    })
    expect(body.oauthCallbackUrl).toBe("http://127.0.0.1:8790/v1/mcp-connections/oauth/callback")

    const connectionId = body.id
    if (typeof connectionId !== "string") throw new Error("Created connection has no id")
    const client = await oauthCredentials.getOrgOAuthClient(organizationId, connectionId)
    expect(client?.clientId).toBe("openwork")
    expect(client?.clientSecret).toBeNull()
    expect(client?.extra).toMatchObject({
      enterpriseMcpRegistrationSource: "pre-registered",
      registeredRedirectUri: "http://127.0.0.1:8790/v1/mcp-connections/oauth/callback",
    })
  })

  test("an admin-supplied OAuth app still wins over the deployment client", async () => {
    const response = await adminRequest("/v1/mcp-connections", {
      method: "POST",
      body: {
        name: "Render with own app",
        url: RENDER_URL,
        authType: "oauth",
        credentialMode: "per_member",
        oauthClient: { clientId: "custom-render-client" },
      },
    })
    expect(response.status).toBe(200)
    const body = await responseRecord(response)
    expect(body.oauthClientId).toBe("custom-render-client")
  })

  test("servers without a deployment client are unaffected", async () => {
    const response = await adminRequest("/v1/mcp-connections", {
      method: "POST",
      body: {
        name: "Slack",
        url: "https://mcp.slack.com/mcp",
        authType: "oauth",
        credentialMode: "per_member",
      },
    })
    expect(response.status).toBe(200)
    const body = await responseRecord(response)
    expect(body).toMatchObject({ oauthClientConfigured: false, oauthClientRequired: true, oauthClientId: null })
  })

  test("switching an API-key connection to OAuth on edit fills in the deployment client", async () => {
    const created = await adminRequest("/v1/mcp-connections", {
      method: "POST",
      body: {
        name: "Render shared",
        url: RENDER_URL,
        authType: "oauth",
        credentialMode: "shared",
        oauthClient: { clientId: "custom-render-client" },
      },
    })
    expect(created.status).toBe(200)
    const createdBody = await responseRecord(created)
    const connectionId = createdBody.id
    if (typeof connectionId !== "string" || typeof createdBody.updatedAt !== "string") throw new Error("Created connection is incomplete")

    // Remove the admin app so the row has no stored client, then save an edit.
    await db.delete(schema.OrgOAuthClientTable).where(drizzle.and(
      drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId),
      drizzle.eq(schema.OrgOAuthClientTable.providerId, connectionId),
    ))
    const edited = await adminRequest(`/v1/mcp-connections/${connectionId}`, {
      method: "PUT",
      body: {
        expectedUpdatedAt: createdBody.updatedAt,
        name: "Render shared (renamed)",
        url: RENDER_URL,
        authType: "oauth",
        credentialMode: "per_member",
        access: { orgWide: true, memberIds: [], teamIds: [] },
      },
    })
    expect(edited.status).toBe(200)
    const editedBody = await responseRecord(edited)
    expect(editedBody).toMatchObject({ oauthClientConfigured: true, oauthClientId: "openwork", oauthRegistrationSource: "pre-registered" })
  })

  test("a stored admin OAuth app survives a plain edit and is replaced only when the identity changes", async () => {
    const created = await adminRequest("/v1/mcp-connections", {
      method: "POST",
      body: {
        name: "Render custom",
        url: RENDER_URL,
        authType: "oauth",
        credentialMode: "per_member",
        oauthClient: { clientId: "custom-render-client" },
      },
    })
    expect(created.status).toBe(200)
    const createdBody = await responseRecord(created)
    const connectionId = createdBody.id
    if (typeof connectionId !== "string" || typeof createdBody.updatedAt !== "string") throw new Error("Created connection is incomplete")

    const renamed = await adminRequest(`/v1/mcp-connections/${connectionId}`, {
      method: "PUT",
      body: {
        expectedUpdatedAt: createdBody.updatedAt,
        name: "Render custom (renamed)",
        url: RENDER_URL,
        authType: "oauth",
        credentialMode: "per_member",
        access: { orgWide: true, memberIds: [], teamIds: [] },
      },
    })
    expect(renamed.status).toBe(200)
    const renamedBody = await responseRecord(renamed)
    expect(renamedBody.oauthClientId).toBe("custom-render-client")
    if (typeof renamedBody.updatedAt !== "string") throw new Error("Renamed connection has no updatedAt")

    // Switching credential mode changes the connection identity, which drops
    // the stored client; the deployment client fills the gap.
    const switched = await adminRequest(`/v1/mcp-connections/${connectionId}`, {
      method: "PUT",
      body: {
        expectedUpdatedAt: renamedBody.updatedAt,
        name: "Render custom (renamed)",
        url: RENDER_URL,
        authType: "oauth",
        credentialMode: "shared",
        access: { orgWide: true, memberIds: [], teamIds: [] },
      },
    })
    expect(switched.status).toBe(200)
    const switchedBody = await responseRecord(switched)
    expect(switchedBody).toMatchObject({ oauthClientConfigured: true, oauthClientId: "openwork" })
  })
})
