import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { Hono } from "hono"
import { requestId } from "hono/request-id"
import { and, eq, isNull, sql } from "@openwork-ee/den-db/drizzle"
import { AuditEventTable, AuditOperationStepTable, AuditPolicyTable, AuditUsageFactTable, AuthSessionTable, AuthUserTable, GatewayCredentialSetTable, GatewayModelGroupTable, GatewayProviderAccessTable, GatewayProviderModelTable, GatewayProviderTable, MemberTable, OrganizationTable, TeamTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { AUDIT_CORRELATION_HEADER } from "@openwork/types/den/audit"
import type { GatewayAccessGrantWrite } from "@openwork/types/den/gateway"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"

const url = process.env.DEN_AUDIT_TEST_DATABASE_URL
if (url) {
  const parsed = new URL(url)
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || !/^\/audit_logs_test(?:_[a-z0-9_]+)?$/.test(parsed.pathname)) throw new Error("Only an explicitly owned disposable loopback audit_logs_test database is allowed; connection withheld.")
}
let storage: typeof import("../src/db.js")
let routes: typeof import("../src/routes/org/inference-providers.js")
let environment: typeof import("../src/env.js")
const realFetch = globalThis.fetch
before(async () => {
  if (!url) return
  Object.assign(process.env, { DATABASE_URL: url, DB_MODE: "mysql", NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DEN_DB_ENCRYPTION_KEY: "audit-provider-disposable-test-key-1234567890123456", BETTER_AUTH_SECRET: "audit-provider-disposable-auth-key-1234567890123456", BETTER_AUTH_URL: "http://127.0.0.1:8790", DEN_BASE_URL: "http://127.0.0.1:8790", GATEWAY_ENABLED: "true", GATEWAY_PUBLIC_BASE_URL: "https://gateway.example.test", GATEWAY_PROXY_BASE_URL: "https://gateway.example.test" })
  globalThis.fetch = async (input) => {
    if (String(input) !== "https://models.openworklabs.com/api.json") throw new Error("Unexpected external call in isolated provider tests")
    return Response.json({ synthetic: { id: "synthetic", name: "Synthetic", npm: "@ai-sdk/openai", env: ["SYNTHETIC_API_KEY"], models: { "model-a": { id: "model-a", name: "Catalog A" }, "model-b": { id: "model-b", name: "Catalog B" } } } })
  }
  environment = await import("../src/env.js")
  Object.assign(environment.env, { auditCaptureEnabled: true })
  storage = await import("../src/db.js")
  routes = await import("../src/routes/org/inference-providers.js")
})
after(async () => {
  globalThis.fetch = realFetch
  if (storage && "end" in storage.client) await storage.client.end()
})
const dbTest = (name: string, run: () => Promise<void>) => test(name, { skip: !url }, run)
function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value))
  return Object.fromEntries(Object.entries(value))
}
function string(value: unknown): string { assert.equal(typeof value, "string"); return String(value) }
function mysqlRows(value: unknown): unknown[] {
  assert.ok(Array.isArray(value))
  assert.ok(Array.isArray(value[0]))
  return value[0]
}
function safeFailure(error: unknown) {
  let code = "unclassified"
  const statements: string[] = []
  let current = error
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    if ("code" in current && (current.code === "ER_LOCK_DEADLOCK" || current.code === "ER_LOCK_WAIT_TIMEOUT")) code = current.code
    if ("query" in current && typeof current.query === "string") {
      const operation = /^(select|insert|update|delete)\b/i.exec(current.query)?.[1]
      const table = /\b(?:from|into|update)\s+`([a-z_]+)`/i.exec(current.query)?.[1]
      if (operation && table) statements.push(`${operation.toLowerCase()} ${table}`)
    }
    current = "cause" in current ? current.cause : null
  }
  return { code, statements }
}

async function fixture(role = "owner", policy = true, sharedOrganizationId?: typeof OrganizationTable.$inferSelect.id) {
  const { db } = storage
  const orgId = sharedOrganizationId ?? createDenTypeId("organization")
  const userId = createDenTypeId("user")
  const memberId = createDenTypeId("member")
  const sessionId = createDenTypeId("session")
  await db.insert(AuthUserTable).values({ id: userId, name: "Synthetic operator", email: `${userId}@example.test`, emailVerified: true })
  if (!sharedOrganizationId) await db.insert(OrganizationTable).values({ id: orgId, name: "Synthetic audit organization", slug: `synthetic-${orgId}`, metadata: { plan: { tier: "enterprise", source: "manual" } } })
  await db.insert(MemberTable).values({ id: memberId, organizationId: orgId, userId, role })
  await db.insert(AuthSessionTable).values({ id: sessionId, userId, token: `synthetic-session-${sessionId}`, activeOrganizationId: orgId, expiresAt: new Date(Date.now() + 600000) })
  if (policy && !sharedOrganizationId) await db.insert(AuditPolicyTable).values({ organization_id: orgId, revision: 1, source: "operator", enabled: true, categories: ["change", "request", "execution", "security"], allowance: 100, excess_mode: "keep_all", attachment_window_seconds: 300, effective_at: new Date("2026-01-01T00:00:00Z") })
  const [user] = await db.select().from(AuthUserTable).where(eq(AuthUserTable.id, userId))
  const [session] = await db.select().from(AuthSessionTable).where(eq(AuthSessionTable.id, sessionId))
  const app = new Hono<{ Variables: OrgRouteVariables }>()
  app.use("*", requestId({ headerName: "", generator: () => createDenTypeId("request") }))
  app.use("*", async (c, next) => { c.set("user", user); c.set("session", session); c.set("apiKey", null); await next() })
  const failures: ReturnType<typeof safeFailure>[] = []
  app.onError((error) => { failures.push(safeFailure(error)); return Response.json({ error: "synthetic_route_error" }, { status: 500 }) })
  routes.registerOrgInferenceProviderRoutes(app)
  const request = async (method: string, path: string, body?: unknown, correlation = randomUUID()) => app.request(path, { method, headers: { "content-type": "application/json", "x-openwork-org-id": orgId, "x-request-id": "external-do-not-trust", [AUDIT_CORRELATION_HEADER]: correlation }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const events = async () => (await db.select().from(AuditEventTable).where(eq(AuditEventTable.org_id, orgId)).orderBy(AuditEventTable.sequence)).flatMap((row) => row.envelope ? [row.envelope] : [])
  const create = async () => {
    const response = await request("POST", "/v1/inference-providers", { name: "Synthetic", providerId: "synthetic", modelIds: ["model-a"], credentialMode: "org", credential: { kind: "api_key", secret: "synthetic-private-material" } })
    assert.equal(response.status, 201, JSON.stringify({ response: await response.clone().text(), failures }))
    const provider = record(record(await response.json()).inferenceProvider)
    const id = string(provider.id)
    const [group] = await db.select().from(GatewayModelGroupTable).where(eq(GatewayModelGroupTable.gateway_provider_id, createDenId(id)))
    const [set] = await db.select().from(GatewayCredentialSetTable).where(eq(GatewayCredentialSetTable.gateway_provider_id, createDenId(id)))
    return { id, group, set }
  }
  return { db, app, orgId, userId, memberId, request, events, create, failures }
}
const createDenId = (value: string) => normalizeDenTypeId("inferenceProvider", value)

dbTest("separate authenticated members of one organization can create providers concurrently", async () => {
  const first = await fixture()
  const second = await fixture("admin", false, first.orgId)
  assert.notEqual(first.userId, second.userId)
  assert.notEqual(first.memberId, second.memberId)
  assert.equal(first.orgId, second.orgId)
  const actors = [first, second]
  const outcomes = await Promise.allSettled(actors.map((actor) => actor.create()))
  const providers: Awaited<ReturnType<typeof first.create>>[] = []
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") throw outcome.reason
    providers.push(outcome.value)
  }
  assert.equal(new Set(providers.map((provider) => provider.id)).size, 2)
  const events = await first.events()
  const created = events.filter((event) => event.action === "provider.created")
  assert.equal(created.length, 2)
  assert.equal(new Set(created.map((event) => event.operationId)).size, 2)
  assert.equal(events.filter((event) => event.category === "request").length, 2)
  for (const [index, actor] of actors.entries()) {
    const provider = providers[index]
    const [row] = await actor.db.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.id, createDenId(provider.id)))
    assert.equal(row.organization_id, first.orgId)
    assert.equal(row.created_by_org_membership_id, actor.memberId)
    assert.equal(provider.set.created_by_org_membership_id, actor.memberId)
    assert.equal(provider.group.gateway_provider_id, row.id)
    const event = created.find((event) => event.operation.scope === row.id)
    assert.equal(event?.actor.id, actor.userId)
    assert.equal(event?.actor.memberId, actor.memberId)
    assert.equal(event?.changes?.before, null)
    assert.ok(events.filter((entry) => entry.operation.scope === row.id).every((entry) => entry.operationId === event?.operationId && entry.actor.id === actor.userId))
  }
})

for (const method of ["PATCH", "POST"]) for (const nextRole of ["admin,member", "member"]) {
  dbTest(`captured provider ${method} waits for organization before member/provider locks during role change to ${nextRole}`, async () => {
    const f = await fixture("admin")
    await fixture("owner", false, f.orgId)
    const { id } = await f.create()
    const before = await f.events()
    const originalProviders = await f.db.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.organization_id, f.orgId))
    const { withOrganizationTeamMutation } = await import("../src/organization-team-roles.js")
    let pending: Promise<Response> | undefined
    let response: Response | undefined
    let requestFinished = false
    let witnessed = false
    try {
      await withOrganizationTeamMutation(f.orgId, async (tx) => {
        pending = f.request(method, method === "PATCH" ? `/v1/inference-providers/${id}` : "/v1/inference-providers", method === "PATCH"
          ? { name: "After role lock barrier" }
          : { name: "After role lock barrier", providerId: "synthetic", modelIds: ["model-a"], credentialMode: "org", credential: { kind: "api_key", secret: "synthetic-lock-regression-material" } })
          .then((result) => { requestFinished = true; return result })
        let witness: Record<string, unknown> | undefined
        const deadline = Date.now() + 5000
        while (!witness && Date.now() < deadline) {
          const result = await tx.execute(sql`
            SELECT CAST(w.REQUESTING_ENGINE_TRANSACTION_ID AS CHAR) AS transactionId,
              requester.PROCESSLIST_INFO AS statement, requested.LOCK_MODE AS lockMode
            FROM performance_schema.data_lock_waits w
            JOIN performance_schema.data_locks requested ON requested.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID AND requested.ENGINE = w.ENGINE
            JOIN performance_schema.data_locks blocked ON blocked.ENGINE_LOCK_ID = w.BLOCKING_ENGINE_LOCK_ID AND blocked.ENGINE = w.ENGINE
            JOIN performance_schema.threads holder ON holder.THREAD_ID = w.BLOCKING_THREAD_ID
            JOIN performance_schema.threads requester ON requester.THREAD_ID = w.REQUESTING_THREAD_ID
            WHERE holder.PROCESSLIST_ID = CONNECTION_ID()
              AND requested.OBJECT_SCHEMA = DATABASE() AND requested.OBJECT_NAME = 'organization'
              AND requested.INDEX_NAME = 'PRIMARY' AND requested.LOCK_TYPE = 'RECORD' AND requested.LOCK_STATUS = 'WAITING'
              AND blocked.OBJECT_SCHEMA = DATABASE() AND blocked.OBJECT_NAME = 'organization' AND blocked.LOCK_STATUS = 'GRANTED'
            LIMIT 2
          `)
          const rows = mysqlRows(result)
          if (rows.length) {
            assert.equal(rows.length, 1)
            witness = record(rows[0])
          } else {
            assert.equal(requestFinished, false, "HTTP request finished before reaching the organization lock barrier")
            await delay(10)
          }
        }
        assert.ok(witness, "HTTP request must demonstrably wait on the role mutation's organization lock")
        assert.match(string(witness.lockMode), /^S(?:,|$)/)
        assert.match(string(witness.statement), /^select\s+`metadata`\s+from\s+`organization`/i)
        assert.match(string(witness.statement), /(?:for share|lock in share mode)\s*$/i)
        const transactionId = string(witness.transactionId)
        const held = await tx.execute(sql`
          SELECT OBJECT_NAME AS tableName, LOCK_MODE AS lockMode
          FROM performance_schema.data_locks
          WHERE ENGINE_TRANSACTION_ID = ${transactionId} AND OBJECT_SCHEMA = DATABASE()
            AND OBJECT_NAME IN ('member', 'gateway_providers', 'audit_state', 'audit_policy', 'audit_operation', 'audit_event')
            AND LOCK_STATUS = 'GRANTED'
        `)
        assert.deepEqual(mysqlRows(held), [], "captured route must not hold member, provider or audit locks while waiting for organization")
        assert.equal(requestFinished, false)
        witnessed = true
        const activeRows = await tx.select({ member: MemberTable, userId: AuthUserTable.id }).from(MemberTable)
          .leftJoin(AuthUserTable, eq(MemberTable.userId, AuthUserTable.id))
          .where(and(eq(MemberTable.organizationId, f.orgId), isNull(MemberTable.removedAt))).for("update")
        assert.equal(activeRows.find((row) => row.member.id === f.memberId)?.member.role, "admin")
        await tx.update(MemberTable).set({ role: nextRole }).where(and(eq(MemberTable.id, f.memberId), eq(MemberTable.organizationId, f.orgId), isNull(MemberTable.removedAt)))
      })
    } finally {
      if (pending) response = await pending
    }
    assert.equal(witnessed, true)
    assert.ok(response)
    assert.deepEqual(f.failures, [])
    const [member] = await f.db.select().from(MemberTable).where(eq(MemberTable.id, f.memberId))
    assert.equal(member.role, nextRole)
    const events = (await f.events()).slice(before.length)
    const providers = await f.db.select().from(GatewayProviderTable).where(eq(GatewayProviderTable.organization_id, f.orgId))
    const step = method === "PATCH" ? "update" : "create"
    if (nextRole === "member") {
      assert.equal(response.status, 403, await response.clone().text())
      assert.deepEqual(providers, originalProviders)
      assert.equal(events.length, 1)
      assert.equal(events[0].action, `provider.configuration.${step}.attempted`)
      assert.equal(events[0].outcome, "denied")
    } else {
      assert.equal(response.status, method === "PATCH" ? 200 : 201, await response.clone().text())
      assert.equal(providers.length, originalProviders.length + (method === "POST" ? 1 : 0))
      assert.ok(providers.some((provider) => provider.name === "After role lock barrier"))
      assert.ok(events.some((event) => event.action === `provider.configuration.${step}.committed` && event.outcome === "succeeded"))
      assert.ok(events.some((event) => event.action === (method === "PATCH" ? "provider.updated" : "provider.created")))
    }
    assert.ok(events.every((event) => event.actor.id === f.userId && event.actor.memberId === f.memberId))
  })
}

dbTest("actual provider Save routes share one operation, including set, group and grant mutations", async () => {
  const f = await fixture()
  const { id, group, set } = await f.create()
  const before = (await f.events()).length
  const correlation = randomUUID()
  for (const [path, body] of [
    [`/v1/inference-providers/${id}`, { name: "Saved", modelIds: ["model-a", "model-b"] }],
    [`/v1/inference-providers/${id}/model-groups/${group.id}`, { name: "Saved group", modelIds: ["model-b"] }],
    [`/v1/inference-providers/${id}/credential-sets/${set.id}`, { name: "Saved credentials", credential: { kind: "api_key", secret: "synthetic-private-rotation" } }],
  ] satisfies Array<[string, unknown]>) assert.equal((await f.request("PATCH", path, body, correlation)).status, 200)
  const grantResponse = await f.request("POST", `/v1/inference-providers/${id}/access-grants`, { modelGroupId: group.id, credentialSetId: set.id, audience: { type: "organization" } }, correlation)
  assert.equal(grantResponse.status, 201)
  const grantId = string(record(record(await grantResponse.json()).accessGrant).id)
  assert.equal((await f.request("DELETE", `/v1/inference-providers/${id}/access-grants/${grantId}`, undefined, correlation)).status, 204)
  const events = (await f.events()).slice(before)
  assert.equal(events.filter((event) => event.category === "request").length, 5)
  assert.equal(new Set(events.map((event) => event.operationId)).size, 1)
  assert.ok(events.every((event) => event.actor.type === "user" && event.actor.id === f.userId && event.actor.memberId === f.memberId && event.requestId?.startsWith("req_")))
  assert.equal(JSON.stringify(events).includes("synthetic-private"), false)
  assert.equal((await f.request("DELETE", `/v1/inference-providers/${id}`)).status, 204)
  assert.ok((await f.events()).some((event) => event.action === "provider.deleted"))
})

dbTest("one Save adding organization, distinct members and team grants creates one operation and usage fact", async () => {
  const f = await fixture()
  const member = await fixture("member", false, f.orgId)
  const teamId = createDenTypeId("team")
  await f.db.insert(TeamTable).values({ id: teamId, organizationId: f.orgId, name: "Synthetic grant audience" })
  const { id, group, set } = await f.create()
  const before = (await f.events()).length
  const facts = () => f.db.select().from(AuditUsageFactTable).where(eq(AuditUsageFactTable.organization_id, f.orgId))
  const beforeFacts = (await facts()).length
  const correlation = randomUUID()
  assert.equal((await f.request("PATCH", `/v1/inference-providers/${id}`, { name: "Multi-audience Save" }, correlation)).status, 200)
  const audiences: GatewayAccessGrantWrite["audience"][] = [
    { type: "organization" }, { type: "member", memberId: f.memberId }, { type: "member", memberId: member.memberId }, { type: "team", teamId },
  ]
  for (const audience of audiences) {
    const response = await f.request("POST", `/v1/inference-providers/${id}/access-grants`, { modelGroupId: group.id, credentialSetId: set.id, audience }, correlation)
    assert.equal(response.status, 201, await response.clone().text())
  }
  const saveEvents = (await f.events()).slice(before)
  const operationId = saveEvents[0].operationId
  assert.equal(new Set(saveEvents.map((event) => event.operationId)).size, 1)
  assert.equal(saveEvents.filter((event) => event.category === "request").length, audiences.length + 1)
  assert.equal(saveEvents.filter((event) => event.action === "provider.access_grant.created").length, audiences.length)
  const claims = await f.db.select().from(AuditOperationStepTable).where(and(eq(AuditOperationStepTable.organization_id, f.orgId), eq(AuditOperationStepTable.operation_id, normalizeDenTypeId("auditOperation", operationId))))
  assert.equal(claims.length, audiences.length + 1)
  assert.deepEqual(claims.filter((claim) => claim.workflow_step === "grant.create").map((claim) => claim.step_scope).sort(), audiences.map((audience) => `${id}/grant-target/${group.id}/${set.id}/${audience.type}/${audience.type === "organization" ? f.orgId : audience.type === "member" ? audience.memberId : audience.teamId}`).sort())
  const afterFacts = await facts()
  assert.equal(afterFacts.length, beforeFacts + 1)
  assert.equal(afterFacts.filter((fact) => fact.operation_id === operationId && fact.delta === 1).length, 1)
  const duplicate = await f.request("POST", `/v1/inference-providers/${id}/access-grants`, { modelGroupId: group.id, credentialSetId: set.id, audience: audiences[1] }, correlation)
  assert.equal(duplicate.status, 409)
  assert.equal(record(await duplicate.json()).error, "access_grant_exists")
  const repeated = (await f.events()).slice(before + saveEvents.length)
  assert.equal(repeated.length, 1)
  assert.equal(repeated[0].outcome, "failed")
  assert.equal(repeated[0].action, "provider.configuration.grant.create.attempted")
  assert.notEqual(repeated[0].operationId, operationId)
  assert.equal(repeated[0].changes, undefined)
  assert.equal((await facts()).length, beforeFacts + 2)
  assert.equal((await f.db.select().from(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.gateway_provider_id, createDenId(id)))).length, audiences.length)
  const sentinel = "synthetic-unvalidated-grant-secret"
  const invalid = await f.request("POST", `/v1/inference-providers/${id}/access-grants`, { modelGroupId: group.id, credentialSetId: set.id, audience: { type: "organization" }, secret: sentinel, workflowStep: "client.workflow", stepHash: sentinel }, correlation)
  assert.equal(invalid.status, 400)
  const failure = (await f.events()).at(-1)
  assert.equal(failure?.outcome, "failed")
  assert.notEqual(failure?.operationId, operationId)
  assert.equal(JSON.stringify(await f.events()).includes(sentinel), false)
  assert.equal(JSON.stringify(claims).includes(sentinel), false)
})

dbTest("grant target grouping isolates provider and actor identities and still enforces DB ownership", async () => {
  const f = await fixture()
  const peer = await fixture("admin", false, f.orgId)
  const foreign = await fixture()
  const provider = await f.create()
  const otherProvider = await f.create()
  const foreignProvider = await foreign.create()
  const foreignTeamId = createDenTypeId("team")
  await foreign.db.insert(TeamTable).values({ id: foreignTeamId, organizationId: foreign.orgId, name: "Synthetic foreign audience" })
  const foreignBefore = (await foreign.events()).length
  const before = (await f.events()).length
  const correlation = randomUUID()
  assert.equal((await f.request("PATCH", `/v1/inference-providers/${provider.id}`, { name: "Grant isolation Save" }, correlation)).status, 200)
  const target: GatewayAccessGrantWrite = { modelGroupId: provider.group.id, credentialSetId: provider.set.id, audience: { type: "organization" } }
  assert.equal((await f.request("POST", `/v1/inference-providers/${provider.id}/access-grants`, target, correlation)).status, 201)
  const rootOperation = (await f.events())[before].operationId
  assert.equal((await peer.request("POST", `/v1/inference-providers/${provider.id}/access-grants`, { ...target, audience: { type: "member", memberId: peer.memberId } }, correlation)).status, 201)
  const peerEvent = (await f.events()).at(-1)
  assert.equal(peerEvent?.actor.id, peer.userId)
  assert.notEqual(peerEvent?.operationId, rootOperation)
  assert.equal((await f.request("POST", `/v1/inference-providers/${otherProvider.id}/access-grants`, { modelGroupId: otherProvider.group.id, credentialSetId: otherProvider.set.id, audience: { type: "organization" } }, correlation)).status, 201)
  const otherEvent = (await f.events()).at(-1)
  assert.equal(otherEvent?.operation.scope, otherProvider.id)
  assert.notEqual(otherEvent?.operationId, rootOperation)
  for (const body of [
    { ...target, modelGroupId: otherProvider.group.id },
    { ...target, credentialSetId: foreignProvider.set.id },
    { ...target, audience: { type: "member", memberId: foreign.memberId } },
    { ...target, audience: { type: "team", teamId: foreignTeamId } },
  ]) {
    assert.equal((await f.request("POST", `/v1/inference-providers/${provider.id}/access-grants`, body, correlation)).status, 404)
    assert.equal((await f.events()).at(-1)?.outcome, "failed")
  }
  assert.equal((await f.db.select().from(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.gateway_provider_id, createDenId(provider.id)))).length, 2)
  assert.equal((await foreign.events()).length, foreignBefore)
  assert.equal((await foreign.db.select().from(GatewayProviderAccessTable).where(eq(GatewayProviderAccessTable.gateway_provider_id, createDenId(foreignProvider.id)))).length, 0)
})

dbTest("different root PATCH Saves reusing one UUID produce distinct operations with all request events attached", async () => {
  const f = await fixture()
  const { id, group } = await f.create()
  const before = (await f.events()).length
  const correlation = randomUUID()
  assert.equal((await f.request("PATCH", `/v1/inference-providers/${id}`, { name: "First Save", modelIds: ["model-a", "model-b"] }, correlation)).status, 200)
  assert.equal((await f.request("PATCH", `/v1/inference-providers/${id}`, { name: "Independent Save", modelIds: ["model-a"] }, correlation)).status, 200)
  const events = (await f.events()).slice(before)
  const requests = events.filter((event) => event.category === "request")
  assert.equal(requests.length, 2)
  assert.notEqual(requests[0].operationId, requests[1].operationId)
  for (const request of requests) assert.ok(events.filter((event) => event.requestId === request.requestId).every((event) => event.operationId === request.operationId))
  const childBefore = (await f.events()).length
  assert.equal((await f.request("PATCH", `/v1/inference-providers/${id}/model-groups/${group.id}`, { name: "First child edit" }, correlation)).status, 200)
  assert.equal((await f.request("PATCH", `/v1/inference-providers/${id}/model-groups/${group.id}`, { name: "Independent child edit" }, correlation)).status, 200)
  const children = (await f.events()).slice(childBefore).filter((event) => event.category === "request")
  assert.equal(children[0].operationId, requests[0].operationId)
  assert.notEqual(children[0].operationId, children[1].operationId)
  assert.equal((await f.request("PATCH", `/v1/inference-providers/${id}/model-groups/not-an-id`, { name: "Invalid target" }, correlation)).status, 400)
  const failure = (await f.events()).at(-1)
  assert.equal(failure?.outcome, "failed")
  assert.ok(!requests.some((event) => event.operationId === failure?.operationId))
})

dbTest("real group routes can create, refresh, repair and delete legal multiline descriptions", async () => {
  const f = await fixture()
  const { id } = await f.create()
  const description = "First line\n\tIndented\r\nLast line\r"
  const created = await f.request("POST", `/v1/inference-providers/${id}/model-groups`, { name: "Multiline", modelIds: ["model-a"], description })
  assert.equal(created.status, 201, await created.clone().text())
  const groupId = string(record(record(await created.json()).modelGroup).id)
  await f.db.update(GatewayProviderModelTable).set({ name: "Stale catalog name" }).where(eq(GatewayProviderModelTable.gateway_provider_id, createDenId(id)))
  assert.equal((await f.request("GET", `/v1/inference-providers/${id}/models`)).status, 200)
  assert.equal((await f.request("PATCH", `/v1/inference-providers/${id}/model-groups/${groupId}`, { description: "Corrected\n\tdescription" })).status, 200)
  assert.equal((await f.request("DELETE", `/v1/inference-providers/${id}/model-groups/${groupId}`)).status, 204)
  const events = await f.events()
  const updated = events.find((event) => event.action === "provider.group.updated" && event.changes?.before?.id === groupId)
  assert.equal(updated?.changes?.before?.description, description)
  assert.equal(updated?.changes?.after?.description, "Corrected\n\tdescription")
  assert.equal(events.find((event) => event.action === "provider.group.deleted" && event.changes?.before?.id === groupId)?.changes?.before?.description, "Corrected\n\tdescription")
})

dbTest("actual management denial and validation failure emit safe attempts outside a transaction", async () => {
  const denied = await fixture("member")
  assert.equal((await denied.request("POST", "/v1/inference-providers", { name: "Synthetic", providerId: "synthetic" })).status, 403)
  const deniedEvents = await denied.events()
  assert.equal(deniedEvents.length, 1)
  assert.equal(deniedEvents[0].outcome, "denied")
  const owner = await fixture()
  assert.equal((await owner.request("POST", "/v1/inference-providers", { secret: "do-not-log-invalid-request" })).status, 400)
  const failures = await owner.events()
  assert.equal(failures.length, 1)
  assert.equal(failures[0].outcome, "failed")
  assert.equal(JSON.stringify(failures).includes("do-not-log-invalid-request"), false)
})

dbTest("flag false and absent policy preserve real provider create/patch/delete APIs", async () => {
  Object.assign(environment.env, { auditCaptureEnabled: false })
  try {
    const f = await fixture()
    const { id } = await f.create()
    assert.equal((await f.request("PATCH", `/v1/inference-providers/${id}`, { name: "No capture" })).status, 200)
    assert.equal((await f.request("DELETE", `/v1/inference-providers/${id}`)).status, 204)
    assert.equal((await f.events()).length, 0)
  } finally { Object.assign(environment.env, { auditCaptureEnabled: true }) }
  const f = await fixture("owner", false)
  const { id } = await f.create()
  assert.equal((await f.request("DELETE", `/v1/inference-providers/${id}`)).status, 204)
  assert.equal((await f.events()).length, 0)
})

dbTest("read-triggered refresh records SYSTEM independently and propagates audit failure, never a warning", async () => {
  const f = await fixture()
  const { id } = await f.create()
  const before = (await f.events()).length
  await f.db.update(GatewayProviderModelTable).set({ name: "Stale catalog name" }).where(eq(GatewayProviderModelTable.gateway_provider_id, createDenId(id)))
  assert.equal((await f.request("GET", `/v1/inference-providers/${id}/models`)).status, 200)
  const changes = (await f.events()).slice(before)
  assert.ok(changes.some((event) => event.action === "provider.model.updated"))
  assert.ok(changes.every((event) => event.actor.type === "system"))
  assert.notEqual(changes[0].operationId, (await f.events())[0].operationId)
  await f.db.update(GatewayProviderModelTable).set({ name: "Must remain stale" }).where(eq(GatewayProviderModelTable.gateway_provider_id, createDenId(id)))
  const last = (await f.events()).at(-1)
  assert.ok(last)
  await f.db.insert(AuditEventTable).values({ id: createDenTypeId("auditEvent"), org_id: f.orgId, action: "synthetic.sequence_conflict", sequence: last.sequence + 1 })
  const response = await f.request("GET", `/v1/inference-providers/${id}/models`)
  assert.equal(response.status, 500)
  assert.equal((await response.text()).includes("catalogWarning"), false)
  assert.equal((await f.db.select().from(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, createDenId(id))))[0].name, "Must remain stale")
})
