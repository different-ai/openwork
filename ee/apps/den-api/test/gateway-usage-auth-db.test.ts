import { afterAll, expect, test, mock } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { createDenDb } from "@openwork-ee/den-db"
import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { z } from "zod"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  AuthSessionTable,
  ConnectedAccountTable,
  AuthUserTable,
  MemberTable,
  OrganizationTable,
  TeamTable,
  TeamMemberTable,
  GatewayRequestLogTable,
  GatewayUsagePolicyTable,
  GatewayUsageLimitTable,
  GatewayUsageAssignmentTable,
  GatewayUsageSubjectTable,
  GatewayUsageTrackingTable,
  GatewayUsageBucketTable,
  GatewayUsageEventTable,
  GatewayUsageChargeTable,
  GatewayUsageResetTable,
  GatewayUsageQuarantineTable,
  GatewayUsageAuditTable,
  AdminAllowlistTable,
} from "@openwork-ee/den-db/schema"
import {
  createGatewayUsageLimits,
  startGatewayUsageLog,
} from "@openwork-ee/den-db/gateway-usage-limits"
import { eq, or } from "@openwork-ee/den-db/drizzle"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"

const url = process.env.DEN_USAGE_TEST_DATABASE_URL
if (
  !url ||
  !["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
  !new URL(url).pathname.startsWith("/usage_limits_test")
) {
  throw new Error(
    "Set DEN_USAGE_TEST_DATABASE_URL to a disposable loopback usage_limits_test database.",
  )
}
process.env.DATABASE_URL = url
process.env.DATABASE_REDIS_URL = ""
process.env.LINEAR_API_KEY = ""
process.env.LINEAR_COMPLIANCE_TEAM_ID = ""
process.env.STRIPE_SECRET_KEY = ""
process.env.OPENWORK_DEV_MODE = "1"
process.env.DEN_ORG_MODE = "multi_org"
process.env.DEN_DB_ENCRYPTION_KEY = "usage-test-key-not-a-secret-32-characters"
process.env.BETTER_AUTH_SECRET = "usage-test-auth-not-a-secret-32-characters"
process.env.BETTER_AUTH_URL = "http://localhost:8790"
process.env.DEN_BASE_URL = "http://localhost:3005"
process.env.GATEWAY_ENABLED = "true"
process.env.GATEWAY_PROXY_BASE_URL = "http://localhost:8791"
process.env.GATEWAY_PUBLIC_BASE_URL = "https://gateway.example.test"

const sqlWitness = new AsyncLocalStorage<string[]>()
let onSql: ((query: string) => void) | undefined
const { db, client } = createDenDb({
  databaseUrl: url,
  mode: "mysql",
  logger: {
    logQuery(query) {
      sqlWitness.getStore()?.push(query)
      onSql?.(query)
    },
  },
})
mock.module("../src/db.js", () => ({ db, client }))
const { sessionMiddleware } = await import("../src/session.js")
const { registerOrgGatewayUsageLimitRoutes } =
  await import("../src/routes/org/gateway-usage-limits.js")
const { registerOrgTeamRoutes } = await import("../src/routes/org/teams.js")
const { registerAdminRoutes } = await import("../src/routes/admin/index.js")
const { deleteGlobalAuthUser } = await import("../src/user-deletion.js")
const { removeOrganizationMember, transferOrganizationOwnership, updateOrganizationMemberRole } =
  await import("../src/orgs.js")
const { registerDeleteOrganizationRoutes } =
  await import("../src/routes/org/delete-organization.js")
const { createRequestAccessLogMiddleware } = await import("../src/observability/hono.js")
const { createAppLogger } = await import("../src/observability/logger.js")
const accessLogs: string[] = []
const service = createGatewayUsageLimits(db)
async function recordUsage(row: typeof GatewayRequestLogTable.$inferInsert) {
  const admission = await service.admit(
    { organizationId: row.organization_id, memberId: row.org_membership_id },
    row.openwork_request_id,
    true,
    row.started_at,
  )
  const attributed = { ...row, metadata: { ...row.metadata, gateway_usage: admission.snapshot } }
  await db.transaction((tx) =>
    startGatewayUsageLog(tx, { ...attributed, completed_at: null, cost_micro_usd: null }),
  )
  await service.record(attributed)
}
const app = new Hono<{ Variables: OrgRouteVariables }>()
app.use(
  "*",
  createRequestAccessLogMiddleware(createAppLogger({ write: (line) => accessLogs.push(line) })),
)
app.use("*", sessionMiddleware)
registerOrgGatewayUsageLimitRoutes(app)
registerOrgTeamRoutes(app)
registerDeleteOrganizationRoutes(app)
registerAdminRoutes(app)
afterAll(async () => {
  if ("end" in client) await client.end()
  mock.restore()
})

async function seed(role: string, organizationId = createDenTypeId("organization")) {
  const memberId = createDenTypeId("member")
  const userId = createDenTypeId("user")
  const token = randomUUID()
  await db
    .insert(OrganizationTable)
    .values({ id: organizationId, name: "Auth fixture", slug: randomUUID() })
    .onDuplicateKeyUpdate({ set: { name: "Auth fixture" } })
  await db
    .insert(AuthUserTable)
    .values({ id: userId, name: "Fixture member", email: `${userId}@example.test` })
  await db.insert(MemberTable).values({ id: memberId, userId, organizationId, role })
  await db.insert(AuthSessionTable).values({
    id: createDenTypeId("session"),
    token,
    userId,
    activeOrganizationId: organizationId,
    expiresAt: new Date(Date.now() + 86_400_000),
  })
  return { memberId, userId, organizationId, token }
}
function request(
  token: string | null,
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const usageSchema = z.object({
  memberId: z.string(),
  organizationId: z.string(),
  buckets: z.array(z.object({ id: z.string() })),
})
const idSchema = z.object({ id: z.string() })
const resetSchema = z.object({ id: z.string(), status: z.string() })

test("real session and org middleware enforce own identity, role and organization path scope", async () => {
  const owner = await seed("owner")
  const member = await seed("member", owner.organizationId)
  const foreign = await seed("owner")
  expect((await request(null, "/v1/gateway/usage-limits/me")).status).toBe(401)
  expect((await request("invalid-session", "/v1/gateway/usage-limits/me")).status).toBe(401)
  const own = await request(member.token, `/v1/gateway/usage-limits/me?memberId=${owner.memberId}`)
  expect(own.status).toBe(200)
  expect(usageSchema.parse(await own.json()).memberId).toBe(member.memberId)
  expect((await request(member.token, "/v1/gateway/usage-limit-policies")).status).toBe(403)
  expect(
    (await request(member.token, `/v1/gateway/usage-limits/members/${owner.memberId}`)).status,
  ).toBe(403)
  expect(
    (await request(owner.token, `/v1/gateway/usage-limits/members/${foreign.memberId}`)).status,
  ).toBe(404)
  expect(
    (
      await request(member.token, "/v1/gateway/usage-limits/me", "GET", undefined, {
        "X-OpenWork-Org-Id": foreign.organizationId,
      })
    ).status,
  ).toBe(404)
  const inspected = await request(
    owner.token,
    `/v1/gateway/usage-limits/members/${member.memberId}`,
  )
  expect(inspected.status).toBe(200)
  expect(usageSchema.parse(await inspected.json()).memberId).toBe(member.memberId)
})

test("member identity search is private, admin-only, active and organization-scoped with safe access logs", async () => {
  const owner = await seed("owner")
  const admin = await seed("admin", owner.organizationId)
  const member = await seed("member", owner.organizationId)
  const removed = await seed("admin", owner.organizationId)
  const foreign = await seed("owner")
  await db
    .update(MemberTable)
    .set({ removedAt: new Date() })
    .where(eq(MemberTable.id, removed.memberId))
  const path = "/v1/gateway/usage-limits/members"
  const logStart = accessLogs.length
  for (const token of [null, "invalid-session"]) {
    const response = await request(token, `${path}?query=Fixture`)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "unauthorized" })
  }
  const forbidden = await request(member.token, `${path}?query=Fixture`)
  expect(forbidden.status).toBe(403)
  expect(forbidden.headers.get("cache-control")).toBe("private, no-store")
  expect(await forbidden.json()).toMatchObject({ error: "forbidden" })
  for (const token of [owner.token, admin.token]) {
    const response = await request(token, `${path}?query=Fixture`)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    const result = z
      .object({
        members: z.array(
          z.object({ id: z.string(), name: z.string(), email: z.string() }).strict(),
        ),
      })
      .parse(await response.json())
    expect(result.members.map((item) => item.id).sort()).toEqual(
      [owner.memberId, admin.memberId, member.memberId].sort(),
    )
    expect(result.members.find((item) => item.id === member.memberId)).toEqual({
      id: member.memberId,
      name: "Fixture member",
      email: `${member.userId}@example.test`,
    })
  }
  const email = `${member.userId}@example.test`
  const byEmail = await request(owner.token, `${path}?query=${encodeURIComponent(email)}`)
  expect(await byEmail.json()).toEqual({
    members: [{ id: member.memberId, name: "Fixture member", email }],
  })
  const crossOrg = await request(foreign.token, path, "GET", undefined, {
    "X-OpenWork-Org-Id": owner.organizationId,
  })
  expect(crossOrg.status).toBe(404)
  expect(await crossOrg.json()).toEqual({ error: "organization_not_found" })
  expect(
    await (await request(foreign.token, `${path}?query=${encodeURIComponent(email)}`)).json(),
  ).toEqual({ members: [] })
  const revoked = await request(removed.token, path, "GET", undefined, {
    "X-OpenWork-Org-Id": owner.organizationId,
  })
  expect(revoked.status).toBe(404)
  expect(await revoked.json()).toEqual({ error: "organization_not_found" })
  const logs = accessLogs.slice(logStart)
  expect(logs.length).toBeGreaterThan(0)
  for (const line of logs) {
    expect(JSON.parse(line)).toMatchObject({ http_route: path, message: "request completed" })
    for (const value of [
      "Fixture",
      "example.test",
      "query=",
      owner.token,
      member.memberId,
      member.userId,
    ]) {
      expect(line).not.toContain(value)
    }
  }
})

test("member identity search honors only current same-organization team admin grants", async () => {
  const owner = await seed("owner")
  const member = await seed("member", owner.organizationId)
  const foreign = await seed("owner")
  const teamId = createDenTypeId("team")
  const membershipId = createDenTypeId("teamMember")
  const path = "/v1/gateway/usage-limits/members"
  await db.insert(TeamTable).values({
    id: teamId,
    organizationId: foreign.organizationId,
    name: randomUUID(),
    grantsOrganizationAdmin: true,
  })
  await db.insert(TeamMemberTable).values({
    id: membershipId,
    teamId,
    orgMembershipId: member.memberId,
  })
  expect((await request(member.token, path)).status).toBe(403)
  await db
    .update(TeamTable)
    .set({ organizationId: owner.organizationId })
    .where(eq(TeamTable.id, teamId))
  const allowed = await request(member.token, path)
  expect(allowed.status).toBe(200)
  expect(allowed.headers.get("cache-control")).toBe("private, no-store")
  const result = z.object({ members: z.array(idSchema) }).parse(await allowed.json())
  expect(result.members.map((item) => item.id).sort()).toEqual(
    [owner.memberId, member.memberId].sort(),
  )
  await db.delete(TeamMemberTable).where(eq(TeamMemberTable.id, membershipId))
  expect((await request(member.token, path)).status).toBe(403)
})

test("actual team API transactions expire remove/rejoin resets without touching unchanged teammates", async () => {
  const owner = await seed("owner")
  const member = await seed("member", owner.organizationId)
  const other = await seed("member", owner.organizationId)
  const teamResponse = await request(owner.token, "/v1/teams", "POST", {
    name: randomUUID(),
    memberIds: [member.memberId, other.memberId],
  })
  expect(teamResponse.status).toBe(201)
  const team = z.object({ team: idSchema }).parse(await teamResponse.json()).team
  const policyResponse = await request(owner.token, "/v1/gateway/usage-limit-policies", "POST", {
    name: "Team daily",
    hardLimit: true,
    allowRequestReset: true,
    limits: [{ timeframe: "day", costUsd: "1" }],
  })
  expect(policyResponse.status).toBe(200)
  const policy = idSchema.parse(await policyResponse.json())
  expect(
    (
      await request(
        owner.token,
        `/v1/gateway/usage-limit-policies/${policy.id}/assignments`,
        "POST",
        { teamId: team.id },
      )
    ).status,
  ).toBe(200)
  async function spendAndRequest(subject: typeof member) {
    const row = {
      id: createDenTypeId("inferenceRequestLog"),
      organization_id: subject.organizationId,
      org_membership_id: subject.memberId,
      openwork_request_id: randomUUID().replaceAll("-", ""),
      started_at: new Date(),
    }
    await service.admit(
      { organizationId: subject.organizationId, memberId: subject.memberId },
      row.openwork_request_id,
      true,
    )
    await recordUsage({
      ...row,
      route: "org_provider",
      protocol: "openai_chat",
      upstream_provider_id: "openai",
      upstream_host: "api.example.test",
      upstream_path: "/chat/completions",
      method: "POST",
      stream: false,
      completed_at: new Date(),
      outcome: "ok",
      usage_source: "json",
      cost_micro_usd: 1_000_000,
    })
    const status = usageSchema.parse(
      await (await request(subject.token, "/v1/gateway/usage-limits/me")).json(),
    )
    const submitted = await request(
      subject.token,
      "/v1/gateway/usage-limit-reset-requests",
      "POST",
      { bucketId: status.buckets[0].id, reason: "Team transition test" },
    )
    expect(submitted.status).toBe(200)
    return resetSchema.parse(await submitted.json())
  }
  const pending = await spendAndRequest(member)
  const unaffected = await spendAndRequest(other)
  expect(
    (await request(owner.token, `/v1/teams/${team.id}`, "PATCH", { memberIds: [other.memberId] }))
      .status,
  ).toBe(200)
  expect(
    (
      await request(owner.token, `/v1/teams/${team.id}`, "PATCH", {
        memberIds: [member.memberId, other.memberId],
      })
    ).status,
  ).toBe(200)
  const review = await request(
    owner.token,
    `/v1/gateway/usage-limit-reset-requests/${pending.id}/approve`,
    "POST",
    {},
  )
  expect(review.status).toBe(200)
  expect(resetSchema.parse(await review.json()).status).toBe("expired")
  const unchanged = await request(
    owner.token,
    `/v1/gateway/usage-limit-reset-requests/${unaffected.id}/approve`,
    "POST",
    {},
  )
  expect(unchanged.status).toBe(200)
  expect(resetSchema.parse(await unchanged.json()).status).toBe("approved")
})

test("small team changes touch only old/new members despite 80 other policy members and an unrelated member lock", async () => {
  const owner = await seed("owner"),
    a = await seed("member", owner.organizationId),
    b = await seed("member", owner.organizationId)
  const teamResponse = await request(owner.token, "/v1/teams", "POST", {
    name: randomUUID(),
    memberIds: [a.memberId, b.memberId],
  })
  const team = z.object({ team: idSchema }).parse(await teamResponse.json()).team
  const policy = await service.savePolicy(owner, {
    name: "Small team",
    hardLimit: true,
    allowRequestReset: true,
    limits: [{ timeframe: "day", costUsd: "1" }],
  })
  const teamId = (
    await db
      .select({ id: TeamTable.id })
      .from(TeamTable)
      .where(eq(TeamTable.organizationId, owner.organizationId))
  )[0].id
  await service.assign(owner, policy.id, { teamId })
  async function measured(memberIds: string[]) {
    const queries: string[] = []
    const started = performance.now()
    const response = await sqlWitness.run(queries, () =>
      request(owner.token, `/v1/teams/${team.id}`, "PATCH", { memberIds }),
    )
    expect(response.status).toBe(200)
    return { queries, ms: performance.now() - started }
  }
  const baseline = await measured([a.memberId])
  const people = Array.from({ length: 80 }, () => ({
    id: createDenTypeId("member"),
    userId: createDenTypeId("user"),
  }))
  await db.insert(AuthUserTable).values(
    people.map((person) => ({
      id: person.userId,
      name: "Unrelated fixture",
      email: `${person.userId}@example.test`,
    })),
  )
  await db
    .insert(MemberTable)
    .values(
      people.map((person) => ({ ...person, organizationId: owner.organizationId, role: "member" })),
    )
  await db.insert(GatewayUsageAssignmentTable).values(
    people.map((person) => ({
      id: randomUUID(),
      organizationId: owner.organizationId,
      memberId: person.id,
      policyId: policy.id,
      createdAt: new Date(),
    })),
  )
  let ready = () => {},
    release = () => {}
  const locked = new Promise<void>((resolve) => {
      ready = resolve
    }),
    released = new Promise<void>((resolve) => {
      release = resolve
    })
  const holder = db.transaction(async (tx) => {
    await tx.select().from(MemberTable).where(eq(MemberTable.id, people[0].id)).for("update")
    ready()
    await released
  })
  await locked
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const large = await Promise.race([
      measured([a.memberId, b.memberId]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Small team mutation waited for unrelated member")),
          2000,
        )
      }),
    ])
    const quota = (queries: string[]) =>
      queries.filter((query) => query.includes("gateway_usage")).length
    expect(quota(large.queries)).toBeLessThanOrEqual(quota(baseline.queries) + 6)
    expect(quota(large.queries)).toBeLessThan(40)
    console.log(
      JSON.stringify({
        benchmark: "small_team_80_unrelated",
        baselineSql: baseline.queries.length,
        largeSql: large.queries.length,
        baselineQuotaSql: quota(baseline.queries),
        largeQuotaSql: quota(large.queries),
        latencyMs: large.ms,
      }),
    )
  } finally {
    clearTimeout(timer)
    release()
    await holder
  }
})

test("both global-user hard-removal paths expire pending requests and clear markers before any review or GET", async () => {
  for (const viaAdminRoute of [false, true]) {
    const owner = await seed("owner"),
      member = await seed("member", owner.organizationId)
    await db
      .insert(AdminAllowlistTable)
      .values({ id: createDenTypeId("adminAllowlist"), email: `${owner.userId}@example.test` })
    const policy = await service.savePolicy(owner, {
      name: "Removal fixture",
      hardLimit: true,
      allowRequestReset: true,
      limits: [{ timeframe: "day", costUsd: "1" }],
    })
    await service.assign(owner, policy.id, { memberId: member.memberId })
    await recordUsage({
      id: createDenTypeId("inferenceRequestLog"),
      organization_id: owner.organizationId,
      org_membership_id: member.memberId,
      openwork_request_id: randomUUID().replaceAll("-", ""),
      route: "org_provider",
      protocol: "openai_chat",
      upstream_provider_id: "openai",
      upstream_host: "example.test",
      upstream_path: "/chat",
      method: "POST",
      stream: false,
      started_at: new Date(),
      completed_at: new Date(),
      outcome: "ok",
      usage_source: "json",
      cost_micro_usd: 1000000,
      metadata: { cost_source: "upstream", cost_complete: true },
    })
    const bucket = (await service.getStatus(member)).buckets[0]
    const pending = await service.submitReset(member, bucket.id, "Removal fixture")
    if (viaAdminRoute)
      expect(
        (await request(owner.token, `/v1/admin/users/${member.userId}`, "DELETE")).status,
      ).toBe(200)
    else await deleteGlobalAuthUser(member.userId)
    const [stored] = await db
      .select()
      .from(GatewayUsageResetTable)
      .where(eq(GatewayUsageResetTable.id, pending.id))
    expect(stored.status).toBe("expired")
    expect(stored.pendingBucketId).toBeNull()
    expect((await service.listResets(owner, false)).pendingCount).toBe(0)
    expect(
      (await service.listResets(owner, false, { view: "history" })).requests.some(
        (row) => row.id === pending.id && row.status === "expired",
      ),
    ).toBe(true)
  }
})

test("actual ordinary offboarding pauses after locks without blocking another member's canonical start or settlement", async () => {
  const counts: number[] = []
  for (const population of [0, 200]) {
    const owner = await seed("owner"),
      target = await seed("super-admin", owner.organizationId)
    const extra = Array.from({ length: population }, () => ({
      id: createDenTypeId("member"),
      userId: createDenTypeId("user"),
    }))
    if (extra.length) {
      await db.insert(AuthUserTable).values(
        extra.map((row) => ({
          id: row.userId,
          name: "Unrelated fixture",
          email: `${row.userId}@example.test`,
        })),
      )
      await db
        .insert(MemberTable)
        .values(
          extra.map((row) => ({ ...row, organizationId: owner.organizationId, role: "member" })),
        )
    }
    const childId = createDenTypeId("connectedAccount")
    await db.insert(ConnectedAccountTable).values({
      id: childId,
      organizationId: owner.organizationId,
      orgMembershipId: target.memberId,
      providerId: "fixture",
    })
    const late: typeof GatewayRequestLogTable.$inferInsert = {
      id: createDenTypeId("inferenceRequestLog"),
      organization_id: owner.organizationId,
      org_membership_id: owner.memberId,
      openwork_request_id: randomUUID().replaceAll("-", ""),
      route: "org_provider",
      protocol: "openai_chat",
      upstream_provider_id: "fixture",
      upstream_host: "example.test",
      upstream_path: "/chat",
      method: "POST",
      stream: false,
      started_at: new Date(),
      completed_at: new Date(),
      outcome: "ok",
      usage_source: "json",
      cost_micro_usd: 11,
      metadata: { cost_source: "upstream", cost_complete: true },
    }
    const admission = await service.admit(owner, late.openwork_request_id, true)
    late.metadata = { ...late.metadata, gateway_usage: admission.snapshot }
    await db.transaction((tx) =>
      startGatewayUsageLog(tx, { ...late, completed_at: null, cost_micro_usd: null }),
    )
    let locked = () => {},
      release = () => {},
      reached = () => {}
    const holding = new Promise<void>((resolve) => {
        locked = resolve
      }),
      freed = new Promise<void>((resolve) => {
        release = resolve
      }),
      afterLocks = new Promise<void>((resolve) => {
        reached = resolve
      })
    const holder = db.transaction(async (tx) => {
      await tx
        .select()
        .from(ConnectedAccountTable)
        .where(eq(ConnectedAccountTable.id, childId))
        .for("update")
      locked()
      await freed
    })
    await holding
    const queries: string[] = []
    onSql = (query) => {
      if (/^delete from `connected_account`/i.test(query)) reached()
    }
    const removal = sqlWitness.run(queries, () =>
      removeOrganizationMember({
        organizationId: owner.organizationId,
        memberId: target.memberId,
        removedByOrgMemberId: owner.memberId,
      }),
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    let transfer: ReturnType<typeof transferOrganizationOwnership> | undefined
    try {
      await Promise.race([
        afterLocks,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Offboarding did not reach its post-lock child operation")),
            2000,
          )
        }),
      ])
      clearTimeout(timer)
      transfer = transferOrganizationOwnership({
        organizationId: owner.organizationId,
        currentOwnerMemberId: owner.memberId,
        targetMemberId: target.memberId,
      })
      const started = performance.now()
      await Promise.race([
        Promise.all([
          service.record(late),
          recordUsage({
            ...late,
            id: createDenTypeId("inferenceRequestLog"),
            openwork_request_id: randomUUID().replaceAll("-", ""),
            cost_micro_usd: 13,
          }),
        ]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Member B accounting waited for offboarding A")),
            2000,
          )
        }),
      ])
      console.log(
        JSON.stringify({
          benchmark: "ordinary_offboard_member_fence",
          unrelatedMembers: population,
          unrelatedStartAndSettleMs: performance.now() - started,
        }),
      )
    } finally {
      clearTimeout(timer)
      onSql = undefined
      release()
      await holder
    }
    expect((await removal).ok).toBe(true)
    expect((await transfer)?.ok).toBe(false)
    expect(
      (
        await removeOrganizationMember({
          organizationId: owner.organizationId,
          memberId: owner.memberId,
        })
      ).ok,
    ).toBe(false)
    expect(
      (
        await updateOrganizationMemberRole({
          organizationId: owner.organizationId,
          memberId: owner.memberId,
          nextRole: "member",
        })
      ).ok,
    ).toBe(false)
    for (const query of queries.filter(
      (query) => /from `member`/.test(query) && /for update/i.test(query),
    ))
      expect(query).toMatch(/`member`\.`id` =|`id` =/)
    counts.push(queries.length)
  }
  expect(counts[1]).toBeLessThanOrEqual(counts[0] + 2)
  console.log(
    JSON.stringify({
      benchmark: "ordinary_offboard_sql",
      baselineSql: counts[0],
      with200UnrelatedSql: counts[1],
    }),
  )
})

test("permanent organization deletion erases every usage table and preserves another organization", async () => {
  const owner = await seed("owner")
  const other = await seed("owner")
  async function populate(subject: typeof owner) {
    const scope = { organizationId: subject.organizationId, memberId: subject.memberId }
    const policy = await service.savePolicy(scope, {
      name: "Erasure policy",
      hardLimit: true,
      allowRequestReset: true,
      limits: [{ timeframe: "day", costUsd: "1" }],
    })
    await service.assign(scope, policy.id, { memberId: subject.memberId })
    const eventId = randomUUID().replaceAll("-", "")
    await service.admit(scope, eventId, true)
    const row: typeof GatewayRequestLogTable.$inferInsert = {
      id: createDenTypeId("inferenceRequestLog"),
      organization_id: scope.organizationId,
      org_membership_id: scope.memberId,
      openwork_request_id: eventId,
      started_at: new Date(),
      completed_at: new Date(),
      route: "org_provider",
      protocol: "openai_chat",
      upstream_provider_id: "openai",
      upstream_host: "fixture.example.test",
      upstream_path: "/chat/completions",
      method: "POST",
      stream: false,
      outcome: "ok",
      usage_source: "json",
      cost_micro_usd: 1_000_000,
      metadata: { cost_source: "upstream", cost_complete: true },
    }
    await recordUsage(row)
    const bucket = (await service.getStatus(scope)).buckets[0]
    await service.submitReset(scope, bucket.id, "Erasure fixture reason")
    await db
      .insert(GatewayUsageSubjectTable)
      .values({ ...scope, trackingSince: row.started_at, initializedAt: row.started_at })
    await db.insert(GatewayUsageQuarantineTable).values({
      id: randomUUID().replaceAll("-", ""),
      ...scope,
      admittedAt: new Date(Date.now() - 3_600_000),
      receivedAt: new Date(),
      costMicroUsd: 7,
      reason: "pre_cutover_identity_missing",
    })
    return {
      organizationId: scope.organizationId,
      policyId: policy.id,
      eventId,
      bucketId: bucket.id,
    }
  }
  const target = await populate(owner)
  const preserved = await populate(other)
  async function snapshot(refs: typeof target) {
    return {
      policy: await db
        .select()
        .from(GatewayUsagePolicyTable)
        .where(eq(GatewayUsagePolicyTable.organizationId, refs.organizationId)),
      entry: await db
        .select()
        .from(GatewayUsageLimitTable)
        .where(eq(GatewayUsageLimitTable.policyId, refs.policyId)),
      assignment: await db
        .select()
        .from(GatewayUsageAssignmentTable)
        .where(eq(GatewayUsageAssignmentTable.organizationId, refs.organizationId)),
      tracking: await db
        .select()
        .from(GatewayUsageTrackingTable)
        .where(eq(GatewayUsageTrackingTable.organizationId, refs.organizationId)),
      subject: await db
        .select()
        .from(GatewayUsageSubjectTable)
        .where(eq(GatewayUsageSubjectTable.organizationId, refs.organizationId)),
      bucket: await db
        .select()
        .from(GatewayUsageBucketTable)
        .where(eq(GatewayUsageBucketTable.organizationId, refs.organizationId)),
      event: await db
        .select()
        .from(GatewayUsageEventTable)
        .where(eq(GatewayUsageEventTable.organizationId, refs.organizationId)),
      charge: await db
        .select()
        .from(GatewayUsageChargeTable)
        .where(
          or(
            eq(GatewayUsageChargeTable.bucketId, refs.bucketId),
            eq(GatewayUsageChargeTable.eventId, refs.eventId),
            eq(GatewayUsageChargeTable.policyId, refs.policyId),
          ),
        ),
      reset: await db
        .select()
        .from(GatewayUsageResetTable)
        .where(eq(GatewayUsageResetTable.organizationId, refs.organizationId)),
      quarantine: await db
        .select()
        .from(GatewayUsageQuarantineTable)
        .where(eq(GatewayUsageQuarantineTable.organizationId, refs.organizationId)),
      audit: await db
        .select()
        .from(GatewayUsageAuditTable)
        .where(eq(GatewayUsageAuditTable.organizationId, refs.organizationId)),
    }
  }
  const beforeTarget = await snapshot(target)
  const beforeOther = await snapshot(preserved)
  for (const rows of Object.values(beforeTarget)) expect(rows.length).toBeGreaterThan(0)
  for (const rows of Object.values(beforeOther)) expect(rows.length).toBeGreaterThan(0)
  const response = await request(owner.token, "/v1/org", "DELETE")
  expect(response.status).toBe(200)
  for (const rows of Object.values(await snapshot(target))) expect(rows).toEqual([])
  expect(await snapshot(preserved)).toEqual(beforeOther)
  expect(
    (
      await db
        .select()
        .from(OrganizationTable)
        .where(eq(OrganizationTable.id, owner.organizationId))
    ).length,
  ).toBe(0)
  expect((await request(other.token, "/v1/gateway/usage-limits/me")).status).toBe(200)
})
