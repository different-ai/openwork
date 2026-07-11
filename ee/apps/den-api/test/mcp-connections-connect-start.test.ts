import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_pr7"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DEN_ALLOW_PRIVATE_MCP_URLS = "1"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let session: typeof import("../src/session.js")
let createExternalMcpConnection: typeof import("../src/capability-sources/external-mcp-connections.js").createExternalMcpConnection
let createOAuthStateToken: typeof import("../src/capability-sources/generic-oauth.js").createOAuthStateToken

const userId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const staleSessionId = createDenTypeId("session")
const staleSessionToken = `stale-mcp-session-${staleSessionId}`
const connectionName = "Broken OAuth MCP"
let connectionId: DenTypeId<"externalMcpConnection"> | undefined

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()
  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const [appMod, dbMod, schemaMod, drizzleMod, sessionMod, connectionsMod, genericOAuthMod] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/session.js"),
    import("../src/capability-sources/external-mcp-connections.js"),
    import("../src/capability-sources/generic-oauth.js"),
  ])
  app = appMod.default
  db = dbMod.db
  schema = schemaMod
  drizzle = drizzleMod
  session = sessionMod
  createExternalMcpConnection = connectionsMod.createExternalMcpConnection
  createOAuthStateToken = genericOAuthMod.createOAuthStateToken

  await db.insert(schema.AuthUserTable).values({
    id: userId,
    name: "MCP Connect Start User",
    email: `mcp-connect-start+${userId}@test.local`,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "MCP Connect Start Org",
    slug: `mcp-connect-start-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values({
    id: memberId,
    organizationId,
    userId,
    role: "admin",
  })
  await db.insert(schema.AuthSessionTable).values({
    id: staleSessionId,
    userId,
    activeOrganizationId: organizationId,
    token: staleSessionToken,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
  })

  const connection = await createExternalMcpConnection({
    organizationId,
    name: connectionName,
    url: "http://127.0.0.1:9/mcp",
    authType: "oauth",
    credentialMode: "per_member",
    createdByOrgMembershipId: memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  connectionId = connection.id
})

afterAll(async () => {
  await db.delete(schema.ConnectedAccountTable).where(drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId))
  await db.delete(schema.OrgOAuthClientTable).where(drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionTable).where(drizzle.eq(schema.ExternalMcpConnectionTable.organizationId, organizationId))
  await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, staleSessionId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, userId))
  mock.restore()
})

function seededConnectionId() {
  if (!connectionId) {
    throw new Error("External MCP connection was not seeded")
  }
  return connectionId
}

function request(path: string) {
  return app.fetch(new Request(`http://den-api.local${path}`, {
    headers: {
      "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({ userId, organizationId }),
    },
  }))
}

function staleSessionRequest(path: string, method = "GET", body?: unknown) {
  return app.fetch(new Request(`http://den-api.local${path}`, {
    method,
    headers: {
      authorization: `Bearer ${staleSessionToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
}

test("GET /v1/mcp-connections/:connectionId/connect/start maps OAuth handshake failures to 502 JSON", async () => {
  const response = await request(`/v1/mcp-connections/${seededConnectionId()}/connect/start`)
  expect(response.status).toBe(502)

  const body: unknown = await response.json()
  expect(isRecord(body)).toBe(true)
  if (!isRecord(body)) {
    throw new Error("connect/start response was not an object")
  }
  expect(body.error).toBe("oauth_handshake_failed")
  expect(typeof body.message).toBe("string")
  if (typeof body.message !== "string") {
    throw new Error("connect/start response message was not a string")
  }
  expect(body.message.length).toBeGreaterThan(0)
  expect(body.message).toContain(connectionName)
  expect(body.message).not.toContain("Unable to connect")
  expect(isRecord(body.diagnostic)).toBe(true)
  if (!isRecord(body.diagnostic)) {
    throw new Error("connect/start response did not include a diagnostic envelope")
  }
  expect(body.diagnostic.phase).toBe("NETWORK_TCP")
  expect(body.diagnostic.category).toBe("network_failure")
  expect(body.diagnostic.code).toBe("MCP_ECONNREFUSED")
  expect(body.diagnostic.highestPassed).toBe("configured")
  expect(body.diagnostic.actionOwner).toBe("network_admin")
  expect(typeof body.diagnostic.operatorAction).toBe("string")
  expect(body.diagnostic.referenceId).toBe(response.headers.get("x-request-id"))
})

test("GET /v1/mcp-connections/:connectionId/connect/start still returns connection_not_found", async () => {
  const response = await request(`/v1/mcp-connections/${createDenTypeId("externalMcpConnection")}/connect/start`)
  expect(response.status).toBe(404)

  const body: unknown = await response.json()
  expect(isRecord(body)).toBe(true)
  if (!isRecord(body)) {
    throw new Error("connect/start 404 response was not an object")
  }
  expect(body.error).toBe("connection_not_found")
})

test("public OAuth callback scopes the signed connection lookup to its organization", async () => {
  const state = createOAuthStateToken({
    organizationId: createDenTypeId("organization"),
    orgMembershipId: memberId,
    providerId: seededConnectionId(),
    secret: process.env.BETTER_AUTH_SECRET ?? "",
  })
  const callbackUrl = new URL(`http://den-api.local/v1/mcp-connections/${seededConnectionId()}/connect/callback`)
  callbackUrl.searchParams.set("code", "must-not-be-redeemed")
  callbackUrl.searchParams.set("state", state)

  const response = await app.fetch(new Request(callbackUrl))
  expect(response.status).toBe(400)
  const body: unknown = await response.json()
  expect(body).toEqual({ error: "invalid_request", message: "Unknown connection." })
})

test("public OAuth callback validates state and renders a safe provider-denial diagnostic", async () => {
  const state = createOAuthStateToken({
    organizationId,
    orgMembershipId: memberId,
    providerId: seededConnectionId(),
    secret: process.env.BETTER_AUTH_SECRET ?? "",
  })
  const callbackUrl = new URL(`http://den-api.local/v1/mcp-connections/${seededConnectionId()}/connect/callback`)
  callbackUrl.searchParams.set("error", "access_denied")
  callbackUrl.searchParams.set("error_description", "tenant=user@example.invalid secret-detail")
  callbackUrl.searchParams.set("session_state", "opaque-provider-session")
  callbackUrl.searchParams.set("state", state)

  const response = await app.fetch(new Request(callbackUrl))
  expect(response.status).toBe(400)
  expect(response.headers.get("content-type")).toContain("text/html")
  const html = await response.text()
  expect(html).toContain("The provider did not grant authorization")
  expect(html).toContain("Diagnostic reference")
  expect(html).not.toContain("user@example.invalid")
  expect(html).not.toContain("secret-detail")
  expect(html).not.toContain("opaque-provider-session")
})

test("non-OAuth create validation returns the same structured network diagnostic", async () => {
  const response = await staleSessionRequest("/v1/mcp-connections", "POST", {
    name: "Broken no-auth MCP",
    url: "http://127.0.0.1:9/mcp",
    authType: "none",
    credentialMode: "shared",
  })
  expect(response.status).toBe(502)
  const body: unknown = await response.json()
  expect(isRecord(body)).toBe(true)
  if (!isRecord(body) || !isRecord(body.diagnostic)) {
    throw new Error("create validation response did not include a diagnostic envelope")
  }
  expect(body.error).toBe("connection_validation_failed")
  expect(body.diagnostic).toMatchObject({
    referenceId: response.headers.get("x-request-id"),
    phase: "NETWORK_TCP",
    category: "network_failure",
    code: "MCP_ECONNREFUSED",
  })
})

test("connection configuration rejects credentials embedded in MCP URLs", async () => {
  for (const url of [
    "not a url",
    "file:///tmp/mcp.sock",
    "ftp://mcp.example.invalid/mcp",
    "https://user:password@mcp.example.invalid/mcp",
    "https://mcp.example.invalid/mcp?access_token=secret",
    "https://mcp.example.invalid/mcp#secret",
  ]) {
    const response = await staleSessionRequest("/v1/mcp-connections", "POST", {
      name: "Unsafe MCP URL",
      url,
      authType: "oauth",
      credentialMode: "shared",
    })
    expect(response.status).toBe(400)
  }
})

test("stale admin sessions can configure and connect shared MCPs but cannot disconnect or delete them", async () => {
  const createResponse = await staleSessionRequest("/v1/mcp-connections", "POST", {
    name: "Shared OAuth MCP",
    url: "http://127.0.0.1:9/mcp",
    authType: "oauth",
    credentialMode: "shared",
  })
  expect(createResponse.status).toBe(200)

  const createdBody: unknown = await createResponse.json()
  expect(isRecord(createdBody)).toBe(true)
  if (!isRecord(createdBody) || typeof createdBody.id !== "string") {
    throw new Error("create connection response did not include an id")
  }

  const accessResponse = await staleSessionRequest(`/v1/mcp-connections/${createdBody.id}/access`, "PUT", {
    access: {
      orgWide: true,
      memberIds: [],
      teamIds: [],
    },
  })
  expect(accessResponse.status).toBe(200)

  const connectResponse = await staleSessionRequest(`/v1/mcp-connections/${createdBody.id}/connect/start`)
  expect(connectResponse.status).toBe(502)
  const connectBody: unknown = await connectResponse.json()
  expect(isRecord(connectBody) && connectBody.error).toBe("oauth_handshake_failed")

  for (const [method, suffix] of [["POST", "/disconnect"], ["DELETE", ""]]) {
    const destructiveResponse = await staleSessionRequest(`/v1/mcp-connections/${createdBody.id}${suffix}`, method)
    expect(destructiveResponse.status).toBe(403)
    const destructiveBody: unknown = await destructiveResponse.json()
    expect(isRecord(destructiveBody) && destructiveBody.error).toBe("reauth")
    expect(isRecord(destructiveBody) && destructiveBody.reason).toBe("fresh_auth_required")
  }

  const [renewedSession] = await db
    .select({ expiresAt: schema.AuthSessionTable.expiresAt })
    .from(schema.AuthSessionTable)
    .where(drizzle.eq(schema.AuthSessionTable.id, staleSessionId))
    .limit(1)
  expect(renewedSession?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000)

  const signOutResponse = await staleSessionRequest("/api/auth/sign-out", "POST", {})
  expect(signOutResponse.status).toBe(200)
  const sessionsAfterSignOut = await db
    .select({ id: schema.AuthSessionTable.id })
    .from(schema.AuthSessionTable)
    .where(drizzle.eq(schema.AuthSessionTable.id, staleSessionId))
  expect(sessionsAfterSignOut).toEqual([])
})
