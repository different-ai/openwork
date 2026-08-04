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

type OAuthIdentityMode = "id-token" | "userinfo-failure"
let oauthIdentityMode: OAuthIdentityMode = "id-token"
let userinfoRequestCount = 0

function idTokenWithEmail(email: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }), "utf8").toString("base64url")
  const payload = Buffer.from(JSON.stringify({ email }), "utf8").toString("base64url")
  return `${header}.${payload}.mock-signature`
}

const fakeOAuthServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/token") {
      return Response.json({
        access_token: "callback-access-token",
        refresh_token: "callback-refresh-token",
        token_type: "Bearer",
        expires_in: 3_600,
        ...(oauthIdentityMode === "id-token" ? { id_token: idTokenWithEmail("connected@example.com") } : {}),
      })
    }
    if (url.pathname === "/userinfo") {
      userinfoRequestCount += 1
      return Response.json({ error: "userinfo unavailable" }, { status: 503 })
    }
    return new Response("Not found", { status: 404 })
  },
})

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_gwsreconnect"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DEN_GOOGLE_OAUTH_AUTHORIZE_URL = `${fakeOAuthServer.url.origin}/authorize`
  process.env.DEN_GOOGLE_OAUTH_TOKEN_URL = `${fakeOAuthServer.url.origin}/token`
  process.env.DEN_GOOGLE_OAUTH_USERINFO_URL = `${fakeOAuthServer.url.origin}/userinfo`
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
let genericOAuth: typeof import("../src/capability-sources/generic-oauth.js")

const cleanupOrganizationIds: DenTypeId<"organization">[] = []
const cleanupUserIds: DenTypeId<"user">[] = []

beforeAll(async () => {
  seedRequiredEnv()
  const [modImport, registryImport, dbImport, schemaImport, drizzleImport, oauthImport, appImport, sessionImport, externalImport, genericOAuthImport] = await Promise.all([
    import("../src/capability-sources/native-provider-connections.js"),
    import("../src/capability-sources/provider-registry.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/capability-sources/oauth-credentials.js"),
    import("../src/app.js"),
    import("../src/session.js"),
    import("../src/capability-sources/external-mcp-connections.js"),
    import("../src/capability-sources/generic-oauth.js"),
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
  genericOAuth = genericOAuthImport
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
  fakeOAuthServer.stop(true)
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

async function seedAdditionalMember(input: { label: string; organizationId: DenTypeId<"organization"> }) {
  const userId = createDenTypeId("user")
  const memberId = createDenTypeId("member")
  cleanupUserIds.push(userId)
  await db.insert(schema.AuthUserTable).values({
    id: userId,
    name: `${input.label} User`,
    email: `${input.label.toLowerCase()}+${userId}@test.local`,
  })
  await db.insert(schema.MemberTable).values({
    id: memberId,
    organizationId: input.organizationId,
    userId,
    role: "member",
  })
  return { userId, memberId }
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

async function seedPendingGoogleOAuth(label: string) {
  const seeded = await seedMember(label)
  await oauthCredentials.upsertOrgOAuthClient({
    organizationId: seeded.organizationId,
    providerId: "google-workspace",
    clientId: "google-client-id",
    clientSecret: "google-client-secret",
    createdByOrgMembershipId: seeded.memberId,
  })
  const pending = await oauthCredentials.upsertConnectedAccount({
    organizationId: seeded.organizationId,
    orgMembershipId: seeded.memberId,
    providerId: "google-workspace",
    pendingCodeVerifier: "callback-pkce-verifier",
  })
  const secret = process.env.BETTER_AUTH_SECRET
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required")
  const state = genericOAuth.createOAuthStateToken({
    organizationId: seeded.organizationId,
    orgMembershipId: seeded.memberId,
    providerId: "google-workspace",
    secret,
  })
  const callbackUrl = new URL("http://den-api.local/v1/oauth-providers/google-workspace/connect/callback")
  callbackUrl.searchParams.set("code", "authorization-code")
  callbackUrl.searchParams.set("state", state)
  return { ...seeded, pending, callbackUrl }
}

function principalRequest(input: {
  organizationId: DenTypeId<"organization">
  path: string
  userId: DenTypeId<"user">
}) {
  return app.fetch(new Request(`http://den-api.local${input.path}`, {
    headers: {
      "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({
        userId: input.userId,
        organizationId: input.organizationId,
      }),
    },
  }))
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

  test("OAuth callback records the email from the token endpoint id_token", async () => {
    oauthIdentityMode = "id-token"
    userinfoRequestCount = 0
    const seeded = await seedPendingGoogleOAuth("IdTokenIdentity")

    const response = await app.request(seeded.callbackUrl.toString())
    expect(response.status).toBe(200)
    expect(userinfoRequestCount).toBe(0)
    await expect(oauthCredentials.getConnectedAccount({
      organizationId: seeded.organizationId,
      orgMembershipId: seeded.memberId,
      providerId: "google-workspace",
    })).resolves.toMatchObject({
      id: seeded.pending.id,
      externalAccountId: "connected@example.com",
      accessToken: "callback-access-token",
      pendingCodeVerifier: null,
    })
  })

  test("OAuth callback still completes when id_token is absent and userinfo fails", async () => {
    oauthIdentityMode = "userinfo-failure"
    userinfoRequestCount = 0
    const seeded = await seedPendingGoogleOAuth("UserinfoFailure")

    const response = await app.request(seeded.callbackUrl.toString())
    expect(response.status).toBe(200)
    expect(userinfoRequestCount).toBe(1)
    await expect(oauthCredentials.getConnectedAccount({
      organizationId: seeded.organizationId,
      orgMembershipId: seeded.memberId,
      providerId: "google-workspace",
    })).resolves.toMatchObject({
      id: seeded.pending.id,
      externalAccountId: null,
      accessToken: "callback-access-token",
      pendingCodeVerifier: null,
    })
  })

  test("two native Google connectors connect independently and connect/start skips MCP discovery", async () => {
    oauthIdentityMode = "id-token"
    const seeded = await seedMember("TwoGoogleConnectors")
    const provider = registry.getNativeOAuthProvider("google-workspace")
    if (!provider) throw new Error("google-workspace provider is missing")
    const first = await createExternalMcpConnection({
      organizationId: seeded.organizationId,
      name: "Acme Google",
      url: provider.websiteUrl,
      authType: "oauth",
      kind: "native_provider",
      nativeProviderKey: provider.providerId,
      credentialMode: "per_member",
      createdByOrgMembershipId: seeded.memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    const second = await createExternalMcpConnection({
      organizationId: seeded.organizationId,
      name: "Subsidiary Google",
      url: provider.websiteUrl,
      authType: "oauth",
      kind: "native_provider",
      nativeProviderKey: provider.providerId,
      credentialMode: "per_member",
      createdByOrgMembershipId: seeded.memberId,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    })
    await oauthCredentials.upsertOrgOAuthClient({
      organizationId: seeded.organizationId,
      providerId: first.id,
      clientId: "first-google-client",
      clientSecret: "first-google-secret",
      createdByOrgMembershipId: seeded.memberId,
    })
    await oauthCredentials.upsertOrgOAuthClient({
      organizationId: seeded.organizationId,
      providerId: second.id,
      clientId: "second-google-client",
      clientSecret: "second-google-secret",
      createdByOrgMembershipId: seeded.memberId,
    })

    for (const connection of [first, second]) {
      const startResponse = await principalRequest({
        organizationId: seeded.organizationId,
        path: `/v1/mcp-connections/${connection.id}/connect/start`,
        userId: seeded.userId,
      })
      expect(startResponse.status).toBe(200)
      const startBody: unknown = await startResponse.json()
      if (!isRecord(startBody) || typeof startBody.authorizeUrl !== "string") {
        throw new Error("Native connector connect/start did not return an authorize URL")
      }
      const authorizeUrl = new URL(startBody.authorizeUrl)
      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("http://den-api.local/v1/oauth-providers/google-workspace/connect/callback")
      const state = authorizeUrl.searchParams.get("state")
      if (!state) throw new Error("Native connector authorize URL omitted state")
      const verified = genericOAuth.verifyOAuthStateToken({ token: state, secret: process.env.BETTER_AUTH_SECRET ?? "" })
      expect(verified?.providerId).toBe(connection.id)
      expect(verified?.binding).toBe("google-workspace")

      const callbackUrl = new URL("http://den-api.local/v1/oauth-providers/google-workspace/connect/callback")
      callbackUrl.searchParams.set("code", `code-${connection.id}`)
      callbackUrl.searchParams.set("state", state)
      const callbackResponse = await app.request(callbackUrl.toString())
      expect(callbackResponse.status).toBe(200)
    }

    const [firstAccount, secondAccount] = await Promise.all([
      oauthCredentials.getConnectedAccount({
        organizationId: seeded.organizationId,
        orgMembershipId: seeded.memberId,
        providerId: first.id,
      }),
      oauthCredentials.getConnectedAccount({
        organizationId: seeded.organizationId,
        orgMembershipId: seeded.memberId,
        providerId: second.id,
      }),
    ])
    expect(firstAccount?.id).not.toBe(secondAccount?.id)
    expect(firstAccount?.accessToken).toBe("callback-access-token")
    expect(secondAccount?.accessToken).toBe("callback-access-token")

    const entries = await mod.listNativeProviderUsableEntries({
      organizationId: seeded.organizationId,
      orgMembershipId: seeded.memberId,
    })
    expect(entries.map((entry) => entry.id).sort()).toEqual([first.id, second.id].sort())
    expect(entries.every((entry) => entry.connectedForMe)).toBe(true)
  })

  test("the legacy Google alias remains listed and connectable", async () => {
    const seeded = await seedMember("LegacyGoogleAlias")
    await oauthCredentials.upsertOrgOAuthClient({
      organizationId: seeded.organizationId,
      providerId: "google-workspace",
      clientId: "legacy-google-client",
      clientSecret: "legacy-google-secret",
      createdByOrgMembershipId: seeded.memberId,
    })

    const entries = await mod.listNativeProviderUsableEntries({
      organizationId: seeded.organizationId,
      orgMembershipId: seeded.memberId,
    })
    expect(entries.map((entry) => entry.id)).toContain("google-workspace")

    const response = await principalRequest({
      organizationId: seeded.organizationId,
      path: "/v1/mcp-connections/google-workspace/connect/start",
      userId: seeded.userId,
    })
    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    if (!isRecord(body) || typeof body.authorizeUrl !== "string") {
      throw new Error("Legacy Google alias did not return an authorize URL")
    }
    const authorizeUrl = new URL(body.authorizeUrl)
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("http://den-api.local/v1/oauth-providers/google-workspace/connect/callback")
    const state = authorizeUrl.searchParams.get("state")
    if (!state) throw new Error("Legacy Google alias omitted state")
    expect(genericOAuth.verifyOAuthStateToken({ token: state, secret: process.env.BETTER_AUTH_SECRET ?? "" })).toMatchObject({
      providerId: "google-workspace",
      binding: "google-workspace",
    })
  })

  test("native connector connect/start requires a member access grant", async () => {
    const ungranted = await seedMember("NativeConnectorUngranted")
    const granted = await seedAdditionalMember({
      label: "NativeConnectorGranted",
      organizationId: ungranted.organizationId,
    })
    const provider = registry.getNativeOAuthProvider("google-workspace")
    if (!provider) throw new Error("google-workspace provider is missing")
    const connection = await createExternalMcpConnection({
      organizationId: ungranted.organizationId,
      name: "Granted Google",
      url: provider.websiteUrl,
      authType: "oauth",
      kind: "native_provider",
      nativeProviderKey: provider.providerId,
      credentialMode: "per_member",
      createdByOrgMembershipId: ungranted.memberId,
      access: { orgWide: false, memberIds: [granted.memberId], teamIds: [] },
    })
    await oauthCredentials.upsertOrgOAuthClient({
      organizationId: ungranted.organizationId,
      providerId: connection.id,
      clientId: "granted-google-client",
      clientSecret: "granted-google-secret",
      createdByOrgMembershipId: ungranted.memberId,
    })

    const explicitDenied = await principalRequest({
      organizationId: ungranted.organizationId,
      path: `/v1/mcp-connections/${connection.id}/connect/start`,
      userId: ungranted.userId,
    })
    expect(explicitDenied.status).toBe(403)
    await expect(explicitDenied.json()).resolves.toEqual({
      error: "forbidden",
      message: "You have not been granted access to this connection.",
    })

    const oauthProviderDenied = await principalRequest({
      organizationId: ungranted.organizationId,
      path: `/v1/oauth-providers/${connection.id}/connect/start`,
      userId: ungranted.userId,
    })
    expect(oauthProviderDenied.status).toBe(403)
    await expect(oauthProviderDenied.json()).resolves.toEqual({
      error: "forbidden",
      message: "You have not been granted access to this connection.",
    })

    const aliasDenied = await principalRequest({
      organizationId: ungranted.organizationId,
      path: "/v1/mcp-connections/google-workspace/connect/start",
      userId: ungranted.userId,
    })
    expect(aliasDenied.status).toBe(404)
    await expect(aliasDenied.json()).resolves.toMatchObject({ error: "client_not_configured" })

    for (const path of [
      `/v1/mcp-connections/${connection.id}/connect/start`,
      `/v1/oauth-providers/${connection.id}/connect/start`,
      "/v1/mcp-connections/google-workspace/connect/start",
    ]) {
      const response = await principalRequest({
        organizationId: ungranted.organizationId,
        path,
        userId: granted.userId,
      })
      expect(response.status).toBe(200)
    }
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
