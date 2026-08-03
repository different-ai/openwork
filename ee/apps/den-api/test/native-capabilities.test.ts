import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { OpenApiOperation } from "../src/mcp/policy.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_nativecaps"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let observedAuthorization: string | null = null
let googleRequestCount = 0
const fakeGoogleServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    googleRequestCount += 1
    observedAuthorization = request.headers.get("authorization")
    const url = new URL(request.url)
    if (url.pathname === "/gmail/v1/users/me/messages") {
      return Response.json({ messages: [] })
    }
    return new Response(`Unhandled fake Google route: ${url.pathname}`, { status: 404 })
  },
})

seedRequiredEnv()
process.env.DEN_GOOGLE_API_BASE_URL = fakeGoogleServer.url.origin

type TestOpenApiDocument = {
  paths?: Record<string, Record<string, OpenApiOperation>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isOpenApiDocument(value: unknown): value is TestOpenApiDocument {
  return isRecord(value) && (value.paths === undefined || isRecord(value.paths))
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let catalog: ReturnType<typeof import("../src/mcp/catalog.js").buildMcpCatalog>
let nativeCapabilities: typeof import("../src/mcp/native-capabilities.js")
let session: typeof import("../src/session.js")
let oauthCredentials: typeof import("../src/capability-sources/oauth-credentials.js")
let createExternalMcpConnection: typeof import("../src/capability-sources/external-mcp-connections.js").createExternalMcpConnection

const organizationId = createDenTypeId("organization")
const userId = createDenTypeId("user")
const memberId = createDenTypeId("member")
const disconnectedUserId = createDenTypeId("user")
const disconnectedMemberId = createDenTypeId("member")
let labsConnectionId: DenTypeId<"externalMcpConnection">
let operationsConnectionId: DenTypeId<"externalMcpConnection">

const member = { orgMembershipId: memberId, teamIds: [] }
const disconnectedMember = { orgMembershipId: disconnectedMemberId, teamIds: [] }
const principal = {
  userId,
  organizationId,
  scopes: new Set(["mcp:read", "mcp:write"]),
  payload: {},
}

async function seedCredential(providerId: string, token: string, externalAccountId: string) {
  await oauthCredentials.upsertOrgOAuthClient({
    organizationId,
    providerId,
    clientId: `client-${providerId}`,
    clientSecret: `secret-${providerId}`,
    createdByOrgMembershipId: memberId,
  })
  await oauthCredentials.upsertConnectedAccount({
    organizationId,
    orgMembershipId: memberId,
    providerId,
    externalAccountId,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    accessToken: token,
    refreshToken: `refresh-${token}`,
    tokenType: "Bearer",
    expiresAt: new Date("2037-01-01T00:00:00Z"),
    pendingCodeVerifier: null,
  })
}

beforeAll(async () => {
  const [appImport, dbImport, schemaImport, drizzleImport, catalogImport, nativeImport, sessionImport, oauthImport, connectionsImport] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/mcp/catalog.js"),
    import("../src/mcp/native-capabilities.js"),
    import("../src/session.js"),
    import("../src/capability-sources/oauth-credentials.js"),
    import("../src/capability-sources/external-mcp-connections.js"),
  ])
  app = appImport.default
  db = dbImport.db
  schema = schemaImport
  drizzle = drizzleImport
  nativeCapabilities = nativeImport
  session = sessionImport
  oauthCredentials = oauthImport
  createExternalMcpConnection = connectionsImport.createExternalMcpConnection

  await db.insert(schema.AuthUserTable).values([
    { id: userId, name: "Native Capability User", email: `${userId}@native-capability.test` },
    { id: disconnectedUserId, name: "Disconnected Native User", email: `${disconnectedUserId}@native-capability.test` },
  ])
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Native Capability Org",
    slug: `native-capability-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values([
    { id: memberId, organizationId, userId, role: "member" },
    { id: disconnectedMemberId, organizationId, userId: disconnectedUserId, role: "member" },
  ])

  const labs = await createExternalMcpConnection({
    organizationId,
    name: "Acme Labs",
    url: "https://workspace.google.com",
    authType: "oauth",
    kind: "native_provider",
    nativeProviderKey: "google-workspace",
    credentialMode: "per_member",
    createdByOrgMembershipId: memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  const operations = await createExternalMcpConnection({
    organizationId,
    name: "Acme Operations",
    url: "https://workspace.google.com",
    authType: "oauth",
    kind: "native_provider",
    nativeProviderKey: "google-workspace",
    credentialMode: "per_member",
    createdByOrgMembershipId: memberId,
    access: { orgWide: true, memberIds: [], teamIds: [] },
  })
  labsConnectionId = labs.id
  operationsConnectionId = operations.id
  await seedCredential(labs.id, "labs-token", "labs@example.com")
  await seedCredential(operations.id, "operations-token", "operations@example.com")
  await seedCredential("google-workspace", "legacy-token", "legacy@example.com")

  const openApiResponse = await app.request("http://den-api.local/openapi.json")
  const document: unknown = await openApiResponse.json()
  if (!isOpenApiDocument(document)) throw new Error("openapi.json did not look like an OpenAPI document")
  catalog = catalogImport.buildMcpCatalog(document)
})

afterAll(async () => {
  await db.delete(schema.ConnectedAccountTable).where(drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId))
  await db.delete(schema.OrgOAuthClientTable).where(drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionTable).where(drizzle.eq(schema.ExternalMcpConnectionTable.organizationId, organizationId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [userId, disconnectedUserId]))
  fakeGoogleServer.stop(true)
})

describe("native capability names", () => {
  test("build and parse round-trip", () => {
    const name = nativeCapabilities.buildNativeCapabilityName(labsConnectionId, "getCapabilitiesGoogleWorkspaceGmailMessages")
    expect(name).toBe(`native:${labsConnectionId}:getCapabilitiesGoogleWorkspaceGmailMessages`)
    expect(nativeCapabilities.parseNativeCapabilityName(name)).toEqual({
      connectionId: labsConnectionId,
      toolName: "getCapabilitiesGoogleWorkspaceGmailMessages",
    })
  })
})

describe("native capability search", () => {
  test("prefixes both connector names and ranks a queried connector first", async () => {
    const matches = await nativeCapabilities.searchNativeCapabilities({
      organizationId,
      member,
      query: "Acme Labs gmail drafts",
      catalog,
      limit: 20,
    })
    const draftTool = "postCapabilitiesGoogleWorkspaceGmailDrafts"
    const labsDraft = matches.find((match) => match.name === nativeCapabilities.buildNativeCapabilityName(labsConnectionId, draftTool))
    const operationsDraft = matches.find((match) => match.name === nativeCapabilities.buildNativeCapabilityName(operationsConnectionId, draftTool))
    expect(matches[0]?.name.startsWith(`native:${labsConnectionId}:`)).toBe(true)
    expect(labsDraft?.summary.startsWith("[Acme Labs]")).toBe(true)
    expect(operationsDraft?.summary.startsWith("[Acme Operations]")).toBe(true)
    expect(labsDraft?.inputSchema).toBe(catalog.find((operation) => operation.name === draftTool)?.inputSchema)
  })

  test("returns one connection status instead of tools for a disconnected connector", async () => {
    const matches = await nativeCapabilities.searchNativeCapabilities({
      organizationId,
      member: disconnectedMember,
      query: "Acme Labs gmail drafts",
      catalog,
      limit: 20,
    })
    const labsMatches = matches.filter((match) => match.name.startsWith(`native:${labsConnectionId}:`))
    expect(labsMatches).toHaveLength(1)
    expect(labsMatches[0]).toMatchObject({
      name: `native:${labsConnectionId}:*`,
      kind: "connection_status",
      status: "needs_connection",
    })
  })
})

describe("native capability execute", () => {
  test("uses the selected connector credential", async () => {
    observedAuthorization = null
    googleRequestCount = 0
    const result = await nativeCapabilities.executeNativeCapability({
      app,
      env: undefined,
      name: nativeCapabilities.buildNativeCapabilityName(operationsConnectionId, "getCapabilitiesGoogleWorkspaceGmailMessages"),
      organizationId,
      member,
      catalog,
      principal,
      query: { maxResults: 1 },
    })
    expect(result?.isError).not.toBe(true)
    expect(googleRequestCount).toBe(1)
    expect(observedAuthorization).toBe("Bearer operations-token")
  })

  test("supports the legacy google-workspace alias", async () => {
    observedAuthorization = null
    const result = await nativeCapabilities.executeNativeCapability({
      app,
      env: undefined,
      name: "native:google-workspace:getCapabilitiesGoogleWorkspaceGmailMessages",
      organizationId,
      member,
      catalog,
      principal,
    })
    expect(result?.isError).not.toBe(true)
    expect(observedAuthorization).toBe("Bearer legacy-token")
  })

  test("returns needs_connection when the selected connector is not connected for the member", async () => {
    googleRequestCount = 0
    const result = await nativeCapabilities.executeNativeCapability({
      app,
      env: undefined,
      name: nativeCapabilities.buildNativeCapabilityName(labsConnectionId, "getCapabilitiesGoogleWorkspaceGmailMessages"),
      organizationId,
      member: disconnectedMember,
      catalog,
      principal: {
        userId: disconnectedUserId,
        organizationId,
        scopes: new Set(["mcp:read"]),
        payload: {},
      },
    })
    expect(result?.isError).toBe(true)
    expect(result?.content[0]?.text).toContain('"error": "needs_connection"')
    expect(googleRequestCount).toBe(0)
  })

  test("rejects an unsigned external connector selection header", () => {
    const headers = new Headers({
      "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({ userId, organizationId }),
      [session.INTERNAL_CAPABILITY_CONNECTOR_HEADER]: operationsConnectionId,
    })
    expect(session.readInternalCapabilityConnectorId(headers)).toBeNull()
  })
})
