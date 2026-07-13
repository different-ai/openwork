import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]
const CALENDAR_READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
const GMAIL_DRAFT_SCOPE = "https://www.googleapis.com/auth/gmail.compose"
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_gwsreconnect"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

let mod: typeof import("../src/capability-sources/native-provider-connections.js")
let registry: typeof import("../src/capability-sources/provider-registry.js")
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let oauthCredentials: typeof import("../src/capability-sources/oauth-credentials.js")
let app: typeof import("../src/app.js").default
let session: typeof import("../src/session.js")
let createExternalMcpConnection: typeof import("../src/capability-sources/external-mcp-connections.js").createExternalMcpConnection

const cleanupOrganizationIds: DenTypeId<"organization">[] = []
const cleanupUserIds: DenTypeId<"user">[] = []

beforeAll(async () => {
  seedRequiredEnv()
  const [modImport, registryImport, dbImport, schemaImport, drizzleImport, oauthImport, appImport, sessionImport, externalImport] = await Promise.all([
    import("../src/capability-sources/native-provider-connections.js"),
    import("../src/capability-sources/provider-registry.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/capability-sources/oauth-credentials.js"),
    import("../src/app.js"),
    import("../src/session.js"),
    import("../src/capability-sources/external-mcp-connections.js"),
  ])
  mod = modImport
  registry = registryImport
  db = dbImport.db
  schema = schemaImport
  drizzle = drizzleImport
  oauthCredentials = oauthImport
  app = appImport.default
  session = sessionImport
  createExternalMcpConnection = externalImport.createExternalMcpConnection
})

afterAll(async () => {
  for (const organizationId of cleanupOrganizationIds) {
    await db.delete(schema.ConnectedAccountTable).where(drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId))
    await db.delete(schema.OrgOAuthClientTable).where(drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId))
    await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.organizationId, organizationId))
    await db.delete(schema.ExternalMcpConnectionTable).where(drizzle.eq(schema.ExternalMcpConnectionTable.organizationId, organizationId))
    await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
    await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
    await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  }
  for (const userId of cleanupUserIds) {
    await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, userId))
  }
})

async function seedMember(label: string) {
  const userId = createDenTypeId("user")
  const organizationId = createDenTypeId("organization")
  const memberId = createDenTypeId("member")
  cleanupUserIds.push(userId)
  cleanupOrganizationIds.push(organizationId)

  await db.insert(schema.AuthUserTable).values({
    id: userId,
    name: `${label} User`,
    email: `${label.toLowerCase()}+${userId}@test.local`,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: `${label} Org`,
    slug: `${label.toLowerCase()}-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values({
    id: memberId,
    organizationId,
    userId,
    role: "member",
  })

  return { userId, organizationId, memberId }
}

async function seedGoogleWorkspaceConnection(input: {
  label: string
  features: string[]
  scopes: string[] | null
}) {
  const seeded = await seedMember(input.label)
  await oauthCredentials.upsertOrgOAuthClient({
    organizationId: seeded.organizationId,
    providerId: "google-workspace",
    clientId: `google-client-${seeded.organizationId}`,
    clientSecret: "google-secret",
    extra: { features: input.features },
    createdByOrgMembershipId: seeded.memberId,
  })
  await oauthCredentials.upsertConnectedAccount({
    organizationId: seeded.organizationId,
    orgMembershipId: seeded.memberId,
    providerId: "google-workspace",
    accessToken: `token-${seeded.memberId}`,
    scopes: input.scopes,
  })
  return seeded
}

async function getGoogleWorkspaceEntry(input: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member"> }) {
  const entries = await mod.listNativeProviderUsableEntries({
    organizationId: input.organizationId,
    orgMembershipId: input.memberId,
  })
  return entries.find((entry) => entry.id === "google-workspace")
}

describe("buildNativeProviderEntry", () => {
  test("no org client configured means no entry — the org has not enrolled", () => {
    const provider = registry.getNativeOAuthProvider("google-workspace")!
    expect(mod.buildNativeProviderEntry(provider, { clientConfigured: false, connectedForMe: false })).toBeNull()
  })

  test("a configured provider renders as a per-member, connectable entry", () => {
    const provider = registry.getNativeOAuthProvider("google-workspace")!
    expect(mod.buildNativeProviderEntry(provider, { clientConfigured: true, connectedForMe: false })).toEqual({
      id: "google-workspace",
      name: "Google Workspace",
      url: "https://workspace.google.com",
      authType: "oauth",
      credentialMode: "per_member",
      connected: true,
      connectedAt: null,
      connectedForMe: false,
      needsReconnect: false,
      missingFeatures: [],
      access: null,
    })
  })

  test("the calling member's own connection state flips connectedForMe only", () => {
    const provider = registry.getNativeOAuthProvider("google-workspace")!
    const entry = mod.buildNativeProviderEntry(provider, { clientConfigured: true, connectedForMe: true })!
    expect(entry.connectedForMe).toBe(true)
    expect(entry.connected).toBe(true)
    expect(entry.credentialMode).toBe("per_member")
  })

  test("covered member scopes do not ask for reconnect", async () => {
    const seeded = await seedGoogleWorkspaceConnection({
      label: "CoveredScopes",
      features: ["calendarRead", "gmailRead"],
      scopes: [...IDENTITY_SCOPES, CALENDAR_READ_SCOPE, GMAIL_READ_SCOPE],
    })

    const entry = await getGoogleWorkspaceEntry({ organizationId: seeded.organizationId, memberId: seeded.memberId })
    expect(entry?.needsReconnect).toBe(false)
    expect(entry?.missingFeatures).toEqual([])
  })

  test("admin-added Gmail read scope is surfaced as reconnect drift", async () => {
    const seeded = await seedGoogleWorkspaceConnection({
      label: "MissingGmailRead",
      features: ["calendarRead", "gmailRead"],
      scopes: [...IDENTITY_SCOPES, CALENDAR_READ_SCOPE],
    })

    const entry = await getGoogleWorkspaceEntry({ organizationId: seeded.organizationId, memberId: seeded.memberId })
    expect(entry?.needsReconnect).toBe(true)
    expect(entry?.missingFeatures).toEqual(["gmailRead"])
  })

  test("unknown member scopes never nag for reconnect", async () => {
    const seeded = await seedGoogleWorkspaceConnection({
      label: "UnknownScopes",
      features: ["calendarRead", "gmailRead"],
      scopes: null,
    })

    const entry = await getGoogleWorkspaceEntry({ organizationId: seeded.organizationId, memberId: seeded.memberId })
    expect(entry?.needsReconnect).toBe(false)
    expect(entry?.missingFeatures).toEqual([])
  })

  test("legacy default features participate in missing feature reporting", async () => {
    const seeded = await seedGoogleWorkspaceConnection({
      label: "LegacyDefaults",
      features: ["calendarRead"],
      scopes: [...IDENTITY_SCOPES, CALENDAR_READ_SCOPE],
    })
    await oauthCredentials.upsertOrgOAuthClient({
      organizationId: seeded.organizationId,
      providerId: "google-workspace",
      clientId: `google-client-updated-${seeded.organizationId}`,
      clientSecret: "google-secret",
      extra: null,
      createdByOrgMembershipId: seeded.memberId,
    })

    const entry = await getGoogleWorkspaceEntry({ organizationId: seeded.organizationId, memberId: seeded.memberId })
    expect(entry?.needsReconnect).toBe(true)
    expect(entry?.missingFeatures).toEqual(["gmailDraft", "driveFile"])
  })

  test("a late token refresh cannot recreate or overwrite a disconnected grant", async () => {
    const seeded = await seedMember("RefreshFence")
    const original = await oauthCredentials.upsertConnectedAccount({
      organizationId: seeded.organizationId,
      orgMembershipId: seeded.memberId,
      providerId: "google-workspace",
      accessToken: "expired-access",
      refreshToken: "original-refresh",
      expiresAt: new Date("2001-01-01T00:00:00.000Z"),
    })

    await oauthCredentials.disconnectAccount({
      organizationId: seeded.organizationId,
      orgMembershipId: seeded.memberId,
      providerId: "google-workspace",
    })
    await expect(oauthCredentials.refreshConnectedAccountForActiveMember({
      organizationId: seeded.organizationId,
      orgMembershipId: seeded.memberId,
      providerId: "google-workspace",
      expectedAccountId: original.id,
      expectedAccessToken: "expired-access",
      expectedRefreshToken: "original-refresh",
      accessToken: "late-access",
      refreshToken: "late-refresh",
      expiresAt: new Date(Date.now() + 3_600_000),
    })).resolves.toBeNull()
    await expect(oauthCredentials.getConnectedAccount({
      organizationId: seeded.organizationId,
      orgMembershipId: seeded.memberId,
      providerId: "google-workspace",
    })).resolves.toBeNull()

    const replacement = await oauthCredentials.upsertConnectedAccount({
      organizationId: seeded.organizationId,
      orgMembershipId: seeded.memberId,
      providerId: "google-workspace",
      accessToken: "replacement-access",
      refreshToken: "replacement-refresh",
    })
    await expect(oauthCredentials.refreshConnectedAccountForActiveMember({
      organizationId: seeded.organizationId,
      orgMembershipId: seeded.memberId,
      providerId: "google-workspace",
      expectedAccountId: original.id,
      expectedAccessToken: "expired-access",
      expectedRefreshToken: "original-refresh",
      accessToken: "late-access",
    })).resolves.toBeNull()
    await expect(oauthCredentials.getConnectedAccount({
      organizationId: seeded.organizationId,
      orgMembershipId: seeded.memberId,
      providerId: "google-workspace",
    })).resolves.toMatchObject({
      id: replacement.id,
      accessToken: "replacement-access",
      refreshToken: "replacement-refresh",
    })
  })

  test("external connection list rows omit native reconnect fields", async () => {
    const seeded = await seedMember("ExternalRows")
    const connection = await createExternalMcpConnection({
      organizationId: seeded.organizationId,
      name: "External No Auth",
      url: "https://example.com/mcp",
      authType: "none",
      credentialMode: "shared",
      createdByOrgMembershipId: seeded.memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })

    const response = await app.fetch(new Request("http://den-api.local/v1/mcp-connections", {
      headers: {
        "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({ userId: seeded.userId, organizationId: seeded.organizationId }),
      },
    }))
    expect(response.status).toBe(200)

    const body: unknown = await response.json()
    if (!isRecord(body) || !Array.isArray(body.connections)) {
      throw new Error("MCP connections response was incomplete.")
    }
    const row = body.connections.find((entry) => isRecord(entry) && entry.id === connection.id)
    expect(isRecord(row)).toBe(true)
    if (!isRecord(row)) {
      throw new Error("External connection row was missing.")
    }
    expect(Object.hasOwn(row, "needsReconnect")).toBe(false)
    expect(Object.hasOwn(row, "missingFeatures")).toBe(false)
  })
})
