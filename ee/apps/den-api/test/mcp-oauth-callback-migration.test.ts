import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, mock, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_pr7"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let connections: typeof import("../src/capability-sources/external-mcp-connections.js")
let credentials: typeof import("../src/capability-sources/oauth-credentials.js")
let persistenceModule: typeof import("../src/capability-sources/enterprise-mcp-oauth-persistence.js")

const userId = createDenTypeId("user")
const secondaryUserId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const secondaryMemberId = createDenTypeId("member")

beforeAll(async () => {
  seedRequiredEnv()
  mock.restore()
  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const [dbMod, schemaMod, drizzleMod, connectionsMod, credentialsMod, loadedPersistenceModule] = await Promise.all([
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/capability-sources/external-mcp-connections.js"),
    import("../src/capability-sources/oauth-credentials.js"),
    import("../src/capability-sources/enterprise-mcp-oauth-persistence.js"),
  ])
  db = dbMod.db
  schema = schemaMod
  drizzle = drizzleMod
  connections = connectionsMod
  credentials = credentialsMod
  persistenceModule = loadedPersistenceModule

  await db.insert(schema.AuthUserTable).values({
    id: userId,
    name: "MCP Callback Migration User",
    email: `mcp-callback-migration+${userId}@test.local`,
  })
  await db.insert(schema.AuthUserTable).values({
    id: secondaryUserId,
    name: "MCP Callback Migration Secondary User",
    email: `mcp-callback-migration+${secondaryUserId}@test.local`,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "MCP Callback Migration Org",
    slug: `mcp-callback-migration-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values({
    id: memberId,
    organizationId,
    userId,
    role: "admin",
  })
  await db.insert(schema.MemberTable).values({
    id: secondaryMemberId,
    organizationId,
    userId: secondaryUserId,
    role: "member",
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
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [userId, secondaryUserId]))
  mock.restore()
})

async function createConnection(name: string, credentialMode: "shared" | "per_member" = "shared") {
  return connections.createExternalMcpConnection({
    organizationId,
    name,
    url: `https://mcp.example.invalid/${encodeURIComponent(name)}`,
    authType: "oauth",
    credentialMode,
    createdByOrgMembershipId: memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
}

async function markAsLegacy(connectionId: DenTypeId<"externalMcpConnection">) {
  await db
    .update(schema.ExternalMcpConnectionTable)
    .set({
      oauthConfiguration: {
        version: 1,
        authorizationServerIssuer: "https://issuer.example.invalid/tenant",
        requestedScopes: ["read"],
        callbackMode: "legacy-v1",
      },
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      pendingCodeVerifier: "old-pending-authorization",
    })
    .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connectionId))
}

test("all new OAuth connections use shared-v1 even if an internal caller asks for legacy", async () => {
  const created = await connections.createExternalMcpConnection({
    organizationId,
    name: "Creation invariant",
    url: "https://mcp.example.invalid/creation-invariant",
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

  expect(created.oauthConfiguration?.callbackMode).toBe("shared-v1")
})

test("manual migration preserves the client credentials, grants, and other members while clearing the caller", async () => {
  const connection = await createConnection("Manual migration", "per_member")
  await markAsLegacy(connection.id)
  const clientBefore = await credentials.upsertOrgOAuthClient({
    organizationId,
    providerId: connection.id,
    clientId: "manual-client-id",
    clientSecret: "manual-client-secret",
    extra: { enterpriseMcpRegistrationSource: "pre-registered", registrationContractVersion: 1 },
    createdByOrgMembershipId: memberId,
  })
  await credentials.upsertConnectedAccount({
    organizationId,
    orgMembershipId: memberId,
    providerId: connection.id,
    accessToken: "member-access-token",
    refreshToken: "member-refresh-token",
    pendingCodeVerifier: "member-pending-authorization",
  })
  await credentials.upsertConnectedAccount({
    organizationId,
    orgMembershipId: secondaryMemberId,
    providerId: connection.id,
    accessToken: "secondary-member-access-token",
    refreshToken: "secondary-member-refresh-token",
    pendingCodeVerifier: "secondary-member-pending-authorization",
  })
  const grantsBefore = await connections.listExternalMcpConnectionAccess({ organizationId, connectionId: connection.id })

  const result = await connections.migrateExternalMcpOAuthCallbackToShared({
    organizationId,
    connectionId: connection.id,
    orgMembershipId: memberId,
  })
  expect(result).toMatchObject({
    status: "migrated",
    changed: true,
    dynamicRegistrationInvalidated: false,
    manualClientPreserved: true,
  })
  if (result.status !== "migrated") throw new Error("migration did not return a connection")

  const [clientAfter, accountAfter, secondaryAccountAfter, grantsAfter, connectionAfter] = await Promise.all([
    credentials.getOrgOAuthClient(organizationId, connection.id),
    credentials.getConnectedAccount({ organizationId, orgMembershipId: memberId, providerId: connection.id }),
    credentials.getConnectedAccount({ organizationId, orgMembershipId: secondaryMemberId, providerId: connection.id }),
    connections.listExternalMcpConnectionAccess({ organizationId, connectionId: connection.id }),
    connections.getExternalMcpConnection({ organizationId, connectionId: connection.id }),
  ])
  const sharedCallbackUrl = new URL("/v1/mcp-connections/oauth/callback", process.env.DEN_API_PUBLIC_URL).toString()
  expect(clientAfter).toMatchObject({
    id: clientBefore.id,
    clientId: "manual-client-id",
    clientSecret: "manual-client-secret",
    extra: {
      enterpriseMcpRegistrationSource: "pre-registered",
      registrationContractVersion: 2,
      registeredRedirectUri: sharedCallbackUrl,
    },
  })
  expect(accountAfter).toBeNull()
  expect(secondaryAccountAfter).toMatchObject({
    orgMembershipId: secondaryMemberId,
    accessToken: "secondary-member-access-token",
    refreshToken: "secondary-member-refresh-token",
  })
  expect(grantsAfter.map((grant) => grant.id)).toEqual(grantsBefore.map((grant) => grant.id))
  expect(connectionAfter).toMatchObject({
    accessToken: null,
    refreshToken: null,
    pendingCodeVerifier: null,
    connectedAt: null,
    oauthConfiguration: { callbackMode: "shared-v1" },
  })

  const repeated = await connections.migrateExternalMcpOAuthCallbackToShared({
    organizationId,
    connectionId: connection.id,
    orgMembershipId: memberId,
  })
  expect(repeated).toMatchObject({ status: "migrated", changed: false })

  const reverseAttempt = await connections.updateExternalMcpConnection({
    organizationId,
    connectionId: connection.id,
    expectedUpdatedAt: result.connection.updatedAt,
    name: result.connection.name,
    url: result.connection.url,
    authType: "oauth",
    credentialMode: result.connection.credentialMode,
    oauthConfiguration: {
      ...result.connection.oauthConfiguration!,
      callbackMode: "legacy-v1",
    },
    access: { orgWide: true, memberIds: [], teamIds: [] },
    updatedByOrgMembershipId: memberId,
  })
  expect(reverseAttempt).toEqual({ status: "conflict" })
})

test("explicit reconnect migration replaces an old dynamic registration without clearing another member", async () => {
  const connection = await createConnection("Dynamic migration", "per_member")
  await markAsLegacy(connection.id)
  const oldClient = await credentials.upsertOrgOAuthClient({
    organizationId,
    providerId: connection.id,
    clientId: "old-dynamic-client",
    clientSecret: "old-dynamic-secret",
    extra: {
      clientInformation: { client_id: "old-dynamic-client", client_secret: "old-dynamic-secret" },
      enterpriseMcpRegistrationSource: "dynamic",
      registrationContractVersion: 1,
      registeredRedirectUri: `http://127.0.0.1:8790/v1/mcp-connections/${connection.id}/connect/callback`,
    },
    createdByOrgMembershipId: memberId,
  })
  await credentials.upsertConnectedAccount({
    organizationId,
    orgMembershipId: memberId,
    providerId: connection.id,
    accessToken: "old-member-token",
    pendingCodeVerifier: "old-member-pending-authorization",
  })
  await credentials.upsertConnectedAccount({
    organizationId,
    orgMembershipId: secondaryMemberId,
    providerId: connection.id,
    accessToken: "other-member-token",
    pendingCodeVerifier: "other-member-pending-authorization",
  })

  const migrated = await connections.migrateExternalMcpOAuthCallbackToShared({
    organizationId,
    connectionId: connection.id,
    orgMembershipId: memberId,
  })
  expect(migrated).toMatchObject({
    status: "migrated",
    dynamicRegistrationInvalidated: true,
    manualClientPreserved: false,
    connection: {
      accessToken: null,
      refreshToken: null,
      pendingCodeVerifier: null,
      connectedAt: null,
      oauthConfiguration: { callbackMode: "shared-v1" },
    },
  })
  expect(await credentials.getOrgOAuthClient(organizationId, connection.id)).toBeNull()
  expect(await credentials.getConnectedAccount({ organizationId, orgMembershipId: memberId, providerId: connection.id })).toBeNull()
  expect(await credentials.getConnectedAccount({
    organizationId,
    orgMembershipId: secondaryMemberId,
    providerId: connection.id,
  })).toMatchObject({
    orgMembershipId: secondaryMemberId,
    accessToken: "other-member-token",
  })

  const replacement = await credentials.upsertOrgOAuthClient({
    organizationId,
    providerId: connection.id,
    clientId: "replacement-dynamic-client",
    extra: {
      enterpriseMcpRegistrationSource: "dynamic",
      registrationContractVersion: 2,
      registeredRedirectUri: "http://127.0.0.1:8790/v1/mcp-connections/oauth/callback",
    },
    createdByOrgMembershipId: memberId,
  })
  expect(replacement.id).not.toBe(oldClient.id)
  expect(replacement.clientId).toBe("replacement-dynamic-client")
})

test("a stale concurrent refresh cannot overwrite the credential that won the transaction", async () => {
  const connection = await createConnection("Concurrent refresh", "shared")
  await db
    .update(schema.ExternalMcpConnectionTable)
    .set({
      accessToken: "original-access-token",
      refreshToken: "original-refresh-token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 60_000),
    })
    .where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))
  const current = await connections.getExternalMcpConnection({ organizationId, connectionId: connection.id })
  if (!current) throw new Error("concurrent refresh connection was not created")

  const first = new persistenceModule.DenEnterpriseMcpOAuthPersistence(current)
  const second = new persistenceModule.DenEnterpriseMcpOAuthPersistence(current)
  const context = () => ({
    connectionId: connection.id,
    commitExpiresAt: Date.now() + 10_000,
    signal: new AbortController().signal,
  })
  const [firstLoaded, secondLoaded] = await Promise.all([
    first.credentials.load(context()),
    second.credentials.load(context()),
  ])
  if (!firstLoaded || !secondLoaded) throw new Error("seeded credential was not loaded")

  await first.credentials.save({
    context: context(),
    tokens: {
      access_token: "winning-access-token",
      refresh_token: "winning-refresh-token",
      token_type: "Bearer",
    },
    expiresAt: Date.now() + 3_600_000,
    source: "refresh",
    expectedCredentialRevision: firstLoaded.revision,
  })
  await expect(second.credentials.save({
    context: context(),
    tokens: {
      access_token: "stale-access-token",
      refresh_token: "stale-refresh-token",
      token_type: "Bearer",
    },
    expiresAt: Date.now() + 3_600_000,
    source: "refresh",
    expectedCredentialRevision: secondLoaded.revision,
  })).rejects.toMatchObject({ code: "MCP_OAUTH_CREDENTIAL_CHANGED" })

  const persisted = await connections.getExternalMcpConnection({ organizationId, connectionId: connection.id })
  expect(persisted).toMatchObject({
    accessToken: "winning-access-token",
    refreshToken: "winning-refresh-token",
  })
})
