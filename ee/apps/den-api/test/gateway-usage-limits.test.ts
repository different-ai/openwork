import { afterAll, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Hono, type MiddlewareHandler } from "hono"
import { createDenDb, AuthUserTable, OrganizationTable, MemberTable, GatewayRequestLogTable } from "@openwork-ee/den-db"
import {
  createGatewayUsageLimits,
  startGatewayUsageLog,
  type GatewayUsageScope,
} from "@openwork-ee/den-db/gateway-usage-limits"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import * as validation from "../src/middleware/validation.js"
import { z } from "zod"
import { generateSpecs } from "hono-openapi"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"
import { writeFile } from "node:fs/promises"

const url = process.env.DEN_USAGE_TEST_DATABASE_URL
if (
  !url ||
  !["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
  !new URL(url).pathname.startsWith("/usage_limits_test")
)
  throw new Error(
    "Set DEN_USAGE_TEST_DATABASE_URL to a disposable loopback usage_limits_test database.",
  )
process.env.DATABASE_URL = url
process.env.OPENWORK_DEV_MODE = "1"
process.env.DEN_DB_ENCRYPTION_KEY = "usage-test-key-not-a-secret-32-characters"
process.env.BETTER_AUTH_SECRET = "usage-test-auth-not-a-secret-32-characters"
process.env.DEN_BASE_URL = "http://localhost:3005"
process.env.GATEWAY_ENABLED = "true"
process.env.GATEWAY_PROXY_BASE_URL = "http://localhost:8791"
process.env.GATEWAY_PUBLIC_BASE_URL = "https://gateway.example.test"
const { db, client } = createDenDb({ databaseUrl: url, mode: "mysql" })
const service = createGatewayUsageLimits(db)
async function recordUsage(row: typeof GatewayRequestLogTable.$inferInsert) {
  const admission = await service.admit({ organizationId: row.organization_id, memberId: row.org_membership_id }, row.openwork_request_id, true, row.started_at)
  const attributed = { ...row, metadata: { ...row.metadata, gateway_usage: admission.snapshot } }
  await db.transaction((tx) => startGatewayUsageLog(tx, { ...attributed, completed_at: null, cost_micro_usd: null }))
  await service.record(attributed)
}
mock.module("../src/db.js", () => ({ db }))
let actor: GatewayUsageScope | null = null
let role = "member"
const memberRoute: MiddlewareHandler = async (c, next) => {
  if (!actor) return c.json({ error: "unauthorized" }, 401)
  c.set("organizationContext", {
    organization: { id: actor.organizationId },
    currentMember: { id: actor.memberId, role, isOwner: role === "owner" },
  })
  await next()
}
mock.module("../src/middleware/index.js", () => ({
  ...validation,
  orgMemberRoute: () => memberRoute,
}))
const { registerOrgGatewayUsageLimitRoutes } = await import(
  "../src/routes/org/gateway-usage-limits.js"
)
const { env } = await import("../src/env.js")
const app = new Hono<{ Variables: OrgRouteVariables }>()
registerOrgGatewayUsageLimitRoutes(app, service)
afterAll(async () => {
  mock.restore()
  if ("end" in client) await client.end()
})
async function seed(
  memberRole: string,
  organizationId = createDenTypeId("organization"),
): Promise<GatewayUsageScope> {
  const userId = createDenTypeId("user")
  const memberId = createDenTypeId("member")
  await db
    .insert(OrganizationTable)
    .values({ id: organizationId, name: "HTTP test", slug: randomUUID() })
    .onDuplicateKeyUpdate({ set: { name: "HTTP test" } })
  await db
    .insert(AuthUserTable)
    .values({ id: userId, name: "Test user", email: `${userId}@example.test` })
  await db.insert(MemberTable).values({ id: memberId, organizationId, userId, role: memberRole })
  return { organizationId, memberId }
}
function request(path: string, method = "GET", body?: unknown) {
  return app.request(`/v1/gateway/${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
}
const input = {
  name: "Standard",
  hardLimit: true,
  allowRequestReset: true,
  limits: [{ timeframe: "day", costUsd: "0.000005" }],
}
const policySchema = z.object({
  id: z.string(),
  revision: z.number(),
  limits: z.array(z.object({ timeframe: z.string(), costLimitMicroUsd: z.number() })),
  assignments: z.array(
    z.object({ id: z.string(), memberId: z.string().nullable(), teamId: z.string().nullable(), organization: z.boolean() }),
  ),
})
const usageSchema = z.object({
  memberId: z.string(),
  organizationId: z.string(),
  state: z.string(),
  buckets: z.array(
    z.object({ id: z.string(), allowanceMicroUsd: z.number(), usedMicroUsd: z.number() }),
  ),
})
const resetSchema = z.object({
  id: z.string(),
  status: z.string(),
  memberId: z.string(),
  reviewedBy: z.string().nullable(),
  allowanceMicroUsd: z.number(),
})

test("HTTP contracts, roles, cross-org lookup, reset ownership and approved extension", async () => {
  const owner = await seed("owner")
  const member = await seed("member", owner.organizationId)
  const foreign = await seed("owner")
  actor = null
  expect((await request("usage-limits/me")).status).toBe(401)
  actor = member
  role = "member"
  expect((await request("usage-limit-policies")).status).toBe(403)
  expect((await request(`usage-limits/members/${owner.memberId}`)).status).toBe(403)
  actor = owner
  role = "owner"
  const created = await request("usage-limit-policies", "POST", input)
  expect(created.status).toBe(200)
  const policy = policySchema.parse(await created.json())
  expect(policy.limits).toEqual([{ timeframe: "day", costLimitMicroUsd: 5 }])
  const assigned = await request(`usage-limit-policies/${policy.id}/assignments`, "POST", {
    memberId: member.memberId,
  })
  expect(assigned.status).toBe(200)
  const assignment = policySchema.parse(await assigned.json()).assignments[0]
  expect(assignment.memberId).toBe(member.memberId)
  expect(
    (
      await request(`usage-limit-policies/${policy.id}/assignments`, "POST", {
        memberId: foreign.memberId,
      })
    ).status,
  ).toBe(404)
  expect(
    (await request(`usage-limit-policies/${policy.id}`, "PATCH", { ...input, revision: 99 }))
      .status,
  ).toBe(409)
  expect(
    (
      await request("usage-limit-policies", "POST", {
        ...input,
        limits: [...input.limits, ...input.limits],
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await request("usage-limit-policies", "POST", {
        ...input,
        limits: [{ timeframe: "day", costUsd: "0.0000001" }],
      })
    ).status,
  ).toBe(400)
  const members = z
    .object({ members: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })) })
    .parse(await (await request("usage-limits/members?query=Test")).json())
  expect(members.members.map((item) => item.id).sort()).toEqual(
    [owner.memberId, member.memberId].sort(),
  )
  actor = member
  role = "member"
  const usage = usageSchema.parse(
    await (await request(`usage-limits/me?memberId=${owner.memberId}`)).json(),
  )
  expect(usage.memberId).toBe(member.memberId)
  await recordUsage({
    id: createDenTypeId("inferenceRequestLog"),
    organization_id: member.organizationId,
    org_membership_id: member.memberId,
    openwork_request_id: randomUUID().replaceAll("-", ""),
    route: "org_provider",
    protocol: "openai_chat",
    upstream_provider_id: "openai",
    upstream_host: "api.example.test",
    upstream_path: "/chat/completions",
    method: "POST",
    stream: false,
    started_at: new Date(),
    completed_at: new Date(),
    outcome: "ok",
    usage_source: "json",
    cost_micro_usd: 5,
  })
  expect(
    (
      await request("usage-limit-reset-requests", "POST", {
        bucketId: usage.buckets[0].id,
        reason: " ",
      })
    ).status,
  ).toBe(400)
  const submitted = await request("usage-limit-reset-requests", "POST", {
    bucketId: usage.buckets[0].id,
    reason: "Test request",
  })
  expect(submitted.status).toBe(200)
  const reset = resetSchema.parse(await submitted.json())
  expect(reset.memberId).toBe(member.memberId)
  expect((await request(`usage-limit-reset-requests/${reset.id}/approve`, "POST", {})).status).toBe(
    403,
  )
  actor = foreign
  role = "owner"
  expect((await request(`usage-limit-reset-requests/${reset.id}/approve`, "POST", {})).status).toBe(
    404,
  )
  expect((await request(`usage-limits/members/${member.memberId}`)).status).toBe(404)
  expect(
    (
      await request("usage-limit-reset-requests", "POST", {
        bucketId: usage.buckets[0].id,
        reason: "Other",
      })
    ).status,
  ).toBe(404)
  actor = owner
  role = "owner"
  const approved = resetSchema.parse(
    await (await request(`usage-limit-reset-requests/${reset.id}/approve`, "POST", {})).json(),
  )
  expect(approved.status).toBe("approved")
  expect(approved.allowanceMicroUsd).toBe(7)
  expect(approved.reviewedBy).toBe(owner.memberId)
  const queue = await (await request("usage-limit-reset-requests")).json()
  expect(queue).toMatchObject({
    requests: [],
    view: "pending",
    limit: 50,
    pendingCount: 0,
    hasMore: false,
    nextCursor: null,
  })
  const history = z
    .object({
      requests: z.array(resetSchema),
      view: z.string(),
      limit: z.number(),
      nextCursor: z.string().nullable(),
    })
    .parse(await (await request("usage-limit-reset-requests?view=history&limit=1")).json())
  expect(history.requests[0].id).toBe(reset.id)
  expect(history.view).toBe("history")
  expect(history.limit).toBe(1)
  expect((await request("usage-limit-reset-requests?limit=101")).status).toBe(400)
  expect((await request("usage-limit-reset-requests?cursor=invalid")).status).toBe(400)
  expect(
    (await request(`usage-limit-policies/${policy.id}/assignments/${assignment.id}`, "DELETE"))
      .status,
  ).toBe(200)
  expect(
    (
      await request(`usage-limit-policies/${policy.id}/archive`, "POST", {
        revision: policy.revision,
      })
    ).status,
  ).toBe(200)
  actor = member
  role = "member"
  expect(usageSchema.parse(await (await request("usage-limits/me")).json()).state).toBe("unlimited")
})

test("organization assignment is strict, admin-only, idempotent and includes future members", async () => {
  const owner = await seed("owner")
  const member = await seed("member", owner.organizationId)
  const foreign = await seed("owner")
  actor = owner
  role = "owner"
  const policy = policySchema.parse(await (await request("usage-limit-policies", "POST", input)).json())
  const path = `usage-limit-policies/${policy.id}/assignments`
  for (const target of [
    {},
    { organization: false },
    { organization: "true" },
    { organization: true, memberId: member.memberId },
    { organization: true, teamId: createDenTypeId("team") },
    { organization: true, organizationId: foreign.organizationId },
  ]) expect((await request(path, "POST", target)).status).toBe(400)
  actor = member
  role = "member"
  expect((await request(path, "POST", { organization: true })).status).toBe(403)
  actor = foreign
  role = "owner"
  expect((await request(path, "POST", { organization: true })).status).toBe(404)
  actor = owner
  const assigned = await request(path, "POST", { organization: true })
  expect(assigned.status).toBe(200)
  const assignments = policySchema.parse(await assigned.json()).assignments
  expect(assignments).toEqual([{ id: expect.any(String), organization: true, memberId: null, teamId: null }])
  expect(policySchema.parse(await (await request(path, "POST", { organization: true })).json()).assignments).toEqual(assignments)
  expect(await (await request(path)).json()).toEqual({ assignments })
  const future = await seed("member", owner.organizationId)
  actor = future
  role = "member"
  expect(usageSchema.parse(await (await request("usage-limits/me")).json()).buckets[0]?.allowanceMicroUsd).toBe(5)
  expect((await service.getStatus(foreign)).state).toBe("unlimited")
})

test("OpenAPI exposes the wire contract and explicit authentication", async () => {
  const spec = await generateSpecs(app, {
    documentation: {
      info: {
        title: "Gateway Usage Limits",
        version: "1.0.0",
        description: "Isolated backend contract",
        contact: { name: "Engineering" },
      },
      servers: [{ url: "https://gateway.example.test" }],
      tags: [
        { name: "Gateway Usage Limits", description: "Estimated-cost policies and member usage." },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
          denApiKey: { type: "apiKey", in: "header", name: "x-api-key" },
        },
      },
    },
  })
  expect(spec.paths?.["/v1/gateway/usage-limits/me"]?.get?.security).toEqual([
    { bearerAuth: [] },
    { denApiKey: [] },
  ])
  expect(spec.paths?.["/v1/gateway/usage-limit-policies"]?.post?.responses?.["200"]).toBeDefined()
  expect(Object.keys(spec.paths ?? {})).toHaveLength(12)
  if (process.env.OPENWORK_USAGE_OPENAPI_PATH)
    await writeFile(process.env.OPENWORK_USAGE_OPENAPI_PATH, JSON.stringify(spec, null, 2))
})

test("deployment gating rejects all management and own usage routes before storage", async () => {
  actor = await seed("owner")
  role = "owner"
  env.gatewayEnabled = false
  for (const [path, method] of [
    ["usage-limit-policies", "GET"],
    ["usage-limit-policies", "POST"],
    ["usage-limits/me", "GET"],
    ["usage-limits/members", "GET"],
    ["usage-limit-reset-requests/me", "GET"],
    ["usage-limit-reset-requests", "GET"],
    ["usage-limit-reset-requests", "POST"],
  ]) {
    expect((await request(path, method)).status).toBe(403)
  }
  env.gatewayEnabled = true
})
