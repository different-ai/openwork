import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { Hono } from "hono"
import { requestId, type RequestIdVariables } from "hono/request-id"
import { generateSpecs } from "hono-openapi"
import { createDenDb } from "@openwork-ee/den-db"
import { and, eq, sql } from "@openwork-ee/den-db/drizzle"
import { appendAuditEvent, readAuditPolicy, type AuditContext, type AuditEventInput } from "@openwork-ee/den-db/audit-log"
import { AuditEventResourceTable, AuditEventTable, AuditOperationTable, AuditPolicyTable, AuditStateTable, AuthSessionTable, AuthUserTable, MemberTable, OrganizationTable, TeamMemberTable, TeamTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { auditEventEnvelopeSchema, auditEventsResponseSchema, auditEventTypesResponseSchema, auditOperationsResponseSchema, auditUsageResponseSchema } from "@openwork/types/den/audit"
import { auditReadCoveredRoutes, supportedAuditEventTypes } from "../src/audit/coverage.js"
import { auditCsv } from "../src/audit/exports.js"
import { AuditReadError, AUDIT_CURSOR_TTL_MS, auditFilterHash, readAuditCursor, signAuditCursor } from "../src/audit/cursors.js"
import { auditExportQuerySchema, auditOperationsQuerySchema, listAuditEvents, listAuditExportEvents, listAuditOperations, readAuditUsage } from "../src/audit/queries.js"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"
import type { DenApiKeySession } from "../src/api-keys.js"

const url = process.env.DEN_AUDIT_TEST_DATABASE_URL
if (url) {
  const parsed = new URL(url)
  if (parsed.protocol !== "mysql:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || !/^\/audit_logs_test(?:_[a-z0-9_]+)?$/.test(parsed.pathname)) throw new Error("Only an explicitly owned disposable loopback audit_logs_test database is allowed; connection withheld.")
}
let instance: ReturnType<typeof createDenDb>
let storage: typeof import("../src/db.js")
let environment: typeof import("../src/env.js")
let routes: typeof import("../src/routes/org/audit.js")
const queries: string[] = []
const secret = "synthetic-audit-api-disposable-secret-1234567890"
before(async () => {
  if (!url) return
  Object.assign(process.env, { DATABASE_URL: url, DB_MODE: "mysql", NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DEN_DB_ENCRYPTION_KEY: "synthetic-audit-api-disposable-key-1234567890", BETTER_AUTH_SECRET: secret, BETTER_AUTH_URL: "http://127.0.0.1:8790", DEN_BASE_URL: "http://127.0.0.1:8790" })
  instance = createDenDb({ databaseUrl: url, mode: "mysql", logger: { logQuery(query) { queries.push(query) } } })
  environment = await import("../src/env.js")
  Object.assign(environment.env, { auditCaptureEnabled: true, auditVisibilityEnabled: true })
  storage = await import("../src/db.js")
  routes = await import("../src/routes/org/audit.js")
})
after(async () => {
  if (instance && "end" in instance.client) await instance.client.end()
  if (storage && "end" in storage.client) await storage.client.end()
})
const dbTest = (name: string, run: () => Promise<void>) => test(name, { skip: !url }, run)
const code = (expected: string) => (error: unknown) => error instanceof AuditReadError && error.code === expected

async function fixture(role = "owner") {
  const db = instance.db
  const org = createDenTypeId("organization")
  const userId = createDenTypeId("user")
  const memberId = createDenTypeId("member")
  const sessionId = createDenTypeId("session")
  await db.insert(AuthUserTable).values({ id: userId, name: "Synthetic operator", email: `${userId}@example.test`, emailVerified: true })
  await db.insert(OrganizationTable).values({ id: org, name: "Synthetic audit test", slug: `synthetic-${org}`, metadata: { plan: { tier: "enterprise", source: "manual" } } })
  await db.insert(MemberTable).values({ id: memberId, organizationId: org, userId, role })
  await db.insert(AuthSessionTable).values({ id: sessionId, userId, token: `synthetic-session-${sessionId}`, activeOrganizationId: org, expiresAt: new Date(Date.now() + 600000) })
  await db.insert(AuditPolicyTable).values({ organization_id: org, revision: 1, source: "operator", enabled: true, categories: ["change"], allowance: 100, excess_mode: "keep_all", effective_at: new Date("2026-01-01T00:00:00Z"), attachment_window_seconds: 300 })
  const policy = await readAuditPolicy(db, org)
  assert.ok(policy)
  const providerId = createDenTypeId("inferenceProvider")
  const context: AuditContext = { organizationId: org, actor: { type: "user", id: userId, memberId }, principalKey: `user:${userId}`, origin: "api", originTrust: "authenticated", requestId: createDenTypeId("request"), kind: "provider.configuration", scope: providerId, workflowStep: "update", workflowStepScope: providerId, correlationId: randomUUID() }
  const event: AuditEventInput = { action: "provider.updated", category: "change", outcome: "succeeded", resources: [{ type: "provider", id: "synthetic-provider", relationship: "target", label: "Deleted provider" }], changes: { before: { name: "Before" }, after: { name: "After" }, changedFields: ["name"] } }
  const append = async (next: Partial<AuditEventInput> = {}, nextContext: Partial<AuditContext> = {}) => {
    const result = await db.transaction((tx) => appendAuditEvent(tx, { context: { ...context, ...(nextContext.correlationId !== undefined && nextContext.correlationId !== context.correlationId ? { requestId: createDenTypeId("request") } : {}), ...nextContext }, policy, event: { ...event, ...next } }))
    assert.ok(result)
    return result
  }
  const [user] = await db.select().from(AuthUserTable).where(eq(AuthUserTable.id, userId)).limit(1)
  const [session] = await db.select().from(AuthSessionTable).where(eq(AuthSessionTable.id, sessionId)).limit(1)
  const app = (auth = true, apiKey: DenApiKeySession | null = null) => {
    const result = new Hono<{ Variables: OrgRouteVariables & RequestIdVariables }>()
    result.use("*", requestId({ headerName: "", generator: () => createDenTypeId("request") }))
    result.use("*", async (c, next) => { c.set("user", auth ? user : null); c.set("session", auth ? session : null); c.set("apiKey", apiKey); await next() })
    result.onError(() => Response.json({ error: "test_unhandled_route_failure" }, { status: 500 }))
    routes.registerOrgAuditRoutes(result)
    return result
  }
  const request = (path: string, headers: Record<string, string> = {}) => app().request(path, { headers: { "x-openwork-org-id": org, ...headers } })
  const events = async () => (await db.select({ envelope: AuditEventTable.envelope }).from(AuditEventTable).where(eq(AuditEventTable.org_id, org)).orderBy(AuditEventTable.sequence)).flatMap((row) => row.envelope ? [row.envelope] : [])
  const toggle = (captureOn: boolean, expectedRevision: number, extra: Record<string, unknown> = {}) => app().request("/v1/audit/settings", { method: "PATCH", headers: { "content-type": "application/json", "x-openwork-org-id": org }, body: JSON.stringify({ captureOn, expectedRevision, ...extra }) })
  return { db, org, userId, memberId, session, context, event, policy, append, app, request, toggle, events, query: { database: db, organizationId: org, secret } }
}

dbTest("operation pages are tenant scoped, bounded projections with stable ties and first-event summaries", async () => {
  const f = await fixture()
  const foreign = await fixture()
  const first = await f.append()
  const child = await f.append({ action: "provider.model.created", resources: [{ type: "provider_model", id: "deleted-model", relationship: "target" }] })
  const second = await f.append({}, { correlationId: randomUUID() })
  await foreign.append()
  await f.db.insert(AuditEventTable).values({ id: createDenTypeId("auditEvent"), org_id: f.org, actor_user_id: f.userId, action: "legacy.action", payload: { raw: "never-expose-legacy" } })
  await f.db.update(AuditOperationTable).set({ first_recorded_at: new Date("2026-02-01T00:00:00Z") }).where(eq(AuditOperationTable.organization_id, f.org))
  queries.length = 0
  const page = await listAuditOperations(f.query, { limit: 1 })
  assert.equal(page.operations.length, 1)
  assert.equal(page.operations[0].id, [first.operationId, second.operationId].sort().at(-1))
  assert.ok(page.nextCursor)
  const next = await listAuditOperations(f.query, { limit: 1, cursor: page.nextCursor })
  assert.equal(next.operations.length, 1)
  assert.notEqual(next.operations[0].id, page.operations[0].id)
  assert.equal(next.nextCursor, null)
  const summary = [...page.operations, ...next.operations].find((row) => row.id === first.operationId)
  assert.equal(summary?.action, "provider.updated")
  assert.equal(summary?.eventCount, 2)
  assert.deepEqual(summary?.resources, first.resources)
  assert.equal(summary?.logicalBytes, first.logicalBytes + child.logicalBytes)
  assert.ok(queries.filter((query) => query.startsWith("select")).every((query) => /limit \?/.test(query)))
  assert.ok(!queries.some((query) => /select \*|select .*`payload`|select `envelope`/.test(query)))
  assert.equal(JSON.stringify(page).includes("never-expose-legacy"), false)
})

dbTest("filters use initiating user, operation outcome and any stored child action/resource without live joins", async () => {
  const f = await fixture()
  const first = await f.append()
  const delegated = createDenTypeId("user")
  await f.append({ action: "provider.model.created", resources: [{ type: "provider_model", id: "CaseSensitive", relationship: "target" }] }, { actor: { type: "user", id: delegated }, initiatingActor: f.context.actor })
  const other = await f.append({}, { correlationId: randomUUID(), origin: "scheduler" })
  await f.db.update(AuditOperationTable).set({ outcome: "partial" }).where(and(eq(AuditOperationTable.organization_id, f.org), eq(AuditOperationTable.id, normalizeDenTypeId("auditOperation", first.operationId))))
  const matching = auditOperationsQuerySchema.parse({ actorId: f.userId, action: "provider.model.created", outcome: "partial", origin: "api", resourceId: "CaseSensitive", resourceType: "provider_model", from: "2026-01-01", to: "2099-01-01" })
  assert.deepEqual((await listAuditOperations(f.query, matching)).operations.map((row) => row.id), [first.operationId])
  assert.equal((await listAuditOperations(f.query, { ...matching, actorId: delegated })).operations.length, 0)
  assert.equal((await listAuditOperations(f.query, { ...matching, outcome: "succeeded" })).operations.length, 0)
  assert.equal((await listAuditOperations(f.query, { ...matching, resourceId: "casesensitive" })).operations.length, 0)
  assert.deepEqual((await listAuditOperations(f.query, { limit: 50, origin: "scheduler" })).operations.map((row) => row.id), [other.operationId])
})

dbTest("malicious cross-tenant reference rows and envelopes cannot leak into queries", async () => {
  const f = await fixture()
  const foreign = await fixture()
  const own = await f.append()
  const theirs = await foreign.append()
  await f.db.insert(AuditEventResourceTable).values({ id: createDenTypeId("auditEventResource"), organization_id: f.org, operation_id: normalizeDenTypeId("auditOperation", own.operationId), event_id: normalizeDenTypeId("auditEvent", theirs.id), resource_type: "provider", resource_id: "foreign-only", relationship: "target" })
  assert.equal((await listAuditOperations(f.query, { limit: 50, resourceId: "foreign-only" })).operations.length, 0)
  await assert.rejects(listAuditEvents(f.query, { limit: 50 }, theirs.operationId), code("audit_operation_not_found"))
  await f.db.update(AuditEventTable).set({ envelope: { ...own, organizationId: foreign.org } }).where(and(eq(AuditEventTable.org_id, f.org), eq(AuditEventTable.id, normalizeDenTypeId("auditEvent", own.id))))
  await assert.rejects(listAuditEvents(f.query, { limit: 50 }, own.operationId), code("audit_storage_inconsistent"))
})

dbTest("event/export traversal freezes publication sequence despite late children and reversed dates", async () => {
  const f = await fixture()
  const first = await f.append()
  const second = await f.append()
  await f.db.update(AuditEventTable).set({ created_at: new Date("2025-01-01") }).where(and(eq(AuditEventTable.org_id, f.org), eq(AuditEventTable.id, normalizeDenTypeId("auditEvent", second.id))))
  const detail = await listAuditEvents(f.query, { limit: 1 }, first.operationId)
  const exported = await listAuditExportEvents(f.query, { limit: 1, format: "ndjson" })
  assert.ok(detail.nextCursor && exported.nextCursor)
  await f.append()
  await f.append({}, { correlationId: randomUUID() })
  const next = await listAuditEvents(f.query, { limit: 100, cursor: detail.nextCursor }, first.operationId)
  const remaining = await listAuditExportEvents(f.query, { limit: 100, format: "ndjson", cursor: exported.nextCursor })
  assert.deepEqual(detail.events.map((row) => row.sequence), [1])
  assert.deepEqual(next.events.map((row) => row.sequence), [2])
  assert.deepEqual(remaining.events.map((row) => row.sequence), [2])
  assert.equal(next.snapshotSequence, 2)
  assert.equal(remaining.snapshotSequence, 2)
  assert.equal(next.nextCursor, null)
  assert.equal(remaining.nextCursor, null)
  const decoded = readAuditCursor(exported.nextCursor, { organizationId: f.org, mode: "export-ndjson", filterHash: auditFilterHash({}), operationId: null }, secret)
  assert.equal(decoded.expiresAt - decoded.issuedAt, AUDIT_CURSOR_TTL_MS)
})

for (const kind of ["operation", "event", "request", "resource"]) dbTest(`ID search matches exact case-sensitive ${kind} IDs on any retained child and exports the whole operation`, async () => {
  const f = await fixture()
  const root = await f.append()
  const child = await f.append({ action: "provider.group.updated", resources: [{ type: "provider_model_group", id: "HiddenChildReference", relationship: "related" }] }, { requestId: "HiddenChildRequest", workflowStep: "group.update", workflowStepScope: `${f.context.scope}/model-groups/${createDenTypeId("gatewayModelGroup")}` })
  assert.equal(child.operationId, root.operationId)
  const sibling = await f.append({ action: "provider.credential.updated", resources: [] })
  const other = await f.append({}, { correlationId: randomUUID() })
  const searchId = kind === "operation" ? root.operationId : kind === "event" ? child.id : kind === "request" ? child.requestId : child.resources[0].id
  assert.ok(searchId)
  const query = auditOperationsQuerySchema.parse({ searchId })
  const operations = await listAuditOperations(f.query, query)
  assert.deepEqual(operations.operations.map((operation) => operation.id), [root.operationId])
  assert.equal(operations.operations[0].action, root.action)
  assert.deepEqual(operations.operations[0].resources, root.resources)
  const exported = await listAuditExportEvents(f.query, { ...query, format: "ndjson" })
  assert.deepEqual(exported.events.map((event) => event.id), [root.id, child.id, sibling.id])
  assert.ok(!exported.events.some((event) => event.operationId === other.operationId))
  for (const mismatch of [searchId.toUpperCase(), searchId.slice(0, -1), `${searchId}suffix`, ` ${searchId}`, `${searchId} `]) {
    assert.notEqual(mismatch, searchId)
    assert.equal((await listAuditOperations(f.query, { limit: 50, searchId: mismatch })).operations.length, 0, mismatch)
    assert.equal((await listAuditExportEvents(f.query, { limit: 50, format: "csv", searchId: mismatch })).events.length, 0, mismatch)
  }
  const foreign = await fixture()
  assert.equal((await listAuditOperations(foreign.query, query)).operations.length, 0)
  assert.equal((await listAuditExportEvents(foreign.query, { ...query, format: "ndjson" })).events.length, 0)
  await f.db.update(AuditOperationTable).set({ retention_state: "evicting" }).where(and(eq(AuditOperationTable.organization_id, f.org), eq(AuditOperationTable.id, normalizeDenTypeId("auditOperation", root.operationId))))
  assert.equal((await listAuditOperations(f.query, query)).operations.length, 0)
  assert.equal((await listAuditExportEvents(f.query, { ...query, format: "ndjson" })).events.length, 0)
})

dbTest("ID search treats SQL metacharacters, Unicode, whitespace and reference relationships literally", async () => {
  const f = await fixture()
  const root = await f.append({ resources: [
    { type: "provider", id: "' OR 1=1 --", relationship: "target" },
    { type: "provider", id: "Literal%_雪", relationship: "parent" },
    { type: "provider", id: " Trailing ", relationship: "related" },
    { type: "provider", id: "x".repeat(255), relationship: "related" },
  ] })
  await f.append({}, { correlationId: randomUUID() })
  for (const resource of root.resources) {
    queries.length = 0
    assert.deepEqual((await listAuditOperations(f.query, { limit: 50, searchId: resource.id })).operations.map((row) => row.id), [root.operationId])
    assert.ok(queries.every((query) => !query.includes(resource.id)), "IDs must be bound parameters, not SQL source")
    assert.deepEqual((await listAuditExportEvents(f.query, { limit: 50, format: "csv", searchId: resource.id })).events.map((row) => row.id), [root.id])
  }
  for (const searchId of ["%", "_", "Trailing", "Literal", "null", "Before", "Deleted provider", f.context.scope]) {
    assert.equal((await listAuditOperations(f.query, { limit: 50, searchId })).operations.length, 0, searchId)
  }
  const nullRequest = await f.append({ resources: [] }, { correlationId: undefined, requestId: null })
  assert.equal(nullRequest.requestId, null)
  assert.equal((await listAuditExportEvents(f.query, { limit: 50, format: "ndjson", searchId: "null" })).events.length, 0)
})

dbTest("ID search cannot match legacy payloads, foreign children or inconsistent resource joins", async () => {
  const f = await fixture()
  const foreign = await fixture()
  const own = await f.append()
  const sameTenantOther = await f.append({ resources: [] }, { correlationId: randomUUID() })
  const theirs = await foreign.append({ resources: [{ type: "provider", id: "ForeignReference", relationship: "target" }] }, { requestId: "ForeignRequest" })
  const legacyId = createDenTypeId("auditEvent")
  await f.db.insert(AuditEventTable).values({ id: legacyId, org_id: f.org, operation_id: normalizeDenTypeId("auditOperation", own.operationId), actor_user_id: f.userId, action: "legacy.action", payload: { requestId: "LegacyRequest", resourceId: "LegacyReference", raw: "LegacyPayload" } })
  await f.db.insert(AuditEventResourceTable).values([
    { id: createDenTypeId("auditEventResource"), organization_id: f.org, operation_id: normalizeDenTypeId("auditOperation", own.operationId), event_id: normalizeDenTypeId("auditEvent", theirs.id), resource_type: "provider", resource_id: "WrongEventTenant", relationship: "target" },
    { id: createDenTypeId("auditEventResource"), organization_id: foreign.org, operation_id: normalizeDenTypeId("auditOperation", own.operationId), event_id: normalizeDenTypeId("auditEvent", own.id), resource_type: "provider", resource_id: "WrongReferenceTenant", relationship: "target" },
    { id: createDenTypeId("auditEventResource"), organization_id: f.org, operation_id: normalizeDenTypeId("auditOperation", own.operationId), event_id: normalizeDenTypeId("auditEvent", sameTenantOther.id), resource_type: "provider", resource_id: "WrongParent", relationship: "target" },
    { id: createDenTypeId("auditEventResource"), organization_id: f.org, operation_id: normalizeDenTypeId("auditOperation", own.operationId), event_id: legacyId, resource_type: "provider", resource_id: "LegacyJoinedReference", relationship: "target" },
  ])
  await f.db.update(AuditEventTable).set({ operation_id: normalizeDenTypeId("auditOperation", own.operationId) }).where(and(eq(AuditEventTable.org_id, foreign.org), eq(AuditEventTable.id, normalizeDenTypeId("auditEvent", theirs.id))))
  for (const searchId of [legacyId, "LegacyRequest", "LegacyReference", "LegacyPayload", "LegacyJoinedReference", theirs.id, theirs.operationId, "ForeignRequest", "ForeignReference", "WrongEventTenant", "WrongReferenceTenant", "WrongParent"]) {
    assert.equal((await listAuditOperations(f.query, { limit: 50, searchId })).operations.length, 0, searchId)
    assert.equal((await listAuditExportEvents(f.query, { limit: 50, format: "ndjson", searchId })).events.length, 0, searchId)
  }
})

dbTest("ID search is AND combined with all filters using operation-start time, including cross-child resources", async () => {
  const f = await fixture()
  const root = await f.append()
  const child = await f.append({ action: "provider.model.created", resources: [{ type: "provider_model", id: "ChildReference", relationship: "target" }] })
  await f.db.update(AuditEventTable).set({ envelope: { ...child, occurredAt: "2098-01-01T00:00:00.000Z" } }).where(and(eq(AuditEventTable.org_id, f.org), eq(AuditEventTable.id, normalizeDenTypeId("auditEvent", child.id))))
  const matching = auditOperationsQuerySchema.parse({ searchId: child.id, actorId: f.userId, action: child.action, outcome: "unknown", origin: "api", resourceId: root.resources[0].id, resourceType: "provider", from: root.operation.startedAt, to: root.operation.startedAt })
  assert.deepEqual((await listAuditOperations(f.query, matching)).operations.map((row) => row.id), [root.operationId])
  assert.deepEqual((await listAuditExportEvents(f.query, { ...matching, format: "csv" })).events.map((row) => row.id), [root.id, child.id])
  for (const mismatch of [
    { searchId: "missing" }, { actorId: createDenTypeId("user") }, { action: "missing.action" }, { outcome: "failed" }, { origin: "scheduler" }, { resourceId: "missing" }, { resourceType: "provider_model" },
    { from: "2098-01-01", to: "2099-01-01" }, { from: "2020-01-01", to: "2020-01-02" },
  ]) {
    const query = auditOperationsQuerySchema.parse({ ...matching, ...mismatch, limit: "50" })
    assert.equal((await listAuditOperations(f.query, query)).operations.length, 0, JSON.stringify(mismatch))
    assert.equal((await listAuditExportEvents(f.query, { ...query, format: "ndjson" })).events.length, 0, JSON.stringify(mismatch))
  }
})

dbTest("ID search pagination and NDJSON/CSV agree on complete matching operations and bind the filter", async () => {
  const f = await fixture()
  const first = await f.append()
  const child = await f.append({ resources: [{ type: "provider_model", id: "SharedSearch", relationship: "related" }] })
  const secondContext = { correlationId: randomUUID(), requestId: "SharedSearch" }
  const second = await f.append({}, secondContext)
  const secondChild = await f.append({ resources: [] }, secondContext)
  await f.append({}, { correlationId: randomUUID() })
  const page = await f.request("/v1/audit/operations?searchId=SharedSearch&limit=1")
  assert.equal(page.status, 200)
  const firstPage = auditOperationsResponseSchema.parse(await page.json())
  assert.ok(firstPage.nextCursor)
  const nextResponse = await f.request(`/v1/audit/operations?searchId=SharedSearch&limit=100&cursor=${firstPage.nextCursor}`)
  assert.equal(nextResponse.status, 200)
  const secondPage = auditOperationsResponseSchema.parse(await nextResponse.json())
  assert.equal(secondPage.nextCursor, null)
  assert.equal(secondPage.snapshotSequence, firstPage.snapshotSequence)
  assert.deepEqual([...firstPage.operations, ...secondPage.operations].map((row) => row.id).sort(), [first.operationId, second.operationId].sort())
  for (const suffix of ["", "&searchId=sharedsearch", "&searchId=other", "&searchId=SharedSearch&resourceId=missing"]) assert.equal((await f.request(`/v1/audit/operations?cursor=${firstPage.nextCursor}${suffix}`)).status, 400)
  const expected = [first, child, second, secondChild]
  for (const format of ["ndjson", "csv"]) {
    const response = await f.request(`/v1/audit/export?format=${format}&searchId=SharedSearch&limit=1`)
    assert.equal(response.status, 200)
    const cursor = response.headers.get("x-audit-next-cursor")
    assert.ok(cursor)
    const remaining = await f.request(`/v1/audit/export?format=${format}&searchId=SharedSearch&limit=100&cursor=${cursor}`)
    assert.equal(remaining.status, 200)
    assert.equal(remaining.headers.get("x-audit-next-cursor"), null)
    assert.equal(remaining.headers.get("x-audit-snapshot-sequence"), response.headers.get("x-audit-snapshot-sequence"))
    if (format === "csv") {
      assert.equal(await response.text(), auditCsv(expected.slice(0, 1)))
      assert.equal(await remaining.text(), auditCsv(expected.slice(1)))
    } else {
      const lines = `${await response.text()}${await remaining.text()}`.trim().split("\n")
      assert.deepEqual(lines.map((line) => auditEventEnvelopeSchema.parse(JSON.parse(line))), expected)
    }
    for (const suffix of ["", "&searchId=sharedsearch", "&searchId=other", "&searchId=SharedSearch&resourceId=missing"]) assert.equal((await f.request(`/v1/audit/export?format=${format}&cursor=${cursor}${suffix}`)).status, 400)
  }
})

dbTest("late matching child request/resource IDs cannot add operations to an existing snapshot", async () => {
  for (const kind of ["request", "resource"]) {
    const f = await fixture()
    const olderContext = { correlationId: randomUUID(), requestId: "OlderRequest" }
    const older = await f.append({ resources: [] }, olderContext)
    const first = await f.append({ resources: [{ type: "provider", id: "FutureMatch", relationship: "target" }] })
    await f.append()
    await f.append({ resources: [{ type: "provider", id: "FutureMatch", relationship: "target" }] }, { correlationId: randomUUID() })
    const operations = await listAuditOperations(f.query, { limit: 1, searchId: "FutureMatch" })
    const exported = await listAuditExportEvents(f.query, { limit: 1, format: "ndjson", searchId: "FutureMatch" })
    assert.ok(operations.nextCursor && exported.nextCursor)
    const late = await f.append({ resources: kind === "resource" ? [{ type: "provider", id: "FutureMatch", relationship: "related" }] : [] }, { ...olderContext, ...(kind === "request" ? { requestId: "FutureMatch", workflowStep: "group.update", workflowStepScope: `${f.context.scope}/model-groups/${createDenTypeId("gatewayModelGroup")}` } : {}) })
    assert.equal(late.operationId, older.operationId)
    assert.ok(late.sequence > operations.snapshotSequence)
    const remaining = await listAuditOperations(f.query, { limit: 100, searchId: "FutureMatch", cursor: operations.nextCursor })
    assert.equal(remaining.operations.length, 1)
    assert.ok(remaining.operations.every((row) => row.id !== older.operationId))
    const tail = await listAuditExportEvents(f.query, { limit: 100, format: "ndjson", searchId: "FutureMatch", cursor: exported.nextCursor })
    assert.equal(tail.events.length, 2)
    assert.equal(tail.snapshotSequence, exported.snapshotSequence)
    assert.ok(tail.events.every((event) => event.operationId !== older.operationId && event.sequence <= exported.snapshotSequence))
    assert.equal((await listAuditOperations(f.query, { limit: 100, searchId: "FutureMatch" })).operations.length, 3)
    assert.equal(exported.events[0].id, first.id)
  }
})

dbTest("a later child event ID is excluded even when the parent and cursor anchor predate the watermark", async () => {
  const f = await fixture()
  const root = await f.append()
  await f.append()
  await f.append({}, { correlationId: randomUUID() })
  const operations = await listAuditOperations(f.query, { limit: 1 })
  const exported = await listAuditExportEvents(f.query, { limit: 1, format: "ndjson" })
  assert.ok(exported.nextCursor && operations.nextCursor)
  const late = await f.append()
  const snapshot = readAuditCursor(exported.nextCursor, { organizationId: f.org, mode: "export-ndjson", operationId: null, filterHash: auditFilterHash({}) }, secret)
  const cursor = signAuditCursor({ ...snapshot, filterHash: auditFilterHash({ searchId: late.id }) }, secret)
  const remaining = await listAuditExportEvents(f.query, { limit: 100, format: "ndjson", searchId: late.id, cursor })
  assert.equal(remaining.snapshotSequence, operations.snapshotSequence)
  assert.deepEqual(remaining.events, [])
  const operationSnapshot = readAuditCursor(operations.nextCursor, { organizationId: f.org, mode: "operations", operationId: null, filterHash: auditFilterHash({}) }, secret)
  const operationCursor = signAuditCursor({ ...operationSnapshot, filterHash: auditFilterHash({ searchId: late.id }) }, secret)
  assert.deepEqual((await listAuditOperations(f.query, { limit: 100, searchId: late.id, cursor: operationCursor })).operations, [])
  assert.deepEqual((await listAuditOperations(f.query, { limit: 100, searchId: late.id })).operations.map((row) => row.id), [root.operationId])
})

dbTest("watermark waits for the tenant writer mutex and includes a previously uncommitted append", async () => {
  const f = await fixture()
  await f.append()
  let release = () => {}
  let entered = () => {}
  const hold = new Promise<void>((resolve) => { release = resolve })
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const writing = f.db.transaction(async (tx) => {
    await appendAuditEvent(tx, { context: f.context, policy: f.policy, event: f.event })
    entered()
    await hold
  })
  await ready
  let readFinished = false
  const reading = listAuditExportEvents(f.query, { limit: 50, format: "ndjson" }).then((result) => { readFinished = true; return result })
  try {
    await delay(100)
    assert.equal(readFinished, false)
  } finally { release() }
  await writing
  const result = await reading
  assert.equal(result.snapshotSequence, 2)
  assert.deepEqual(result.events.map((row) => row.sequence), [1, 2])
})

dbTest("retention gaps and missing anchors return 410; fresh reads exclude evicting operations", async () => {
  const f = await fixture()
  const first = await f.append()
  await f.append()
  const page = await listAuditExportEvents(f.query, { limit: 1, format: "ndjson" })
  assert.ok(page.nextCursor)
  await f.db.update(AuditOperationTable).set({ retention_state: "evicting" }).where(and(eq(AuditOperationTable.organization_id, f.org), eq(AuditOperationTable.id, normalizeDenTypeId("auditOperation", first.operationId))))
  await assert.rejects(listAuditExportEvents(f.query, { limit: 1, format: "ndjson", cursor: page.nextCursor }), code("audit_history_unavailable"))
  assert.equal((await listAuditOperations(f.query, { limit: 50 })).operations.length, 0)
  await assert.rejects(listAuditEvents(f.query, { limit: 50 }, first.operationId), code("audit_operation_not_found"))
  const g = await fixture()
  await g.append()
  await g.append()
  const beforeRemoval = await listAuditExportEvents(g.query, { limit: 1, format: "ndjson" })
  assert.ok(beforeRemoval.nextCursor)
  await g.db.update(AuditStateTable).set({ event_count: 1 }).where(eq(AuditStateTable.organization_id, g.org))
  await assert.rejects(listAuditExportEvents(g.query, { limit: 1, format: "ndjson", cursor: beforeRemoval.nextCursor }), code("audit_history_unavailable"))
})

dbTest("continuation rejects a physically missing position even without a changed removal counter", async () => {
  const f = await fixture()
  const first = await f.append()
  await f.append()
  const page = await listAuditExportEvents(f.query, { limit: 1, format: "ndjson" })
  assert.ok(page.nextCursor)
  await f.db.delete(AuditEventTable).where(and(eq(AuditEventTable.org_id, f.org), eq(AuditEventTable.id, normalizeDenTypeId("auditEvent", first.id))))
  await assert.rejects(listAuditExportEvents(f.query, { limit: 1, format: "ndjson", cursor: page.nextCursor }), code("audit_history_unavailable"))
})

dbTest("summary reference bound never silently truncates first-event evidence", async () => {
  const f = await fixture()
  const resources: AuditEventInput["resources"] = Array.from({ length: 256 }, (_, index) => ({ type: "provider_model", id: `model-${index}`, relationship: "target" }))
  const event = await f.append({ resources })
  assert.equal((await listAuditOperations(f.query, { limit: 1 })).operations[0].resources.length, 256)
  await f.db.insert(AuditEventResourceTable).values({ id: createDenTypeId("auditEventResource"), organization_id: f.org, event_id: normalizeDenTypeId("auditEvent", event.id), operation_id: normalizeDenTypeId("auditOperation", event.operationId), resource_type: "provider_model", resource_id: "unexpected-extra", relationship: "target" })
  await assert.rejects(listAuditOperations(f.query, { limit: 1 }), code("audit_storage_inconsistent"))
})

dbTest("usage reads stored counters and oldest operation; disabling capture does not remove history", async () => {
  const f = await fixture()
  const first = await f.append()
  const second = await f.append()
  await f.db.update(AuditPolicyTable).set({ enabled: false }).where(eq(AuditPolicyTable.organization_id, f.org))
  queries.length = 0
  const usage = await readAuditUsage(f.query, true)
  assert.equal(usage.captureEnabled, false)
  assert.equal(usage.retainedOperations, 1)
  assert.equal(usage.eventCount, 2)
  assert.equal(usage.logicalBytes, first.logicalBytes + second.logicalBytes)
  assert.equal(usage.oldestAvailableAt, first.operation.startedAt)
  assert.equal(usage.billing, "disabled")
  assert.equal(usage.cleanup, "dry_run")
  assert.equal(usage.drains, "not_configured")
  assert.ok(!queries.some((query) => /count\(|sum\(/i.test(query)))
  assert.equal((await listAuditEvents(f.query, { limit: 50 }, first.operationId)).events.length, 2)
  const emptyOrg = createDenTypeId("organization")
  await f.db.insert(OrganizationTable).values({ id: emptyOrg, name: "Synthetic empty", slug: `synthetic-${emptyOrg}` })
  const empty = await readAuditUsage({ database: f.db, organizationId: emptyOrg }, true)
  assert.equal(empty.retainedOperations, 0)
  assert.equal(empty.policy, null)
  assert.equal(empty.measuredAt, null)
})

dbTest("event catalog includes hidden actions with empty history and is independent of rows and capture policy", async () => {
  const f = await fixture()
  const expected = { eventTypes: supportedAuditEventTypes() }
  const check = async () => {
    const response = await f.request("/v1/audit/event-types")
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.deepEqual(auditEventTypesResponseSchema.parse(await response.json()), expected)
  }
  await check()
  assert.equal((await f.events()).length, 0)
  assert.ok(expected.eventTypes.includes("provider.credential.updated"))
  assert.ok(expected.eventTypes.includes("audit.event_types.requested"))
  assert.ok(expected.eventTypes.includes("audit.event_types.served"))
  await f.append()
  await f.db.insert(AuditEventTable).values({ id: createDenTypeId("auditEvent"), org_id: f.org, actor_user_id: f.userId, action: "legacy.action", payload: { raw: "never-in-catalog" } })
  await check()
  assert.equal((await f.events()).length, 1)
  for (const categories of [["access"], ["read"], ["change"]] satisfies Array<Array<"access" | "read" | "change">>) {
    await f.db.update(AuditPolicyTable).set({ categories }).where(eq(AuditPolicyTable.organization_id, f.org))
    await check()
  }
  Object.assign(environment.env, { auditCaptureEnabled: false })
  try { await check() } finally { Object.assign(environment.env, { auditCaptureEnabled: true }) }
  await f.db.update(AuditPolicyTable).set({ enabled: false }).where(eq(AuditPolicyTable.organization_id, f.org))
  await check()
  await f.db.delete(AuditPolicyTable).where(eq(AuditPolicyTable.organization_id, f.org))
  await check()
  for (const query of ["limit=1", "cursor=bad", "from=2026-01-01", "action=provider.updated", "searchId=missing", "resourceId=missing", "searchId=a&searchId=b"]) assert.equal((await f.request(`/v1/audit/event-types?${query}`)).status, 400, query)
})

dbTest("event catalog uses real tenant admin middleware, visibility and API-key member scope", async () => {
  const f = await fixture()
  const member = await fixture("member")
  const admin = await fixture("admin")
  const foreign = await fixture()
  const path = "/v1/audit/event-types"
  assert.equal((await f.app(false).request(path)).status, 401)
  assert.equal((await member.request(path)).status, 403)
  assert.equal((await admin.request(path)).status, 200)
  assert.equal((await f.request(path, { "x-openwork-org-id": foreign.org })).status, 404)
  const key: DenApiKeySession = { id: createDenTypeId("apiKey"), configId: "default", referenceId: f.userId, metadata: { organizationId: f.org, orgMembershipId: f.memberId, issuedByUserId: f.userId, issuedByOrgMembershipId: f.memberId } }
  const response = await f.app(true, key).request(path, { headers: { "x-openwork-org-id": foreign.org } })
  assert.equal(response.status, 200)
  assert.deepEqual(auditEventTypesResponseSchema.parse(await response.json()).eventTypes, supportedAuditEventTypes())
  assert.ok(key.metadata)
  assert.equal((await f.app(true, { ...key, metadata: { ...key.metadata, orgMembershipId: foreign.memberId } }).request(path)).status, 403)
  await f.db.update(AuditPolicyTable).set({ categories: ["access"] }).where(eq(AuditPolicyTable.organization_id, f.org))
  Object.assign(environment.env, { auditVisibilityEnabled: false })
  try {
    const hidden = await f.request(path)
    assert.equal(hidden.status, 403)
    assert.deepEqual(await hidden.json(), { error: "audit_visibility_disabled" })
    assert.equal((await f.events()).length, 0)
  } finally { Object.assign(environment.env, { auditVisibilityEnabled: true }) }
})

dbTest("event catalog records content-free requested/served access with read fallback and fails closed", async () => {
  for (const category of ["access", "read"] satisfies Array<"access" | "read">) {
    const f = await fixture()
    await f.db.update(AuditPolicyTable).set({ categories: [category] }).where(eq(AuditPolicyTable.organization_id, f.org))
    assert.equal((await f.request("/v1/audit/event-types")).status, 200)
    const events = await f.events()
    assert.deepEqual(events.map((event) => event.action), ["audit.event_types.requested", "audit.event_types.served"])
    assert.equal(events[0].operationId, events[1].operationId)
    assert.equal(events[0].requestId, events[1].requestId)
    assert.deepEqual(events.map((event) => event.outcome), ["unknown", "succeeded"])
    for (const event of events) {
      assert.equal(event.category, category)
      assert.equal(event.operation.scope, "audit.event_types")
      assert.equal(event.actor.id, f.userId)
      assert.equal(event.changes, undefined)
      assert.deepEqual(event.resources, [{ type: "audit_collection", id: "audit.event_types", relationship: "target" }])
    }
    assert.equal(JSON.stringify(events).includes("provider.credential.updated"), false)
  }
  const f = await fixture()
  await f.db.update(AuditPolicyTable).set({ categories: ["access"] }).where(eq(AuditPolicyTable.organization_id, f.org))
  await f.db.execute(sql.raw("CREATE TRIGGER audit_api_test_catalog_fail_served BEFORE INSERT ON audit_event FOR EACH ROW BEGIN IF NEW.action = 'audit.event_types.served' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic-sensitive-storage-failure'; END IF; END"))
  try {
    const response = await f.request("/v1/audit/event-types")
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: "audit_unavailable" })
    assert.deepEqual((await f.events()).map((event) => event.action), ["audit.event_types.requested"])
  } finally { await f.db.execute(sql.raw("DROP TRIGGER audit_api_test_catalog_fail_served")) }
  const blocked = await fixture()
  await blocked.db.update(AuditPolicyTable).set({ categories: ["access"] }).where(eq(AuditPolicyTable.organization_id, blocked.org))
  await blocked.db.insert(AuditEventTable).values({ id: createDenTypeId("auditEvent"), org_id: blocked.org, sequence: 1, action: "synthetic.sequence_conflict" })
  const response = await blocked.request("/v1/audit/event-types")
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: "audit_unavailable" })
  assert.equal((await blocked.events()).length, 0)
})

dbTest("real organization middleware denies anonymous/member/foreign-org access and enforces key tenant/member scope", async () => {
  const f = await fixture()
  const member = await fixture("member")
  const foreign = await fixture()
  const event = await foreign.append()
  assert.equal((await f.app(false).request("/v1/audit/operations")).status, 401)
  assert.equal((await member.request("/v1/audit/operations")).status, 403)
  assert.equal((await f.request("/v1/audit/operations", { "x-openwork-org-id": foreign.org })).status, 404)
  assert.equal((await f.request(`/v1/audit/operations/${event.operationId}/events`)).status, 404)
  const key: DenApiKeySession = { id: createDenTypeId("apiKey"), configId: "default", referenceId: f.userId, metadata: { organizationId: f.org, orgMembershipId: f.memberId, issuedByUserId: f.userId, issuedByOrgMembershipId: f.memberId } }
  await f.append()
  const response = await f.app(true, key).request("/v1/audit/operations", { headers: { "x-openwork-org-id": foreign.org } })
  assert.equal(response.status, 200)
  assert.equal(auditOperationsResponseSchema.parse(await response.json()).operations[0].initiatingActor.id, f.userId)
  const invalidKey = { ...key, metadata: { ...key.metadata!, orgMembershipId: foreign.memberId } }
  assert.equal((await f.app(true, invalidKey).request("/v1/audit/usage")).status, 403)
})

dbTest("HTTP query/cursor errors are strict and export is a bounded attachment with same-query continuation", async () => {
  const f = await fixture()
  const first = await f.append()
  await f.append()
  await f.append({}, { correlationId: randomUUID() })
  for (const query of ["limit=101", "limit=1&limit=2", "unknown=1", "from=not-a-date", "actorId=not-an-id", "cursor=bad", "outcome=denied"]) {
    const response = await f.request(`/v1/audit/operations?${query}`)
    assert.equal(response.status, 400, query)
  }
  for (const query of ["searchId=", `searchId=${"x".repeat(256)}`, "searchId=a&searchId=b", ...[0, 9, 10, 31, 127, 128, 133, 159].map((value) => `searchId=${encodeURIComponent(`a${String.fromCharCode(value)}b`)}`)]) {
    for (const path of ["operations", "export"]) {
      const response = await f.request(`/v1/audit/${path}?${query}`)
      assert.equal(response.status, 400, query)
      assert.deepEqual(await response.json(), { error: "audit_invalid_query" })
    }
  }
  const response = await f.request("/v1/audit/export?format=ndjson&limit=1")
  assert.equal(response.status, 200)
  assert.ok(response.headers.get("content-disposition")?.startsWith("attachment;"))
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.equal(response.headers.get("x-audit-snapshot-sequence"), "3")
  const token = response.headers.get("x-audit-next-cursor")
  assert.ok(token)
  assert.equal((await response.text()).trim().split("\n").length, 1)
  const next = await f.request(`/v1/audit/export?format=ndjson&limit=100&cursor=${token}`)
  assert.equal(next.status, 200)
  assert.equal((await next.text()).trim().split("\n").length, 2)
  assert.equal(next.headers.get("x-audit-next-cursor"), null)
  for (const path of [`/v1/audit/export?format=csv&cursor=${token}`, `/v1/audit/export?cursor=${token}&action=provider.updated`, `/v1/audit/operations?cursor=${token}`, `/v1/audit/operations/${first.operationId}/events?cursor=${token}`]) assert.equal((await f.request(path)).status, 400)
  const foreign = await fixture()
  assert.equal((await foreign.request(`/v1/audit/export?cursor=${token}`)).status, 400)
  const decoded = readAuditCursor(token, { organizationId: f.org, mode: "export-ndjson", operationId: null, filterHash: auditFilterHash({}) }, secret)
  const issuedAt = Date.now() - AUDIT_CURSOR_TTL_MS - 1000
  const expired = signAuditCursor({ ...decoded, issuedAt, expiresAt: issuedAt + AUDIT_CURSOR_TTL_MS }, secret)
  const expiration = await f.request(`/v1/audit/export?cursor=${expired}`)
  assert.equal(expiration.status, 410)
  assert.deepEqual(await expiration.json(), { error: "audit_cursor_expired" })
  const csv = await f.request("/v1/audit/export?format=csv&limit=1")
  assert.equal(csv.status, 200)
  assert.equal((await csv.text()).split("\r\n").length, 3)
})

dbTest("access capture records durable request/served in one server-request operation, ignoring correlation headers", async () => {
  const f = await fixture()
  await f.db.update(AuditPolicyTable).set({ categories: ["access"] }).where(eq(AuditPolicyTable.organization_id, f.org))
  const key: DenApiKeySession = { id: createDenTypeId("apiKey"), configId: "default", referenceId: f.userId, metadata: { organizationId: f.org, orgMembershipId: f.memberId, issuedByUserId: f.userId, issuedByOrgMembershipId: f.memberId } }
  const headers = { "x-openwork-audit-correlation": randomUUID(), "x-request-id": "untrusted-request", "x-openwork-org-id": f.org }
  for (let index = 0; index < 2; index++) {
    const response = await f.app(true, key).request("/v1/audit/usage", { headers })
    assert.equal(response.status, 200, await response.clone().text())
    const result = auditUsageResponseSchema.parse(await response.json())
    assert.equal(result.eventCount, index * 2 + 1)
  }
  const events = await f.events()
  assert.deepEqual(events.map((event) => event.action), ["audit.usage.requested", "audit.usage.served", "audit.usage.requested", "audit.usage.served"])
  assert.equal(events[0].operationId, events[1].operationId)
  assert.equal(events[2].operationId, events[3].operationId)
  assert.notEqual(events[0].operationId, events[2].operationId)
  assert.ok(events.every((event) => event.actor.id === f.userId && event.actor.memberId === f.memberId && event.actor.credentialId === key.id && event.requestId?.startsWith("req_") && event.operation.kind === "audit.access"))
  assert.ok(events.every((event) => event.changes === undefined && event.resources.length === 1))
  assert.equal(JSON.stringify(events).includes("untrusted-request"), false)
})

dbTest("failed intent or served persistence releases no content and preserves only durable intent", async () => {
  const f = await fixture()
  await f.db.update(AuditPolicyTable).set({ categories: ["read"] }).where(eq(AuditPolicyTable.organization_id, f.org))
  await f.db.execute(sql.raw("CREATE TRIGGER audit_api_test_fail_served BEFORE INSERT ON audit_event FOR EACH ROW BEGIN IF NEW.action = 'audit.usage.served' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic-sensitive-storage-failure'; END IF; END"))
  try {
    const response = await f.request("/v1/audit/usage")
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: "audit_unavailable" })
    const events = await f.events()
    assert.equal(events.length, 1)
    assert.equal(events[0].action, "audit.usage.requested")
    assert.equal(events[0].category, "read")
  } finally { await f.db.execute(sql.raw("DROP TRIGGER audit_api_test_fail_served")) }
  const blocked = await fixture()
  await blocked.db.update(AuditPolicyTable).set({ categories: ["access"] }).where(eq(AuditPolicyTable.organization_id, blocked.org))
  await blocked.db.insert(AuditEventTable).values({ id: createDenTypeId("auditEvent"), org_id: blocked.org, sequence: 1, action: "synthetic.sequence_conflict" })
  const response = await blocked.request("/v1/audit/export")
  assert.equal(response.status, 503)
  assert.equal(response.headers.get("content-disposition"), null)
  assert.deepEqual(await response.json(), { error: "audit_unavailable" })
  assert.equal((await blocked.events()).length, 0)
})

dbTest("visibility alone gates reads; capture flag, absent/disabled policy and excluded categories preserve access", async () => {
  const f = await fixture()
  const event = await f.append()
  Object.assign(environment.env, { auditVisibilityEnabled: false })
  try {
    const response = await f.request("/v1/audit/operations")
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: "audit_visibility_disabled" })
    assert.equal((await f.events()).length, 1)
  } finally { Object.assign(environment.env, { auditVisibilityEnabled: true }) }
  Object.assign(environment.env, { auditCaptureEnabled: false })
  try {
    await f.db.update(AuditPolicyTable).set({ categories: ["access"] }).where(eq(AuditPolicyTable.organization_id, f.org))
    const response = await f.request(`/v1/audit/operations/${event.operationId}/events`)
    assert.equal(response.status, 200)
    assert.equal(auditEventsResponseSchema.parse(await response.json()).events.length, 1)
    assert.equal(auditUsageResponseSchema.parse(await (await f.request("/v1/audit/usage")).json()).captureEnabled, false)
    assert.equal((await f.events()).length, 1)
  } finally { Object.assign(environment.env, { auditCaptureEnabled: true }) }
  await f.db.update(AuditPolicyTable).set({ enabled: false }).where(eq(AuditPolicyTable.organization_id, f.org))
  assert.equal((await f.request("/v1/audit/operations")).status, 200)
  await f.db.delete(AuditPolicyTable).where(eq(AuditPolicyTable.organization_id, f.org))
  assert.equal((await f.request("/v1/audit/operations")).status, 200)
  assert.equal((await f.events()).length, 1)
})

dbTest("capture entitlement matrix ignores legacy gating and tenant-writable claims, and never opts in implicitly", async () => {
  const original = { auditSelfHostedEnabled: environment.env.auditSelfHostedEnabled, planGatingEnabled: environment.env.planGatingEnabled }
  const { getOrganizationEntitlements } = await import("../src/entitlements.js")
  try {
    for (const tier of ["enterprise", "team", "free"]) for (const selfHosted of [false, true]) for (const gating of [false, true]) {
      const f = await fixture()
      const metadata = { plan: { tier, source: "manual" }, auditLogs: true, audit: { enabled: true }, entitlements: { auditLogs: true } }
      Object.assign(environment.env, { auditSelfHostedEnabled: selfHosted, planGatingEnabled: gating })
      await f.db.update(OrganizationTable).set({ metadata }).where(eq(OrganizationTable.id, f.org))
      await f.db.update(AuditPolicyTable).set({ enabled: false }).where(eq(AuditPolicyTable.organization_id, f.org))
      const entitled = selfHosted || tier === "enterprise"
      assert.equal(getOrganizationEntitlements(metadata).auditLogs, entitled)
      const before = auditUsageResponseSchema.parse(await (await f.request("/v1/audit/usage")).json())
      assert.deepEqual(before.entitlement, { enabled: entitled, source: selfHosted ? "self_hosted" : entitled ? "enterprise_plan" : "none" })
      assert.equal(before.captureOn, false)
      assert.equal(before.captureEnabled, false)
      assert.equal(before.captureAvailable, true)
      assert.equal((await f.events()).length, 0)
      const result = await f.toggle(true, 1)
      assert.equal(result.status, entitled ? 200 : 402)
      if (entitled) {
        const usage = auditUsageResponseSchema.parse(await result.json())
        assert.equal(usage.captureEnabled, true)
        assert.equal(usage.policy?.revision, 2)
      } else assert.deepEqual(await result.json(), { error: "enterprise_plan_required", feature: "auditLogs", message: "Audit logs requires an Enterprise plan or explicit self-hosted installation entitlement." })
    }
  } finally { Object.assign(environment.env, original) }
})

dbTest("on-off-on keeps retained history, first capture time and operator settings with fixed control evidence", async () => {
  const f = await fixture()
  const retained = await f.append()
  const original = await readAuditPolicy(f.db, f.org)
  assert.ok(original)
  const before = await f.events()
  const off = await f.toggle(false, 1)
  assert.equal(off.status, 200)
  const offUsage = auditUsageResponseSchema.parse(await off.json())
  assert.equal(offUsage.captureOn, false)
  assert.equal(offUsage.captureEnabled, false)
  assert.equal(offUsage.policy?.revision, 2)
  const afterOff = await f.events()
  assert.deepEqual(afterOff.slice(0, before.length), before)
  const control = afterOff.at(-1)
  assert.ok(control)
  assert.equal(control.action, "audit.capture.disabled")
  assert.equal(control.category, "lifecycle")
  assert.equal(control.operation.kind, "audit.policy")
  assert.deepEqual(control.actor, { type: "user", id: f.userId, memberId: f.memberId })
  assert.deepEqual(control.changes?.before, { captureOn: true, revision: 1, effectiveAt: original.effectiveAt })
  assert.deepEqual(control.changes?.after, { captureOn: false, revision: 2, effectiveAt: offUsage.policy?.effectiveAt })
  assert.equal((await f.request(`/v1/audit/operations/${retained.operationId}/events`)).status, 200)
  assert.equal((await f.request("/v1/audit/export")).status, 200)
  assert.equal((await f.toggle(false, 2)).status, 200)
  assert.equal((await f.toggle(false, 1)).status, 409)
  assert.deepEqual(await f.events(), afterOff)
  const on = await f.toggle(true, 2)
  assert.equal(on.status, 200)
  const final = auditUsageResponseSchema.parse(await on.json())
  assert.equal(final.captureEnabled, true)
  assert.equal(final.policy?.revision, 3)
  assert.equal(final.policy?.captureStartedAt, original.captureStartedAt)
  for (const key of ["source", "allowance", "excessMode", "attachmentWindowSeconds", "categories"] as const) assert.deepEqual(final.policy?.[key], original[key])
  assert.equal((await f.events()).at(-1)?.action, "audit.capture.enabled")
  const events = await f.events()
  assert.equal((await f.toggle(true, 3)).status, 200)
  assert.equal((await f.toggle(true, 2)).status, 409)
  assert.deepEqual(await f.events(), events)
  const [state] = await f.db.select().from(AuditStateTable).where(eq(AuditStateTable.organization_id, f.org))
  assert.equal(state.event_count, events.length)
  assert.equal(state.logical_bytes, events.reduce((sum, event) => sum + event.logicalBytes, 0))
  assert.equal(state.retained_operations, new Set(events.map((event) => event.operationId)).size)
})

dbTest("missing operator policy never fabricates allowance and OFF revision zero is a no-op", async () => {
  const f = await fixture()
  await f.db.delete(AuditPolicyTable).where(eq(AuditPolicyTable.organization_id, f.org))
  const response = await f.toggle(true, 0)
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: "audit_policy_not_configured" })
  assert.equal((await f.toggle(false, 1)).status, 409)
  const off = await f.toggle(false, 0)
  assert.equal(off.status, 200)
  const usage = auditUsageResponseSchema.parse(await off.json())
  assert.equal(usage.policy, null)
  assert.equal(usage.captureOn, false)
  assert.equal(usage.entitlement.enabled, true)
  assert.equal((await f.events()).length, 0)
  assert.deepEqual(await f.db.select().from(AuditStateTable).where(eq(AuditStateTable.organization_id, f.org)), [])
})

dbTest("revoked plans and unavailable rollout cannot enable but can disable without hiding history", async () => {
  const f = await fixture()
  const retained = await f.append()
  await f.db.update(AuditPolicyTable).set({ categories: ["access"] }).where(eq(AuditPolicyTable.organization_id, f.org))
  await f.db.update(OrganizationTable).set({ metadata: { plan: { tier: "team" } } }).where(eq(OrganizationTable.id, f.org))
  const revoked = auditUsageResponseSchema.parse(await (await f.request("/v1/audit/usage")).json())
  assert.deepEqual(revoked.entitlement, { enabled: false, source: "none" })
  assert.equal(revoked.captureOn, true)
  assert.equal(revoked.captureEnabled, false)
  assert.equal((await f.toggle(true, 1)).status, 402)
  assert.equal((await f.request("/v1/audit/export")).status, 200)
  assert.equal((await f.request(`/v1/audit/operations/${retained.operationId}/events`)).status, 200)
  assert.equal((await f.events()).length, 1)
  Object.assign(environment.env, { auditCaptureEnabled: false })
  try {
    assert.equal((await f.toggle(false, 1)).status, 200)
    await f.db.update(OrganizationTable).set({ metadata: { plan: { tier: "enterprise" } } }).where(eq(OrganizationTable.id, f.org))
    const unavailable = await f.toggle(true, 2)
    assert.equal(unavailable.status, 409)
    assert.deepEqual(await unavailable.json(), { error: "audit_capture_unavailable" })
    const usage = auditUsageResponseSchema.parse(await (await f.request("/v1/audit/usage")).json())
    assert.equal(usage.captureAvailable, false)
    assert.equal(usage.captureOn, false)
  } finally { Object.assign(environment.env, { auditCaptureEnabled: true }) }
})

dbTest("settings reject unauthenticated, member, foreign org and forged configuration; OFF also requires reauth", async () => {
  const f = await fixture()
  const member = await fixture("member")
  const foreign = await fixture()
  const init = { method: "PATCH", headers: { "content-type": "application/json", "x-openwork-org-id": f.org }, body: JSON.stringify({ captureOn: false, expectedRevision: 1 }) }
  assert.equal((await f.app(false).request("/v1/audit/settings", init)).status, 401)
  assert.equal((await member.toggle(false, 1)).status, 403)
  assert.equal((await f.app().request("/v1/audit/settings", { ...init, headers: { ...init.headers, "x-openwork-org-id": foreign.org } })).status, 404)
  for (const extra of [{ entitlement: { enabled: true } }, { source: "operator" }, { allowance: 999 }, { excessMode: "keep_all" }, { categories: ["read"] }, { enabled: true }, { captureOn: "false" }, { expectedRevision: -1 }, { expectedRevision: 1.1 }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { organizationId: foreign.org }]) assert.equal((await f.toggle(false, 1, extra)).status, 400)
  Object.assign(environment.env, { auditVisibilityEnabled: false })
  try { assert.equal((await f.toggle(false, 1)).status, 403) } finally { Object.assign(environment.env, { auditVisibilityEnabled: true }) }
  f.session.createdAt = new Date(Date.now() - 3600000)
  const reauth = await f.toggle(false, 1)
  assert.equal(reauth.status, 403)
  assert.equal((await reauth.json()).error, "reauth")
  assert.equal((await readAuditPolicy(f.db, f.org))?.revision, 1)
  assert.equal((await f.events()).length, 0)
})

dbTest("capture control evidence binds the verified API key and ignores foreign headers and grouping hints", async () => {
  const f = await fixture()
  const foreign = await fixture()
  const key: DenApiKeySession = { id: createDenTypeId("apiKey"), configId: "default", referenceId: f.userId, metadata: { organizationId: f.org, orgMembershipId: f.memberId, issuedByUserId: f.userId, issuedByOrgMembershipId: f.memberId } }
  const request = { method: "PATCH", headers: { "content-type": "application/json", "x-openwork-org-id": foreign.org, "x-request-id": "untrusted-request", "x-openwork-audit-correlation": randomUUID() }, body: JSON.stringify({ captureOn: false, expectedRevision: 1 }) }
  assert.equal((await f.app(true, key).request("/v1/audit/settings", request)).status, 200)
  const [event] = await f.events()
  assert.equal(event.organizationId, f.org)
  assert.deepEqual(event.actor, { type: "user", id: f.userId, memberId: f.memberId, credentialId: key.id })
  assert.ok(event.requestId?.startsWith("req_"))
  assert.equal(event.operation.scope, f.org)
  assert.equal((await foreign.events()).length, 0)
  assert.equal((await readAuditPolicy(foreign.db, foreign.org))?.enabled, true)
  const forgedKey = { ...key, metadata: { ...key.metadata!, orgMembershipId: foreign.memberId } }
  assert.equal((await f.app(true, forgedKey).request("/v1/audit/settings", request)).status, 403)
})

dbTest("live team-derived organization administrators may toggle, but revoked grants cannot", async () => {
  const f = await fixture("member")
  const teamId = createDenTypeId("team")
  await f.db.insert(TeamTable).values({ id: teamId, organizationId: f.org, name: "Synthetic administrators", grantsOrganizationAdmin: true })
  await f.db.insert(TeamMemberTable).values({ id: createDenTypeId("teamMember"), teamId, orgMembershipId: f.memberId })
  assert.equal((await f.toggle(false, 1)).status, 200)
  await f.db.update(TeamTable).set({ grantsOrganizationAdmin: false }).where(eq(TeamTable.id, teamId))
  assert.equal((await f.toggle(true, 2)).status, 403)
  assert.equal((await f.events()).length, 1)
})

dbTest("required control event insert failure rolls back policy, counters and operation", async () => {
  const f = await fixture()
  const original = await readAuditPolicy(f.db, f.org)
  await f.db.execute(sql.raw("CREATE TRIGGER audit_api_test_fail_capture BEFORE INSERT ON audit_event FOR EACH ROW BEGIN IF NEW.action = 'audit.capture.disabled' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic-insert-failure'; END IF; END"))
  try {
    const response = await f.toggle(false, 1)
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: "audit_unavailable" })
    assert.deepEqual(await readAuditPolicy(f.db, f.org), original)
    assert.equal((await f.events()).length, 0)
    assert.deepEqual(await f.db.select().from(AuditStateTable).where(eq(AuditStateTable.organization_id, f.org)), [])
    assert.deepEqual(await f.db.select().from(AuditOperationTable).where(eq(AuditOperationTable.organization_id, f.org)), [])
  } finally { await f.db.execute(sql.raw("DROP TRIGGER audit_api_test_fail_capture")) }
})

dbTest("concurrent desired-state toggles reject a stale revision rather than silently losing updates", async () => {
  const f = await fixture()
  const results = await Promise.all([f.toggle(false, 1), f.toggle(false, 1)])
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 409])
  assert.equal((await readAuditPolicy(f.db, f.org))?.revision, 2)
  assert.equal((await f.events()).length, 1)
})

dbTest("live member fence rejects demotion committed while toggle authorization was in flight", async () => {
  const f = await fixture("admin")
  let locked = () => {}
  let release = () => {}
  const holding = new Promise<void>((resolve) => { locked = resolve })
  const resume = new Promise<void>((resolve) => { release = resolve })
  const demotion = f.db.transaction(async (tx) => {
    await tx.update(MemberTable).set({ role: "member" }).where(eq(MemberTable.id, f.memberId))
    locked()
    await resume
  })
  await holding
  const request = f.toggle(false, 1)
  try { await delay(100) } finally { release() }
  await demotion
  assert.equal((await request).status, 403)
  assert.equal((await readAuditPolicy(f.db, f.org))?.revision, 1)
  assert.equal((await f.events()).length, 0)
})

dbTest("OpenAPI exposes the exact contracts and stable operation IDs but excludes every audit route from MCP", async () => {
  const f = await fixture()
  const document = await generateSpecs(f.app())
  for (const [path, operationId] of [["/v1/audit/event-types", "getAuditEventTypes"], ["/v1/audit/operations", "getAuditOperations"], ["/v1/audit/operations/{operationId}/events", "getAuditOperationEvents"], ["/v1/audit/usage", "getAuditUsage"], ["/v1/audit/export", "getAuditExport"]]) {
    const operation = document.paths?.[path]?.get
    assert.ok(operation)
    assert.equal(operation.operationId, operationId)
    assert.equal(Reflect.get(operation, "x-mcp"), false)
    for (const status of [200, 400, 401, 403, 404, 410, 503]) assert.ok(operation.responses?.[String(status)])
    assert.ok(operation.description?.includes("Legacy"))
  }
  assert.deepEqual(Object.keys(document.paths ?? {}).sort(), [...auditReadCoveredRoutes.map((route) => route.path.replace(":operationId", "{operationId}")), "/v1/audit/settings"].sort())
  const settings = document.paths?.["/v1/audit/settings"]?.patch
  assert.ok(settings)
  assert.equal(settings.operationId, "updateAuditCapture")
  assert.equal(Reflect.get(settings, "x-mcp"), false)
  assert.match(JSON.stringify(settings.requestBody), /expectedRevision/)
  assert.match(JSON.stringify(settings.responses?.["200"]), /entitlement/)
  for (const status of [200, 400, 401, 402, 403, 409, 503]) assert.ok(settings.responses?.[String(status)])
  const catalog = document.paths?.["/v1/audit/event-types"]?.get
  assert.ok(catalog)
  assert.match(catalog.description ?? "", /static supported semantic action catalog/)
  assert.match(catalog.description ?? "", /independent of loaded rows, time\/filter selection and capture category enablement/)
  assert.match(catalog.description ?? "", /support does not imply this organization has events of every type/)
  assert.equal(catalog.parameters?.length ?? 0, 0)
  assert.match(JSON.stringify(catalog.responses?.["200"]), /"eventTypes"/)
  for (const path of ["/v1/audit/operations", "/v1/audit/export"]) {
    const operation = document.paths?.[path]?.get
    assert.ok(operation)
    const searchId = operation.parameters?.find((parameter) => "name" in parameter && parameter.name === "searchId")
    assert.ok(searchId && "schema" in searchId)
    assert.deepEqual(searchId.schema, { type: "string", minLength: 1, maxLength: 255, pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$" })
    assert.equal(searchId.required ?? false, false)
    assert.match(searchId.description ?? "", /Exact case-sensitive/)
    assert.match(operation.description ?? "", /AND combined with searchId/)
    assert.match(operation.description ?? "", /inclusive operation-start bounds/)
  }
  const response = await f.request("/v1/audit/operations")
  assert.equal(response.headers.get("x-audit-resource-scope"), "first_event")
  assert.equal(response.headers.get("cache-control"), "no-store")
  auditOperationsResponseSchema.parse(await response.json())
  const filtered = await listAuditExportEvents(f.query, auditExportQuerySchema.parse({ action: "missing.action" }))
  assert.equal(filtered.events.length, 0)
})
