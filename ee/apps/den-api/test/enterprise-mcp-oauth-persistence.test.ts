import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

function seedRequiredEnv(): void {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_pr7"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DEN_ALLOW_PRIVATE_MCP_URLS = "1"
}

let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let DenEnterpriseMcpOAuthPersistence: typeof import("../src/capability-sources/enterprise-mcp-oauth-persistence.js").DenEnterpriseMcpOAuthPersistence
let createExternalMcpConnection: typeof import("../src/capability-sources/external-mcp-connections.js").createExternalMcpConnection

const userId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
let connection: Awaited<ReturnType<typeof createExternalMcpConnection>>

beforeAll(async () => {
  seedRequiredEnv()
  const modules = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/capability-sources/enterprise-mcp-oauth-persistence.js"),
    import("../src/capability-sources/external-mcp-connections.js"),
  ])
  db = modules[0].db
  schema = modules[1]
  drizzle = modules[2]
  DenEnterpriseMcpOAuthPersistence = modules[3].DenEnterpriseMcpOAuthPersistence
  createExternalMcpConnection = modules[4].createExternalMcpConnection

  await db.insert(schema.AuthUserTable).values({
    id: userId,
    name: "Enterprise MCP Persistence User",
    email: `enterprise-mcp-persistence+${userId}@test.local`,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Enterprise MCP Persistence Org",
    slug: `enterprise-mcp-persistence-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values({
    id: memberId,
    organizationId,
    userId,
    role: "admin",
  })
  connection = await createExternalMcpConnection({
    organizationId,
    name: "Enterprise MCP persistence test",
    url: "https://mcp.example.test/mcp",
    authType: "oauth",
    credentialMode: "shared",
    createdByOrgMembershipId: memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
})

afterAll(async () => {
  await db.delete(schema.ConnectedAccountTable).where(drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId))
  await db.delete(schema.OrgOAuthClientTable).where(drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionTable).where(drizzle.eq(schema.ExternalMcpConnectionTable.organizationId, organizationId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, userId))
})

function context(offsetMs = 30_000) {
  return {
    connectionId: connection.id,
    commitExpiresAt: Date.now() + offsetMs,
    signal: new AbortController().signal,
  }
}

describe("Den enterprise MCP OAuth persistence adapter", () => {
  test("stores DCR secrets only in encrypted columns and returns the first registration", async () => {
    const persistence = new DenEnterpriseMcpOAuthPersistence(connection)
    const saved = await persistence.clientRegistrations.save({
      context: context(),
      clientInformation: {
        client_id: "registered-client",
        client_secret: "encrypted-client-secret",
        registration_access_token: "must-not-enter-json",
        token_endpoint_auth_method: "client_secret_post",
      },
      source: "dynamic",
    })
    expect(saved.clientInformation.client_id).toBe("registered-client")
    const rows = await db
      .select()
      .from(schema.OrgOAuthClientTable)
      .where(drizzle.and(
        drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId),
        drizzle.eq(schema.OrgOAuthClientTable.providerId, connection.id),
      ))
      .limit(1)
    expect(rows[0]?.clientSecret).toBe("encrypted-client-secret")
    expect(JSON.stringify(rows[0]?.extra)).not.toContain("encrypted-client-secret")
    expect(JSON.stringify(rows[0]?.extra)).not.toContain("must-not-enter-json")

    const loser = await persistence.clientRegistrations.save({
      context: context(),
      clientInformation: { client_id: "losing-client" },
      source: "dynamic",
    })
    expect(loser.clientInformation.client_id).toBe("registered-client")
  })

  test("isolates concurrent signed PKCE transactions and consumes only the callback winner", async () => {
    const persistence = new DenEnterpriseMcpOAuthPersistence(connection)
    const registration = await persistence.clientRegistrations.load(context())
    if (!registration) throw new Error("Expected the seeded OAuth client registration.")
    await persistence.authorizations.begin({
      context: context(),
      id: "signed-state-a",
      codeVerifier: "a".repeat(43),
      expiresAt: Date.now() + 10 * 60_000,
      clientRegistrationRevision: registration.revision,
    })
    await persistence.authorizations.begin({
      context: context(),
      id: "signed-state-b",
      codeVerifier: "b".repeat(43),
      expiresAt: Date.now() + 10 * 60_000,
      clientRegistrationRevision: registration.revision,
    })
    const first = await persistence.authorizations.load({ context: context(), id: "signed-state-a" })
    const second = await persistence.authorizations.load({ context: context(), id: "signed-state-b" })
    expect(first?.codeVerifier).toBe("a".repeat(43))
    expect(second?.codeVerifier).toBe("b".repeat(43))
    const connectionRows = await db
      .select({ pending: schema.ExternalMcpConnectionTable.pendingCodeVerifier })
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
      .limit(1)
    expect(connectionRows[0]?.pending).not.toContain("signed-state-a")
    expect(connectionRows[0]?.pending).not.toContain("signed-state-b")

    if (!first) throw new Error("Expected the first OAuth authorization transaction.")
    await persistence.credentials.save({
      context: context(),
      tokens: {
        access_token: "callback-access-token",
        refresh_token: "callback-refresh-token",
        token_type: "Bearer",
        expires_in: 3_600,
      },
      expiresAt: Date.now() + 3_600_000,
      source: "authorization-code",
      authorization: first.handle,
      clientRegistrationRevision: registration.revision,
    })
    expect(await persistence.authorizations.load({ context: context(), id: "signed-state-a" })).toBeUndefined()
    expect(await persistence.authorizations.load({ context: context(), id: "signed-state-b" })).toBeDefined()
    expect((await persistence.credentials.load(context()))?.tokens.access_token).toBe("callback-access-token")

    await expect(persistence.credentials.save({
      context: context(),
      tokens: { access_token: "late-replay-token", token_type: "Bearer" },
      source: "authorization-code",
      authorization: first.handle,
      clientRegistrationRevision: registration.revision,
    })).rejects.toThrow("missing, expired, or already consumed")
    expect((await persistence.credentials.load(context()))?.tokens.access_token).toBe("callback-access-token")
  })

  test("rejects persistence after its lifecycle deadline without changing credentials", async () => {
    const persistence = new DenEnterpriseMcpOAuthPersistence(connection)
    const before = await persistence.credentials.load(context())
    await expect(persistence.credentials.save({
      context: context(-1),
      tokens: { access_token: "must-not-commit", token_type: "Bearer" },
      source: "refresh",
    })).rejects.toThrow("deadline expired")
    const after = await persistence.credentials.load(context())
    expect(after?.tokens.access_token).toBe(before?.tokens.access_token)
  })

  test("removes a denied per-member authorization and keeps repeated cleanup idempotent", async () => {
    const perMemberConnection = await createExternalMcpConnection({
      organizationId,
      name: "Enterprise MCP denied callback cleanup",
      url: "https://mcp.example.test/mcp",
      authType: "oauth",
      credentialMode: "per_member",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const adapter = await import("../src/capability-sources/enterprise-mcp-client-adapter.js")
    const persistence = new DenEnterpriseMcpOAuthPersistence(
      perMemberConnection,
      { orgMembershipId: memberId },
    )
    await persistence.authorizations.begin({
      context: {
        connectionId: perMemberConnection.id,
        commitExpiresAt: Date.now() + 30_000,
        signal: new AbortController().signal,
      },
      id: "signed-state-already-absent",
      codeVerifier: "d".repeat(43),
      expiresAt: Date.now() + 600_000,
    })
    await expect(adapter.abandonExternalMcpAuth(
      perMemberConnection,
      "signed-state-already-absent",
      { orgMembershipId: memberId },
      "req_denial_cleanup",
    )).resolves.toBeUndefined()
    expect(await persistence.authorizations.load({
      context: {
        connectionId: perMemberConnection.id,
        commitExpiresAt: Date.now() + 30_000,
        signal: new AbortController().signal,
      },
      id: "signed-state-already-absent",
    })).toBeUndefined()
    await expect(adapter.abandonExternalMcpAuth(
      perMemberConnection,
      "signed-state-already-absent",
      { orgMembershipId: memberId },
      "req_denial_cleanup_repeat",
    )).resolves.toBeUndefined()
  })

  test("completes signed state, PKCE, token commit, and post-callback MCP validation together", async () => {
    let origin = ""
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
          return Response.json({
            resource: `${origin}/mcp`,
            authorization_servers: [origin],
            scopes_supported: ["tools.read"],
          })
        }
        if (url.pathname === "/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
          })
        }
        if (url.pathname === "/register") {
          const metadata: unknown = await request.json()
          const redirectUris = typeof metadata === "object" && metadata !== null && "redirect_uris" in metadata
            && Array.isArray(metadata.redirect_uris)
            && metadata.redirect_uris.every((value) => typeof value === "string")
            ? metadata.redirect_uris
            : []
          return Response.json({
            client_id: "end-to-end-client",
            token_endpoint_auth_method: "none",
            redirect_uris: redirectUris,
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          }, { status: 201 })
        }
        if (url.pathname === "/token") {
          const form = new URLSearchParams(await request.text())
          expect(form.get("grant_type")).toBe("authorization_code")
          expect(form.get("code")).toBe("approved-code")
          expect(form.get("code_verifier")?.length).toBeGreaterThanOrEqual(43)
          return Response.json({
            access_token: "end-to-end-access-token",
            refresh_token: "end-to-end-refresh-token",
            token_type: "Bearer",
            expires_in: 3_600,
          })
        }
        if (url.pathname === "/mcp") {
          if (request.headers.get("authorization") !== "Bearer end-to-end-access-token") {
            return new Response(null, {
              status: 401,
              headers: {
                "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="tools.read"`,
              },
            })
          }
          const rpc: unknown = await request.json()
          if (typeof rpc !== "object" || rpc === null || !("method" in rpc)) {
            return Response.json({ error: "invalid_request" }, { status: 400 })
          }
          if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 })
          const id = "id" in rpc && (typeof rpc.id === "string" || typeof rpc.id === "number") ? rpc.id : null
          return Response.json({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "den-enterprise-e2e", version: "1.0.0" },
            },
          })
        }
        return new Response(null, { status: 404 })
      },
    })
    origin = `http://127.0.0.1:${server.port}`
    try {
      const endToEndConnection = await createExternalMcpConnection({
        organizationId,
        name: "Enterprise MCP OAuth e2e",
        url: `${origin}/mcp`,
        authType: "oauth",
        credentialMode: "shared",
        createdByOrgMembershipId: memberId,
        access: { orgWide: true, memberIds: [], teamIds: [] },
      })
      const adapter = await import("../src/capability-sources/enterprise-mcp-client-adapter.js")
      const redirectUri = "https://den.example.test/v1/mcp-connections/callback"
      const signedState = "signed-den-state-end-to-end"
      const started = await adapter.connectExternalMcp(
        endToEndConnection,
        redirectUri,
        signedState,
        undefined,
        "req_enterprise_e2e_start",
      )
      expect(started.status).toBe("needs_auth")
      if (started.status !== "needs_auth") throw new Error("Expected provider authorization to be required.")
      expect(new URL(started.authorizeUrl).searchParams.get("state")).toBe(signedState)

      const refreshedRows = await db
        .select()
        .from(schema.ExternalMcpConnectionTable)
        .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, endToEndConnection.id))
        .limit(1)
      const refreshed = refreshedRows[0]
      if (!refreshed) throw new Error("Expected the OAuth connection after Connect start.")
      await adapter.completeExternalMcpAuth(
        refreshed,
        "approved-code",
        redirectUri,
        undefined,
        "req_enterprise_e2e_callback",
        signedState,
      )
      const committedRows = await db
        .select()
        .from(schema.ExternalMcpConnectionTable)
        .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, endToEndConnection.id))
        .limit(1)
      expect(committedRows[0]?.accessToken).toBe("end-to-end-access-token")
      expect(committedRows[0]?.refreshToken).toBe("end-to-end-refresh-token")
      expect(committedRows[0]?.pendingCodeVerifier).toBeNull()
    } finally {
      server.stop(true)
    }
  })
})
