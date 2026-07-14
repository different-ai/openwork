import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"

function seedRequiredEnv(): void {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_pr7"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

seedRequiredEnv()

let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let connections: typeof import("../src/capability-sources/external-mcp-connections.js")
let ExternalMcpOAuthProvider: typeof import("../src/capability-sources/external-mcp-client.js").ExternalMcpOAuthProvider
let ExternalMcpDiagnosticTracker: typeof import("../src/capability-sources/external-mcp-diagnostics.js").ExternalMcpDiagnosticTracker

const userId = createDenTypeId("user")
const targetUserId = createDenTypeId("user")
const removedUserId = createDenTypeId("user")
const foreignUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const foreignOrganizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const otherMemberId = createDenTypeId("member")
const targetMemberId = createDenTypeId("member")
const removedMemberId = createDenTypeId("member")
const foreignMemberId = createDenTypeId("member")
const teamId = createDenTypeId("team")
const foreignTeamId = createDenTypeId("team")
let connection: Awaited<ReturnType<typeof connections.createExternalMcpConnection>>

const dcrDiscoveryState: OAuthDiscoveryState = {
  authorizationServerUrl: "https://auth.example.test",
  authorizationServerMetadata: {
    issuer: "https://auth.example.test",
    authorization_endpoint: "https://auth.example.test/authorize",
    token_endpoint: "https://auth.example.test/token",
    registration_endpoint: "https://auth.example.test/register",
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  },
}

const confidentialDcrDiscoveryState: OAuthDiscoveryState = {
  authorizationServerUrl: "https://auth.example.test",
  authorizationServerMetadata: {
    issuer: "https://auth.example.test",
    authorization_endpoint: "https://auth.example.test/authorize",
    token_endpoint: "https://auth.example.test/token",
    registration_endpoint: "https://auth.example.test/register",
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic"],
  },
}

const cimdDiscoveryState: OAuthDiscoveryState = {
  authorizationServerUrl: "https://auth.example.test",
  authorizationServerMetadata: {
    issuer: "https://auth.example.test",
    authorization_endpoint: "https://auth.example.test/authorize",
    token_endpoint: "https://auth.example.test/token",
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
  },
}

beforeAll(async () => {
  const modules = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/capability-sources/external-mcp-connections.js"),
    import("../src/capability-sources/external-mcp-client.js"),
    import("../src/capability-sources/external-mcp-diagnostics.js"),
  ])
  db = modules[0].db
  schema = modules[1]
  drizzle = modules[2]
  connections = modules[3]
  ExternalMcpOAuthProvider = modules[4].ExternalMcpOAuthProvider
  ExternalMcpDiagnosticTracker = modules[5].ExternalMcpDiagnosticTracker

  await db.insert(schema.AuthUserTable).values([
    {
      id: userId,
      name: "External MCP OAuth Concurrency User",
      email: `external-mcp-oauth-concurrency+${userId}@test.local`,
    },
    {
      id: targetUserId,
      name: "External MCP Access Target User",
      email: `external-mcp-access-target+${targetUserId}@test.local`,
    },
    {
      id: removedUserId,
      name: "Removed External MCP Access Target User",
      email: `external-mcp-removed-target+${removedUserId}@test.local`,
    },
    {
      id: foreignUserId,
      name: "Foreign External MCP Access Target User",
      email: `external-mcp-foreign-target+${foreignUserId}@test.local`,
    },
  ])
  await db.insert(schema.OrganizationTable).values([
    {
      id: organizationId,
      name: "External MCP OAuth Concurrency Org",
      slug: `external-mcp-oauth-concurrency-${organizationId}`,
    },
    {
      id: foreignOrganizationId,
      name: "Foreign External MCP Access Org",
      slug: `external-mcp-access-foreign-${foreignOrganizationId}`,
    },
  ])
  await db.insert(schema.MemberTable).values([
    { id: memberId, organizationId, userId, role: "admin" },
    { id: otherMemberId, organizationId, userId: null, role: "member" },
    { id: targetMemberId, organizationId, userId: targetUserId, role: "member" },
    { id: removedMemberId, organizationId, userId: removedUserId, role: "member", removedAt: new Date() },
    { id: foreignMemberId, organizationId: foreignOrganizationId, userId: foreignUserId, role: "member" },
  ])
  await db.insert(schema.TeamTable).values([
    { id: teamId, organizationId, name: "External MCP Access Team" },
    { id: foreignTeamId, organizationId: foreignOrganizationId, name: "Foreign External MCP Access Team" },
  ])
  connection = await connections.createExternalMcpConnection({
    organizationId,
    name: "External MCP OAuth concurrency",
    url: "https://mcp.example.test/mcp",
    authType: "oauth",
    credentialMode: "shared",
    createdByOrgMembershipId: memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
})

beforeEach(async () => {
  await db.delete(schema.ExternalMcpOAuthTransactionTable).where(
    drizzle.eq(schema.ExternalMcpOAuthTransactionTable.externalMcpConnectionId, connection.id),
  )
  await db.delete(schema.OrgOAuthClientTable).where(drizzle.and(
    drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId),
    drizzle.eq(schema.OrgOAuthClientTable.providerId, connection.id),
  ))
  await db
    .update(schema.ExternalMcpConnectionTable)
    .set({
      accessToken: null,
      refreshToken: null,
      tokenType: null,
      scope: null,
      connectedAt: null,
      oauthRegistrationLeaseToken: null,
      oauthRegistrationLeaseStartedAt: null,
      oauthAuthorizationEpoch: 0,
      pendingCodeVerifier: null,
    })
    .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
})

afterAll(async () => {
  await db.delete(schema.ExternalMcpOAuthTransactionTable).where(
    drizzle.eq(schema.ExternalMcpOAuthTransactionTable.organizationId, organizationId),
  )
  await db.delete(schema.ConnectedAccountTable).where(drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId))
  await db.delete(schema.OrgOAuthClientTable).where(drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.PluginMcpRequirementBindingTable).where(drizzle.eq(schema.PluginMcpRequirementBindingTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionTable).where(drizzle.eq(schema.ExternalMcpConnectionTable.organizationId, organizationId))
  await db.delete(schema.TeamMemberTable).where(drizzle.inArray(schema.TeamMemberTable.teamId, [teamId, foreignTeamId]))
  await db.delete(schema.TeamTable).where(drizzle.inArray(schema.TeamTable.id, [teamId, foreignTeamId]))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, foreignOrganizationId))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.inArray(schema.OrganizationTable.id, [organizationId, foreignOrganizationId]))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [userId, targetUserId, removedUserId, foreignUserId]))
})

function provider(input: { state: string; dynamicRegistration?: boolean }) {
  return new ExternalMcpOAuthProvider(
    connection,
    `https://api.openwork.example/v1/mcp-connections/${connection.id}/connect/callback`,
    input.state,
    undefined,
    new ExternalMcpDiagnosticTracker(`req_${input.state}`),
    undefined,
    { orgMembershipId: memberId },
    input.dynamicRegistration ?? false,
  )
}

describe("current Den external MCP OAuth concurrency", () => {
  test("dual-writes one new start for old replicas and exact-state completion clears both copies", async () => {
    const state = "signed-state-expand-dual-write"
    const verifier = "w".repeat(43)
    const started = provider({ state })
    started.state()
    await started.saveCodeVerifier(verifier)

    const connectionRows = await db
      .select({ pendingCodeVerifier: schema.ExternalMcpConnectionTable.pendingCodeVerifier })
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
      .limit(1)
    const transactionRows = await db
      .select({ codeVerifier: schema.ExternalMcpOAuthTransactionTable.codeVerifier })
      .from(schema.ExternalMcpOAuthTransactionTable)
      .where(drizzle.eq(
        schema.ExternalMcpOAuthTransactionTable.stateKey,
        connections.externalMcpOAuthStateKey(state),
      ))
      .limit(1)
    expect(connectionRows[0]?.pendingCodeVerifier).toBe(verifier)
    expect(transactionRows[0]?.codeVerifier).toBe(verifier)

    expect(await provider({ state }).codeVerifier()).toBe(verifier)
    const completedRows = await db
      .select({ pendingCodeVerifier: schema.ExternalMcpConnectionTable.pendingCodeVerifier })
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
      .limit(1)
    expect(completedRows[0]?.pendingCodeVerifier).toBeNull()
    await expect(provider({ state }).codeVerifier()).rejects.toThrow("already consumed")
  })

  test("completes a pre-deploy shared legacy verifier once and rejects replay", async () => {
    const verifier = "l".repeat(43)
    await db
      .update(schema.ExternalMcpConnectionTable)
      .set({ pendingCodeVerifier: verifier })
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))

    expect(await provider({ state: "signed-state-from-old-replica" }).codeVerifier()).toBe(verifier)
    await expect(provider({ state: "signed-state-from-old-replica" }).codeVerifier()).rejects.toThrow("already consumed")
  })

  test("completes a pre-deploy per-member legacy verifier only for that member", async () => {
    const perMemberConnection = await connections.createExternalMcpConnection({
      organizationId,
      name: "External MCP legacy per-member callback",
      url: "https://mcp.example.test/member",
      authType: "oauth",
      credentialMode: "per_member",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const verifier = "m".repeat(43)
    await db.insert(schema.ConnectedAccountTable).values({
      id: createDenTypeId("connectedAccount"),
      organizationId,
      orgMembershipId: memberId,
      providerId: perMemberConnection.id,
      pendingCodeVerifier: verifier,
    })
    const callbackProvider = new ExternalMcpOAuthProvider(
      perMemberConnection,
      `https://api.openwork.example/v1/mcp-connections/${perMemberConnection.id}/connect/callback`,
      "signed-member-state-from-old-replica",
      { orgMembershipId: memberId },
      new ExternalMcpDiagnosticTracker("req_legacy_member"),
      undefined,
      { orgMembershipId: memberId },
    )

    expect(await callbackProvider.codeVerifier()).toBe(verifier)
    await expect(callbackProvider.codeVerifier()).rejects.toThrow("already consumed")
  })

  test("keeps two browser PKCE transactions independent and consumes each state once", async () => {
    const firstStart = provider({ state: "signed-state-first" })
    const secondStart = provider({ state: "signed-state-second" })
    expect(firstStart.state()).toBe("signed-state-first")
    expect(secondStart.state()).toBe("signed-state-second")
    await Promise.all([
      firstStart.saveCodeVerifier("a".repeat(43)),
      secondStart.saveCodeVerifier("b".repeat(43)),
    ])

    // Tabs may return in either order without overwriting one another.
    expect(await provider({ state: "signed-state-second" }).codeVerifier()).toBe("b".repeat(43))
    expect(await provider({ state: "signed-state-first" }).codeVerifier()).toBe("a".repeat(43))
    await expect(provider({ state: "signed-state-first" }).codeVerifier()).rejects.toThrow("already consumed")
    await expect(provider({ state: "signed-state-second" }).codeVerifier()).rejects.toThrow("already consumed")
  })

  test("atomically gives one concurrent callback the verifier and rejects the replay", async () => {
    const started = provider({ state: "signed-state-race" })
    started.state()
    await started.saveCodeVerifier("r".repeat(43))
    const results = await Promise.allSettled([
      provider({ state: "signed-state-race" }).codeVerifier(),
      provider({ state: "signed-state-race" }).codeVerifier(),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  })

  test("caps pending OAuth starts at eight per member and connection", async () => {
    for (let index = 0; index < 8; index += 1) {
      await connections.saveExternalMcpOAuthTransaction({
        authorizationActor: { orgMembershipId: memberId },
        codeVerifier: String(index).repeat(43),
        connectionId: connection.id,
        expectedAuthorizationEpoch: 0,
        organizationId,
        orgMembershipId: memberId,
        signedState: `bounded-pending-state-${index}`,
      })
    }

    await expect(connections.saveExternalMcpOAuthTransaction({
      authorizationActor: { orgMembershipId: memberId },
      codeVerifier: "9".repeat(43),
      connectionId: connection.id,
      expectedAuthorizationEpoch: 0,
      organizationId,
      orgMembershipId: memberId,
      signedState: "bounded-pending-state-overflow",
    })).rejects.toThrow("At most 8 pending OAuth authorizations")

    const rows = await db
      .select({ stateKey: schema.ExternalMcpOAuthTransactionTable.stateKey })
      .from(schema.ExternalMcpOAuthTransactionTable)
      .where(drizzle.and(
        drizzle.eq(schema.ExternalMcpOAuthTransactionTable.organizationId, organizationId),
        drizzle.eq(schema.ExternalMcpOAuthTransactionTable.externalMcpConnectionId, connection.id),
        drizzle.eq(schema.ExternalMcpOAuthTransactionTable.orgMembershipId, memberId),
      ))
    expect(rows).toHaveLength(8)
    expect(rows.some((row) => row.stateKey === connections.externalMcpOAuthStateKey("bounded-pending-state-overflow"))).toBe(false)

    await db.update(schema.MemberTable).set({ role: "admin" }).where(drizzle.eq(schema.MemberTable.id, targetMemberId))
    try {
      await connections.saveExternalMcpOAuthTransaction({
        authorizationActor: { orgMembershipId: targetMemberId },
        codeVerifier: "t".repeat(43),
        connectionId: connection.id,
        expectedAuthorizationEpoch: 0,
        organizationId,
        orgMembershipId: targetMemberId,
        signedState: "bounded-pending-state-second-member",
      })
    } finally {
      await db.update(schema.MemberTable).set({ role: "member" }).where(drizzle.eq(schema.MemberTable.id, targetMemberId))
    }
    const secondMemberRows = await db
      .select({ orgMembershipId: schema.ExternalMcpOAuthTransactionTable.orgMembershipId })
      .from(schema.ExternalMcpOAuthTransactionTable)
      .where(drizzle.and(
        drizzle.eq(schema.ExternalMcpOAuthTransactionTable.organizationId, organizationId),
        drizzle.eq(schema.ExternalMcpOAuthTransactionTable.externalMcpConnectionId, connection.id),
      ))
    expect(secondMemberRows.filter((row) => row.orgMembershipId === memberId)).toHaveLength(8)
    expect(secondMemberRows.filter((row) => row.orgMembershipId === targetMemberId)).toHaveLength(1)
  })

  test("cleans only one bounded batch of expired OAuth transactions per start", async () => {
    const expiredAt = new Date(Date.now() - 60_000)
    await db.insert(schema.ExternalMcpOAuthTransactionTable).values(
      Array.from({ length: 40 }, (_, index) => ({
        stateKey: connections.externalMcpOAuthStateKey(`expired-oauth-state-${index}`),
        organizationId,
        externalMcpConnectionId: connection.id,
        orgMembershipId: memberId,
        connectionAuthorizationEpoch: 0,
        codeVerifier: String(index % 10).repeat(43),
        expiresAt: expiredAt,
      })),
    )

    await connections.saveExternalMcpOAuthTransaction({
      authorizationActor: { orgMembershipId: memberId },
      codeVerifier: "n".repeat(43),
      connectionId: connection.id,
      expectedAuthorizationEpoch: 0,
      organizationId,
      orgMembershipId: memberId,
      signedState: "new-state-after-bounded-cleanup",
    })

    const rows = await db
      .select({ expiresAt: schema.ExternalMcpOAuthTransactionTable.expiresAt })
      .from(schema.ExternalMcpOAuthTransactionTable)
      .where(drizzle.and(
        drizzle.eq(schema.ExternalMcpOAuthTransactionTable.organizationId, organizationId),
        drizzle.eq(schema.ExternalMcpOAuthTransactionTable.externalMcpConnectionId, connection.id),
      ))
    expect(rows.filter((row) => row.expiresAt <= expiredAt)).toHaveLength(8)
    expect(rows).toHaveLength(9)
  })

  test("rejects a shared authorization-code commit after the initiating admin is demoted", async () => {
    const state = "signed-state-shared-demotion"
    const started = provider({ state })
    started.state()
    await started.saveCodeVerifier("s".repeat(43))
    const callback = provider({ state })
    expect(await callback.codeVerifier()).toBe("s".repeat(43))

    await db
      .update(schema.MemberTable)
      .set({ role: "member" })
      .where(drizzle.eq(schema.MemberTable.id, memberId))
    try {
      await expect(callback.saveTokens({
        access_token: "must-not-save-after-demotion",
        token_type: "Bearer",
      })).rejects.toThrow("no longer has authority")
      const rows = await db
        .select({ accessToken: schema.ExternalMcpConnectionTable.accessToken })
        .from(schema.ExternalMcpConnectionTable)
        .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
        .limit(1)
      expect(rows[0]?.accessToken).toBeNull()
    } finally {
      await db
        .update(schema.MemberTable)
        .set({ role: "admin" })
        .where(drizzle.eq(schema.MemberTable.id, memberId))
    }
  })

  test("rejects a per-member authorization-code commit after assignment replacement removes access", async () => {
    const perMemberConnection = await connections.createExternalMcpConnection({
      organizationId,
      name: "External MCP assignment revocation",
      url: "https://mcp.example.test/assignment-revocation",
      authType: "oauth",
      credentialMode: "per_member",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const makeProvider = (state: string) => new ExternalMcpOAuthProvider(
      perMemberConnection,
      `https://api.openwork.example/v1/mcp-connections/${perMemberConnection.id}/connect/callback`,
      state,
      { orgMembershipId: memberId },
      new ExternalMcpDiagnosticTracker(`req_${state}`),
      undefined,
      { orgMembershipId: memberId },
    )
    const state = "signed-state-assignment-revocation"
    const started = makeProvider(state)
    started.state()
    await started.saveCodeVerifier("u".repeat(43))
    const callback = makeProvider(state)
    expect(await callback.codeVerifier()).toBe("u".repeat(43))

    await connections.replaceExternalMcpConnectionAccess({
      access: { orgWide: false, memberIds: [], teamIds: [] },
      connectionId: perMemberConnection.id,
      createdByOrgMembershipId: memberId,
      organizationId,
    })
    await expect(callback.saveTokens({
      access_token: "must-not-save-after-unassignment",
      token_type: "Bearer",
    })).rejects.toThrow("no longer has authority")
    const accounts = await db
      .select({ accessToken: schema.ConnectedAccountTable.accessToken })
      .from(schema.ConnectedAccountTable)
      .where(drizzle.and(
        drizzle.eq(schema.ConnectedAccountTable.providerId, perMemberConnection.id),
        drizzle.eq(schema.ConnectedAccountTable.orgMembershipId, memberId),
      ))
    expect(accounts[0]?.accessToken).toBeNull()
  })

  test("disconnect fences a callback that already consumed PKCE and prevents token resurrection", async () => {
    const state = "signed-state-disconnect-fence"
    const started = provider({ state })
    started.state()
    await started.saveCodeVerifier("x".repeat(43))
    const callback = provider({ state })
    expect(await callback.codeVerifier()).toBe("x".repeat(43))

    expect(await connections.disconnectExternalMcpConnection({
      organizationId,
      connectionId: connection.id,
    })).toBe(true)
    await expect(callback.saveTokens({
      access_token: "must-not-resurrect-after-disconnect",
      token_type: "Bearer",
    })).rejects.toThrow("disconnected")
    const rows = await db
      .select({
        accessToken: schema.ExternalMcpConnectionTable.accessToken,
        authorizationEpoch: schema.ExternalMcpConnectionTable.oauthAuthorizationEpoch,
      })
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
      .limit(1)
    expect(rows[0]).toEqual({ accessToken: null, authorizationEpoch: 1 })
  })

  test("delete wins against a per-member callback without leaving an orphan account", async () => {
    const deletedConnection = await connections.createExternalMcpConnection({
      organizationId,
      name: "External MCP delete fence",
      url: "https://mcp.example.test/delete-fence",
      authType: "oauth",
      credentialMode: "per_member",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const makeProvider = (state: string) => new ExternalMcpOAuthProvider(
      deletedConnection,
      `https://api.openwork.example/v1/mcp-connections/${deletedConnection.id}/connect/callback`,
      state,
      { orgMembershipId: memberId },
      new ExternalMcpDiagnosticTracker(`req_${state}`),
      undefined,
      { orgMembershipId: memberId },
    )
    const state = "signed-state-delete-fence"
    const started = makeProvider(state)
    started.state()
    await started.saveCodeVerifier("z".repeat(43))
    const callback = makeProvider(state)
    expect(await callback.codeVerifier()).toBe("z".repeat(43))
    expect(await connections.deleteExternalMcpConnection({
      organizationId,
      connectionId: deletedConnection.id,
    })).toBe(true)

    await expect(callback.saveTokens({
      access_token: "must-not-create-an-orphan",
      token_type: "Bearer",
    })).rejects.toThrow("no longer exists")
    await callback.invalidateCredentials("tokens")
    const accounts = await db
      .select({ id: schema.ConnectedAccountTable.id })
      .from(schema.ConnectedAccountTable)
      .where(drizzle.eq(schema.ConnectedAccountTable.providerId, deletedConnection.id))
    expect(accounts).toHaveLength(0)
  })

  test("binds a transaction to the initiating member and cleans up only the named state", async () => {
    await connections.saveExternalMcpOAuthTransaction({
      organizationId,
      connectionId: connection.id,
      orgMembershipId: memberId,
      authorizationActor: { orgMembershipId: memberId },
      expectedAuthorizationEpoch: 0,
      signedState: "signed-state-keep",
      codeVerifier: "k".repeat(43),
    })
    await connections.saveExternalMcpOAuthTransaction({
      organizationId,
      connectionId: connection.id,
      orgMembershipId: memberId,
      authorizationActor: { orgMembershipId: memberId },
      expectedAuthorizationEpoch: 0,
      signedState: "signed-state-remove",
      codeVerifier: "d".repeat(43),
    })
    expect(await connections.consumeExternalMcpOAuthTransaction({
      organizationId,
      connectionId: connection.id,
      orgMembershipId: otherMemberId,
      signedState: "signed-state-keep",
    })).toBeNull()
    await provider({ state: "signed-state-remove" }).invalidateCredentials("verifier")
    expect(await connections.consumeExternalMcpOAuthTransaction({
      organizationId,
      connectionId: connection.id,
      orgMembershipId: memberId,
      signedState: "signed-state-remove",
    })).toBeNull()
    expect(await connections.consumeExternalMcpOAuthTransaction({
      organizationId,
      connectionId: connection.id,
      orgMembershipId: memberId,
      signedState: "signed-state-keep",
    })).toEqual({ codeVerifier: "k".repeat(43), authorizationEpoch: 0 })
  })

  test("single-flights DCR and lets the waiting replica reuse the winner", async () => {
    const winner = provider({ state: "signed-state-dcr-winner", dynamicRegistration: true })
    const waiter = provider({ state: "signed-state-dcr-waiter", dynamicRegistration: true })
    await Promise.all([
      winner.saveDiscoveryState(dcrDiscoveryState),
      waiter.saveDiscoveryState(dcrDiscoveryState),
    ])
    expect(await winner.clientInformation()).toBeUndefined()
    const waitingClient = waiter.clientInformation()
    // Give the waiter time to observe the live lease before the winner
    // commits, proving it waits instead of issuing a second registration.
    await new Promise((resolve) => setTimeout(resolve, 20))
    await winner.saveClientInformation({
      client_id: "single-flight-client",
      token_endpoint_auth_method: "none",
    })
    expect(await waitingClient).toMatchObject({
      client_id: "single-flight-client",
      token_endpoint_auth_method: "none",
    })
  })

  test("rejects a DCR secret commit after the initiating shared admin is demoted", async () => {
    const registering = provider({ state: "signed-state-dcr-demotion", dynamicRegistration: true })
    await registering.saveDiscoveryState(confidentialDcrDiscoveryState)
    expect(await registering.clientInformation()).toBeUndefined()

    await db
      .update(schema.MemberTable)
      .set({ role: "member" })
      .where(drizzle.eq(schema.MemberTable.id, memberId))
    try {
      await expect(registering.saveClientInformation({
        client_id: "must-not-save-after-demotion",
        client_secret: "must-not-save-secret-after-demotion",
        token_endpoint_auth_method: "client_secret_basic",
      })).rejects.toThrow("no longer has authority")
      const clients = await db
        .select({ id: schema.OrgOAuthClientTable.id })
        .from(schema.OrgOAuthClientTable)
        .where(drizzle.eq(schema.OrgOAuthClientTable.providerId, connection.id))
      expect(clients).toHaveLength(0)
    } finally {
      await db
        .update(schema.MemberTable)
        .set({ role: "admin" })
        .where(drizzle.eq(schema.MemberTable.id, memberId))
      await registering.releaseOAuthRegistrationLease()
    }
  })

  test("rejects a CIMD client commit after the initiating member loses assignment", async () => {
    const perMemberConnection = await connections.createExternalMcpConnection({
      organizationId,
      name: "External MCP CIMD assignment fence",
      url: "https://mcp.example.test/cimd-assignment-fence",
      authType: "oauth",
      credentialMode: "per_member",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const registering = new ExternalMcpOAuthProvider(
      perMemberConnection,
      `https://api.openwork.example/v1/mcp-connections/${perMemberConnection.id}/connect/callback`,
      "signed-state-cimd-assignment",
      { orgMembershipId: memberId },
      new ExternalMcpDiagnosticTracker("req_cimd_assignment"),
      undefined,
      { orgMembershipId: memberId },
    )
    await registering.saveDiscoveryState(cimdDiscoveryState)
    const clientId = registering.clientMetadataUrl
    expect(clientId).toBeDefined()
    await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(
      drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, perMemberConnection.id),
    )

    await expect(registering.saveClientInformation({
      client_id: clientId!,
      token_endpoint_auth_method: "none",
    })).rejects.toThrow("no longer has authority")
    const clients = await db
      .select({ id: schema.OrgOAuthClientTable.id })
      .from(schema.OrgOAuthClientTable)
      .where(drizzle.eq(schema.OrgOAuthClientTable.providerId, perMemberConnection.id))
    expect(clients).toHaveLength(0)
  })

  test("does not recreate a CIMD client after its connection is deleted", async () => {
    const deletedConnection = await connections.createExternalMcpConnection({
      organizationId,
      name: "External MCP deleted during CIMD",
      url: "https://mcp.example.test/cimd-delete",
      authType: "oauth",
      credentialMode: "shared",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const cimdProvider = new ExternalMcpOAuthProvider(
      deletedConnection,
      `https://api.openwork.example/v1/mcp-connections/${deletedConnection.id}/connect/callback`,
      "signed-state-cimd-delete",
      undefined,
      new ExternalMcpDiagnosticTracker("req_cimd_delete"),
      undefined,
      { orgMembershipId: memberId },
    )
    await cimdProvider.saveDiscoveryState(cimdDiscoveryState)
    const clientId = cimdProvider.clientMetadataUrl
    expect(clientId).toBeDefined()
    expect(await connections.deleteExternalMcpConnection({
      organizationId,
      connectionId: deletedConnection.id,
    })).toBe(true)

    await expect(cimdProvider.saveClientInformation({
      client_id: clientId!,
      token_endpoint_auth_method: "none",
    })).rejects.toThrow("no longer exists")
    const orphanedClients = await db
      .select({ id: schema.OrgOAuthClientTable.id })
      .from(schema.OrgOAuthClientTable)
      .where(drizzle.and(
        drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId),
        drizzle.eq(schema.OrgOAuthClientTable.providerId, deletedConnection.id),
      ))
    expect(orphanedClients).toHaveLength(0)
  })

  test("does not let late CIMD persistence overwrite a concurrently configured client", async () => {
    const cimdProvider = provider({ state: "signed-state-cimd-rotation" })
    await cimdProvider.saveDiscoveryState(cimdDiscoveryState)
    const clientId = cimdProvider.clientMetadataUrl
    expect(clientId).toBeDefined()
    await db.insert(schema.OrgOAuthClientTable).values({
      id: createDenTypeId("orgOAuthClient"),
      organizationId,
      providerId: connection.id,
      clientId: "administrator-rotated-client",
      clientSecret: "administrator-rotated-secret",
      extra: { registrationProvenance: "pre_registered", marker: "keep-me" },
      createdByOrgMembershipId: memberId,
    })

    await expect(cimdProvider.saveClientInformation({
      client_id: clientId!,
      token_endpoint_auth_method: "none",
    })).rejects.toThrow("configured while Client ID Metadata persistence was in progress")
    const clients = await db
      .select({
        clientId: schema.OrgOAuthClientTable.clientId,
        clientSecret: schema.OrgOAuthClientTable.clientSecret,
        extra: schema.OrgOAuthClientTable.extra,
      })
      .from(schema.OrgOAuthClientTable)
      .where(drizzle.and(
        drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId),
        drizzle.eq(schema.OrgOAuthClientTable.providerId, connection.id),
      ))
    expect(clients).toEqual([{
      clientId: "administrator-rotated-client",
      clientSecret: "administrator-rotated-secret",
      extra: { registrationProvenance: "pre_registered", marker: "keep-me" },
    }])
  })

  test("rejects a stale provenance backfill and reloads the administrator's rotated client", async () => {
    const clientId = createDenTypeId("orgOAuthClient")
    await db.insert(schema.OrgOAuthClientTable).values({
      id: clientId,
      organizationId,
      providerId: connection.id,
      clientId: "legacy-client",
      clientSecret: "legacy-secret",
      extra: null,
      createdByOrgMembershipId: memberId,
    })
    const legacyRows = await db
      .select()
      .from(schema.OrgOAuthClientTable)
      .where(drizzle.eq(schema.OrgOAuthClientTable.id, clientId))
      .limit(1)
    const legacy = legacyRows[0]!
    await db
      .update(schema.OrgOAuthClientTable)
      .set({
        clientId: "administrator-rotated-client",
        clientSecret: "administrator-rotated-secret",
        extra: { marker: "rotated" },
      })
      .where(drizzle.eq(schema.OrgOAuthClientTable.id, clientId))

    const staleBackfill = await connections.compareAndSetExternalMcpOAuthClient({
      organizationId,
      connectionId: connection.id,
      expectedAuthorizationEpoch: connection.oauthAuthorizationEpoch,
      expected: connections.externalMcpOAuthClientRevision(legacy),
      next: {
        ...connections.externalMcpOAuthClientValue(legacy),
        extra: {
          clientInformation: {
            client_id: legacy.clientId,
            token_endpoint_auth_method: "client_secret_basic",
          },
          registrationProvenance: "pre_registered",
        },
      },
    })
    expect(staleBackfill).toEqual({ status: "client_changed" })

    const currentProvider = provider({ state: "signed-state-client-backfill" })
    await currentProvider.saveDiscoveryState(confidentialDcrDiscoveryState)
    expect(await currentProvider.clientInformation()).toMatchObject({
      client_id: "administrator-rotated-client",
      client_secret: "administrator-rotated-secret",
      token_endpoint_auth_method: "client_secret_basic",
    })
    const currentRows = await db
      .select({
        clientId: schema.OrgOAuthClientTable.clientId,
        clientSecret: schema.OrgOAuthClientTable.clientSecret,
        extra: schema.OrgOAuthClientTable.extra,
      })
      .from(schema.OrgOAuthClientTable)
      .where(drizzle.eq(schema.OrgOAuthClientTable.id, clientId))
      .limit(1)
    expect(currentRows[0]).toMatchObject({
      clientId: "administrator-rotated-client",
      clientSecret: "administrator-rotated-secret",
      extra: {
        registrationProvenance: "pre_registered",
        clientInformation: {
          client_id: "administrator-rotated-client",
          token_endpoint_auth_method: "client_secret_basic",
        },
      },
    })
  })

  test("returns a post-write revision so rollback cannot clobber a later administrator rotation", async () => {
    const sagaWrite = await connections.compareAndSetExternalMcpOAuthClient({
      organizationId,
      connectionId: connection.id,
      expectedAuthorizationEpoch: connection.oauthAuthorizationEpoch,
      expected: null,
      next: {
        clientId: "github-import-client",
        clientSecret: "github-import-secret",
        extra: { source: "github-import" },
        createdByOrgMembershipId: memberId,
      },
    })
    expect(sagaWrite.status).toBe("applied")
    if (sagaWrite.status !== "applied" || !sagaWrite.revision) {
      throw new Error("Expected the saga client write to return its committed revision.")
    }

    await db
      .update(schema.OrgOAuthClientTable)
      .set({
        clientId: "administrator-rotated-client",
        clientSecret: "administrator-rotated-secret",
        extra: { source: "admin" },
      })
      .where(drizzle.eq(schema.OrgOAuthClientTable.id, sagaWrite.revision.id))
    expect(await connections.compareAndSetExternalMcpOAuthClient({
      organizationId,
      connectionId: connection.id,
      expectedAuthorizationEpoch: connection.oauthAuthorizationEpoch,
      expected: sagaWrite.revision,
      next: null,
    })).toEqual({ status: "client_changed" })

    const clients = await db
      .select({
        clientId: schema.OrgOAuthClientTable.clientId,
        clientSecret: schema.OrgOAuthClientTable.clientSecret,
        extra: schema.OrgOAuthClientTable.extra,
      })
      .from(schema.OrgOAuthClientTable)
      .where(drizzle.and(
        drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId),
        drizzle.eq(schema.OrgOAuthClientTable.providerId, connection.id),
      ))
    expect(clients).toEqual([{
      clientId: "administrator-rotated-client",
      clientSecret: "administrator-rotated-secret",
      extra: { source: "admin" },
    }])
  })

  test("invalid_client cleanup removes the exact auto-managed DCR revision", async () => {
    await db.insert(schema.OrgOAuthClientTable).values({
      id: createDenTypeId("orgOAuthClient"),
      organizationId,
      providerId: connection.id,
      clientId: "invalid-dcr-client",
      clientSecret: "invalid-dcr-secret",
      extra: {
        registrationProvenance: "dcr",
        clientInformation: {
          client_id: "invalid-dcr-client",
          client_secret: "invalid-dcr-secret",
          token_endpoint_auth_method: "client_secret_basic",
        },
      },
      createdByOrgMembershipId: memberId,
    })

    const failedProvider = provider({ state: "signed-state-invalid-dcr-cleanup" })
    await failedProvider.saveDiscoveryState(confidentialDcrDiscoveryState)
    expect((await failedProvider.clientInformation())?.client_id).toBe("invalid-dcr-client")
    await failedProvider.invalidateCredentials("client")
    const clients = await db
      .select({ id: schema.OrgOAuthClientTable.id })
      .from(schema.OrgOAuthClientTable)
      .where(drizzle.and(
        drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId),
        drizzle.eq(schema.OrgOAuthClientTable.providerId, connection.id),
      ))
    expect(clients).toHaveLength(0)
  })

  test("a delayed invalid_client response cannot delete an administrator-rotated client", async () => {
    const clientRowId = createDenTypeId("orgOAuthClient")
    await db.insert(schema.OrgOAuthClientTable).values({
      id: clientRowId,
      organizationId,
      providerId: connection.id,
      clientId: "failed-client-t1",
      clientSecret: "failed-secret-t1",
      extra: {
        registrationProvenance: "dcr",
        clientInformation: {
          client_id: "failed-client-t1",
          token_endpoint_auth_method: "client_secret_basic",
        },
      },
      createdByOrgMembershipId: memberId,
    })
    const delayed = provider({ state: "signed-state-delayed-invalid-client" })
    await delayed.saveDiscoveryState(confidentialDcrDiscoveryState)
    expect((await delayed.clientInformation())?.client_id).toBe("failed-client-t1")

    await db
      .update(schema.OrgOAuthClientTable)
      .set({
        clientId: "rotated-client-t2",
        clientSecret: "rotated-secret-t2",
        extra: { registrationProvenance: "pre_registered", marker: "administrator-rotation" },
      })
      .where(drizzle.eq(schema.OrgOAuthClientTable.id, clientRowId))
    await delayed.invalidateCredentials("client")

    const clients = await db
      .select({
        clientId: schema.OrgOAuthClientTable.clientId,
        clientSecret: schema.OrgOAuthClientTable.clientSecret,
      })
      .from(schema.OrgOAuthClientTable)
      .where(drizzle.eq(schema.OrgOAuthClientTable.id, clientRowId))
    expect(clients).toEqual([{
      clientId: "rotated-client-t2",
      clientSecret: "rotated-secret-t2",
    }])
  })

  test("a delayed T1 rejection cannot clear the newer shared T2 token revision", async () => {
    await db
      .update(schema.ExternalMcpConnectionTable)
      .set({
        accessToken: "shared-access-t1",
        refreshToken: "shared-refresh-t1",
        tokenType: "Bearer",
        scope: "tools.read",
        connectedAt: new Date(),
      })
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
    const delayed = provider({ state: "signed-state-delayed-token-rejection" })
    expect((await delayed.tokens())?.access_token).toBe("shared-access-t1")

    await db
      .update(schema.ExternalMcpConnectionTable)
      .set({
        accessToken: "shared-access-t2",
        refreshToken: "shared-refresh-t2",
        tokenType: "Bearer",
        scope: "tools.read tools.write",
        connectedAt: new Date(),
      })
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
    await delayed.invalidateCredentials("tokens")

    const rows = await db
      .select({
        accessToken: schema.ExternalMcpConnectionTable.accessToken,
        refreshToken: schema.ExternalMcpConnectionTable.refreshToken,
      })
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
      .limit(1)
    expect(rows[0]).toEqual({
      accessToken: "shared-access-t2",
      refreshToken: "shared-refresh-t2",
    })
  })

  test("conditionally deletes only an unused import-created connection shell", async () => {
    const unusedConnection = await connections.createExternalMcpConnection({
      organizationId,
      name: "Unused imported API-key MCP",
      url: "https://mcp.example.test/unused-import-shell",
      authType: "apikey",
      credentialMode: "shared",
      apiKey: "import-provided-api-key",
      createdByOrgMembershipId: memberId,
      access: { orgWide: false, memberIds: [], teamIds: [] },
    })

    expect(await connections.deleteExternalMcpConnectionIfUnused({
      organizationId,
      connectionId: unusedConnection.id,
    })).toBe("deleted")
    expect(await connections.deleteExternalMcpConnectionIfUnused({
      organizationId,
      connectionId: unusedConnection.id,
    })).toBe("missing")
  })

  test("atomically reclaims only the exact saga-owned OAuth client with its unused connection", async () => {
    const importedConnection = await connections.createExternalMcpConnection({
      organizationId,
      name: "OAuth import shell",
      url: "https://mcp.example.test/oauth-import-shell",
      authType: "oauth",
      credentialMode: "shared",
      createdByOrgMembershipId: memberId,
      access: { orgWide: false, memberIds: [], teamIds: [] },
    })
    const sagaClient = await connections.compareAndSetExternalMcpOAuthClient({
      organizationId,
      connectionId: importedConnection.id,
      expectedAuthorizationEpoch: importedConnection.oauthAuthorizationEpoch,
      expectedConnection: importedConnection,
      expected: null,
      next: {
        clientId: "saga-owned-client",
        clientSecret: "saga-owned-secret",
        extra: { registrationProvenance: "pre_registered" },
        createdByOrgMembershipId: memberId,
      },
      requireNoDependentState: true,
    })
    expect(sagaClient.status).toBe("applied")
    if (sagaClient.status !== "applied" || !sagaClient.revision) throw new Error("Expected a committed saga client revision.")

    expect(await connections.deleteExternalMcpConnectionIfUnused({
      organizationId,
      connectionId: importedConnection.id,
      expectedConnection: importedConnection,
      expectedOwnedOAuthClient: sagaClient.revision,
    })).toBe("deleted")
    expect(await db.select().from(schema.OrgOAuthClientTable).where(
      drizzle.eq(schema.OrgOAuthClientTable.providerId, importedConnection.id),
    )).toEqual([])
  })

  test("does not install a saga OAuth client after its connection is changed or adopted", async () => {
    for (const concurrentAction of ["rename", "binding"] as const) {
      const importedConnection = await connections.createExternalMcpConnection({
        organizationId,
        name: `OAuth client install ${concurrentAction}`,
        url: `https://mcp.example.test/oauth-client-install-${concurrentAction}`,
        authType: "oauth",
        credentialMode: "shared",
        createdByOrgMembershipId: memberId,
        access: { orgWide: false, memberIds: [], teamIds: [] },
      })
      if (concurrentAction === "rename") {
        await db.update(schema.ExternalMcpConnectionTable).set({
          name: "Administrator adopted connection",
        }).where(drizzle.eq(schema.ExternalMcpConnectionTable.id, importedConnection.id))
      } else {
        await db.insert(schema.PluginMcpRequirementBindingTable).values({
          id: createDenTypeId("pluginMcpRequirementBinding"),
          organizationId,
          pluginId: createDenTypeId("plugin"),
          configObjectId: createDenTypeId("configObject"),
          serverName: `adopted-${importedConnection.id}`,
          externalMcpConnectionId: importedConnection.id,
          createdByOrgMembershipId: memberId,
        })
      }
      expect(await connections.compareAndSetExternalMcpOAuthClient({
        organizationId,
        connectionId: importedConnection.id,
        expectedAuthorizationEpoch: importedConnection.oauthAuthorizationEpoch,
        expectedConnection: importedConnection,
        expected: null,
        next: {
          clientId: "must-not-persist",
          clientSecret: "must-not-persist",
          extra: { registrationProvenance: "pre_registered" },
          createdByOrgMembershipId: memberId,
        },
        requireNoDependentState: true,
      }), concurrentAction).toEqual({ status: "connection_changed" })
      expect(await db.select({ id: schema.OrgOAuthClientTable.id })
        .from(schema.OrgOAuthClientTable)
        .where(drizzle.eq(schema.OrgOAuthClientTable.providerId, importedConnection.id)))
        .toEqual([])
      await connections.deleteExternalMcpConnection({ organizationId, connectionId: importedConnection.id })
    }
  })

  test("preserves a saga client when another actor changes, rotates, or starts OAuth before rollback", async () => {
    for (const concurrentAction of ["rename", "rotate", "start"] as const) {
      const importedConnection = await connections.createExternalMcpConnection({
        organizationId,
        name: `OAuth import ${concurrentAction}`,
        url: `https://mcp.example.test/oauth-import-${concurrentAction}`,
        authType: "oauth",
        credentialMode: "shared",
        createdByOrgMembershipId: memberId,
        access: { orgWide: false, memberIds: [], teamIds: [] },
      })
      const sagaClient = await connections.compareAndSetExternalMcpOAuthClient({
        organizationId,
        connectionId: importedConnection.id,
        expectedAuthorizationEpoch: importedConnection.oauthAuthorizationEpoch,
        expected: null,
        next: {
          clientId: "saga-owned-client",
          clientSecret: "saga-owned-secret",
          extra: { registrationProvenance: "pre_registered" },
          createdByOrgMembershipId: memberId,
        },
      })
      expect(sagaClient.status).toBe("applied")
      if (sagaClient.status !== "applied" || !sagaClient.revision) throw new Error("Expected a committed saga client revision.")

      if (concurrentAction === "rename") {
        await db.update(schema.ExternalMcpConnectionTable).set({
          name: "Administrator adopted connection",
        }).where(drizzle.eq(schema.ExternalMcpConnectionTable.id, importedConnection.id))
      } else if (concurrentAction === "rotate") {
        await db.update(schema.OrgOAuthClientTable).set({
          clientId: "administrator-rotated-client",
          clientSecret: "administrator-rotated-secret",
        }).where(drizzle.eq(schema.OrgOAuthClientTable.id, sagaClient.revision.id))
      } else {
        await db.insert(schema.ExternalMcpOAuthTransactionTable).values({
          stateKey: connections.externalMcpOAuthStateKey(`concurrent-${importedConnection.id}`),
          organizationId,
          externalMcpConnectionId: importedConnection.id,
          orgMembershipId: memberId,
          connectionAuthorizationEpoch: importedConnection.oauthAuthorizationEpoch,
          codeVerifier: "v".repeat(43),
          expiresAt: new Date(Date.now() + 60_000),
        })
      }

      expect(await connections.deleteExternalMcpConnectionIfUnused({
        organizationId,
        connectionId: importedConnection.id,
        expectedConnection: importedConnection,
        expectedOwnedOAuthClient: sagaClient.revision,
      }), concurrentAction).toBe("in_use")
      expect(await db.select({ id: schema.ExternalMcpConnectionTable.id })
        .from(schema.ExternalMcpConnectionTable)
        .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, importedConnection.id)))
        .toHaveLength(1)
      expect(await connections.deleteExternalMcpConnection({
        organizationId,
        connectionId: importedConnection.id,
      })).toBe(true)
    }
  })

  test("conditional import cleanup preserves every connection lifecycle or ownership signal", async () => {
    type ConnectionId = typeof connection.id
    const blockers: Array<{
      name: string
      install: (connectionId: ConnectionId) => Promise<unknown>
    }> = [
      {
        name: "connected readiness",
        install: (connectionId) => db
          .update(schema.ExternalMcpConnectionTable)
          .set({ connectedAt: new Date() })
          .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connectionId)),
      },
      {
        name: "plugin binding",
        install: (connectionId) => db.insert(schema.PluginMcpRequirementBindingTable).values({
          id: createDenTypeId("pluginMcpRequirementBinding"),
          organizationId,
          pluginId: createDenTypeId("plugin"),
          configObjectId: createDenTypeId("configObject"),
          serverName: `server-${connectionId}`,
          externalMcpConnectionId: connectionId,
          createdByOrgMembershipId: memberId,
        }),
      },
      {
        name: "access grant",
        install: (connectionId) => db.insert(schema.ExternalMcpConnectionAccessGrantTable).values({
          id: createDenTypeId("externalMcpConnectionAccessGrant"),
          organizationId,
          externalMcpConnectionId: connectionId,
          sourceKey: `test-${connectionId}`,
          orgWide: true,
          createdByOrgMembershipId: memberId,
        }),
      },
      {
        name: "connected account",
        install: (connectionId) => db.insert(schema.ConnectedAccountTable).values({
          id: createDenTypeId("connectedAccount"),
          organizationId,
          orgMembershipId: memberId,
          providerId: connectionId,
        }),
      },
      {
        name: "OAuth transaction",
        install: (connectionId) => db.insert(schema.ExternalMcpOAuthTransactionTable).values({
          stateKey: connections.externalMcpOAuthStateKey(`cleanup-${connectionId}`),
          organizationId,
          externalMcpConnectionId: connectionId,
          orgMembershipId: memberId,
          connectionAuthorizationEpoch: 0,
          codeVerifier: "v".repeat(43),
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      {
        name: "DCR lease",
        install: (connectionId) => db
          .update(schema.ExternalMcpConnectionTable)
          .set({
            oauthRegistrationLeaseToken: `lease-${connectionId}`.slice(0, 64),
            oauthRegistrationLeaseStartedAt: new Date(),
          })
          .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connectionId)),
      },
      {
        name: "shared token",
        install: (connectionId) => db
          .update(schema.ExternalMcpConnectionTable)
          .set({ accessToken: "concurrently-authorized-token", tokenType: "Bearer" })
          .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connectionId)),
      },
      {
        name: "legacy PKCE transaction",
        install: (connectionId) => db
          .update(schema.ExternalMcpConnectionTable)
          .set({ pendingCodeVerifier: "p".repeat(43) })
          .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connectionId)),
      },
      {
        name: "OAuth client",
        install: (connectionId) => db.insert(schema.OrgOAuthClientTable).values({
          id: createDenTypeId("orgOAuthClient"),
          organizationId,
          providerId: connectionId,
          clientId: "concurrently-configured-client",
          clientSecret: "concurrently-configured-secret",
          createdByOrgMembershipId: memberId,
        }),
      },
    ]

    for (const blocker of blockers) {
      const protectedConnection = await connections.createExternalMcpConnection({
        organizationId,
        name: `Protected by ${blocker.name}`,
        url: `https://mcp.example.test/cleanup-${encodeURIComponent(blocker.name)}`,
        authType: "oauth",
        credentialMode: "shared",
        createdByOrgMembershipId: memberId,
        access: { orgWide: false, memberIds: [], teamIds: [] },
      })
      await blocker.install(protectedConnection.id)
      expect(await connections.deleteExternalMcpConnectionIfUnused({
        organizationId,
        connectionId: protectedConnection.id,
      }), blocker.name).toBe("in_use")
      expect(await connections.deleteExternalMcpConnection({
        organizationId,
        connectionId: protectedConnection.id,
      }), blocker.name).toBe(true)
    }
  })

  test("binding materialization refuses a connection deleted before commit", async () => {
    const bindings = await import("../src/mcp/plugin-mcp-requirement-bindings.js")
    const deletedConnectionId = createDenTypeId("externalMcpConnection")
    await expect(bindings.upsertPluginMcpRequirementBinding({
      configObjectId: createDenTypeId("configObject"),
      createdByOrgMembershipId: memberId,
      externalMcpConnectionId: deletedConnectionId,
      organizationId,
      pluginId: createDenTypeId("plugin"),
      serverName: "deleted-before-binding",
    })).rejects.toBeInstanceOf(bindings.PluginMcpRequirementConnectionMissingError)

    const orphaned = await db
      .select({ id: schema.PluginMcpRequirementBindingTable.id })
      .from(schema.PluginMcpRequirementBindingTable)
      .where(drizzle.eq(
        schema.PluginMcpRequirementBindingTable.externalMcpConnectionId,
        deletedConnectionId,
      ))
    expect(orphaned).toEqual([])
  })

  test("direct access replacement rejects inactive and cross-organization targets before changing grants", async () => {
    const assignedConnection = await connections.createExternalMcpConnection({
      organizationId,
      name: "Validated direct access replacement",
      url: "https://mcp.example.test/validated-direct-access",
      authType: "none",
      credentialMode: "shared",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })

    try {
      await expect(connections.replaceExternalMcpConnectionAccess({
        organizationId,
        connectionId: assignedConnection.id,
        access: {
          orgWide: false,
          memberIds: [otherMemberId, removedMemberId, foreignMemberId],
          teamIds: [foreignTeamId],
        },
        createdByOrgMembershipId: memberId,
      })).rejects.toBeInstanceOf(connections.ExternalMcpAccessTargetInvalidError)

      const grants = await connections.listExternalMcpConnectionAccess(assignedConnection.id)
      expect(grants).toHaveLength(1)
      expect(grants[0]).toMatchObject({
        orgWide: true,
        orgMembershipId: null,
        pluginMcpRequirementBindingId: null,
        teamId: null,
      })
    } finally {
      await connections.deleteExternalMcpConnection({
        organizationId,
        connectionId: assignedConnection.id,
      })
    }
  })

  test("concurrent direct access replacements publish one complete assignment set", async () => {
    const assignedConnection = await connections.createExternalMcpConnection({
      organizationId,
      name: "Concurrent direct access replacement",
      url: "https://mcp.example.test/concurrent-direct-access",
      authType: "none",
      credentialMode: "shared",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })

    try {
      await Promise.all([
        connections.replaceExternalMcpConnectionAccess({
          organizationId,
          connectionId: assignedConnection.id,
          access: { orgWide: false, memberIds: [targetMemberId], teamIds: [] },
          createdByOrgMembershipId: memberId,
        }),
        connections.replaceExternalMcpConnectionAccess({
          organizationId,
          connectionId: assignedConnection.id,
          access: { orgWide: false, memberIds: [], teamIds: [teamId] },
          createdByOrgMembershipId: memberId,
        }),
      ])

      const grants = await connections.listExternalMcpConnectionAccess(assignedConnection.id)
      expect(grants).toHaveLength(1)
      expect([
        { orgMembershipId: targetMemberId, teamId: null },
        { orgMembershipId: null, teamId },
      ]).toContainEqual({
        orgMembershipId: grants[0]?.orgMembershipId ?? null,
        teamId: grants[0]?.teamId ?? null,
      })
    } finally {
      await connections.deleteExternalMcpConnection({
        organizationId,
        connectionId: assignedConnection.id,
      })
    }
  })

  test("plugin-sourced access replacement validates targets without erasing the previous assignment", async () => {
    const assignedConnection = await connections.createExternalMcpConnection({
      organizationId,
      name: "Validated plugin-sourced access replacement",
      url: "https://mcp.example.test/validated-plugin-access",
      authType: "none",
      credentialMode: "shared",
      createdByOrgMembershipId: memberId,
      access: { orgWide: false, memberIds: [], teamIds: [] },
    })
    const bindingId = createDenTypeId("pluginMcpRequirementBinding")
    await db.insert(schema.PluginMcpRequirementBindingTable).values({
      id: bindingId,
      organizationId,
      pluginId: createDenTypeId("plugin"),
      configObjectId: createDenTypeId("configObject"),
      serverName: "validated-plugin-access",
      externalMcpConnectionId: assignedConnection.id,
      createdByOrgMembershipId: memberId,
    })

    try {
      await connections.replaceExternalMcpConnectionAccessForPluginBinding({
        organizationId,
        connectionId: assignedConnection.id,
        bindingId,
        access: { orgWide: true, memberIds: [], teamIds: [] },
        createdByOrgMembershipId: memberId,
      })
      await expect(connections.replaceExternalMcpConnectionAccessForPluginBinding({
        organizationId,
        connectionId: assignedConnection.id,
        bindingId,
        access: { orgWide: false, memberIds: [removedMemberId], teamIds: [foreignTeamId] },
        createdByOrgMembershipId: memberId,
      })).rejects.toBeInstanceOf(connections.ExternalMcpAccessTargetInvalidError)

      const grants = (await connections.listExternalMcpConnectionAccess(assignedConnection.id))
        .filter((grant) => grant.pluginMcpRequirementBindingId === bindingId)
      expect(grants).toHaveLength(1)
      expect(grants[0]).toMatchObject({ orgWide: true, orgMembershipId: null, teamId: null })
    } finally {
      await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(
        drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId, bindingId),
      )
      await db.delete(schema.PluginMcpRequirementBindingTable).where(
        drizzle.eq(schema.PluginMcpRequirementBindingTable.id, bindingId),
      )
      await connections.deleteExternalMcpConnection({
        organizationId,
        connectionId: assignedConnection.id,
      })
    }
  })

  test("concurrent plugin-sourced replacements publish one complete assignment set", async () => {
    const assignedConnection = await connections.createExternalMcpConnection({
      organizationId,
      name: "Concurrent plugin-sourced access replacement",
      url: "https://mcp.example.test/concurrent-plugin-access",
      authType: "none",
      credentialMode: "shared",
      createdByOrgMembershipId: memberId,
      access: { orgWide: false, memberIds: [], teamIds: [] },
    })
    const bindingId = createDenTypeId("pluginMcpRequirementBinding")
    await db.insert(schema.PluginMcpRequirementBindingTable).values({
      id: bindingId,
      organizationId,
      pluginId: createDenTypeId("plugin"),
      configObjectId: createDenTypeId("configObject"),
      serverName: "concurrent-plugin-access",
      externalMcpConnectionId: assignedConnection.id,
      createdByOrgMembershipId: memberId,
    })

    try {
      await Promise.all([
        connections.replaceExternalMcpConnectionAccessForPluginBinding({
          organizationId,
          connectionId: assignedConnection.id,
          bindingId,
          access: { orgWide: false, memberIds: [targetMemberId], teamIds: [] },
          createdByOrgMembershipId: memberId,
        }),
        connections.replaceExternalMcpConnectionAccessForPluginBinding({
          organizationId,
          connectionId: assignedConnection.id,
          bindingId,
          access: { orgWide: false, memberIds: [], teamIds: [teamId] },
          createdByOrgMembershipId: memberId,
        }),
      ])

      const grants = (await connections.listExternalMcpConnectionAccess(assignedConnection.id))
        .filter((grant) => grant.pluginMcpRequirementBindingId === bindingId)
      expect(grants).toHaveLength(1)
      expect([
        { orgMembershipId: targetMemberId, teamId: null },
        { orgMembershipId: null, teamId },
      ]).toContainEqual({
        orgMembershipId: grants[0]?.orgMembershipId ?? null,
        teamId: grants[0]?.teamId ?? null,
      })
    } finally {
      await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(
        drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId, bindingId),
      )
      await db.delete(schema.PluginMcpRequirementBindingTable).where(
        drizzle.eq(schema.PluginMcpRequirementBindingTable.id, bindingId),
      )
      await connections.deleteExternalMcpConnection({
        organizationId,
        connectionId: assignedConnection.id,
      })
    }
  })

  test("access materialization refuses a connection deleted before commit", async () => {
    const deletedConnection = await connections.createExternalMcpConnection({
      organizationId,
      name: "Deleted before access",
      url: "https://mcp.example.test/deleted-before-access",
      authType: "none",
      credentialMode: "shared",
      createdByOrgMembershipId: memberId,
      access: { orgWide: false, memberIds: [], teamIds: [] },
    })
    expect(await connections.deleteExternalMcpConnectionIfUnused({
      organizationId,
      connectionId: deletedConnection.id,
    })).toBe("deleted")
    await expect(connections.replaceExternalMcpConnectionAccess({
      organizationId,
      connectionId: deletedConnection.id,
      access: { orgWide: true, memberIds: [], teamIds: [] },
      createdByOrgMembershipId: memberId,
    })).rejects.toThrow("no longer exists")
    const orphaned = await db.select({ id: schema.ExternalMcpConnectionAccessGrantTable.id })
      .from(schema.ExternalMcpConnectionAccessGrantTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, deletedConnection.id))
    expect(orphaned).toEqual([])
  })

  test("allows stale lease takeover and gates DCR persistence to the lease owner", async () => {
    await db
      .update(schema.ExternalMcpConnectionTable)
      .set({
        oauthRegistrationLeaseToken: "dead-replica",
        oauthRegistrationLeaseStartedAt: new Date(Date.now() - 120_000),
      })
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
    expect(await connections.tryAcquireExternalMcpOAuthRegistrationLease({
      organizationId,
      connectionId: connection.id,
      leaseToken: "takeover-owner",
      startedAt: new Date(),
      staleBefore: new Date(Date.now() - 60_000),
    })).toBe("acquired")

    const persistenceInput = {
      organizationId,
      connectionId: connection.id,
      expectedAuthorizationEpoch: 0,
      authorizationActor: { orgMembershipId: memberId },
      clientId: "lease-owned-client",
      clientSecret: null,
      extra: { registrationProvenance: "dcr" },
    }
    await expect(connections.persistExternalMcpDcrOAuthClientWithLease({
      ...persistenceInput,
      leaseToken: "not-the-owner",
    })).rejects.toThrow("no longer owned")
    await connections.persistExternalMcpDcrOAuthClientWithLease({
      ...persistenceInput,
      leaseToken: "takeover-owner",
    })

    const rows = await db
      .select({
        clientId: schema.OrgOAuthClientTable.clientId,
        leaseToken: schema.ExternalMcpConnectionTable.oauthRegistrationLeaseToken,
      })
      .from(schema.ExternalMcpConnectionTable)
      .innerJoin(
        schema.OrgOAuthClientTable,
        drizzle.and(
          drizzle.eq(schema.OrgOAuthClientTable.organizationId, schema.ExternalMcpConnectionTable.organizationId),
          drizzle.eq(schema.OrgOAuthClientTable.providerId, schema.ExternalMcpConnectionTable.id),
        ),
      )
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
      .limit(1)
    expect(rows[0]).toEqual({ clientId: "lease-owned-client", leaseToken: null })
  })

  test("lets exactly one concurrent legacy scope adopter win and rejects a different set", async () => {
    const legacyConnection = await connections.createExternalMcpConnection({
      organizationId,
      name: "External MCP concurrent scope adoption",
      url: "https://mcp.example.test/scopes",
      authType: "oauth",
      credentialMode: "shared",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const [first, second] = await Promise.all([
      connections.adoptLegacyExternalMcpRequestedOAuthScopes({
        organizationId,
        connectionId: legacyConnection.id,
        requestedOAuthScopes: ["scope:first"],
      }),
      connections.adoptLegacyExternalMcpRequestedOAuthScopes({
        organizationId,
        connectionId: legacyConnection.id,
        requestedOAuthScopes: ["scope:second"],
      }),
    ])
    const winners = [first, second].filter((result) => result !== null)
    expect(winners).toHaveLength(1)
    const persisted = await connections.getExternalMcpConnection({
      organizationId,
      connectionId: legacyConnection.id,
    })
    expect(persisted?.requestedOAuthScopes).toEqual(winners[0]?.requestedOAuthScopes)
    expect(new Set(persisted?.requestedOAuthScopes ?? [])).toEqual(
      new Set(first ? ["scope:first"] : ["scope:second"]),
    )
  })
})
