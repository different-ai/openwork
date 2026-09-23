import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { organizationWebOriginListSchema, organizationWebOriginSchema } from "@openwork/types/den/organization-web-origins"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono } from "hono"

const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const userId = createDenTypeId("user")
const existingOriginId = createDenTypeId("organizationWebOrigin")
const createdAt = new Date("2026-09-01T12:00:00.000Z")

let role = "owner"
let isOwner = true
let sessionCreatedAt = new Date()
let approveOutcome: "created" | "already_approved" | "limit_reached" = "created"
let removeResult: string | null = "https://workspace.example.test"

const approveCalls: Array<{ organizationId: string; origin: string; createdByOrgMemberId: string }> = []
const removeCalls: Array<{ organizationId: string; id: string }> = []
const auditEvents: Array<{ organizationId: string; actorUserId: string; action: string; payload?: Record<string, unknown> }> = []

function organizationContext() {
  return {
    organization: { id: organizationId, slug: "example-workspace", name: "Example Workspace", metadata: {} },
    currentMember: { id: memberId, userId, role, isOwner },
    currentMemberTeams: [],
    members: [],
    teams: [],
    roles: [],
  }
}

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"

// Keep the real module graph (no database is contacted) and replace only the
// organization context lookup that orgRoleRoute consults.
const actualOrgs = await import("../src/orgs.js")
mock.module("../src/orgs.js", () => ({
  ...actualOrgs,
  getOrganizationContextForUser: () => Promise.resolve(organizationContext()),
}))

mock.module("../src/audit-events.js", () => ({
  ORGANIZATION_AUDIT_ACTIONS: {
    webOriginApproved: "organization.web_origin.approved",
    webOriginRemoved: "organization.web_origin.removed",
  },
  recordOrganizationAuditEvent: (event: { organizationId: string; actorUserId: string; action: string; payload?: Record<string, unknown> }) => {
    auditEvents.push(event)
    return Promise.resolve()
  },
}))

mock.module("../src/organization-web-origins.js", () => ({
  listOrganizationWebOrigins: () => Promise.resolve([
    { id: existingOriginId, origin: "https://workspace.example.test", createdAt, createdByName: "Owner Example" },
  ]),
  approveOrganizationWebOrigin: (input: { organizationId: string; origin: string; createdByOrgMemberId: string }) => {
    approveCalls.push(input)
    if (approveOutcome !== "created") return Promise.resolve({ ok: false, reason: approveOutcome })
    return Promise.resolve({
      ok: true,
      webOrigin: { id: createDenTypeId("organizationWebOrigin"), origin: input.origin, createdAt, createdByName: "Owner Example" },
    })
  },
  removeOrganizationWebOrigin: (input: { organizationId: string; id: string }) => {
    removeCalls.push(input)
    return Promise.resolve(removeResult)
  },
}))

let app: Hono

beforeAll(async () => {
  const { registerOrgWebOriginRoutes } = await import("../src/routes/org/web-origins.js")
  app = new Hono()
  app.use("*", async (c, next) => {
    c.set("user", { id: userId })
    c.set("session", { id: "session_web_origins", createdAt: sessionCreatedAt, activeOrganizationId: organizationId })
    c.set("activeOrganizationId", organizationId)
    await next()
  })
  registerOrgWebOriginRoutes(app)
})

beforeEach(() => {
  role = "owner"
  isOwner = true
  sessionCreatedAt = new Date()
  approveOutcome = "created"
  removeResult = "https://workspace.example.test"
  approveCalls.length = 0
  removeCalls.length = 0
  auditEvents.length = 0
})

afterAll(() => {
  mock.restore()
})

function approve(origin: string) {
  return app.request("http://den.local/v1/org/web-origins", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ origin }),
  })
}

function remove(id: string) {
  return app.request(`http://den.local/v1/org/web-origins/${id}`, { method: "DELETE" })
}

describe("GET /v1/org/web-origins", () => {
  test("admins list approved origins with the limit", async () => {
    role = "admin"
    isOwner = false
    const response = await app.request("http://den.local/v1/org/web-origins")
    expect(response.status).toBe(200)
    const body = organizationWebOriginListSchema.parse(await response.json())
    expect(body).toEqual({
      origins: [{ id: existingOriginId, origin: "https://workspace.example.test", createdAt: createdAt.toISOString(), createdByName: "Owner Example" }],
      limit: 20,
    })
  })

  test("members cannot list approved origins", async () => {
    role = "member"
    isOwner = false
    const response = await app.request("http://den.local/v1/org/web-origins")
    expect(response.status).toBe(403)
  })
})

describe("POST /v1/org/web-origins", () => {
  test("super-admins approve a normalized origin and the change is audited", async () => {
    role = "super-admin"
    isOwner = false
    const response = await approve("https://Workspace.Example.test:8787/")
    expect(response.status).toBe(201)
    const body = organizationWebOriginSchema.parse(await response.json())
    expect(body.origin).toBe("https://workspace.example.test:8787")
    expect(body.createdAt).toBe(createdAt.toISOString())
    expect(approveCalls).toEqual([{ organizationId, origin: "https://workspace.example.test:8787", createdByOrgMemberId: memberId }])
    expect(auditEvents).toEqual([{
      organizationId,
      actorUserId: userId,
      action: "organization.web_origin.approved",
      payload: { origin: "https://workspace.example.test:8787" },
    }])
  })

  test("admins who are not super-admins cannot approve origins", async () => {
    role = "admin"
    isOwner = false
    const response = await approve("https://workspace.example.test")
    expect(response.status).toBe(403)
    expect(approveCalls).toHaveLength(0)
    expect(auditEvents).toHaveLength(0)
  })

  test("a stale session must confirm identity before approving", async () => {
    sessionCreatedAt = new Date(Date.now() - 60 * 60 * 1000)
    const response = await approve("https://workspace.example.test")
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: "reauth", reason: "fresh_auth_required" })
    expect(approveCalls).toHaveLength(0)
  })

  test.each([
    "http://workspace.example.test",
    "https://workspace.example.test/app",
    "https://workspace.example.test?next=/",
    "https://workspace.example.test#top",
    "https://*.example.test",
    "https://user:secret@workspace.example.test",
    "workspace.example.test",
  ])("rejects %s as not an exact HTTPS origin", async (origin) => {
    const response = await approve(origin)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "invalid_web_origin",
      message: "Enter an exact HTTPS origin like https://workspace.example.com, with an optional port and no path.",
    })
    expect(approveCalls).toHaveLength(0)
  })

  test("rejects a missing origin as an invalid request", async () => {
    const response = await app.request("http://den.local/v1/org/web-origins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: "invalid_request" })
  })

  test("reports an already approved origin", async () => {
    approveOutcome = "already_approved"
    const response = await approve("https://workspace.example.test")
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "web_origin_already_approved", message: "This origin is already approved." })
    expect(auditEvents).toHaveLength(0)
  })

  test("reports the per-organization limit", async () => {
    approveOutcome = "limit_reached"
    const response = await approve("https://workspace.example.test")
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "web_origin_limit_reached",
      message: "This organization already has 20 approved web origins. Remove one before adding another.",
    })
    expect(auditEvents).toHaveLength(0)
  })
})

describe("DELETE /v1/org/web-origins/:webOriginId", () => {
  test("super-admins remove an origin and the change is audited", async () => {
    const response = await remove(existingOriginId)
    expect(response.status).toBe(204)
    expect(removeCalls).toEqual([{ organizationId, id: existingOriginId }])
    expect(auditEvents).toEqual([{
      organizationId,
      actorUserId: userId,
      action: "organization.web_origin.removed",
      payload: { origin: "https://workspace.example.test" },
    }])
  })

  test("reports an origin that no longer exists", async () => {
    removeResult = null
    const response = await remove(existingOriginId)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: "web_origin_not_found", message: "This approved origin no longer exists." })
    expect(auditEvents).toHaveLength(0)
  })

  test("rejects ids that are not approved-origin ids", async () => {
    const response = await remove(createDenTypeId("member"))
    expect(response.status).toBe(400)
    expect(removeCalls).toHaveLength(0)
  })

  test("admins and stale sessions cannot remove origins", async () => {
    role = "admin"
    isOwner = false
    expect((await remove(existingOriginId)).status).toBe(403)

    role = "owner"
    isOwner = true
    sessionCreatedAt = new Date(Date.now() - 60 * 60 * 1000)
    const stale = await remove(existingOriginId)
    expect(stale.status).toBe(403)
    expect(await stale.json()).toMatchObject({ error: "reauth" })
    expect(removeCalls).toHaveLength(0)
  })
})
