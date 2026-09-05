import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  AuthUserTable,
  DashboardAccessGrantTable,
  DashboardTable,
  MemberTable,
  OrganizationTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono, type MiddlewareHandler } from "hono"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"

const API_ORIGIN = "http://127.0.0.1:8790"

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_dashboards"
process.env.DB_MODE ??= "mysql"
process.env.DEN_DB_ENCRYPTION_KEY ??= "dashboards-test-encryption-key-1234567890"
process.env.BETTER_AUTH_SECRET ??= "dashboards-test-secret-123456789012"
process.env.BETTER_AUTH_URL ??= API_ORIGIN
process.env.CORS_ORIGINS ??= API_ORIGIN

let app: Hono<{ Variables: OrgRouteVariables }>
let db: typeof import("../src/db.js").db

const organizationId = createDenTypeId("organization")
const otherOrganizationId = createDenTypeId("organization")
const teamId = createDenTypeId("team")
const adminUserId = createDenTypeId("user")
const caseyUserId = createDenTypeId("user")
const novaUserId = createDenTypeId("user")
const adminMemberId = createDenTypeId("member")
const caseyMemberId = createDenTypeId("member")
const novaMemberId = createDenTypeId("member")
const foreignUserId = createDenTypeId("user")
const foreignMemberId = createDenTypeId("member")

const readOnlyElement = {
  serverName: "openwork-app-host-connect-0123456789ab",
  connectionId: "emc_01dashboardfixture0000000000",
  toolName: "render_report",
  projectedToolName: "openwork-app-host-connect-0123456789ab_render_report",
  resourceUri: "ui://fixture/report/view.html",
  title: "Weekly report",
}

const writeElement = {
  serverName: "openwork-app-host-connect-0123456789ab",
  connectionId: "emc_01dashboardfixture0000000000",
  toolName: "create_ticket",
  projectedToolName: "openwork-app-host-connect-0123456789ab_create_ticket",
  resourceUri: "ui://fixture/ticket/view.html",
  title: "Create ticket",
  launchArguments: { queue: "support" },
  requiresApproval: true,
}

const organizationAutoLaunchElement = {
  ...writeElement,
  organizationAutoLaunch: true,
}

async function cleanup() {
  await db.delete(DashboardAccessGrantTable).where(inArray(DashboardAccessGrantTable.organizationId, [organizationId, otherOrganizationId]))
  await db.delete(DashboardTable).where(inArray(DashboardTable.organizationId, [organizationId, otherOrganizationId]))
  await db.delete(TeamMemberTable).where(eq(TeamMemberTable.teamId, teamId))
  await db.delete(TeamTable).where(eq(TeamTable.organizationId, organizationId))
  await db.delete(MemberTable).where(inArray(MemberTable.organizationId, [organizationId, otherOrganizationId]))
  await db.delete(OrganizationTable).where(inArray(OrganizationTable.id, [organizationId, otherOrganizationId]))
  await db.delete(AuthUserTable).where(inArray(AuthUserTable.id, [adminUserId, caseyUserId, novaUserId, foreignUserId]))
}

type Actor = "admin" | "casey" | "nova"

function organizationContext(actor: Actor) {
  const now = new Date()
  const member = actor === "admin"
    ? { id: adminMemberId, userId: adminUserId, role: "admin" }
    : actor === "casey"
      ? { id: caseyMemberId, userId: caseyUserId, role: "member" }
      : { id: novaMemberId, userId: novaUserId, role: "member" }
  return {
    organization: {
      id: organizationId,
      name: "Dashboards Test",
      slug: `dashboards-${organizationId}`,
      logo: null,
      allowedEmailDomains: null,
      metadata: null,
      createdAt: now,
      updatedAt: now,
    },
    currentMember: {
      id: member.id,
      userId: member.userId,
      role: member.role,
      createdAt: now,
      joinedAt: now,
      isOwner: false,
    },
    invitations: [],
    members: [],
    roles: [],
    teams: [],
  }
}

function memberTeams(actor: Actor) {
  if (actor !== "casey") return []
  const now = new Date()
  return [{ id: teamId, organizationId, name: "Product", createdAt: now, updatedAt: now }]
}

function request(path: string, init: RequestInit & { actor?: Actor } = {}) {
  const { actor, ...rest } = init
  const headers = new Headers(rest.headers)
  headers.set("x-test-actor", actor ?? "admin")
  if (rest.body) headers.set("content-type", "application/json")
  return app.request(path, { ...rest, headers })
}

beforeAll(async () => {
  mock.restore()
  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  db = realDb
  mock.module("../src/db.js", () => ({ db: realDb }))
  const middleware = await import("../src/middleware/index.js")
  const passThroughMiddleware: MiddlewareHandler = async (_c, next) => {
    await next()
  }
  mock.module("../src/middleware/index.js", () => ({
    ...middleware,
    orgMemberRoute: () => passThroughMiddleware,
    // Keep the real role check while skipping session resolution, so member
    // versus admin authorization stays observable in these tests.
    orgRoleRoute: (roles: readonly string[]) => {
      const handler: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
        const payload = c.get("organizationContext")
        if (!payload) return c.json({ error: "organization_not_found" }, 404)
        if (!middleware.verifyOrgRole({ roles, userContext: payload.currentMember })) {
          return c.json({ error: "forbidden" }, 403)
        }
        await next()
      }
      return handler
    },
    resolveMemberTeamsMiddleware: passThroughMiddleware,
  }))
  const { registerOrgDashboardRoutes } = await import("../src/routes/org/dashboards.js")
  app = new Hono<{ Variables: OrgRouteVariables }>()
  app.use("*", async (c, next) => {
    const header = c.req.header("x-test-actor")
    const actor: Actor = header === "casey" ? "casey" : header === "nova" ? "nova" : "admin"
    c.set("organizationContext", organizationContext(actor))
    c.set("memberTeams", memberTeams(actor))
    await next()
  })
  registerOrgDashboardRoutes(app)

  await cleanup()
  await db.insert(AuthUserTable).values([
    { id: adminUserId, name: "Avery Admin", email: `${adminUserId}@dashboards.test`, emailVerified: true },
    { id: caseyUserId, name: "Casey Collaborator", email: `${caseyUserId}@dashboards.test`, emailVerified: true },
    { id: novaUserId, name: "Nova Member", email: `${novaUserId}@dashboards.test`, emailVerified: true },
    { id: foreignUserId, name: "Farah Foreign", email: `${foreignUserId}@dashboards.test`, emailVerified: true },
  ])
  await db.insert(OrganizationTable).values([
    { id: organizationId, name: "Dashboards Test", slug: `dashboards-${organizationId}` },
    { id: otherOrganizationId, name: "Other Org", slug: `dashboards-other-${otherOrganizationId}` },
  ])
  await db.insert(MemberTable).values([
    { id: adminMemberId, organizationId, userId: adminUserId, role: "admin" },
    { id: caseyMemberId, organizationId, userId: caseyUserId, role: "member" },
    { id: novaMemberId, organizationId, userId: novaUserId, role: "member" },
    { id: foreignMemberId, organizationId: otherOrganizationId, userId: foreignUserId, role: "member" },
  ])
  await db.insert(TeamTable).values({ id: teamId, organizationId, name: "Product" })
  await db.insert(TeamMemberTable).values({
    id: createDenTypeId("teamMember"),
    teamId,
    orgMembershipId: caseyMemberId,
  })
})

afterAll(async () => {
  await cleanup()
  mock.restore()
})

async function createDashboard(name: string, elements: unknown[] = [readOnlyElement]) {
  const response = await request("/v1/dashboards", {
    method: "POST",
    body: JSON.stringify({ name, elements }),
  })
  expect(response.status).toBe(201)
  const payload = await response.json() as { item: { id: string } }
  return payload.item
}

async function grantAccess(dashboardId: string, body: Record<string, unknown>) {
  const response = await request(`/v1/dashboards/${dashboardId}/access`, {
    method: "POST",
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(201)
  const payload = await response.json() as { ok: true; item: { id: string } }
  return payload.item
}

test("admins create, list, update, and soft-delete dashboards", async () => {
  const created = await createDashboard("Support board", [readOnlyElement, organizationAutoLaunchElement])
  expect(created.id.startsWith("dsb_")).toBe(true)

  const listResponse = await request("/v1/dashboards")
  expect(listResponse.status).toBe(200)
  const list = await listResponse.json() as { items: Array<{ id: string; name: string; elements: unknown[] }> }
  const listed = list.items.find((item) => item.id === created.id)
  expect(listed?.name).toBe("Support board")
  expect(listed?.elements).toEqual([readOnlyElement, organizationAutoLaunchElement])

  const updateResponse = await request(`/v1/dashboards/${created.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "Support board v2", elements: [organizationAutoLaunchElement, readOnlyElement] }),
  })
  expect(updateResponse.status).toBe(200)
  const updated = await updateResponse.json() as { item: { name: string; elements: unknown[] } }
  expect(updated.item.name).toBe("Support board v2")
  // Element array order is the tile order.
  expect(updated.item.elements).toEqual([organizationAutoLaunchElement, readOnlyElement])

  const deleteResponse = await request(`/v1/dashboards/${created.id}`, { method: "DELETE" })
  expect(deleteResponse.status).toBe(204)
  const getResponse = await request(`/v1/dashboards/${created.id}`)
  expect(getResponse.status).toBe(404)
})

test("dashboard management requires an admin role", async () => {
  const createResponse = await request("/v1/dashboards", {
    method: "POST",
    actor: "casey",
    body: JSON.stringify({ name: "Not allowed" }),
  })
  expect(createResponse.status).toBe(403)
  const listResponse = await request("/v1/dashboards", { actor: "casey" })
  expect(listResponse.status).toBe(403)
})

test("dashboard elements are validated", async () => {
  const badResourceUri = await request("/v1/dashboards", {
    method: "POST",
    body: JSON.stringify({
      name: "Bad elements",
      elements: [{ ...readOnlyElement, resourceUri: "https://attacker.example/view.html" }],
    }),
  })
  expect(badResourceUri.status).toBe(400)
})

test("grants target exactly one subject inside the organization", async () => {
  const dashboard = await createDashboard("Grant validation")

  const bothSubjects = await request(`/v1/dashboards/${dashboard.id}/access`, {
    method: "POST",
    body: JSON.stringify({ orgMembershipId: caseyMemberId, teamId, role: "viewer" }),
  })
  expect(bothSubjects.status).toBe(400)

  const noSubject = await request(`/v1/dashboards/${dashboard.id}/access`, {
    method: "POST",
    body: JSON.stringify({ role: "viewer" }),
  })
  expect(noSubject.status).toBe(400)

  const foreignMember = await request(`/v1/dashboards/${dashboard.id}/access`, {
    method: "POST",
    body: JSON.stringify({ orgMembershipId: foreignMemberId, role: "viewer" }),
  })
  expect(foreignMember.status).toBe(404)
})

test("grant, list, revoke, and regrant follow the connector assignment lifecycle", async () => {
  const dashboard = await createDashboard("Lifecycle board")
  const grant = await grantAccess(dashboard.id, { orgMembershipId: caseyMemberId, role: "viewer" })
  expect(grant.id.startsWith("dsg_")).toBe(true)

  const listResponse = await request(`/v1/dashboards/${dashboard.id}/access`)
  expect(listResponse.status).toBe(200)
  const list = await listResponse.json() as { items: Array<{ id: string; orgMembershipId: string | null; removedAt: string | null }> }
  expect(list.items.map((item) => item.id)).toContain(grant.id)

  const revokeResponse = await request(`/v1/dashboards/${dashboard.id}/access/${grant.id}`, { method: "DELETE" })
  expect(revokeResponse.status).toBe(204)

  const afterRevoke = await request("/v1/me/dashboards", { actor: "casey" })
  const revokedItems = await afterRevoke.json() as { items: Array<{ id: string }> }
  expect(revokedItems.items.map((item) => item.id)).not.toContain(dashboard.id)

  // Regranting the same subject reactivates the existing grant row.
  const regrant = await grantAccess(dashboard.id, { orgMembershipId: caseyMemberId, role: "viewer" })
  expect(regrant.id).toBe(grant.id)

  const afterRegrant = await request("/v1/me/dashboards", { actor: "casey" })
  const regrantedItems = await afterRegrant.json() as { items: Array<{ id: string }> }
  expect(regrantedItems.items.map((item) => item.id)).toContain(dashboard.id)
})

test("members see granted dashboards through direct, team, and org-wide grants only", async () => {
  const teamBoard = await createDashboard("Team board")
  const directBoard = await createDashboard("Direct board")
  const orgBoard = await createDashboard("Org board")
  const privateBoard = await createDashboard("Private board")
  const deletedBoard = await createDashboard("Deleted board")

  await grantAccess(teamBoard.id, { teamId, role: "viewer" })
  await grantAccess(directBoard.id, { orgMembershipId: novaMemberId, role: "viewer" })
  await grantAccess(orgBoard.id, { orgWide: true, role: "viewer" })
  await grantAccess(deletedBoard.id, { orgWide: true, role: "viewer" })
  const deleteResponse = await request(`/v1/dashboards/${deletedBoard.id}`, { method: "DELETE" })
  expect(deleteResponse.status).toBe(204)

  const caseyResponse = await request("/v1/me/dashboards", { actor: "casey" })
  expect(caseyResponse.status).toBe(200)
  const caseyItems = (await caseyResponse.json() as { items: Array<{ id: string; name: string; elements: unknown[] }> }).items
  const caseyIds = caseyItems.map((item) => item.id)
  expect(caseyIds).toContain(teamBoard.id)
  expect(caseyIds).toContain(orgBoard.id)
  expect(caseyIds).not.toContain(directBoard.id)
  expect(caseyIds).not.toContain(privateBoard.id)
  expect(caseyIds).not.toContain(deletedBoard.id)
  expect(caseyItems.find((item) => item.id === teamBoard.id)?.elements).toEqual([readOnlyElement])

  const novaResponse = await request("/v1/me/dashboards", { actor: "nova" })
  expect(novaResponse.status).toBe(200)
  const novaIds = (await novaResponse.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)
  expect(novaIds).toContain(directBoard.id)
  expect(novaIds).toContain(orgBoard.id)
  expect(novaIds).not.toContain(teamBoard.id)
  expect(novaIds).not.toContain(privateBoard.id)
})
