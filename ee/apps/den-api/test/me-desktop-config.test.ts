import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DEN_MCP_CONNECTIONS_GATING_ENABLED = "true"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let session: typeof import("../src/session.js")
let env: typeof import("../src/env.js").env
let memberFacingMcpConnectionsEnabled: typeof import("../src/capability-sources/external-mcp-rollout.js")["memberFacingMcpConnectionsEnabled"]

const userId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const capabilityOrganizationId = createDenTypeId("organization")
const capabilityMemberId = createDenTypeId("member")
const flatConnectMetadata = {
  connectEnabled: true,
  brandAppName: "Acme Work",
  brandLogoUrl: "https://den.example-corp.internal/assets/wordmark.svg",
  brandIconUrl: "https://den.example-corp.internal/assets/icon.png",
}
const capabilityMetadata = { capabilities: { mcpConnections: true } }

beforeAll(async () => {
  seedRequiredEnv()
  const [appMod, dbMod, schemaMod, drizzleMod, sessionMod, envMod, rolloutMod] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/session.js"),
    import("../src/env.js"),
    import("../src/capability-sources/external-mcp-rollout.js"),
  ])
  app = appMod.default
  db = dbMod.db
  schema = schemaMod
  drizzle = drizzleMod
  session = sessionMod
  env = envMod.env
  memberFacingMcpConnectionsEnabled = rolloutMod.memberFacingMcpConnectionsEnabled

  await db.insert(schema.AuthUserTable).values({
    id: userId,
    name: "Desktop Config User",
    email: `desktop-config+${userId}@test.local`,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Desktop Config Org",
    slug: `desktop-config-${organizationId}`,
    metadata: flatConnectMetadata,
  })
  await db.insert(schema.OrganizationTable).values({
    id: capabilityOrganizationId,
    name: "Desktop Config Capability Org",
    slug: `desktop-config-capability-${capabilityOrganizationId}`,
    metadata: capabilityMetadata,
  })
  await db.insert(schema.MemberTable).values([
    {
      id: memberId,
      organizationId,
      userId,
      role: "owner",
    },
    {
      id: capabilityMemberId,
      organizationId: capabilityOrganizationId,
      userId,
      role: "owner",
    },
  ])
})

afterAll(async () => {
  const memberIds = [memberId, capabilityMemberId]
  const organizationIds = [organizationId, capabilityOrganizationId]
  await db.delete(schema.MemberTable).where(drizzle.inArray(schema.MemberTable.id, memberIds))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.inArray(schema.OrganizationRoleTable.organizationId, organizationIds))
  await db.delete(schema.OrganizationTable).where(drizzle.inArray(schema.OrganizationTable.id, organizationIds))
  await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, userId))
})

async function requestDesktopConfig(activeOrganizationId: string) {
  const response = await app.fetch(new Request("http://den-api.local/v1/me/desktop-config", {
    headers: {
      "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({ userId, organizationId: activeOrganizationId }),
    },
  }))

  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  expect(isRecord(body)).toBe(true)
  if (!isRecord(body)) {
    throw new Error("Desktop config response was not an object")
  }
  return body
}

function expectConnectEnabled(body: Record<string, unknown>, metadata: Record<string, unknown>) {
  const expected = memberFacingMcpConnectionsEnabled(metadata, {
    gatingEnabled: env.mcpConnectionsGatingEnabled,
  })
  expect(typeof body.connectEnabled).toBe("boolean")
  expect(body.connectEnabled).toBe(expected)
}

test("GET /v1/me/desktop-config exposes the effective connectEnabled org flag", async () => {
  const flatBody = await requestDesktopConfig(organizationId)
  expectConnectEnabled(flatBody, flatConnectMetadata)
  expect(flatBody.brandAppName).toBe(flatConnectMetadata.brandAppName)
  expect(flatBody.brandLogoUrl).toBe(flatConnectMetadata.brandLogoUrl)
  expect(flatBody.brandIconUrl).toBe(flatConnectMetadata.brandIconUrl)

  const capabilityBody = await requestDesktopConfig(capabilityOrganizationId)
  expectConnectEnabled(capabilityBody, capabilityMetadata)
  expect(capabilityBody.connectEnabled).toBe(true)
})
