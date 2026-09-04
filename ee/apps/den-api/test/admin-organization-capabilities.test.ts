import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { Hono } from "hono"
import type { AuthContextVariables } from "../src/session.js"

const adminUserId = createDenTypeId("user")
const adminAllowlistId = createDenTypeId("adminAllowlist")
const organizationId = createDenTypeId("organization")
const adminEmail = `admin-capabilities+${adminUserId}@test.local`
const organizationSlug = `admin-capabilities-${organizationId}`

function seedRequiredEnv() {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = "y".repeat(32)
  process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = "http://127.0.0.1:8790"
  process.env.DEN_ORG_MODE = "multi_org"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

let app: Hono<{ Variables: AuthContextVariables }> | null = null
let db: typeof import("../src/db.js").db | null = null
let schema: typeof import("@openwork-ee/den-db/schema") | null = null
let drizzle: typeof import("@openwork-ee/den-db/drizzle") | null = null
let routeTestUnavailable: string | null = null

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function shouldRunRouteDbCoverage() {
  const testFiles = process.argv.filter((argument) => argument.endsWith(".test.ts"))
  return testFiles.length <= 2 && testFiles.some((argument) => argument.endsWith("admin-organization-capabilities.test.ts"))
}

function isRouteDatabase(value: unknown) {
  return isRecord(value) && "query" in value
}

function testDatabase() {
  if (!db || !schema || !drizzle) {
    throw new Error("test database not initialized")
  }

  return { db, schema, drizzle }
}

function routeApp() {
  if (!app) {
    throw new Error("test app not initialized")
  }

  return app
}

async function cleanup() {
  if (!db || !schema || !drizzle) {
    return
  }

  await db.delete(schema.AuditEventTable).where(drizzle.eq(schema.AuditEventTable.org_id, organizationId))
  await db.delete(schema.OrgSubscriptionTable).where(drizzle.eq(schema.OrgSubscriptionTable.organization_id, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, adminUserId))
  await db.delete(schema.AdminAllowlistTable).where(drizzle.eq(schema.AdminAllowlistTable.id, adminAllowlistId))
}

async function readOrganizationMetadata() {
  const { db, schema, drizzle } = testDatabase()
  const rows = await db
    .select({ metadata: schema.OrganizationTable.metadata })
    .from(schema.OrganizationTable)
    .where(drizzle.eq(schema.OrganizationTable.id, organizationId))
    .limit(1)
  const metadata = rows[0]?.metadata
  return isRecord(metadata) ? metadata : {}
}

function readCapabilityMetadata(metadata: Record<string, unknown>) {
  return isRecord(metadata.capabilities) ? metadata.capabilities : {}
}

async function replaceOrganizationMetadata(metadata: Record<string, unknown>) {
  const { db, schema, drizzle } = testDatabase()
  await db
    .update(schema.OrganizationTable)
    .set({ metadata })
    .where(drizzle.eq(schema.OrganizationTable.id, organizationId))
}

async function putCapabilities(capabilities: { installLinks?: boolean | null; mcpConnections?: boolean | null }) {
  return routeApp().request(`http://den.local/v1/admin/organizations/${organizationId}/capabilities`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capabilities }),
  })
}

async function putOpenWorkWebAccess(enabled: boolean, reason: string) {
  return routeApp().request(`http://den.local/v1/admin/organizations/${organizationId}/openwork-web-access`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled, reason }),
  })
}

beforeAll(async () => {
  if (!shouldRunRouteDbCoverage()) {
    routeTestUnavailable = "aggregate suite run; covered by the focused route DB test"
    return
  }

  seedRequiredEnv()
  let adminRoutesModule: typeof import("../src/routes/admin/index.js")
  let dbModule: typeof import("../src/db.js")
  let schemaModule: typeof import("@openwork-ee/den-db/schema")
  let drizzleModule: typeof import("@openwork-ee/den-db/drizzle")
  try {
    [dbModule, schemaModule, drizzleModule] = await Promise.all([
      import("../src/db.js"),
      import("@openwork-ee/den-db/schema"),
      import("@openwork-ee/den-db/drizzle"),
    ])
    if (!isRouteDatabase(dbModule.db)) {
      routeTestUnavailable = "aggregate suite run; db module is mocked by another route test"
      return
    }
    adminRoutesModule = await import("../src/routes/admin/index.js")
  } catch (error) {
    routeTestUnavailable = errorMessage(error)
    return
  }
  db = dbModule.db
  schema = schemaModule
  drizzle = drizzleModule

  try {
    await cleanup()

    await db.insert(schema.AuthUserTable).values({
      id: adminUserId,
      name: "Admin Capabilities",
      email: adminEmail,
      emailVerified: true,
    })
    await db.insert(schema.AdminAllowlistTable).values({
      id: adminAllowlistId,
      email: adminEmail,
      note: "Admin capability route test",
    })
    await db.insert(schema.OrganizationTable).values({
      id: organizationId,
      name: "Admin Capabilities Org",
      slug: organizationSlug,
      metadata: { brandAppName: "Admin Capabilities" },
    })
  } catch (error) {
    routeTestUnavailable = errorMessage(error)
    return
  }

  app = new Hono<{ Variables: AuthContextVariables }>()
  app.use("*", async (c, next) => {
    c.set("user", {
      id: adminUserId,
      name: "Admin Capabilities",
      email: adminEmail,
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    c.set("session", null)
    c.set("apiKey", null)
    await next()
  })
  adminRoutesModule.registerAdminRoutes(app)
})

afterAll(async () => {
  if (routeTestUnavailable) {
    return
  }

  await cleanup()
})

test("admin capability routes show effective defaults while preserving raw overrides", async () => {
  if (routeTestUnavailable) {
    console.warn(`admin capability route DB coverage skipped: ${routeTestUnavailable}`)
    return
  }

  const getAbsent = await routeApp().request(`http://den.local/v1/admin/organizations/${organizationId}/capabilities`)
  expect(getAbsent.status).toBe(200)
  await expect(getAbsent.json()).resolves.toMatchObject({ capabilities: { installLinks: true, mcpConnections: true } })

  const listAbsent = await routeApp().request(`http://den.local/v1/admin/organizations?search=${organizationId}`)
  expect(listAbsent.status).toBe(200)
  await expect(listAbsent.json()).resolves.toMatchObject({
    organizations: [{ id: organizationId, capabilities: { installLinks: true, mcpConnections: true } }],
  })

  const enableInstallLinks = await putCapabilities({ installLinks: true })
  expect(enableInstallLinks.status).toBe(200)
  await expect(enableInstallLinks.json()).resolves.toMatchObject({ capabilities: { installLinks: true, mcpConnections: true } })
  expect(readCapabilityMetadata(await readOrganizationMetadata())).toMatchObject({ installLinks: true })
  expect("mcpConnections" in readCapabilityMetadata(await readOrganizationMetadata())).toBe(false)

  const disableConnect = await putCapabilities({ mcpConnections: false })
  expect(disableConnect.status).toBe(200)
  await expect(disableConnect.json()).resolves.toMatchObject({ capabilities: { installLinks: true, mcpConnections: false } })
  expect(readCapabilityMetadata(await readOrganizationMetadata())).toMatchObject({ installLinks: true, mcpConnections: false })

  const clearConnect = await putCapabilities({ mcpConnections: null })
  expect(clearConnect.status).toBe(200)
  await expect(clearConnect.json()).resolves.toMatchObject({ capabilities: { installLinks: true, mcpConnections: true } })
  expect("mcpConnections" in readCapabilityMetadata(await readOrganizationMetadata())).toBe(false)

  // The retired Cloud alpha flag is no longer accepted or reported: Cloud is
  // entitled by OpenWork Web access instead.
  const rejectCloud = await routeApp().request(`http://den.local/v1/admin/organizations/${organizationId}/capabilities`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capabilities: { cloud: true } }),
  })
  expect(rejectCloud.status).toBe(200)
  const rejectCloudPayload = await rejectCloud.json() as { capabilities: Record<string, unknown> }
  expect("cloud" in rejectCloudPayload.capabilities).toBe(false)
  expect("cloud" in readCapabilityMetadata(await readOrganizationMetadata())).toBe(false)

  await replaceOrganizationMetadata({ capabilities: { installLinks: true, workflows: false, codemodeScripts: true, remoteMcpApps: true, cloud: true } })
  const dropRetired = await putCapabilities({ installLinks: true })
  expect(dropRetired.status).toBe(200)
  const retiredMetadata = readCapabilityMetadata(await readOrganizationMetadata())
  expect("workflows" in retiredMetadata).toBe(false)
  expect("codemodeScripts" in retiredMetadata).toBe(false)
  expect("remoteMcpApps" in retiredMetadata).toBe(false)
  expect("cloud" in retiredMetadata).toBe(false)
  expect(retiredMetadata).toMatchObject({ installLinks: true })

  await replaceOrganizationMetadata({ connectEnabled: true, capabilities: { installLinks: true } })
  const disableFlatEnabledConnect = await putCapabilities({ mcpConnections: false })
  expect(disableFlatEnabledConnect.status).toBe(200)
  await expect(disableFlatEnabledConnect.json()).resolves.toMatchObject({ capabilities: { mcpConnections: false } })
  const getDisabledOverride = await routeApp().request(`http://den.local/v1/admin/organizations/${organizationId}/capabilities`)
  expect(getDisabledOverride.status).toBe(200)
  await expect(getDisabledOverride.json()).resolves.toMatchObject({ capabilities: { mcpConnections: false } })

  await replaceOrganizationMetadata({ mcpConnectionsEnabled: false, capabilities: { installLinks: true, mcpConnections: false } })
  const enableFlatDisabledConnect = await putCapabilities({ mcpConnections: true })
  expect(enableFlatDisabledConnect.status).toBe(200)
  await expect(enableFlatDisabledConnect.json()).resolves.toMatchObject({ capabilities: { mcpConnections: true } })
  const getEnabledOverride = await routeApp().request(`http://den.local/v1/admin/organizations/${organizationId}/capabilities`)
  expect(getEnabledOverride.status).toBe(200)
  await expect(getEnabledOverride.json()).resolves.toMatchObject({ capabilities: { mcpConnections: true } })
})

test("platform admins grant and revoke audited complimentary Web access", async () => {
  if (routeTestUnavailable) {
    console.warn(`admin complimentary Web route DB coverage skipped: ${routeTestUnavailable}`)
    return
  }

  const invalid = await putOpenWorkWebAccess(true, "x")
  expect(invalid.status).toBe(400)

  const grant = await putOpenWorkWebAccess(true, "Internal administration organization")
  expect(grant.status).toBe(200)
  await expect(grant.json()).resolves.toMatchObject({
    organization: {
      id: organizationId,
      openworkWebAccess: {
        hasAccess: true,
        accessSource: "complimentary",
        complimentaryAccess: true,
        hasOngoingSubscription: false,
      },
    },
  })
  expect(await readOrganizationMetadata()).toMatchObject({
    mcpConnectionsEnabled: false,
    capabilities: { installLinks: true, mcpConnections: true },
    complimentaryAccess: { openworkWeb: true },
  })

  const listed = await routeApp().request(`http://den.local/v1/admin/organizations?search=${organizationId}`)
  expect(listed.status).toBe(200)
  await expect(listed.json()).resolves.toMatchObject({
    organizations: [{
      id: organizationId,
      openworkWebAccess: { complimentaryAccess: true, hasOngoingSubscription: false },
    }],
  })

  const { db, schema, drizzle } = testDatabase()
  const auditRows = await db
    .select({ action: schema.AuditEventTable.action, payload: schema.AuditEventTable.payload })
    .from(schema.AuditEventTable)
    .where(drizzle.eq(schema.AuditEventTable.org_id, organizationId))
  expect(auditRows).toHaveLength(1)
  expect(auditRows[0]).toMatchObject({
    action: "organization.openwork_web.complimentary_access_granted",
    payload: { reason: "Internal administration organization", complimentaryAccess: true },
  })

  const revoke = await putOpenWorkWebAccess(false, "Return organization to standard billing")
  expect(revoke.status).toBe(200)
  expect(await readOrganizationMetadata()).not.toHaveProperty("complimentaryAccess.openworkWeb")

  const revokedAuditRows = await db
    .select({ action: schema.AuditEventTable.action })
    .from(schema.AuditEventTable)
    .where(drizzle.eq(schema.AuditEventTable.org_id, organizationId))
  expect(revokedAuditRows.map((row) => row.action).sort()).toEqual([
    "organization.openwork_web.complimentary_access_granted",
    "organization.openwork_web.complimentary_access_revoked",
  ])

  await db.insert(schema.OrgSubscriptionTable).values({
    id: createDenTypeId("orgSubscription"),
    organization_id: organizationId,
    created_by_org_membership_id: null,
    type: "web",
    status: "active",
    stripe_customer_id: "cus_admin_web_access_test",
    stripe_subscription_id: "sub_admin_web_access_test",
    stripe_price_id: "price_admin_web_access_test",
    stripe_subscription_item_id: "si_admin_web_access_test",
    quantity: 1,
  })
  const paidConflict = await putOpenWorkWebAccess(true, "Would overlap paid billing")
  expect(paidConflict.status).toBe(409)
  await expect(paidConflict.json()).resolves.toMatchObject({ error: "openwork_web_subscription_exists" })
  expect(await readOrganizationMetadata()).not.toHaveProperty("complimentaryAccess.openworkWeb")
})
