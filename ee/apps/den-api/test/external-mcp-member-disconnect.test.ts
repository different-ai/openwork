import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_pr7"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let connections: typeof import("../src/capability-sources/external-mcp-connections.js")
let oauthCredentials: typeof import("../src/capability-sources/oauth-credentials.js")

const organizationId = createDenTypeId("organization")
const memberUserId = createDenTypeId("user")
const adminUserId = createDenTypeId("user")
const memberId = createDenTypeId("member")
const adminMemberId = createDenTypeId("member")
const memberSessionId = createDenTypeId("session")
const adminSessionId = createDenTypeId("session")
const memberSessionToken = `external-mcp-member-disconnect-${memberSessionId}`
const adminSessionToken = `external-mcp-admin-disconnect-${adminSessionId}`

beforeAll(async () => {
  seedRequiredEnv()
  const modules = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/capability-sources/external-mcp-connections.js"),
    import("../src/capability-sources/oauth-credentials.js"),
  ])
  app = modules[0].default
  db = modules[1].db
  schema = modules[2]
  drizzle = modules[3]
  connections = modules[4]
  oauthCredentials = modules[5]

  await db.insert(schema.AuthUserTable).values([
    {
      id: memberUserId,
      name: "External MCP Disconnect Member",
      email: `external-mcp-disconnect-member+${memberUserId}@test.local`,
    },
    {
      id: adminUserId,
      name: "External MCP Disconnect Admin",
      email: `external-mcp-disconnect-admin+${adminUserId}@test.local`,
    },
  ])
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "External MCP Member Disconnect Org",
    slug: `external-mcp-member-disconnect-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values([
    { id: memberId, organizationId, userId: memberUserId, role: "member" },
    { id: adminMemberId, organizationId, userId: adminUserId, role: "admin" },
  ])
  const now = new Date()
  await db.insert(schema.AuthSessionTable).values([
    {
      id: memberSessionId,
      userId: memberUserId,
      activeOrganizationId: organizationId,
      token: memberSessionToken,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
      createdAt: now,
    },
    {
      id: adminSessionId,
      userId: adminUserId,
      activeOrganizationId: organizationId,
      token: adminSessionToken,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
      createdAt: now,
    },
  ])
})

afterAll(async () => {
  await db.delete(schema.ExternalMcpOAuthTransactionTable).where(
    drizzle.eq(schema.ExternalMcpOAuthTransactionTable.organizationId, organizationId),
  )
  await db.delete(schema.ConnectedAccountTable).where(
    drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId),
  )
  await db.delete(schema.OrgOAuthClientTable).where(
    drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId),
  )
  await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(
    drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.organizationId, organizationId),
  )
  await db.delete(schema.ExternalMcpConnectionTable).where(
    drizzle.eq(schema.ExternalMcpConnectionTable.organizationId, organizationId),
  )
  await db.delete(schema.AuthSessionTable).where(
    drizzle.inArray(schema.AuthSessionTable.id, [memberSessionId, adminSessionId]),
  )
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [memberUserId, adminUserId]))
})

function request(sessionToken: string, path: string) {
  return app.fetch(new Request(`http://den-api.local${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
  }))
}

async function createPerMemberConnection(label: string) {
  return connections.createExternalMcpConnection({
    organizationId,
    name: label,
    url: `https://mcp.example.test/${label.toLowerCase().replaceAll(" ", "-")}`,
    authType: "oauth",
    credentialMode: "per_member",
    createdByOrgMembershipId: adminMemberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
}

async function connectBothMembers(connectionId: DenTypeId<"externalMcpConnection">) {
  const memberAccount = await oauthCredentials.upsertConnectedAccount({
    organizationId,
    orgMembershipId: memberId,
    providerId: connectionId,
    accessToken: "member-access-token",
    refreshToken: "member-refresh-token",
  })
  const adminAccount = await oauthCredentials.upsertConnectedAccount({
    organizationId,
    orgMembershipId: adminMemberId,
    providerId: connectionId,
    accessToken: "admin-access-token",
    refreshToken: "admin-refresh-token",
  })
  return { adminAccount, memberAccount }
}

describe("per-member external MCP disconnect", () => {
  test("removes only the caller's account and pending OAuth work", async () => {
    const connection = await createPerMemberConnection("Member isolation")
    await connectBothMembers(connection.id)
    await Promise.all([
      connections.saveExternalMcpOAuthTransaction({
        organizationId,
        connectionId: connection.id,
        orgMembershipId: memberId,
        authorizationActor: { orgMembershipId: memberId },
        expectedAuthorizationEpoch: connection.oauthAuthorizationEpoch,
        signedState: "member-pending-state",
        codeVerifier: "m".repeat(43),
      }),
      connections.saveExternalMcpOAuthTransaction({
        organizationId,
        connectionId: connection.id,
        orgMembershipId: adminMemberId,
        authorizationActor: { orgMembershipId: adminMemberId },
        expectedAuthorizationEpoch: connection.oauthAuthorizationEpoch,
        signedState: "admin-pending-state",
        codeVerifier: "a".repeat(43),
      }),
    ])

    const response = await request(
      memberSessionToken,
      `/v1/mcp-connections/${connection.id}/my-account/disconnect`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    await expect(oauthCredentials.getConnectedAccount({
      organizationId,
      orgMembershipId: memberId,
      providerId: connection.id,
    })).resolves.toBeNull()
    await expect(oauthCredentials.getConnectedAccount({
      organizationId,
      orgMembershipId: adminMemberId,
      providerId: connection.id,
    })).resolves.toEqual(expect.objectContaining({
      accessToken: "admin-access-token",
      refreshToken: "admin-refresh-token",
    }))

    const pendingRows = await db
      .select({ orgMembershipId: schema.ExternalMcpOAuthTransactionTable.orgMembershipId })
      .from(schema.ExternalMcpOAuthTransactionTable)
      .where(drizzle.eq(schema.ExternalMcpOAuthTransactionTable.externalMcpConnectionId, connection.id))
    expect(pendingRows).toEqual([{ orgMembershipId: adminMemberId }])
    await expect(connections.getExternalMcpConnection({
      organizationId,
      connectionId: connection.id,
    })).resolves.toEqual(expect.objectContaining({
      oauthAuthorizationEpoch: connection.oauthAuthorizationEpoch,
    }))

    await expect(connections.saveExternalMcpAuthorizationCodeTokens({
      organizationId,
      connectionId: connection.id,
      authorizationActor: { orgMembershipId: memberId },
      expectedAuthorizationEpoch: connection.oauthAuthorizationEpoch,
      orgMembershipId: memberId,
      accessToken: "late-member-access-token",
    })).rejects.toThrow("disconnected")
    await expect(oauthCredentials.getConnectedAccount({
      organizationId,
      orgMembershipId: memberId,
      providerId: connection.id,
    })).resolves.toBeNull()
  })

  test("the personal endpoint cannot clear a shared organization credential", async () => {
    const connection = await connections.createExternalMcpConnection({
      organizationId,
      name: "Shared isolation",
      url: "https://mcp.example.test/shared-isolation",
      authType: "oauth",
      credentialMode: "shared",
      createdByOrgMembershipId: adminMemberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    await db.update(schema.ExternalMcpConnectionTable).set({
      accessToken: "shared-access-token",
      refreshToken: "shared-refresh-token",
      connectedAt: new Date(),
    }).where(drizzle.eq(schema.ExternalMcpConnectionTable.id, connection.id))

    const response = await request(
      memberSessionToken,
      `/v1/mcp-connections/${connection.id}/my-account/disconnect`,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "invalid_request",
      details: [{ message: "Only per-member MCP connections have a personal account to disconnect." }],
    })
    await expect(connections.getExternalMcpConnection({
      organizationId,
      connectionId: connection.id,
    })).resolves.toEqual(expect.objectContaining({
      accessToken: "shared-access-token",
      refreshToken: "shared-refresh-token",
    }))
  })

  test("the existing admin disconnect still clears every account", async () => {
    const connection = await createPerMemberConnection("Admin global disconnect")
    await connectBothMembers(connection.id)

    const response = await request(
      adminSessionToken,
      `/v1/mcp-connections/${connection.id}/disconnect`,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    for (const orgMembershipId of [memberId, adminMemberId]) {
      await expect(oauthCredentials.getConnectedAccount({
        organizationId,
        orgMembershipId,
        providerId: connection.id,
      })).resolves.toBeNull()
    }
  })
})
