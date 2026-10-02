import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import type { AuthContextVariables } from "../src/session.js"
import type { FreeAutoUsageReport } from "../src/routes/admin/free-auto-usage.js"

const adminUserId = createDenTypeId("user"), adminAllowlistId = createDenTypeId("adminAllowlist")
const adminEmail = `admin-free-usage+${adminUserId}@test.local`
const ownerUserId = createDenTypeId("user"), ownerEmail = `owner-free-usage+${ownerUserId}@test.local`
const enrolledOrg = createDenTypeId("organization"), quietOrg = createDenTypeId("organization"), payingOrg = createDenTypeId("organization")
const organizationIds = [enrolledOrg, quietOrg, payingOrg]
const members = [createDenTypeId("member"), createDenTypeId("member"), createDenTypeId("member"), createDenTypeId("member")]
const people = ["a", "b", "c"].map((letter) => letter.repeat(8) + randomUUID().replaceAll("-", "").slice(0, 56))
const guestPrincipal = "d".repeat(8) + randomUUID().replaceAll("-", "").slice(0, 56)
const requestPrefix = `admfree${randomUUID().replaceAll("-", "").slice(0, 12)}`
const bucketIds = [`${requestPrefix}-bucket-a`, `${requestPrefix}-bucket-b`]
const UNIT = 100_000_000 // inference usage units per USD

let app: Hono<{ Variables: AuthContextVariables }> | null = null
let db: typeof import("../src/db.js").db | null = null
let schema: typeof import("@openwork-ee/den-db/schema") | null = null
let drizzle: typeof import("@openwork-ee/den-db/drizzle") | null = null
let unavailable: string | null = null

function seedRequiredEnv() {
  process.env.DATABASE_URL ??= process.env.DEN_TEST_DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = "y".repeat(32)
  process.env.BETTER_AUTH_URL = "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = "http://127.0.0.1:8790"
  process.env.DEN_ORG_MODE = "multi_org"
  process.env.INFERENCE_FREE_ENABLED = "true"
  process.env.INFERENCE_FREE_WEEKLY_BUDGET_USD = "5"
}

function routeApp() {
  if (!app) throw new Error(`free Auto usage route coverage unavailable: ${unavailable}`)
  return app
}

async function report(caller?: "anonymous" | "owner", days = 7) {
  return routeApp().request(`http://den.local/v1/admin/free-auto/usage?days=${days}`, { headers: caller ? { "x-test-caller": caller } : {} })
}

async function cleanup() {
  if (!db || !schema || !drizzle) return
  const { inArray, sql } = drizzle
  const like = (column: unknown, pattern: string) => sql`${column} like ${pattern}`
  await db.delete(schema.InferenceFreeUsageTable).where(like(schema.InferenceFreeUsageTable.request_id, `${requestPrefix}%`))
  await db.delete(schema.AnonymousInferenceUsageTable).where(like(schema.AnonymousInferenceUsageTable.request_id, `${requestPrefix}%`))
  await db.delete(schema.InferenceFreeUsageBucketTable).where(inArray(schema.InferenceFreeUsageBucketTable.id, bucketIds))
  await db.delete(schema.OrgSubscriptionTable).where(inArray(schema.OrgSubscriptionTable.organization_id, organizationIds))
  await db.delete(schema.MemberTable).where(inArray(schema.MemberTable.id, members))
  await db.delete(schema.OrganizationTable).where(inArray(schema.OrganizationTable.id, organizationIds))
  await db.delete(schema.AuthUserTable).where(inArray(schema.AuthUserTable.id, [adminUserId, ownerUserId]))
  await db.delete(schema.AdminAllowlistTable).where(drizzle.eq(schema.AdminAllowlistTable.id, adminAllowlistId))
}

beforeAll(async () => {
  seedRequiredEnv()
  try {
    const [dbModule, schemaModule, drizzleModule] = await Promise.all([import("../src/db.js"), import("@openwork-ee/den-db/schema"), import("@openwork-ee/den-db/drizzle")])
    if (!(typeof dbModule.db === "object" && dbModule.db !== null && "query" in dbModule.db)) {
      unavailable = "db module is mocked by another test in this process"
      return
    }
    db = dbModule.db; schema = schemaModule; drizzle = drizzleModule
    const routes = await import("../src/routes/admin/index.js")
    await cleanup()
    await db.insert(schema.AuthUserTable).values([
      { id: adminUserId, name: "Admin", email: adminEmail, emailVerified: true },
      { id: ownerUserId, name: "Owner", email: ownerEmail, emailVerified: true },
    ])
    await db.insert(schema.AdminAllowlistTable).values({ id: adminAllowlistId, email: adminEmail, note: "free Auto usage route test" })
    const now = new Date()
    await db.insert(schema.OrganizationTable).values([
      { id: enrolledOrg, name: "Enrolled Pilot", slug: `enrolled-${enrolledOrg}`, metadata: { inferenceFree: { rolloutEnabled: true } } },
      { id: quietOrg, name: "Quiet Pilot", slug: `quiet-${quietOrg}`, metadata: { inferenceFree: { rolloutEnabled: true } } },
      { id: payingOrg, name: "Paying Customer", slug: `paying-${payingOrg}`, metadata: { inference: { enabled: true, tier: "tier1" } } },
    ])
    await db.insert(schema.MemberTable).values([
      { id: members[0], organizationId: enrolledOrg, userId: ownerUserId, role: "owner", joinedAt: now },
      { id: members[1], organizationId: enrolledOrg, userId: adminUserId, role: "member", joinedAt: now },
      { id: members[2], organizationId: quietOrg, userId: ownerUserId, role: "owner", joinedAt: now },
      { id: members[3], organizationId: payingOrg, userId: ownerUserId, role: "owner", joinedAt: now, removedAt: now },
    ])
    const key = createDenTypeId("inferenceKey")
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000)
    const row = (suffix: string, organizationId: string, membershipId: string, principal: string, amount: number, createdAt: Date, estimated = false) => ({
      request_id: `${requestPrefix}${suffix}`, completion_id: estimated ? null : `chatcmpl-${requestPrefix}${suffix}`, principal_hash: principal,
      organization_id: organizationId, org_membership_id: membershipId, inference_key_id: key, model_id: "openai/gpt-6-luna",
      amount, input_tokens: estimated ? null : 1000, output_tokens: estimated ? null : 200, estimated, created_at: createdAt,
    }) as typeof schema.InferenceFreeUsageTable.$inferInsert
    await db.insert(schema.InferenceFreeUsageTable).values([
      row("m1", enrolledOrg, members[0], people[0], 2 * UNIT, at(0)),
      row("m2", enrolledOrg, members[0], people[0], UNIT, at(1)),
      row("m3", enrolledOrg, members[1], people[1], UNIT / 2, at(2), true),
      row("m4", payingOrg, members[3], people[2], UNIT, at(3)),
      row("old", enrolledOrg, members[0], people[0], 50 * UNIT, at(20)),
    ])
    await db.insert(schema.AnonymousInferenceUsageTable).values([
      { request_id: `${requestPrefix}g1`, completion_id: `chatcmpl-${requestPrefix}g1`, principal_hash: guestPrincipal, model_id: "openai/gpt-6-luna", amount: UNIT / 4, input_tokens: 100, output_tokens: 10, created_at: at(0) },
      { request_id: `${requestPrefix}g2`, completion_id: null, principal_hash: guestPrincipal, model_id: "openai/gpt-6-luna", amount: UNIT / 4, estimated: true, created_at: at(1) },
    ])
    const { freeInferenceWindow } = await import("@openwork/types/den/inference")
    const week = freeInferenceWindow(now)
    await db.insert(schema.InferenceFreeUsageBucketTable).values([
      { id: bucketIds[0], identity_hash: people[0], window_start_at: week.start, window_end_at: week.end, limit_amount: 5 * UNIT, used_amount: 5 * UNIT },
      { id: bucketIds[1], identity_hash: people[1], window_start_at: week.start, window_end_at: week.end, limit_amount: 5 * UNIT, used_amount: UNIT },
    ])
    app = new Hono<{ Variables: AuthContextVariables }>()
    app.use("*", async (c, next) => {
      const caller = c.req.header("x-test-caller")
      c.set("user", caller === "anonymous" ? null : {
        id: caller === "owner" ? ownerUserId : adminUserId, name: "Caller", email: caller === "owner" ? ownerEmail : adminEmail,
        emailVerified: true, image: null, createdAt: new Date(), updatedAt: new Date(),
      })
      c.set("session", null)
      c.set("apiKey", null)
      await next()
    })
    routes.registerAdminRoutes(app)
  } catch (error) {
    unavailable = error instanceof Error ? error.message : String(error)
  }
})

afterAll(async () => { await cleanup() })

test("free Auto usage reports members per organization, guests in aggregate, and this week's allowance pressure", async () => {
  const response = await report()
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const body = await response.json() as FreeAutoUsageReport
  const enrolled = body.organizations.find((row) => row.id === enrolledOrg)
  expect(enrolled).toMatchObject({
    name: "Enrolled Pilot", enrolled: true, subscribed: false, memberCount: 2, activePeople: 2, peopleAtWeeklyLimit: 1,
    requests: 3, estimatedRequests: 1, costMicroUsd: 3_500_000, inputTokens: 2000, outputTokens: 400,
  })
  expect(enrolled?.lastUsedAt).toBeString()
  expect(body.organizations.find((row) => row.id === quietOrg)).toMatchObject({ enrolled: true, requests: 0, costMicroUsd: 0, memberCount: 1, lastUsedAt: null })
  expect(body.organizations.find((row) => row.id === payingOrg)).toMatchObject({ enrolled: false, subscribed: true, memberCount: 0, requests: 1, costMicroUsd: 1_000_000 })
  expect(body.guests.requests).toBeGreaterThanOrEqual(2)
  expect(body.guests.estimatedRequests).toBeGreaterThanOrEqual(1)
  expect(JSON.stringify(body)).not.toContain(guestPrincipal)
  expect(JSON.stringify(body)).not.toContain(people[0])
  expect(body.range).toMatchObject({ days: 7, timezone: "UTC" })
  expect(body.daily).toHaveLength(7)
  expect(body.settings).toMatchObject({ membersEnabled: true, weeklyLimitMicroUsd: 5_000_000 })
  expect(body.week.peopleAtWeeklyLimit).toBeGreaterThanOrEqual(1)
  // Everything adds up: members plus guests equal the totals, and the organization rows plus "other" equal the members.
  const orgSum = body.organizations.reduce((sum, row) => sum + row.costMicroUsd, 0) + (body.otherOrganizations?.costMicroUsd ?? 0)
  expect(orgSum).toBe(body.members.costMicroUsd)
  expect(body.members.costMicroUsd + body.guests.costMicroUsd).toBe(body.totals.costMicroUsd)
  const dailySum = body.daily.reduce((sum, day) => sum + day.membersMicroUsd + day.guestsMicroUsd, 0)
  expect(dailySum).toBe(body.totals.costMicroUsd)
  // Usage older than the range is left out, and a wider range brings it back.
  const wide = await (await report(undefined, 30)).json() as FreeAutoUsageReport
  expect(wide.organizations.find((row) => row.id === enrolledOrg)).toMatchObject({ requests: 4, costMicroUsd: 53_500_000 })
})

test("only platform admins can read free Auto usage, and the range is bounded", async () => {
  expect((await report("anonymous")).status).toBe(401)
  expect((await report("owner")).status).toBe(403)
  for (const days of [0, 91]) expect((await report(undefined, days)).status).toBe(400)
})
