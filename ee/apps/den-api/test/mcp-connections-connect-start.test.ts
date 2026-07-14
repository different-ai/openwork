import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
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
let externalMcpIdentityBinding: typeof import("../src/capability-sources/external-mcp-connections.js").externalMcpIdentityBinding
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
  externalMcpIdentityBinding = connectionsMod.externalMcpIdentityBinding
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
    requestedOAuthScopes: ["read:jira-work", "offline_access"],
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

test("public OAuth client metadata is exact, cache-disabled, and credential-free", async () => {
  const path = `/v1/mcp-connections/${seededConnectionId()}/oauth-client-metadata`
  const response = await app.fetch(new Request(`http://den-api.local${path}`))
  const publicApiBaseUrl = (process.env.DEN_API_PUBLIC_URL ?? "http://den-api.local").replace(/\/+$/, "")
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toEqual({
    client_id: `${publicApiBaseUrl}${path}`,
    client_name: "OpenWork",
    redirect_uris: [`${publicApiBaseUrl}/v1/mcp-connections/${seededConnectionId()}/connect/callback`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "read:jira-work offline_access",
  })
})

test("public OAuth client metadata does not reveal unknown or non-OAuth connections", async () => {
  const unknownId = createDenTypeId("externalMcpConnection")
  const noAuth = await createExternalMcpConnection({
    organizationId,
    name: "No-auth metadata decoy",
    url: "http://127.0.0.1:9/no-auth-metadata-decoy",
    authType: "none",
    credentialMode: "shared",
    createdByOrgMembershipId: memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  for (const connectionId of [unknownId, noAuth.id]) {
    const response = await app.fetch(new Request(`http://den-api.local/v1/mcp-connections/${connectionId}/oauth-client-metadata`))
    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ error: "connection_not_found", message: "Unknown OAuth connection." })
  }
})

test("public OAuth callback scopes the signed connection lookup to its organization", async () => {
  const state = createOAuthStateToken({
    organizationId: createDenTypeId("organization"),
    orgMembershipId: memberId,
    providerId: seededConnectionId(),
    binding: externalMcpIdentityBinding({
      url: "http://127.0.0.1:9/mcp",
      authType: "oauth",
      credentialMode: "per_member",
    }),
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

test("public OAuth callback rechecks the initiating member's current shared-connection authority", async () => {
  const sharedConnection = await createExternalMcpConnection({
    organizationId,
    name: "Shared callback authority check",
    url: "http://127.0.0.1:9/shared-callback-authority",
    authType: "oauth",
    credentialMode: "shared",
    createdByOrgMembershipId: memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  const state = createOAuthStateToken({
    organizationId,
    orgMembershipId: memberId,
    providerId: sharedConnection.id,
    secret: process.env.BETTER_AUTH_SECRET ?? "",
  })
  const callbackUrl = new URL(`http://den-api.local/v1/mcp-connections/${sharedConnection.id}/connect/callback`)
  callbackUrl.searchParams.set("code", "must-not-be-redeemed-after-demotion")
  callbackUrl.searchParams.set("state", state)

  await db.update(schema.MemberTable).set({ role: "member" }).where(drizzle.eq(schema.MemberTable.id, memberId))
  try {
    const response = await app.fetch(new Request(callbackUrl))
    expect(response.status).toBe(403)
    expect(response.headers.get("content-type")).toContain("text/html")
    const html = await response.text()
    expect(html).toContain("access to this connection changed")
    expect(html).not.toContain("must-not-be-redeemed-after-demotion")
  } finally {
    await db.update(schema.MemberTable).set({ role: "admin" }).where(drizzle.eq(schema.MemberTable.id, memberId))
  }
})

test("public OAuth callback rechecks a per-member connection's current assignment", async () => {
  const assignedConnection = await createExternalMcpConnection({
    organizationId,
    name: "Per-member callback assignment check",
    url: "http://127.0.0.1:9/per-member-callback-assignment",
    authType: "oauth",
    credentialMode: "per_member",
    createdByOrgMembershipId: memberId,
    access: { orgWide: false, memberIds: [memberId], teamIds: [] },
  })
  const state = createOAuthStateToken({
    organizationId,
    orgMembershipId: memberId,
    providerId: assignedConnection.id,
    secret: process.env.BETTER_AUTH_SECRET ?? "",
  })
  const callbackUrl = new URL(`http://den-api.local/v1/mcp-connections/${assignedConnection.id}/connect/callback`)
  callbackUrl.searchParams.set("code", "must-not-be-redeemed-after-unassignment")
  callbackUrl.searchParams.set("state", state)

  await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(
    drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, assignedConnection.id),
  )
  const response = await app.fetch(new Request(callbackUrl))
  expect(response.status).toBe(403)
  expect(response.headers.get("content-type")).toContain("text/html")
  const html = await response.text()
  expect(html).toContain("access to this connection changed")
  expect(html).not.toContain("must-not-be-redeemed-after-unassignment")
})

test("public OAuth callback validates state and renders a safe provider-denial diagnostic", async () => {
  const state = createOAuthStateToken({
    organizationId,
    orgMembershipId: memberId,
    providerId: seededConnectionId(),
    binding: externalMcpIdentityBinding({
      url: "http://127.0.0.1:9/mcp",
      authType: "oauth",
      credentialMode: "per_member",
    }),
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
  const leftovers = await db
    .select({ id: schema.ExternalMcpConnectionTable.id })
    .from(schema.ExternalMcpConnectionTable)
    .where(drizzle.and(
      drizzle.eq(schema.ExternalMcpConnectionTable.organizationId, organizationId),
      drizzle.eq(schema.ExternalMcpConnectionTable.name, "Broken no-auth MCP"),
    ))
  expect(leftovers).toEqual([])
})

test("connection configuration rejects credentials embedded in MCP URLs", async () => {
  for (const url of [
    "not a url",
    "file:///tmp/mcp.sock",
    "ftp://mcp.example.invalid/mcp",
    "https://user:password@mcp.example.invalid/mcp",
    "https://mcp.example.invalid/mcp?access_token=secret",
    "https://mcp.example.invalid/mcp?apiKey=secret",
    "https://mcp.example.invalid/mcp?clientSecret=secret",
    "https://mcp.example.invalid/mcp?password=secret",
    "https://mcp.example.invalid/mcp?githubToken=secret",
    "https://mcp.example.invalid/mcp?accessKeyId=secret",
    "https://mcp.example.invalid/mcp?customSessionToken=secret",
    "https://mcp.example.invalid/mcp?signingKey=secret",
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

test("connection URL validation never reflects a rejected credential value", async () => {
  const literal = "must-not-reflect-direct-url-value"
  const url = `https://mcp.example.invalid/mcp?customSessionToken=${literal}`
  const response = await staleSessionRequest("/v1/mcp-connections", "POST", {
    name: "Redacted unsafe MCP URL",
    url,
    authType: "oauth",
    credentialMode: "shared",
  })
  expect(response.status).toBe(400)
  const responseText = await response.text()
  expect(responseText).not.toContain(literal)
  expect(responseText).not.toContain(url)
})

test("POST /v1/mcp-connections/discover probes a valid MCP without creating it", async () => {
  const methods: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      methods.push(request.method)
      return Response.json({
        jsonrpc: "2.0",
        id: "openwork-mcp-discovery",
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: { name: "route-test-mcp", version: "1.0.0" },
        },
      })
    },
  })

  try {
    const url = `http://127.0.0.1:${server.port}/mcp`
    const response = await staleSessionRequest("/v1/mcp-connections/discover", "POST", { url })
    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    expect(body).toEqual({
      discovery: expect.objectContaining({
        auth: { confidence: "inferred", kind: "none", source: "live_protocol" },
        support: { status: "needs_review" },
        transport: { kind: "remote_http", supported: true, url },
      }),
    })
    expect(methods).toEqual(["POST"])
  } finally {
    await server.stop(true)
  }
})

test("POST /v1/mcp-connections/discover rejects manifest credential values without echoing them", async () => {
  const literal = "must-not-enter-discovery"
  for (const manifest of [
    { headers: { Authorization: `Bearer ${literal}` } },
    { url: `https://mcp.example.invalid/mcp?apiKey=${literal}` },
    { url: `https://mcp.example.invalid/mcp?clientSecret=${literal}` },
    { url: `https://mcp.example.invalid/mcp?password=${literal}` },
    { config: { githubToken: literal } },
    { config: { signing_key: literal } },
    { endpoint: `https://mcp.example.invalid/mcp?customSessionToken=${literal}` },
  ]) {
    const response = await staleSessionRequest("/v1/mcp-connections/discover", "POST", {
      url: "http://127.0.0.1:9/mcp",
      manifest,
    })
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain(literal)
  }
})

test("POST /v1/mcp-connections/discover rejects manifests beyond traversal safety limits", async () => {
  const manifest: Record<string, unknown> = {}
  let cursor = manifest
  for (let depth = 0; depth < 40; depth += 1) {
    const next: Record<string, unknown> = {}
    cursor.next = next
    cursor = next
  }
  const response = await staleSessionRequest("/v1/mcp-connections/discover", "POST", {
    url: "http://127.0.0.1:9/mcp",
    manifest,
  })
  expect(response.status).toBe(400)
  expect(await response.text()).toContain("depth safety limit")
})

test("connection listings project only the caller's granted OAuth scopes", async () => {
  const shared = await createExternalMcpConnection({
    organizationId,
    name: "Shared scoped MCP",
    url: "http://127.0.0.1:9/shared-scoped-mcp",
    authType: "oauth",
    credentialMode: "shared",
    createdByOrgMembershipId: memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  await db
    .update(schema.ExternalMcpConnectionTable)
    .set({ scope: "issues:read issues:write issues:read" })
    .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, shared.id))

  const perMember = await createExternalMcpConnection({
    organizationId,
    name: "Per-member scoped MCP",
    url: "http://127.0.0.1:9/per-member-scoped-mcp",
    authType: "oauth",
    credentialMode: "per_member",
    createdByOrgMembershipId: memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  const { upsertConnectedAccount } = await import("../src/capability-sources/oauth-credentials.js")
  await upsertConnectedAccount({
    organizationId,
    orgMembershipId: memberId,
    providerId: perMember.id,
    accessToken: "encrypted-at-rest-test-token",
    scopes: ["tasks:read", "tasks:write", "tasks:read"],
  })

  const response = await staleSessionRequest("/v1/mcp-connections?scope=manageable")
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  if (!isRecord(body) || !Array.isArray(body.connections)) {
    throw new Error("manageable connections response was not a list")
  }
  const sharedResponse = body.connections.find((entry) => isRecord(entry) && entry.id === shared.id)
  const perMemberResponse = body.connections.find((entry) => isRecord(entry) && entry.id === perMember.id)
  expect(sharedResponse).toEqual(expect.objectContaining({ grantedScopes: ["issues:read", "issues:write"] }))
  expect(perMemberResponse).toEqual(expect.objectContaining({ grantedScopes: ["tasks:read", "tasks:write"] }))
})

test("successful no-auth create publishes readiness with the atomic connection", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const rpc: unknown = await request.json()
      if (!isRecord(rpc) || typeof rpc.method !== "string") {
        return Response.json({ error: "invalid_request" }, { status: 400 })
      }
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 })
      return Response.json({
        jsonrpc: "2.0",
        id: typeof rpc.id === "string" || typeof rpc.id === "number" ? rpc.id : null,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: { name: "atomic-no-auth", version: "1.0.0" },
        },
      })
    },
  })

  try {
    const response = await staleSessionRequest("/v1/mcp-connections", "POST", {
      name: "Atomic no-auth readiness",
      url: `http://127.0.0.1:${server.port}/mcp`,
      authType: "none",
      credentialMode: "shared",
    })
    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    expect(body).toEqual(expect.objectContaining({
      connected: true,
      connectedForMe: true,
      connectedAt: expect.any(String),
    }))
    if (!isRecord(body) || typeof body.id !== "string") throw new Error("No-auth create response was missing its id.")

    const rows = await db
      .select({ connectedAt: schema.ExternalMcpConnectionTable.connectedAt })
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, body.id))
    expect(rows[0]?.connectedAt).toBeInstanceOf(Date)
    const connections = await import("../src/capability-sources/external-mcp-connections.js")
    await connections.deleteExternalMcpConnection({
      organizationId,
      connectionId: normalizeDenTypeId("externalMcpConnection", body.id),
    })
  } finally {
    await server.stop(true)
  }
})

test("non-OAuth create stays invisible while validation is pending and cannot commit after the 15 second deadline", async () => {
  const connectionName = `Delayed direct MCP ${createDenTypeId("externalMcpConnection")}`
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      await new Promise<void>((resolve) => {
        if (request.signal.aborted) {
          resolve()
          return
        }
        request.signal.addEventListener("abort", () => resolve(), { once: true })
      })
      return Response.json({
        jsonrpc: "2.0",
        id: "late-initialize",
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: { name: "too-late", version: "1.0.0" },
        },
      })
    },
  })

  const matchingConnections = () => db
    .select({ id: schema.ExternalMcpConnectionTable.id })
    .from(schema.ExternalMcpConnectionTable)
    .where(drizzle.and(
      drizzle.eq(schema.ExternalMcpConnectionTable.organizationId, organizationId),
      drizzle.eq(schema.ExternalMcpConnectionTable.name, connectionName),
    ))

  try {
    const startedAt = Date.now()
    const responsePromise = staleSessionRequest("/v1/mcp-connections", "POST", {
      name: connectionName,
      url: `http://127.0.0.1:${server.port}/mcp`,
      authType: "none",
      credentialMode: "shared",
    })
    await Bun.sleep(100)
    expect(await matchingConnections()).toEqual([])

    const response = await responsePromise
    expect(response.status).toBe(502)
    const body: unknown = await response.json()
    expect(body).toEqual(expect.objectContaining({
      error: "connection_validation_failed",
      diagnostic: expect.objectContaining({ code: "MCP_LIFECYCLE_DEADLINE" }),
    }))
    expect(Date.now() - startedAt).toBeLessThan(17_000)

    // A transport that resolves after cancellation still has no staged row it
    // can publish from a detached continuation.
    await Bun.sleep(100)
    expect(await matchingConnections()).toEqual([])
  } finally {
    await server.stop(true)
  }
}, 20_000)

test("prepared direct creation commits connection, assignment, and OAuth client atomically with deletion", async () => {
  const connections = await import("../src/capability-sources/external-mcp-connections.js")
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const prepared = connections.prepareExternalMcpConnection({
      organizationId,
      name: `Atomic direct OAuth MCP ${iteration}`,
      url: `https://mcp.example.invalid/atomic-direct-${iteration}`,
      authType: "oauth",
      credentialMode: "shared",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const createPromise = connections.commitPreparedExternalMcpConnection({
      prepared,
      oauthClient: {
        clientId: `atomic-client-${iteration}`,
        clientSecret: `atomic-secret-${iteration}`,
        extra: { registrationProvenance: "pre_registered" },
      },
    })
    const deletePromise = connections.deleteExternalMcpConnection({
      organizationId,
      connectionId: prepared.connection.id,
    })
    const [createResult] = await Promise.all([createPromise, deletePromise])
    expect(createResult.id).toBe(prepared.connection.id)

    const [connectionRows, grantRows, clientRows] = await Promise.all([
      db.select({ id: schema.ExternalMcpConnectionTable.id })
        .from(schema.ExternalMcpConnectionTable)
        .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, prepared.connection.id)),
      db.select({ id: schema.ExternalMcpConnectionAccessGrantTable.id })
        .from(schema.ExternalMcpConnectionAccessGrantTable)
        .where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, prepared.connection.id)),
      db.select({ id: schema.OrgOAuthClientTable.id })
        .from(schema.OrgOAuthClientTable)
        .where(drizzle.and(
          drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId),
          drizzle.eq(schema.OrgOAuthClientTable.providerId, prepared.connection.id),
        )),
    ])

    // Delete may linearize before the unseen insert (all three remain) or
    // after its atomic commit (all three are removed), but no partial graph is
    // observable in either ordering.
    expect([connectionRows.length, grantRows.length, clientRows.length]).toEqual(
      connectionRows.length === 0 ? [0, 0, 0] : [1, 1, 1],
    )
    await connections.deleteExternalMcpConnection({
      organizationId,
      connectionId: prepared.connection.id,
    })
  }
})

test("a failed OAuth client insert leaves no direct connection or assignment shell", async () => {
  const connections = await import("../src/capability-sources/external-mcp-connections.js")
  const prepared = connections.prepareExternalMcpConnection({
    organizationId,
    name: "Atomic direct OAuth client failure",
    url: "https://mcp.example.invalid/atomic-client-failure",
    authType: "oauth",
    credentialMode: "shared",
    createdByOrgMembershipId: memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })

  await expect(connections.commitPreparedExternalMcpConnection({
    prepared,
    oauthClient: {
      // Route validation caps this at 512. Passing an oversized value here
      // deliberately faults the final dependent insert inside the transaction.
      clientId: "x".repeat(513),
      clientSecret: null,
      extra: { registrationProvenance: "pre_registered" },
    },
  })).rejects.toThrow()

  const [connectionRows, grantRows, clientRows] = await Promise.all([
    db.select({ id: schema.ExternalMcpConnectionTable.id })
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, prepared.connection.id)),
    db.select({ id: schema.ExternalMcpConnectionAccessGrantTable.id })
      .from(schema.ExternalMcpConnectionAccessGrantTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, prepared.connection.id)),
    db.select({ id: schema.OrgOAuthClientTable.id })
      .from(schema.OrgOAuthClientTable)
      .where(drizzle.and(
        drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId),
        drizzle.eq(schema.OrgOAuthClientTable.providerId, prepared.connection.id),
      )),
  ])
  expect([connectionRows, grantRows, clientRows]).toEqual([[], [], []])
})

test("an expired direct-create commit budget leaves no connection graph", async () => {
  const connections = await import("../src/capability-sources/external-mcp-connections.js")
  const prepared = connections.prepareExternalMcpConnection({
    organizationId,
    name: "Expired atomic direct create",
    url: "https://mcp.example.invalid/expired-atomic-create",
    authType: "oauth",
    credentialMode: "shared",
    createdByOrgMembershipId: memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  await expect(connections.commitPreparedExternalMcpConnection({
    commitExpiresAt: Date.now() - 1,
    prepared,
    oauthClient: {
      clientId: "must-not-commit",
      clientSecret: "must-not-commit",
      extra: { registrationProvenance: "pre_registered" },
    },
  })).rejects.toMatchObject({ name: "ExternalMcpLifecycleDeadlineError" })

  const [connectionRows, grantRows, clientRows] = await Promise.all([
    db.select({ id: schema.ExternalMcpConnectionTable.id })
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, prepared.connection.id)),
    db.select({ id: schema.ExternalMcpConnectionAccessGrantTable.id })
      .from(schema.ExternalMcpConnectionAccessGrantTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, prepared.connection.id)),
    db.select({ id: schema.OrgOAuthClientTable.id })
      .from(schema.OrgOAuthClientTable)
      .where(drizzle.eq(schema.OrgOAuthClientTable.providerId, prepared.connection.id)),
  ])
  expect([connectionRows, grantRows, clientRows]).toEqual([[], [], []])
})

test("direct OAuth create publishes its pre-registered client and request-derived callback together", async () => {
  const response = await staleSessionRequest("/v1/mcp-connections", "POST", {
    name: "Atomic route OAuth MCP",
    url: "https://mcp.example.invalid/atomic-route-oauth",
    authType: "oauth",
    credentialMode: "shared",
    oauthClient: {
      clientId: "route-pre-registered-client",
      clientSecret: "route-pre-registered-secret",
    },
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  if (!isRecord(body) || typeof body.id !== "string" || !isRecord(body.links)) {
    throw new Error("Atomic OAuth create response was missing its connection links.")
  }

  const publicApiBaseUrl = (process.env.DEN_API_PUBLIC_URL ?? "http://den-api.local").replace(/\/+$/, "")
  expect(body.links.oauthCallback).toBe(`${publicApiBaseUrl}/v1/mcp-connections/${body.id}/connect/callback`)
  const [connectionRows, grantRows, clientRows] = await Promise.all([
    db.select({ id: schema.ExternalMcpConnectionTable.id })
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, body.id)),
    db.select({ id: schema.ExternalMcpConnectionAccessGrantTable.id })
      .from(schema.ExternalMcpConnectionAccessGrantTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, body.id)),
    db.select({ clientId: schema.OrgOAuthClientTable.clientId })
      .from(schema.OrgOAuthClientTable)
      .where(drizzle.and(
        drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId),
        drizzle.eq(schema.OrgOAuthClientTable.providerId, body.id),
      )),
  ])
  expect(connectionRows).toHaveLength(1)
  expect(grantRows).toHaveLength(1)
  expect(clientRows).toEqual([{ clientId: "route-pre-registered-client" }])

  const connections = await import("../src/capability-sources/external-mcp-connections.js")
  await connections.deleteExternalMcpConnection({
    organizationId,
    connectionId: normalizeDenTypeId("externalMcpConnection", body.id),
  })
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
