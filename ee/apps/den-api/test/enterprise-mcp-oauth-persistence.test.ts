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
let connections: typeof import("../src/capability-sources/external-mcp-connections.js")
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
  connections = modules[4]
  createExternalMcpConnection = connections.createExternalMcpConnection

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
    const persistence = new DenEnterpriseMcpOAuthPersistence(
      connection,
      undefined,
      { orgMembershipId: memberId },
    )
    const registrationContext = context()
    const registrationClaim = await persistence.clientRegistrations.claimDynamicRegistration(registrationContext)
    if (registrationClaim.status !== "acquired") throw new Error("Expected to acquire the DCR claim.")
    const saved = await persistence.clientRegistrations.save({
      context: registrationContext,
      clientInformation: {
        client_id: "registered-client",
        client_secret: "encrypted-client-secret",
        registration_access_token: "must-not-enter-json",
        token_endpoint_auth_method: "client_secret_post",
      },
      source: "dynamic",
      claim: registrationClaim.claim,
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
    expect(rows[0]?.extra?.clientInformation).toBeUndefined()
    expect(rows[0]?.extra?.clientInformationV2).toMatchObject({
      client_id: "registered-client",
      token_endpoint_auth_method: "client_secret_post",
    })
    // A replica from before clientInformationV2 ignores the new metadata key
    // and therefore reconstructs the complete credential from encrypted
    // columns instead of returning sanitized JSON without its secret.
    const oldReplicaRead = rows[0]?.extra?.clientInformation ?? {
      client_id: rows[0]?.clientId,
      client_secret: rows[0]?.clientSecret ?? undefined,
    }
    expect(oldReplicaRead).toEqual({
      client_id: "registered-client",
      client_secret: "encrypted-client-secret",
    })

    const loser = await persistence.clientRegistrations.claimDynamicRegistration(context())
    expect(loser.status).toBe("existing")
    if (loser.status === "existing") expect(loser.registration.clientInformation.client_id).toBe("registered-client")
  })

  test("rejects dynamic registration after the initiating shared admin is demoted", async () => {
    const registeringConnection = await createExternalMcpConnection({
      organizationId,
      name: "Enterprise MCP DCR demotion fence",
      url: "https://mcp.example.test/enterprise-dcr-demotion",
      authType: "oauth",
      credentialMode: "shared",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const persistence = new DenEnterpriseMcpOAuthPersistence(
      registeringConnection,
      undefined,
      { orgMembershipId: memberId },
    )
    await db
      .update(schema.MemberTable)
      .set({ role: "member" })
      .where(drizzle.eq(schema.MemberTable.id, memberId))
    try {
      await expect(persistence.clientRegistrations.claimDynamicRegistration({
          connectionId: registeringConnection.id,
          commitExpiresAt: Date.now() + 30_000,
          signal: new AbortController().signal,
      })).rejects.toThrow("no longer has authority")
      const clients = await db
        .select({ id: schema.OrgOAuthClientTable.id })
        .from(schema.OrgOAuthClientTable)
        .where(drizzle.eq(schema.OrgOAuthClientTable.providerId, registeringConnection.id))
      expect(clients).toHaveLength(0)
    } finally {
      await db
        .update(schema.MemberTable)
        .set({ role: "admin" })
        .where(drizzle.eq(schema.MemberTable.id, memberId))
    }
  })

  test("rejects dynamic registration after the initiating member loses assignment", async () => {
    const registeringConnection = await createExternalMcpConnection({
      organizationId,
      name: "Enterprise MCP DCR assignment fence",
      url: "https://mcp.example.test/enterprise-dcr-assignment",
      authType: "oauth",
      credentialMode: "per_member",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const persistence = new DenEnterpriseMcpOAuthPersistence(
      registeringConnection,
      { orgMembershipId: memberId },
      { orgMembershipId: memberId },
    )
    await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(
      drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, registeringConnection.id),
    )

    await expect(persistence.clientRegistrations.claimDynamicRegistration({
        connectionId: registeringConnection.id,
        commitExpiresAt: Date.now() + 30_000,
        signal: new AbortController().signal,
    })).rejects.toThrow("no longer has authority")
    const clients = await db
      .select({ id: schema.OrgOAuthClientTable.id })
      .from(schema.OrgOAuthClientTable)
      .where(drizzle.eq(schema.OrgOAuthClientTable.providerId, registeringConnection.id))
    expect(clients).toHaveLength(0)
  })

  test("a delayed T1 rejection cannot clear a newer enterprise T2 credential", async () => {
    const tokenConnection = await createExternalMcpConnection({
      organizationId,
      name: "Enterprise MCP token revision fence",
      url: "https://mcp.example.test/enterprise-token-revision",
      authType: "oauth",
      credentialMode: "shared",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    await db
      .update(schema.ExternalMcpConnectionTable)
      .set({
        accessToken: "enterprise-access-t1",
        refreshToken: "enterprise-refresh-t1",
        tokenType: "Bearer",
        connectedAt: new Date(),
      })
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, tokenConnection.id))
    const persistence = new DenEnterpriseMcpOAuthPersistence(tokenConnection)
    const failed = await persistence.credentials.load({
      connectionId: tokenConnection.id,
      commitExpiresAt: Date.now() + 30_000,
      signal: new AbortController().signal,
    })
    if (!failed) throw new Error("Expected the T1 enterprise credential.")

    await db
      .update(schema.ExternalMcpConnectionTable)
      .set({
        accessToken: "enterprise-access-t2",
        refreshToken: "enterprise-refresh-t2",
        tokenType: "Bearer",
        connectedAt: new Date(),
      })
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, tokenConnection.id))
    await persistence.credentials.invalidate({
      context: {
        connectionId: tokenConnection.id,
        commitExpiresAt: Date.now() + 30_000,
        signal: new AbortController().signal,
      },
      reason: "provider-rejected",
      revision: failed.revision,
    })

    const rows = await db
      .select({
        accessToken: schema.ExternalMcpConnectionTable.accessToken,
        refreshToken: schema.ExternalMcpConnectionTable.refreshToken,
      })
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, tokenConnection.id))
      .limit(1)
    expect(rows[0]).toEqual({
      accessToken: "enterprise-access-t2",
      refreshToken: "enterprise-refresh-t2",
    })
  })

  test("enterprise invalid_client cleanup cannot delete a rotated client revision", async () => {
    const clientConnection = await createExternalMcpConnection({
      organizationId,
      name: "Enterprise MCP client revision fence",
      url: "https://mcp.example.test/enterprise-client-revision",
      authType: "oauth",
      credentialMode: "shared",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const clientRowId = createDenTypeId("orgOAuthClient")
    await db.insert(schema.OrgOAuthClientTable).values({
      id: clientRowId,
      organizationId,
      providerId: clientConnection.id,
      clientId: "enterprise-client-t1",
      clientSecret: "enterprise-secret-t1",
      extra: { enterpriseMcpRegistrationSource: "dynamic" },
      createdByOrgMembershipId: memberId,
    })
    const persistence = new DenEnterpriseMcpOAuthPersistence(clientConnection)
    const failed = await persistence.clientRegistrations.load({
      connectionId: clientConnection.id,
      commitExpiresAt: Date.now() + 30_000,
      signal: new AbortController().signal,
    })
    if (!failed) throw new Error("Expected the T1 enterprise OAuth client.")

    await db
      .update(schema.OrgOAuthClientTable)
      .set({
        clientId: "enterprise-client-t2",
        clientSecret: "enterprise-secret-t2",
        extra: { administratorRotation: true },
      })
      .where(drizzle.eq(schema.OrgOAuthClientTable.id, clientRowId))
    await persistence.clientRegistrations.invalidate({
      context: {
        connectionId: clientConnection.id,
        commitExpiresAt: Date.now() + 30_000,
        signal: new AbortController().signal,
      },
      reason: "provider-rejected",
      revision: failed.revision,
    })

    const clients = await db
      .select({
        clientId: schema.OrgOAuthClientTable.clientId,
        clientSecret: schema.OrgOAuthClientTable.clientSecret,
      })
      .from(schema.OrgOAuthClientTable)
      .where(drizzle.eq(schema.OrgOAuthClientTable.id, clientRowId))
    expect(clients).toEqual([{
      clientId: "enterprise-client-t2",
      clientSecret: "enterprise-secret-t2",
    }])
  })

  test("invalid_client and expiry cleanup rotate only exact dynamic registrations", async () => {
    async function createRegistrationConnection(name: string, path: string) {
      return createExternalMcpConnection({
        organizationId,
        name,
        url: `https://mcp.example.test/${path}`,
        authType: "oauth",
        credentialMode: "shared",
        createdByOrgMembershipId: memberId,
        access: { orgWide: true, memberIds: [], teamIds: [] },
      })
    }
    function registrationContext(connectionId: string) {
      return {
        connectionId,
        commitExpiresAt: Date.now() + 30_000,
        signal: new AbortController().signal,
      }
    }

    const manualConnection = await createRegistrationConnection("Manual enterprise OAuth client", "manual-client")
    const manualClientId = createDenTypeId("orgOAuthClient")
    await db.insert(schema.OrgOAuthClientTable).values({
      id: manualClientId,
      organizationId,
      providerId: manualConnection.id,
      clientId: "administrator-client",
      clientSecret: "administrator-secret",
      extra: null,
      createdByOrgMembershipId: memberId,
    })
    const manualPersistence = new DenEnterpriseMcpOAuthPersistence(manualConnection)
    const manualRegistration = await manualPersistence.clientRegistrations.load(registrationContext(manualConnection.id))
    if (!manualRegistration) throw new Error("Expected the administrator OAuth client.")
    expect(manualRegistration.source).toBe("pre-registered")
    await manualPersistence.clientRegistrations.invalidate({
      context: registrationContext(manualConnection.id),
      reason: "provider-rejected",
      revision: manualRegistration.revision,
    })
    expect(await manualPersistence.clientRegistrations.load(registrationContext(manualConnection.id))).toBeDefined()

    const cimdConnection = await createRegistrationConnection("Enterprise CIMD client", "cimd-client")
    const cimdClientId = createDenTypeId("orgOAuthClient")
    await db.insert(schema.OrgOAuthClientTable).values({
      id: cimdClientId,
      organizationId,
      providerId: cimdConnection.id,
      clientId: "https://den.example.test/v1/mcp-connections/cimd/oauth-client-metadata",
      clientSecret: null,
      extra: { registrationProvenance: "cimd" },
      createdByOrgMembershipId: memberId,
    })
    const cimdPersistence = new DenEnterpriseMcpOAuthPersistence(cimdConnection)
    const cimdRegistration = await cimdPersistence.clientRegistrations.load(registrationContext(cimdConnection.id))
    if (!cimdRegistration) throw new Error("Expected the Client ID Metadata registration.")
    expect(cimdRegistration.source).toBe("client-metadata")
    await cimdPersistence.clientRegistrations.invalidate({
      context: registrationContext(cimdConnection.id),
      reason: "expired",
      revision: cimdRegistration.revision,
    })
    expect(await cimdPersistence.clientRegistrations.load(registrationContext(cimdConnection.id))).toBeDefined()

    const dynamicConnection = await createRegistrationConnection("Enterprise dynamic OAuth client", "dynamic-client")
    const dynamicPersistence = new DenEnterpriseMcpOAuthPersistence(
      dynamicConnection,
      undefined,
      { orgMembershipId: memberId },
    )
    const dynamicContext = registrationContext(dynamicConnection.id)
    const dynamicClaim = await dynamicPersistence.clientRegistrations.claimDynamicRegistration(dynamicContext)
    if (dynamicClaim.status !== "acquired") throw new Error("Expected to acquire the dynamic registration claim.")
    const dynamicRegistration = await dynamicPersistence.clientRegistrations.save({
      context: dynamicContext,
      clientInformation: {
        client_id: "dynamic-client",
        client_secret: "dynamic-secret",
        token_endpoint_auth_method: "client_secret_basic",
      },
      source: "dynamic",
      claim: dynamicClaim.claim,
    })
    expect(dynamicRegistration.source).toBe("dynamic")
    await dynamicPersistence.clientRegistrations.invalidate({
      context: registrationContext(dynamicConnection.id),
      reason: "provider-rejected",
      revision: dynamicRegistration.revision,
    })
    expect(await dynamicPersistence.clientRegistrations.load(registrationContext(dynamicConnection.id))).toBeUndefined()

    const legacyDynamicConnection = await createRegistrationConnection("Legacy dynamic OAuth client", "legacy-dynamic-client")
    await db.insert(schema.OrgOAuthClientTable).values({
      id: createDenTypeId("orgOAuthClient"),
      organizationId,
      providerId: legacyDynamicConnection.id,
      clientId: "legacy-dynamic-client",
      clientSecret: null,
      extra: { clientInformation: { client_id: "legacy-dynamic-client" } },
      createdByOrgMembershipId: memberId,
    })
    const legacyDynamicPersistence = new DenEnterpriseMcpOAuthPersistence(legacyDynamicConnection)
    const legacyDynamicRegistration = await legacyDynamicPersistence.clientRegistrations.load(
      registrationContext(legacyDynamicConnection.id),
    )
    if (!legacyDynamicRegistration) throw new Error("Expected the legacy OAuth client.")
    expect(legacyDynamicRegistration.source).toBe("pre-registered")
    await legacyDynamicPersistence.clientRegistrations.invalidate({
      context: registrationContext(legacyDynamicConnection.id),
      reason: "provider-rejected",
      revision: legacyDynamicRegistration.revision,
    })
    expect(
      await legacyDynamicPersistence.clientRegistrations.load(registrationContext(legacyDynamicConnection.id)),
    ).toBeDefined()
  })

  test("isolates concurrent signed PKCE transactions and consumes only the callback winner", async () => {
    const persistence = new DenEnterpriseMcpOAuthPersistence(
      connection,
      undefined,
      { orgMembershipId: memberId },
    )
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
    expect(first?.codeVerifier).toBe("a".repeat(43))
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
    const second = await persistence.authorizations.load({ context: context(), id: "signed-state-b" })
    expect(second?.codeVerifier).toBe("b".repeat(43))
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

  test("rechecks shared admin authority in the same transaction as enterprise token persistence", async () => {
    const persistence = new DenEnterpriseMcpOAuthPersistence(
      connection,
      undefined,
      { orgMembershipId: memberId },
    )
    const registration = await persistence.clientRegistrations.load(context())
    if (!registration) throw new Error("Expected the seeded OAuth client registration.")
    await persistence.authorizations.begin({
      context: context(),
      id: "signed-state-enterprise-demotion",
      codeVerifier: "q".repeat(43),
      expiresAt: Date.now() + 600_000,
      clientRegistrationRevision: registration.revision,
    })
    const authorization = await persistence.authorizations.load({
      context: context(),
      id: "signed-state-enterprise-demotion",
    })
    if (!authorization) throw new Error("Expected the pending enterprise authorization.")
    const before = await persistence.credentials.load(context())

    await db
      .update(schema.MemberTable)
      .set({ role: "member" })
      .where(drizzle.eq(schema.MemberTable.id, memberId))
    try {
      await expect(persistence.credentials.save({
        context: context(),
        tokens: { access_token: "must-not-save-after-enterprise-demotion", token_type: "Bearer" },
        source: "authorization-code",
        authorization: authorization.handle,
        clientRegistrationRevision: registration.revision,
      })).rejects.toThrow("no longer has authority")
      expect((await persistence.credentials.load(context()))?.tokens.access_token).toBe(before?.tokens.access_token)
    } finally {
      await db
        .update(schema.MemberTable)
        .set({ role: "admin" })
        .where(drizzle.eq(schema.MemberTable.id, memberId))
      await persistence.authorizations.invalidate({
        context: context(),
        id: "signed-state-enterprise-demotion",
        reason: "abandoned",
      })
    }
  })

  test("rechecks per-member assignment before enterprise token persistence", async () => {
    const perMemberConnection = await createExternalMcpConnection({
      organizationId,
      name: "Enterprise MCP assignment commit fence",
      url: "https://mcp.example.test/enterprise-assignment-fence",
      authType: "oauth",
      credentialMode: "per_member",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const persistenceContext = () => ({
      connectionId: perMemberConnection.id,
      commitExpiresAt: Date.now() + 30_000,
      signal: new AbortController().signal,
    })
    const persistence = new DenEnterpriseMcpOAuthPersistence(
      perMemberConnection,
      { orgMembershipId: memberId },
      { orgMembershipId: memberId },
    )
    const assignmentContext = persistenceContext()
    const assignmentClaim = await persistence.clientRegistrations.claimDynamicRegistration(assignmentContext)
    if (assignmentClaim.status !== "acquired") throw new Error("Expected to acquire the assignment DCR claim.")
    const registration = await persistence.clientRegistrations.save({
      context: assignmentContext,
      clientInformation: { client_id: "enterprise-assignment-client" },
      source: "dynamic",
      claim: assignmentClaim.claim,
    })
    await persistence.authorizations.begin({
      context: persistenceContext(),
      id: "signed-state-enterprise-unassignment",
      codeVerifier: "v".repeat(43),
      expiresAt: Date.now() + 600_000,
      clientRegistrationRevision: registration.revision,
    })
    const authorization = await persistence.authorizations.load({
      context: persistenceContext(),
      id: "signed-state-enterprise-unassignment",
    })
    if (!authorization) throw new Error("Expected the pending per-member enterprise authorization.")
    await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(
      drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId, perMemberConnection.id),
    )

    await expect(persistence.credentials.save({
      context: persistenceContext(),
      tokens: { access_token: "must-not-save-after-enterprise-unassignment", token_type: "Bearer" },
      source: "authorization-code",
      authorization: authorization.handle,
      clientRegistrationRevision: registration.revision,
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

  test("enterprise callback cannot restore credentials after disconnect", async () => {
    const disconnectedConnection = await createExternalMcpConnection({
      organizationId,
      name: "Enterprise MCP disconnect fence",
      url: "https://mcp.example.test/enterprise-disconnect-fence",
      authType: "oauth",
      credentialMode: "shared",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const persistenceContext = () => ({
      connectionId: disconnectedConnection.id,
      commitExpiresAt: Date.now() + 30_000,
      signal: new AbortController().signal,
    })
    const persistence = new DenEnterpriseMcpOAuthPersistence(
      disconnectedConnection,
      undefined,
      { orgMembershipId: memberId },
    )
    const disconnectContext = persistenceContext()
    const disconnectClaim = await persistence.clientRegistrations.claimDynamicRegistration(disconnectContext)
    if (disconnectClaim.status !== "acquired") throw new Error("Expected to acquire the disconnect DCR claim.")
    const registration = await persistence.clientRegistrations.save({
      context: disconnectContext,
      clientInformation: { client_id: "enterprise-disconnect-client" },
      source: "dynamic",
      claim: disconnectClaim.claim,
    })
    await persistence.authorizations.begin({
      context: persistenceContext(),
      id: "signed-state-enterprise-disconnect",
      codeVerifier: "y".repeat(43),
      expiresAt: Date.now() + 600_000,
      clientRegistrationRevision: registration.revision,
    })
    const authorization = await persistence.authorizations.load({
      context: persistenceContext(),
      id: "signed-state-enterprise-disconnect",
    })
    if (!authorization) throw new Error("Expected the pending enterprise authorization.")
    expect(await connections.disconnectExternalMcpConnection({
      organizationId,
      connectionId: disconnectedConnection.id,
    })).toBe(true)

    await expect(persistence.credentials.save({
      context: persistenceContext(),
      tokens: { access_token: "must-not-save-after-enterprise-disconnect", token_type: "Bearer" },
      source: "authorization-code",
      authorization: authorization.handle,
      clientRegistrationRevision: registration.revision,
    })).rejects.toThrow(/missing, expired, or already consumed|disconnected/)
    const rows = await db
      .select({ accessToken: schema.ExternalMcpConnectionTable.accessToken })
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, disconnectedConnection.id))
      .limit(1)
    expect(rows[0]?.accessToken).toBeNull()
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

  test("rejects late credential and client writes after the connection identity changes", async () => {
    const oldIdentity = await createExternalMcpConnection({
      organizationId,
      name: "Enterprise MCP old identity",
      url: "https://old-mcp.example.test/mcp",
      authType: "oauth",
      credentialMode: "shared",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const persistence = new DenEnterpriseMcpOAuthPersistence(
      oldIdentity,
      undefined,
      { orgMembershipId: memberId },
    )
    await db
      .update(schema.ExternalMcpConnectionTable)
      .set({ url: "https://replacement-mcp.example.test/mcp", updatedAt: new Date() })
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, oldIdentity.id))
    const oldContext = {
      connectionId: oldIdentity.id,
      commitExpiresAt: Date.now() + 30_000,
      signal: new AbortController().signal,
    }

    await expect(persistence.credentials.save({
      context: oldContext,
      tokens: { access_token: "late-enterprise-token", token_type: "Bearer" },
      source: "refresh",
    })).rejects.toThrow("identity changed")
    await expect(persistence.clientRegistrations.claimDynamicRegistration(oldContext)).rejects.toThrow("identity changed")

    const rows = await db
      .select()
      .from(schema.ExternalMcpConnectionTable)
      .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, oldIdentity.id))
      .limit(1)
    expect(rows[0]?.accessToken).toBeNull()
    const clients = await db
      .select()
      .from(schema.OrgOAuthClientTable)
      .where(drizzle.eq(schema.OrgOAuthClientTable.providerId, oldIdentity.id))
    expect(clients).toEqual([])
  })

  test("enterprise refresh requires the existing per-member account without an authorization actor", async () => {
    const perMemberConnection = await createExternalMcpConnection({
      organizationId,
      name: "Enterprise MCP refresh account fence",
      url: "https://mcp.example.test/enterprise-refresh-account-fence",
      authType: "oauth",
      credentialMode: "per_member",
      createdByOrgMembershipId: memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const accountId = createDenTypeId("connectedAccount")
    await db.insert(schema.ConnectedAccountTable).values({
      id: accountId,
      organizationId,
      orgMembershipId: memberId,
      providerId: perMemberConnection.id,
      accessToken: "enterprise-refresh-old-access",
      refreshToken: "enterprise-refresh-old-refresh",
    })
    const persistence = new DenEnterpriseMcpOAuthPersistence(
      perMemberConnection,
      { orgMembershipId: memberId },
    )
    const persistenceContext = {
      connectionId: perMemberConnection.id,
      commitExpiresAt: Date.now() + 30_000,
      signal: new AbortController().signal,
    }
    await db.delete(schema.ConnectedAccountTable).where(
      drizzle.eq(schema.ConnectedAccountTable.id, accountId),
    )

    await expect(persistence.credentials.save({
      context: persistenceContext,
      tokens: {
        access_token: "must-not-resurrect-refresh-account",
        refresh_token: "must-not-resurrect-refresh-token",
        token_type: "Bearer",
      },
      source: "refresh",
    })).rejects.toThrow("disconnected before refreshed credentials")
    const accounts = await db
      .select({ id: schema.ConnectedAccountTable.id })
      .from(schema.ConnectedAccountTable)
      .where(drizzle.eq(schema.ConnectedAccountTable.providerId, perMemberConnection.id))
    expect(accounts).toHaveLength(0)
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
    let expectedClientId = ""
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
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
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
            client_id_metadata_document_supported: true,
          })
        }
        if (url.pathname === "/register") {
          return Response.json({ error: "unexpected_dynamic_registration" }, { status: 500 })
        }
        if (url.pathname === "/token") {
          const form = new URLSearchParams(await request.text())
          expect(form.get("grant_type")).toBe("authorization_code")
          expect(form.get("code")).toBe("approved-code")
          expect(form.get("code_verifier")?.length).toBeGreaterThanOrEqual(43)
          expect(form.get("client_id")).toBe(expectedClientId)
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
                "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
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
        requestedOAuthScopes: ["issues:read", "offline_access"],
        createdByOrgMembershipId: memberId,
        access: { orgWide: true, memberIds: [], teamIds: [] },
      })
      const adapter = await import("../src/capability-sources/enterprise-mcp-client-adapter.js")
      const redirectUri = `https://den.example.test/v1/mcp-connections/${endToEndConnection.id}/connect/callback`
      expectedClientId = `https://den.example.test/v1/mcp-connections/${endToEndConnection.id}/oauth-client-metadata`
      const signedState = "signed-den-state-end-to-end"
      const started = await adapter.connectExternalMcp(
        endToEndConnection,
        redirectUri,
        signedState,
        undefined,
        "req_enterprise_e2e_start",
        { orgMembershipId: memberId },
      )
      expect(started.status).toBe("needs_auth")
      if (started.status !== "needs_auth") throw new Error("Expected provider authorization to be required.")
      const authorizeUrl = new URL(started.authorizeUrl)
      expect(authorizeUrl.searchParams.get("state")).toBe(signedState)
      expect(authorizeUrl.searchParams.get("scope")).toBe("issues:read offline_access")
      expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256")
      expect(authorizeUrl.searchParams.get("client_id")).toBe(expectedClientId)

      const clientRows = await db
        .select({ clientId: schema.OrgOAuthClientTable.clientId, extra: schema.OrgOAuthClientTable.extra })
        .from(schema.OrgOAuthClientTable)
        .where(drizzle.eq(schema.OrgOAuthClientTable.providerId, endToEndConnection.id))
        .limit(1)
      expect(clientRows[0]?.clientId).toBe(expectedClientId)
      expect(clientRows[0]?.extra?.registrationProvenance).toBe("cimd")

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
        { orgMembershipId: memberId },
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
