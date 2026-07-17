import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_pr7"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DEN_ALLOW_PRIVATE_MCP_URLS = "1"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let session: typeof import("../src/session.js")
let createExternalMcpConnection: typeof import("../src/capability-sources/external-mcp-connections.js").createExternalMcpConnection
let externalMcpIdentityBinding: typeof import("../src/capability-sources/external-mcp-connections.js").externalMcpIdentityBinding
let isolateExternalMcpOAuthCallback: typeof import("../src/capability-sources/external-mcp-connections.js").isolateExternalMcpOAuthCallback
let createOAuthStateToken: typeof import("../src/capability-sources/generic-oauth.js").createOAuthStateToken
let upsertOrgOAuthClient: typeof import("../src/capability-sources/oauth-credentials.js").upsertOrgOAuthClient
let getOrgOAuthClient: typeof import("../src/capability-sources/oauth-credentials.js").getOrgOAuthClient

const userId = createDenTypeId("user")
const regularUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const regularMemberId = createDenTypeId("member")
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
  createExternalMcpConnection = connectionsMod.createExternalMcpConnection
  externalMcpIdentityBinding = connectionsMod.externalMcpIdentityBinding
  isolateExternalMcpOAuthCallback = connectionsMod.isolateExternalMcpOAuthCallback
  createOAuthStateToken = genericOAuthMod.createOAuthStateToken
  upsertOrgOAuthClient = oauthCredentialsMod.upsertOrgOAuthClient
  getOrgOAuthClient = oauthCredentialsMod.getOrgOAuthClient

  await db.insert(schema.AuthUserTable).values({
    id: userId,
    name: "MCP Connect Start User",
    email: `mcp-connect-start+${userId}@test.local`,
  })
  await db.insert(schema.AuthUserTable).values({
    id: regularUserId,
    name: "MCP Connect Start Regular User",
    email: `mcp-connect-start+${regularUserId}@test.local`,
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
  await db.insert(schema.MemberTable).values({
    id: regularMemberId,
    organizationId,
    userId: regularUserId,
    role: "member",
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
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [userId, regularUserId]))
  mock.restore()
})

function seededConnectionId() {
  if (!connectionId) {
    throw new Error("External MCP connection was not seeded")
  }
  return connectionId
}

function request(path: string) {
  return principalRequest(userId, path)
}

function principalRequest(principalUserId: string, path: string, method = "GET") {
  return app.fetch(new Request(`http://den-api.local${path}`, {
    method,
    headers: {
      "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({ userId: principalUserId, organizationId }),
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

test("an existing legacy callback reconnects without migration or credential rewrites", async () => {
  const connection = await createExternalMcpConnection({
    organizationId,
    name: "Existing legacy OAuth MCP",
    url: "http://127.0.0.1:9/legacy-mcp",
    authType: "oauth",
    credentialMode: "per_member",
    createdByOrgMembershipId: memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  await db
    .update(schema.ExternalMcpConnectionTable)
    .set({
      oauthConfiguration: {
        version: 1,
        authorizationServerIssuer: null,
        requestedScopes: [],
        callbackMode: "legacy-v1",
      },
    })
    .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
  await upsertOrgOAuthClient({
    organizationId,
    providerId: connection.id,
    clientId: "existing-client",
    clientSecret: "existing-secret",
    createdByOrgMembershipId: memberId,
  })

  const listResponse = await request("/v1/mcp-connections?scope=manageable")
  expect(listResponse.status).toBe(200)
  const listBody: unknown = await listResponse.json()
  if (!isRecord(listBody) || !Array.isArray(listBody.connections)) {
    throw new Error("manageable connection response was not a list")
  }
  const listed = listBody.connections.find((entry) => isRecord(entry) && entry.id === connection.id)
  expect(listed).toMatchObject({
    oauthCallbackMode: "legacy-v1",
    oauthCallbackUrl: new URL(
      `/v1/mcp-connections/${connection.id}/connect/callback`,
      process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790",
    ).toString(),
  })

  const response = await request(`/v1/mcp-connections/${connection.id}/connect/start`)
  expect(response.status).toBe(502)
  expect(await response.json()).toMatchObject({ error: "oauth_handshake_failed" })
  expect(await getOrgOAuthClient(organizationId, connection.id)).toMatchObject({
    clientId: "existing-client",
  })
})

test("requirements discovery is side-effect free", async () => {
  const before = await db.select({ id: schema.ExternalMcpConnectionTable.id }).from(schema.ExternalMcpConnectionTable)
  const response = await staleSessionRequest("/v1/mcp-connections/discover", "POST", {
    url: "http://127.0.0.1:9/mcp",
  })
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  expect(body).toMatchObject({ status: "unreachable" })
  const after = await db.select({ id: schema.ExternalMcpConnectionTable.id }).from(schema.ExternalMcpConnectionTable)
  expect(after).toEqual(before)
})

test("public client metadata exposes only the deployment-wide web callback", async () => {
  const response = await app.fetch(new Request("http://den-api.local/oauth/client-metadata.json"))
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("public, max-age=300")
  const publicOrigin = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"
  expect(await response.json()).toEqual({
    client_id: new URL("/oauth/client-metadata.json", publicOrigin).toString(),
    client_name: "OpenWork",
    application_type: "web",
    redirect_uris: [new URL("/v1/mcp-connections/oauth/callback", publicOrigin).toString()],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  })
})

test("callback isolation replaces SDK registration state and exposes the scoped callback", async () => {
  const issuer = "https://legacy-issuer.example.test"
  const connection = await createExternalMcpConnection({
    organizationId,
    name: "Issuer-isolated OAuth MCP",
    url: "http://127.0.0.1:9/isolated-mcp",
    authType: "oauth",
    credentialMode: "shared",
    createdByOrgMembershipId: memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  await db
    .update(schema.ExternalMcpConnectionTable)
    .set({
      oauthConfiguration: {
        version: 1,
        authorizationServerIssuer: issuer,
        requestedScopes: [],
        callbackMode: "shared-v1",
        discovery: {
          authorizationServerUrl: issuer,
          authorizationServerMetadata: {
            issuer,
            authorization_response_iss_parameter_supported: false,
            code_challenge_methods_supported: ["S256"],
          },
          resourceMetadata: { authorization_servers: [issuer] },
        },
      },
    })
    .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
  await upsertOrgOAuthClient({
    organizationId,
    providerId: connection.id,
    clientId: "https://den.example.test/oauth/client-metadata.json",
    clientSecret: null,
    extra: {
      enterpriseMcpRegistrationSource: "client-metadata",
      registrationContractVersion: 2,
    },
    createdByOrgMembershipId: memberId,
  })

  const isolated = await isolateExternalMcpOAuthCallback({
    organizationId,
    connectionId: connection.id,
  })
  expect(isolated.oauthConfiguration?.callbackMode).toBe("isolated-v1")
  expect(await getOrgOAuthClient(organizationId, connection.id)).toBeNull()

  const response = await request("/v1/mcp-connections?scope=manageable")
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  if (!isRecord(body) || !Array.isArray(body.connections)) throw new Error("Expected manageable connections.")
  const listed = body.connections.find((entry) => isRecord(entry) && entry.id === connection.id)
  expect(listed).toMatchObject({
    oauthCallbackMode: "isolated-v1",
    oauthCallbackUrl: new URL(
      `/v1/mcp-connections/${connection.id}/connect/callback`,
      process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790",
    ).toString(),
  })
})

test("connect start selects an isolated callback before sending the user to a legacy authorization server", async () => {
  let origin = ""
  const registeredRedirects: string[][] = []
  const server = Bun.serve({
    port: 0,
    async fetch(incoming) {
      const url = new URL(incoming.url)
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        })
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        })
      }
      if (url.pathname === "/register") {
        const metadata: unknown = await incoming.json()
        const redirectUris = isRecord(metadata) && isStringArray(metadata.redirect_uris)
          ? metadata.redirect_uris
          : []
        registeredRedirects.push(redirectUris)
        return Response.json({
          client_id: `dynamic-client-${registeredRedirects.length}`,
          token_endpoint_auth_method: "none",
          redirect_uris: redirectUris,
        }, { status: 201 })
      }
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await incoming.text())
        expect(form.get("grant_type")).toBe("authorization_code")
        expect(form.get("code")).toBe("isolated-authorization-code")
        expect(form.get("code_verifier")?.length).toBeGreaterThanOrEqual(43)
        return Response.json({
          access_token: "isolated-access-token",
          refresh_token: "isolated-refresh-token",
          token_type: "Bearer",
          expires_in: 3_600,
        })
      }
      if (url.pathname === "/mcp") {
        if (incoming.headers.get("authorization") === "Bearer isolated-access-token") {
          if (incoming.method !== "POST") return new Response(null, { status: 405 })
          const rpc: unknown = await incoming.json()
          if (!isRecord(rpc)) return Response.json({ error: "invalid_request" }, { status: 400 })
          if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 })
          const id = typeof rpc.id === "string" || typeof rpc.id === "number" ? rpc.id : null
          if (rpc.method === "tools/list") {
            return Response.json({ jsonrpc: "2.0", id, result: { tools: [] } })
          }
          return Response.json({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "isolated-callback-test", version: "1.0.0" },
            },
          })
        }
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        })
      }
      return new Response(null, { status: 404 })
    },
  })
  origin = `http://127.0.0.1:${server.port}`

  try {
    const connection = await createExternalMcpConnection({
      organizationId,
      name: "Automatic isolated callback MCP",
      url: `${origin}/mcp`,
      authType: "oauth",
      credentialMode: "shared",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const response = await request(`/v1/mcp-connections/${connection.id}/connect/start`)
    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    if (!isRecord(body) || typeof body.authorizeUrl !== "string") throw new Error("Expected an OAuth authorize URL.")
    const authorizeUrl = new URL(body.authorizeUrl)
    const isolatedCallback = new URL(
      `/v1/mcp-connections/${connection.id}/connect/callback`,
      process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790",
    ).toString()
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(isolatedCallback)
    expect(registeredRedirects).toHaveLength(2)
    expect(registeredRedirects[0]).toEqual([
      new URL("/v1/mcp-connections/oauth/callback", process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790").toString(),
    ])
    expect(registeredRedirects[1]).toEqual([isolatedCallback])

    const rows = await db
      .select()
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
      .limit(1)
    expect(rows[0]?.oauthConfiguration?.callbackMode).toBe("isolated-v1")

    const callbackUrl = new URL(isolatedCallback)
    callbackUrl.searchParams.set("code", "isolated-authorization-code")
    callbackUrl.searchParams.set("state", authorizeUrl.searchParams.get("state") ?? "")
    callbackUrl.searchParams.set("iss", "stytch.com/project-live-provider-value")
    const callbackResponse = await app.fetch(new Request(callbackUrl))
    expect(callbackResponse.status).toBe(200)
    expect(await callbackResponse.text()).toContain("You're connected")

    const connectedRows = await db
      .select()
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
      .limit(1)
    expect(connectedRows[0]?.accessToken).toBe("isolated-access-token")
    expect(connectedRows[0]?.refreshToken).toBe("isolated-refresh-token")
  } finally {
    server.stop(true)
  }
})

test("connect start repairs a verified stale resource issuer alias before authorization", async () => {
  let authorizationOrigin = ""
  const registeredRedirects: string[][] = []
  const authorizationServer = Bun.serve({
    port: 0,
    async fetch(incoming) {
      const url = new URL(incoming.url)
      if (url.pathname === "/register") {
        const metadata: unknown = await incoming.json()
        const redirectUris = isRecord(metadata) && isStringArray(metadata.redirect_uris)
          ? metadata.redirect_uris
          : []
        registeredRedirects.push(redirectUris)
        return Response.json({
          client_id: "recovered-dynamic-client",
          token_endpoint_auth_method: "none",
          redirect_uris: redirectUris,
        }, { status: 201 })
      }
      return new Response(null, { status: 404 })
    },
  })
  authorizationOrigin = `http://127.0.0.1:${authorizationServer.port}`

  let resourceOrigin = ""
  const resourceServer = Bun.serve({
    port: 0,
    fetch(incoming) {
      const url = new URL(incoming.url)
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: `${resourceOrigin}/`,
          authorization_servers: [resourceOrigin],
        })
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: authorizationOrigin,
          authorization_endpoint: `${authorizationOrigin}/authorize`,
          token_endpoint: `${authorizationOrigin}/token`,
          registration_endpoint: `${authorizationOrigin}/register`,
          authorization_response_iss_parameter_supported: true,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        })
      }
      if (url.pathname === "/") {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${resourceOrigin}/.well-known/oauth-protected-resource"`,
          },
        })
      }
      return new Response(null, { status: 404 })
    },
  })
  resourceOrigin = `http://127.0.0.1:${resourceServer.port}`

  try {
    const connection = await createExternalMcpConnection({
      organizationId,
      name: "Recoverable resource alias MCP",
      url: resourceOrigin,
      authType: "oauth",
      credentialMode: "per_member",
      oauthConfiguration: {
        version: 1,
        authorizationServerIssuer: resourceOrigin,
        requestedScopes: [],
      },
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    await db
      .update(schema.ExternalMcpConnectionTable)
      .set({
        oauthConfiguration: {
          version: 1,
          authorizationServerIssuer: resourceOrigin,
          requestedScopes: [],
          callbackMode: "shared-v1",
          discovery: {
            authorizationServerUrl: resourceOrigin,
            authorizationServerMetadata: {
              issuer: authorizationOrigin,
              authorization_endpoint: `${authorizationOrigin}/authorize`,
              token_endpoint: `${authorizationOrigin}/token`,
              registration_endpoint: `${authorizationOrigin}/register`,
              authorization_response_iss_parameter_supported: true,
              code_challenge_methods_supported: ["S256"],
            },
            resourceMetadata: {
              resource: `${resourceOrigin}/`,
              authorization_servers: [resourceOrigin],
            },
          },
        },
      })
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))

    const response = await request(`/v1/mcp-connections/${connection.id}/connect/start`)
    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    if (!isRecord(body) || typeof body.authorizeUrl !== "string") {
      throw new Error("Expected a recovered OAuth authorize URL.")
    }
    expect(new URL(body.authorizeUrl).origin).toBe(authorizationOrigin)
    expect(registeredRedirects).toHaveLength(1)

    const [repaired] = await db
      .select()
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
      .limit(1)
    expect(repaired?.oauthConfiguration?.authorizationServerIssuer).toBe(authorizationOrigin)
    expect(repaired?.oauthIssuerReviewRequiredAt).toBeNull()

    if (!repaired?.oauthConfiguration?.discovery) throw new Error("Expected repaired discovery state.")
    await db
      .update(schema.ExternalMcpConnectionTable)
      .set({
        oauthConfiguration: {
          ...repaired.oauthConfiguration,
          authorizationServerIssuer: resourceOrigin,
        },
      })
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
    const memberResponse = await principalRequest(
      regularUserId,
      `/v1/mcp-connections/${connection.id}/connect/start`,
    )
    expect(memberResponse.status).toBe(409)
    expect(await memberResponse.json()).toMatchObject({
      error: "mcp_oauth_issuer_mismatch",
      message: "This connection's OAuth issuer changed and existing credentials must be cleared. Ask a workspace admin to reconnect it.",
    })
    const [memberBlocked] = await db
      .select()
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
      .limit(1)
    expect(memberBlocked?.oauthConfiguration?.authorizationServerIssuer).toBe(resourceOrigin)
    expect(memberBlocked?.oauthIssuerReviewRequiredAt).not.toBeNull()
  } finally {
    resourceServer.stop(true)
    authorizationServer.stop(true)
  }
})

test("issuer review requires an admin and only adopts the issuer advertised by live discovery", async () => {
  let origin = ""
  const server = Bun.serve({
    port: 0,
    fetch(incoming) {
      const url = new URL(incoming.url)
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        })
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        })
      }
      if (url.pathname === "/mcp") {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        })
      }
      return new Response(null, { status: 404 })
    },
  })
  origin = `http://127.0.0.1:${server.port}`

  try {
    const connection = await createExternalMcpConnection({
      organizationId,
      name: "Issuer review route MCP",
      url: `${origin}/mcp`,
      authType: "oauth",
      credentialMode: "shared",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const previousIssuer = "https://previous-issuer.example.test"
    const updatedAt = new Date(Date.now() + 1_000)
    await db
      .update(schema.ExternalMcpConnectionTable)
      .set({
        oauthConfiguration: {
          version: 1,
          authorizationServerIssuer: previousIssuer,
          requestedScopes: [],
          callbackMode: "shared-v1",
        },
        oauthIssuerReviewRequiredAt: new Date(),
        accessToken: "issuer-bound-access-token",
        refreshToken: "issuer-bound-refresh-token",
        connectedAt: new Date(),
        updatedAt,
      })
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
    await upsertOrgOAuthClient({
      organizationId,
      providerId: connection.id,
      clientId: "issuer-bound-client",
      clientSecret: "issuer-bound-secret",
      createdByOrgMembershipId: memberId,
    })

    const memberResponse = await app.fetch(new Request(
      `http://den-api.local/v1/mcp-connections/${connection.id}/oauth/issuer-review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({
            userId: regularUserId,
            organizationId,
          }),
        },
        body: JSON.stringify({ action: "preview" }),
      },
    ))
    expect(memberResponse.status).toBe(403)

    const previewResponse = await staleSessionRequest(
      `/v1/mcp-connections/${connection.id}/oauth/issuer-review`,
      "POST",
      { action: "preview" },
    )
    expect(previewResponse.status).toBe(200)
    expect(await previewResponse.json()).toEqual({
      currentIssuer: previousIssuer,
      advertisedIssuers: [origin],
      reviewRequired: true,
    })

    const unadvertisedResponse = await staleSessionRequest(
      `/v1/mcp-connections/${connection.id}/oauth/issuer-review`,
      "POST",
      {
        action: "confirm",
        expectedUpdatedAt: updatedAt.toISOString(),
        authorizationServerIssuer: "https://unadvertised.example.test",
      },
    )
    expect(unadvertisedResponse.status).toBe(409)

    const confirmResponse = await staleSessionRequest(
      `/v1/mcp-connections/${connection.id}/oauth/issuer-review`,
      "POST",
      {
        action: "confirm",
        expectedUpdatedAt: updatedAt.toISOString(),
        authorizationServerIssuer: origin,
      },
    )
    expect(confirmResponse.status).toBe(200)
    expect(await confirmResponse.json()).toMatchObject({
      currentIssuer: origin,
      advertisedIssuers: [origin],
      reviewRequired: false,
      issuerChanged: true,
      reconnectionRequired: true,
    })

    const [updatedConnection] = await db
      .select()
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
      .limit(1)
    expect(updatedConnection).toMatchObject({
      accessToken: null,
      refreshToken: null,
      connectedAt: null,
      oauthIssuerReviewRequiredAt: null,
    })
    expect(updatedConnection?.oauthConfiguration?.authorizationServerIssuer).toBe(origin)
    expect(await getOrgOAuthClient(organizationId, connection.id)).toBeNull()
  } finally {
    server.stop(true)
  }
})

test("shared callback rejects missing or tampered state before routing", async () => {
  const missing = await app.fetch(new Request("http://den-api.local/v1/mcp-connections/oauth/callback?code=unused"))
  expect(missing.status).toBe(400)
  expect(await missing.json()).toEqual({ error: "invalid_request", message: "Missing state." })

  const tampered = await app.fetch(new Request("http://den-api.local/v1/mcp-connections/oauth/callback?code=unused&state=tampered"))
  expect(tampered.status).toBe(400)
  expect(await tampered.json()).toEqual({ error: "invalid_request", message: "Invalid or expired state." })
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
  expect(body).toEqual({ error: "invalid_request", message: "Unknown authorization transaction." })
})

test("public OAuth callback validates state and renders a safe provider-denial diagnostic", async () => {
  const issuer = "https://identity.example.test/tenant"
  await db
    .update(schema.ExternalMcpConnectionTable)
    .set({
      oauthConfiguration: {
        version: 1,
        authorizationServerIssuer: issuer,
        requestedScopes: [],
        callbackMode: "shared-v1",
        discovery: {
          authorizationServerUrl: issuer,
          authorizationServerMetadata: {
            issuer,
            authorization_response_iss_parameter_supported: true,
          },
          resourceMetadata: { authorization_servers: [issuer] },
        },
      },
    })
    .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, seededConnectionId()))
  const state = createOAuthStateToken({
    organizationId,
    orgMembershipId: memberId,
    providerId: seededConnectionId(),
    binding: externalMcpIdentityBinding({
      url: "http://127.0.0.1:9/mcp",
      authType: "oauth",
      credentialMode: "per_member",
    }),
    version: 2,
    callbackMode: "shared-v1",
    authorizationServerIssuer: issuer,
    secret: process.env.BETTER_AUTH_SECRET ?? "",
  })
  const callbackUrl = new URL("http://den-api.local/v1/mcp-connections/oauth/callback")
  callbackUrl.searchParams.set("error", "access_denied")
  callbackUrl.searchParams.set("error_description", "tenant=user@example.invalid secret-detail")
  callbackUrl.searchParams.set("session_state", "opaque-provider-session")
  callbackUrl.searchParams.set("iss", issuer)
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

test("shared callback validates a required response issuer before acting on provider errors", async () => {
  const issuer = "https://identity.example.test/tenant"
  const state = createOAuthStateToken({
    organizationId,
    orgMembershipId: memberId,
    providerId: seededConnectionId(),
    binding: externalMcpIdentityBinding({
      url: "http://127.0.0.1:9/mcp",
      authType: "oauth",
      credentialMode: "per_member",
    }),
    version: 2,
    callbackMode: "shared-v1",
    authorizationServerIssuer: issuer,
    secret: process.env.BETTER_AUTH_SECRET ?? "",
  })
  const callbackUrl = new URL("http://den-api.local/v1/mcp-connections/oauth/callback")
  callbackUrl.searchParams.set("error", "access_denied")
  callbackUrl.searchParams.set("error_description", "must-not-be-rendered")
  callbackUrl.searchParams.set("state", state)

  const response = await app.fetch(new Request(callbackUrl))
  expect(response.status).toBe(400)
  const html = await response.text()
  expect(html).toContain("authorization server")
  expect(html).not.toContain("must-not-be-rendered")
  expect(html).not.toContain("did not grant authorization")
})

test("issuer-isolated callback tolerates an unadvertised provider issuer without trusting it", async () => {
  const issuer = "https://api.provider.example"
  await db
    .update(schema.ExternalMcpConnectionTable)
    .set({
      oauthConfiguration: {
        version: 1,
        authorizationServerIssuer: issuer,
        requestedScopes: [],
        callbackMode: "isolated-v1",
        discovery: {
          authorizationServerUrl: issuer,
          authorizationServerMetadata: {
            issuer,
            authorization_response_iss_parameter_supported: false,
            code_challenge_methods_supported: ["S256"],
          },
          resourceMetadata: { authorization_servers: [issuer] },
        },
      },
    })
    .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, seededConnectionId()))
  const state = createOAuthStateToken({
    organizationId,
    orgMembershipId: memberId,
    providerId: seededConnectionId(),
    binding: externalMcpIdentityBinding({
      url: "http://127.0.0.1:9/mcp",
      authType: "oauth",
      credentialMode: "per_member",
    }),
    version: 2,
    callbackMode: "isolated-v1",
    authorizationServerIssuer: issuer,
    secret: process.env.BETTER_AUTH_SECRET ?? "",
  })
  const callbackUrl = new URL(`http://den-api.local/v1/mcp-connections/${seededConnectionId()}/connect/callback`)
  callbackUrl.searchParams.set("error", "access_denied")
  callbackUrl.searchParams.set("iss", "stytch.com/project-live-provider-value")
  callbackUrl.searchParams.set("state", state)

  const response = await app.fetch(new Request(callbackUrl))
  expect(response.status).toBe(400)
  const html = await response.text()
  expect(html).toContain("The provider did not grant authorization")
  expect(html).not.toContain("does not match the issuer")
})

test("version-one state remains temporarily valid only through the legacy callback route", async () => {
  const legacyConnection = await createExternalMcpConnection({
    organizationId,
    name: "In-flight legacy OAuth MCP",
    url: "http://127.0.0.1:9/legacy-mcp",
    authType: "oauth",
    credentialMode: "shared",
    createdByOrgMembershipId: memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  await db
    .update(schema.ExternalMcpConnectionTable)
    .set({
      oauthConfiguration: {
        version: 1,
        authorizationServerIssuer: null,
        requestedScopes: [],
        callbackMode: "legacy-v1",
      },
      pendingCodeVerifier: "version-one-pkce-verifier",
    })
    .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, legacyConnection.id))

  const versionOneState = createOAuthStateToken({
    organizationId,
    orgMembershipId: memberId,
    providerId: legacyConnection.id,
    binding: externalMcpIdentityBinding(legacyConnection),
    secret: process.env.BETTER_AUTH_SECRET ?? "",
  })
  const legacyUrl = new URL(`http://den-api.local/v1/mcp-connections/${legacyConnection.id}/connect/callback`)
  legacyUrl.searchParams.set("error", "access_denied")
  legacyUrl.searchParams.set("state", versionOneState)

  const accepted = await app.fetch(new Request(legacyUrl))
  expect(accepted.status).toBe(400)
  expect(accepted.headers.get("content-type")).toContain("text/html")
  expect(await accepted.text()).toContain("The provider did not grant authorization")
  const [cleaned] = await db
    .select({ pendingCodeVerifier: schema.ExternalMcpConnectionTable.pendingCodeVerifier })
    .from(schema.ExternalMcpConnectionTable)
    .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, legacyConnection.id))
    .limit(1)
  expect(cleaned?.pendingCodeVerifier).toBeNull()

  const sharedUrl = new URL("http://den-api.local/v1/mcp-connections/oauth/callback")
  sharedUrl.searchParams.set("error", "access_denied")
  sharedUrl.searchParams.set("state", versionOneState)
  const wrongRoute = await app.fetch(new Request(sharedUrl))
  expect(wrongRoute.status).toBe(400)
  expect(await wrongRoute.json()).toMatchObject({ error: "invalid_request" })
})

test("version-two legacy callbacks use enterprise issuer validation", async () => {
  const legacyConnection = await createExternalMcpConnection({
    organizationId,
    name: "Legacy engine callback",
    url: "http://127.0.0.1:9/legacy-engine-callback",
    authType: "oauth",
    credentialMode: "shared",
    oauthConfiguration: {
      version: 1,
      authorizationServerIssuer: null,
      requestedScopes: [],
      callbackMode: "legacy-v1",
    },
    createdByOrgMembershipId: memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  await db
    .update(schema.ExternalMcpConnectionTable)
    .set({
      oauthConfiguration: {
        version: 1,
        authorizationServerIssuer: null,
        requestedScopes: [],
        callbackMode: "legacy-v1",
      },
      pendingCodeVerifier: "legacy-engine-pkce-verifier",
    })
    .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, legacyConnection.id))

  const state = createOAuthStateToken({
    organizationId,
    orgMembershipId: memberId,
    providerId: legacyConnection.id,
    binding: externalMcpIdentityBinding(legacyConnection),
    version: 2,
    callbackMode: "legacy-v1",
    secret: process.env.BETTER_AUTH_SECRET ?? "",
  })
  const callbackUrl = new URL(`http://den-api.local/v1/mcp-connections/${legacyConnection.id}/connect/callback`)
  callbackUrl.searchParams.set("error", "access_denied")
  callbackUrl.searchParams.set("state", state)

  const response = await app.fetch(new Request(callbackUrl))
  expect(response.status).toBe(400)
  const html = await response.text()
  expect(html).toContain("OpenWork could not register or identify its OAuth client with the authorization server")
  expect(html).not.toContain("The provider did not grant authorization")
})

test("shared-callback version-two state is rejected by the legacy callback even when its path id matches", async () => {
  const state = createOAuthStateToken({
    organizationId,
    orgMembershipId: memberId,
    providerId: seededConnectionId(),
    binding: externalMcpIdentityBinding({
      url: "http://127.0.0.1:9/mcp",
      authType: "oauth",
      credentialMode: "per_member",
    }),
    version: 2,
    callbackMode: "shared-v1",
    secret: process.env.BETTER_AUTH_SECRET ?? "",
  })
  const callbackUrl = new URL(`http://den-api.local/v1/mcp-connections/${seededConnectionId()}/connect/callback`)
  callbackUrl.searchParams.set("error", "access_denied")
  callbackUrl.searchParams.set("state", state)

  const response = await app.fetch(new Request(callbackUrl))
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: "invalid_request", message: "Invalid or expired state." })
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
  expect(createdBody.oauthCallbackMode).toBe("shared-v1")
  const sharedCallbackUrl = new URL("/v1/mcp-connections/oauth/callback", process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790").toString()
  expect(createdBody.oauthCallbackUrl).toBe(sharedCallbackUrl)
  expect(createdBody.oauthSharedCallbackUrl).toBe(sharedCallbackUrl)
  expect("runtime" in createdBody).toBe(false)
  expect("enterpriseRuntime" in createdBody).toBe(false)

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
