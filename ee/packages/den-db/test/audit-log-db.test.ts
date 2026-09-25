import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import mysql from "mysql2/promise"
import { and, eq } from "drizzle-orm"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { createDenDb } from "../src/client"
import { AuditLogError, appendAuditEvent, canonicalAuditJson, readAuditPolicy, type AuditContext, type AuditEventInput, type AuditPolicy } from "../src/audit-log"
import { AuditEventTable, AuditEventResourceTable, AuditOperationTable, AuditOperationStepTable, AuditPolicyTable, AuditStateTable, AuditUsageFactTable, WorkerTable } from "../src/schema"
import { localConnectionConfig, migrateLocalDatabase } from "../scripts/dev-migrate"
import { loadMigrationPlan, record } from "../scripts/migration-baseline"

const url = process.env.DEN_AUDIT_TEST_DATABASE_URL
if (url) {
  let valid = false
  try {
    const parsed = new URL(url)
    valid = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) && /^\/audit_logs_test(?:_[a-z0-9_]+)?$/.test(parsed.pathname)
  } catch {}
  if (!valid) throw new Error("Use an explicitly owned disposable loopback audit_logs_test database only; connection value withheld.")
}
let instance: ReturnType<typeof createDenDb> | undefined
before(async () => {
  if (!url) return
  const connection = await mysql.createConnection({ ...localConnectionConfig(url), multipleStatements: true })
  try {
    await migrateLocalDatabase({ query: async (query, args = []) => {
      const [rows] = await connection.query(query, args)
      const result: unknown = rows
      return Array.isArray(result) ? result.filter(record) : []
    } }, loadMigrationPlan(fileURLToPath(new URL("../drizzle", import.meta.url))))
  } finally { await connection.end() }
  instance = createDenDb({ databaseUrl: url, mode: "mysql" })
})
after(async () => {
  if (instance && "end" in instance.client) await instance.client.end()
})
const dbTest = (name: string, run: () => Promise<void>) => test(name, { skip: !url }, run)
function database() { assert.ok(instance); return instance.db }
const code = (expected: string) => (error: unknown) => error instanceof AuditLogError && error.code === expected
function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
}

async function fixture() {
  const db = database()
  const organizationId = createDenTypeId("organization")
  const userId = createDenTypeId("user")
  const providerId = createDenTypeId("inferenceProvider")
  await db.insert(AuditPolicyTable).values({ organization_id: organizationId, revision: 1, source: "operator", enabled: true, categories: ["change", "security", "execution", "request"], allowance: 100, excess_mode: "keep_all", effective_at: new Date("2026-01-01T00:00:00.000Z"), attachment_window_seconds: 300 })
  const policy = await readAuditPolicy(db, organizationId)
  assert.ok(policy)
  const context: AuditContext = { organizationId, actor: { type: "user", id: userId }, principalKey: `user:${userId}`, origin: "api", originTrust: "authenticated", requestId: createDenTypeId("request"), correlationId: randomUUID(), kind: "provider.configuration", scope: providerId, workflowStep: "update", workflowStepScope: providerId }
  const event: AuditEventInput = { action: "provider.updated", category: "change", outcome: "succeeded", resources: [{ type: "provider", id: providerId, relationship: "target", label: "Synthetic provider" }], changes: { before: { name: "Before" }, after: { name: "After" }, changedFields: ["name"] } }
  const append = (nextEvent: AuditEventInput = event, nextContext: AuditContext = context, nextPolicy: AuditPolicy = policy) => db.transaction((tx) => appendAuditEvent(tx, { context: nextContext, policy: nextPolicy, event: nextEvent }))
  const state = async () => (await db.select().from(AuditStateTable).where(eq(AuditStateTable.organization_id, organizationId)))[0]
  return { db, organizationId, providerId, policy, context, event, append, state }
}

dbTest("absent policy disables capture and a first event atomically creates all retained records", async () => {
  const f = await fixture()
  assert.equal(await readAuditPolicy(f.db, createDenTypeId("organization")), null)
  const envelope = await f.append()
  assert.ok(envelope)
  const { logicalBytes, ...withoutBytes } = envelope
  assert.equal(logicalBytes, Buffer.byteLength(canonicalAuditJson(withoutBytes), "utf8"))
  const state = await f.state()
  assert.equal(state.last_sequence, 1)
  assert.equal(state.event_count, 1)
  assert.equal(state.retained_operations, 1)
  assert.equal(state.logical_bytes, logicalBytes)
  const [operation] = await f.db.select().from(AuditOperationTable).where(eq(AuditOperationTable.organization_id, f.organizationId))
  assert.equal(operation.id, envelope.operationId)
  assert.equal(operation.outcome, "unknown")
  assert.equal(operation.event_count, 1)
  assert.equal(operation.logical_bytes, logicalBytes)
  const resources = await f.db.select().from(AuditEventResourceTable).where(eq(AuditEventResourceTable.organization_id, f.organizationId))
  assert.equal(resources.length, 1)
  assert.equal(resources[0].resource_id, f.providerId)
  const facts = await f.db.select().from(AuditUsageFactTable).where(eq(AuditUsageFactTable.organization_id, f.organizationId))
  assert.equal(facts.length, 1)
  assert.equal(facts[0].delta, 1)
  assert.equal(facts[0].policy_revision, 1)
  assert.equal(facts[0].excess_mode, "keep_all")
  assert.equal((await readAuditPolicy(f.db, f.organizationId))?.captureStartedAt, envelope.recordedAt)
})

dbTest("one root and nineteen distinct concurrent child requests share twenty bounded step claims", async () => {
  const f = await fixture()
  const root = await f.append()
  const children = await Promise.all(Array.from({ length: 19 }, (_, index) => {
    const groupId = createDenTypeId("gatewayModelGroup")
    return f.append({ ...f.event, action: "provider.group.updated", resources: [{ type: "provider_model_group", id: groupId, relationship: "target" }], idempotencyKey: `step:${index}` }, { ...f.context, requestId: createDenTypeId("request"), workflowStep: "group.update", workflowStepScope: `${f.providerId}/model-groups/${groupId}` })
  }))
  const events = [root, ...children]
  const claims = await f.db.select().from(AuditOperationStepTable).where(eq(AuditOperationStepTable.organization_id, f.organizationId))
  assert.equal(claims.length, 20)
  assert.equal(new Set(claims.map((claim) => claim.request_id)).size, 20)
  assert.equal(new Set(events.map((event) => event?.operationId)).size, 1)
  assert.deepEqual(events.map((event) => event?.sequence).sort((a, b) => Number(a) - Number(b)), Array.from({ length: 20 }, (_, index) => index + 1))
  const state = await f.state()
  assert.equal(state.retained_operations, 1)
  assert.equal(state.event_count, 20)
  assert.equal(state.last_sequence, 20)
  assert.equal(state.logical_bytes, events.reduce((sum, event) => sum + (event?.logicalBytes ?? 0), 0))
  assert.equal((await f.db.select().from(AuditUsageFactTable).where(eq(AuditUsageFactTable.organization_id, f.organizationId))).length, 1)
})

dbTest("sequence allocation stays locked until commit and high-water readers cannot miss a late commit", async () => {
  const f = await fixture()
  const { promise: holding, resolve: signalHolding } = deferred()
  const { promise: release, resolve: releaseLock } = deferred()
  let secondCommitted = false
  const first = f.db.transaction(async (tx) => {
    const event = await appendAuditEvent(tx, { context: f.context, policy: f.policy, event: f.event })
    signalHolding()
    await release
    return event
  })
  await holding
  const second = f.append(f.event, { ...f.context, requestId: createDenTypeId("request") }).then((event) => { secondCommitted = true; return event })
  try {
    await delay(50)
    assert.equal(secondCommitted, false)
    assert.equal(await f.state(), undefined)
    assert.equal((await f.db.select().from(AuditEventTable).where(eq(AuditEventTable.org_id, f.organizationId))).length, 0)
  } finally { releaseLock() }
  const [a, b] = await Promise.all([first, second])
  assert.equal(a?.sequence, 1)
  assert.equal(b?.sequence, 2)
  assert.equal((await f.state()).last_sequence, 2)
})

dbTest("mutation rollback leaves no event, parent, resource, fact, counter or capture start", async () => {
  const f = await fixture()
  const workerId = createDenTypeId("worker")
  await assert.rejects(f.db.transaction(async (tx) => {
    await tx.insert(WorkerTable).values({ id: workerId, org_id: f.organizationId, name: "Synthetic worker", destination: "local", status: "healthy" })
    await appendAuditEvent(tx, { context: f.context, policy: f.policy, event: f.event })
    throw new Error("synthetic_mutation_rollback")
  }), /synthetic_mutation_rollback/)
  assert.equal((await f.db.select().from(WorkerTable).where(and(eq(WorkerTable.org_id, f.organizationId), eq(WorkerTable.id, workerId)))).length, 0)
  assert.equal(await f.state(), undefined)
  assert.equal((await readAuditPolicy(f.db, f.organizationId))?.captureStartedAt, null)
  for (const table of [AuditOperationTable, AuditOperationStepTable, AuditUsageFactTable, AuditEventResourceTable]) assert.equal((await f.db.select().from(table).where(eq(table.organization_id, f.organizationId))).length, 0)
  assert.equal((await f.db.select().from(AuditEventTable).where(eq(AuditEventTable.org_id, f.organizationId))).length, 0)
})

dbTest("an actual audit INSERT failure rolls back the mutation and preceding parent/fact writes", async () => {
  const f = await fixture()
  const workerId = createDenTypeId("worker")
  await f.db.insert(AuditEventTable).values({ id: createDenTypeId("auditEvent"), org_id: f.organizationId, action: "synthetic.sequence_conflict", sequence: 1 })
  await assert.rejects(f.db.transaction(async (tx) => {
    await tx.insert(WorkerTable).values({ id: workerId, org_id: f.organizationId, name: "Synthetic worker", destination: "local", status: "healthy" })
    await appendAuditEvent(tx, { context: f.context, policy: f.policy, event: f.event })
  }))
  assert.equal((await f.db.select().from(WorkerTable).where(and(eq(WorkerTable.org_id, f.organizationId), eq(WorkerTable.id, workerId)))).length, 0)
  assert.equal(await f.state(), undefined)
  assert.equal((await f.db.select().from(AuditOperationTable).where(eq(AuditOperationTable.organization_id, f.organizationId))).length, 0)
  assert.equal((await f.db.select().from(AuditUsageFactTable).where(eq(AuditUsageFactTable.organization_id, f.organizationId))).length, 0)
  assert.equal((await f.db.select().from(AuditOperationStepTable).where(eq(AuditOperationStepTable.organization_id, f.organizationId))).length, 0)
})

dbTest("idempotency is tenant/operation-scoped, concurrent retries return one immutable envelope, changed evidence rejects", async () => {
  const f = await fixture()
  const event = { ...f.event, idempotencyKey: "step:save" }
  const results = await Promise.all(Array.from({ length: 10 }, () => f.append(event, f.context)))
  assert.equal(new Set(results.map((row) => row?.id)).size, 1)
  assert.equal((await f.db.select().from(AuditOperationStepTable).where(eq(AuditOperationStepTable.organization_id, f.organizationId))).length, 1)
  assert.equal((await f.state()).event_count, 1)
  await assert.rejects(f.append({ ...event, changes: { before: null, after: { name: "Different" }, changedFields: ["name"] } }), code("audit_idempotency_mismatch"))
  assert.equal((await f.state()).event_count, 1)
  const next = await f.append(event, { ...f.context, correlationId: randomUUID() })
  assert.notEqual(next?.operationId, results[0]?.operationId)
  assert.equal((await f.state()).retained_operations, 2)
  const other = await fixture()
  assert.ok(await other.append({ ...other.event, idempotencyKey: "step:save" }))
})

dbTest("repeated root and child steps from different requests fall back without splitting their events", async () => {
  const f = await fixture()
  const first = await f.append()
  const repeatContext = { ...f.context, requestId: createDenTypeId("request") }
  const second = await f.append({ ...f.event, changes: { before: { name: "After" }, after: { name: "Independent Save" }, changedFields: ["name"] } }, repeatContext)
  const support = await f.append({ action: "provider.configuration.update.committed", category: "request", outcome: "succeeded", resources: [] }, repeatContext)
  assert.notEqual(first?.operationId, second?.operationId)
  assert.equal(second?.operationId, support?.operationId)
  const groupId = createDenTypeId("gatewayModelGroup")
  const child = { ...f.context, requestId: createDenTypeId("request"), workflowStep: "group.update", workflowStepScope: `${f.providerId}/model-groups/${groupId}` }
  const childFirst = await f.append(f.event, child)
  assert.equal(childFirst?.operationId, first?.operationId)
  const childRepeat = { ...child, requestId: createDenTypeId("request") }
  const childSecond = await f.append(f.event, childRepeat)
  assert.notEqual(childSecond?.operationId, first?.operationId)
  assert.equal((await f.append(f.event, { ...childRepeat, workflowStep: "group.delete" }))?.operationId, childSecond?.operationId)
  const claims = await f.db.select().from(AuditOperationStepTable).where(eq(AuditOperationStepTable.organization_id, f.organizationId))
  assert.equal(claims.length, 2)
  assert.equal((await f.state()).event_count, 6)
})

dbTest("128 claim bound permits same-request support events but rejects further resource attachments", async () => {
  const f = await fixture()
  const root = await f.append()
  for (let index = 0; index < 127; index++) {
    const context = { ...f.context, workflowStep: "group.update", workflowStepScope: `${f.providerId}/model-groups/${createDenTypeId("gatewayModelGroup")}`, requestId: createDenTypeId("request") }
    assert.equal((await f.append(f.event, context))?.operationId, root?.operationId)
  }
  assert.equal((await f.append({ ...f.event, action: "provider.configuration.update.committed", category: "request" }, f.context))?.operationId, root?.operationId)
  const excessContext = { ...f.context, workflowStep: "group.update", workflowStepScope: `${f.providerId}/model-groups/${createDenTypeId("gatewayModelGroup")}`, requestId: createDenTypeId("request") }
  const excess = await f.append(f.event, excessContext)
  assert.notEqual(excess?.operationId, root?.operationId)
  assert.equal((await f.append(f.event, excessContext))?.operationId, excess?.operationId)
  assert.equal((await f.db.select().from(AuditOperationStepTable).where(eq(AuditOperationStepTable.organization_id, f.organizationId))).length, 128)
  assert.equal((await f.state()).retained_operations, 2)
})

dbTest("invalid step scope and generic audit access ignore hints but retain records under request fallback", async () => {
  const f = await fixture()
  const root = await f.append()
  for (const change of [{ workflowStepScope: "not-a-provider" }, { workflowStep: "client.workflow" }, { workflowStep: undefined }, { kind: "audit.access" }]) {
    const context = { ...f.context, ...change, requestId: createDenTypeId("request") }
    const first = await f.append(f.event, context)
    assert.notEqual(first?.operationId, root?.operationId)
    assert.equal((await f.append(f.event, context))?.operationId, first?.operationId)
    assert.notEqual((await f.append(f.event, { ...context, requestId: createDenTypeId("request") }))?.operationId, first?.operationId)
    if (context.kind === "provider.configuration") assert.equal((await f.append(f.event, { ...context, workflowStep: "update", workflowStepScope: f.providerId }))?.operationId, first?.operationId)
  }
})

dbTest("distinct validated grant targets share bounded claims and repeated targets retain failed attempts separately", async () => {
  const f = await fixture()
  const root = await f.append()
  const groupId = createDenTypeId("gatewayModelGroup")
  const setId = createDenTypeId("gatewayCredentialSet")
  const memberId = createDenTypeId("member")
  const targets = [
    `${groupId}/${setId}/organization/${f.organizationId}`,
    `${groupId}/${setId}/member/${memberId}`,
    `${groupId}/${setId}/member/${createDenTypeId("member")}`,
    `${groupId}/${setId}/team/${createDenTypeId("team")}`,
    `${createDenTypeId("gatewayModelGroup")}/${setId}/member/${memberId}`,
    `${groupId}/${createDenTypeId("gatewayCredentialSet")}/member/${memberId}`,
  ]
  for (const target of targets) {
    const context = { ...f.context, workflowStep: "grant.create", workflowStepScope: `${f.providerId}/grant-target/${target}`, requestId: createDenTypeId("request") }
    const event = await f.append({ ...f.event, action: "provider.access_grant.created", changes: { before: null, after: { target }, changedFields: ["target"] } }, context)
    assert.equal(event?.operationId, root?.operationId)
  }
  const claims = await f.db.select().from(AuditOperationStepTable).where(eq(AuditOperationStepTable.organization_id, f.organizationId))
  assert.equal(claims.length, targets.length + 1)
  assert.equal(new Set(claims.map((claim) => claim.step_hash)).size, claims.length)
  assert.deepEqual(claims.filter((claim) => claim.workflow_step === "grant.create").map((claim) => claim.step_scope).sort(), targets.map((target) => `${f.providerId}/grant-target/${target}`).sort())
  assert.equal((await f.db.select().from(AuditUsageFactTable).where(eq(AuditUsageFactTable.organization_id, f.organizationId))).length, 1)
  const repeated = { ...f.context, workflowStep: "grant.create", workflowStepScope: `${f.providerId}/grant-target/${targets[0]}`, requestId: createDenTypeId("request") }
  const failed: AuditEventInput = { action: "provider.configuration.grant.create.attempted", category: "request", outcome: "failed", reasonCode: "provider_configuration_rejected", resources: [], idempotencyKey: "grant-attempt" }
  const attempt = await f.append(failed, repeated)
  assert.notEqual(attempt?.operationId, root?.operationId)
  assert.equal((await f.append(failed, repeated))?.id, attempt?.id)
  assert.equal((await f.state()).retained_operations, 2)
  assert.equal((await f.state()).event_count, targets.length + 2)
})

dbTest("child creation claims provider scope conservatively rather than allowing random new resource IDs", async () => {
  const f = await fixture()
  const firstContext = { ...f.context, workflowStep: "group.create", workflowStepScope: f.providerId }
  const first = await f.append(f.event, firstContext)
  const second = await f.append(f.event, { ...firstContext, requestId: createDenTypeId("request") })
  assert.notEqual(first?.operationId, second?.operationId)
  const invalidCreate = { ...firstContext, requestId: createDenTypeId("request"), workflowStepScope: `${f.providerId}/model-groups/${createDenTypeId("gatewayModelGroup")}` }
  assert.notEqual((await f.append(f.event, invalidCreate))?.operationId, first?.operationId)
  assert.equal((await f.db.select().from(AuditOperationStepTable).where(eq(AuditOperationStepTable.organization_id, f.organizationId))).length, 1)
})

dbTest("same UUID cannot combine principals, scopes, workflow kinds or tenants", async () => {
  const f = await fixture()
  const otherUserId = createDenTypeId("user")
  const otherProviderId = createDenTypeId("inferenceProvider")
  const contexts: AuditContext[] = [f.context, { ...f.context, principalKey: "user:other-credential" }, { ...f.context, actor: { type: "user", id: otherUserId }, principalKey: `user:${otherUserId}` }, { ...f.context, scope: otherProviderId, workflowStepScope: otherProviderId }, { ...f.context, kind: "audit.access" }]
  const rows = await Promise.all(contexts.map((context) => f.append(f.event, context)))
  assert.equal(new Set(rows.map((row) => row?.operationId)).size, contexts.length)
  const other = await fixture()
  const foreign = await other.append(other.event, { ...other.context, correlationId: f.context.correlationId })
  assert.ok(!rows.some((row) => row?.operationId === foreign?.operationId))
  await assert.rejects(f.append(f.event, other.context), code("audit_invalid_input"))
})

dbTest("expired UUID falls back to a new request operation without reusing the expired parent", async () => {
  const f = await fixture()
  const first = await f.append()
  assert.ok(first)
  await f.db.update(AuditOperationTable).set({ attachment_expires_at: new Date("2020-01-01T00:00:00.000Z") }).where(and(eq(AuditOperationTable.organization_id, f.organizationId), eq(AuditOperationTable.id, normalizeDenTypeId("auditOperation", first.operationId))))
  const nextContext = { ...f.context, requestId: createDenTypeId("request") }
  const second = await f.append(f.event, nextContext)
  const third = await f.append(f.event, nextContext)
  assert.notEqual(second?.operationId, first.operationId)
  assert.equal(second?.operationId, third?.operationId)
  assert.equal((await f.state()).retained_operations, 2)
})

dbTest("policy changes reject a stale preflight and roll back rather than dropping the audit event", async () => {
  const f = await fixture()
  await f.db.update(AuditPolicyTable).set({ revision: 2, enabled: false }).where(eq(AuditPolicyTable.organization_id, f.organizationId))
  await assert.rejects(f.append(), code("audit_policy_changed"))
  assert.equal(await f.state(), undefined)
  assert.equal((await f.db.select().from(AuditOperationTable).where(eq(AuditOperationTable.organization_id, f.organizationId))).length, 0)
})

dbTest("a concurrent policy writer serializes with event append and the stale mutation rolls back", async () => {
  const f = await fixture()
  await f.db.insert(AuditStateTable).values({ organization_id: f.organizationId })
  const holding = deferred()
  const release = deferred()
  const update = f.db.transaction(async (tx) => {
    await tx.select().from(AuditStateTable).where(eq(AuditStateTable.organization_id, f.organizationId)).for("update")
    await tx.update(AuditPolicyTable).set({ revision: 2, allowance: 200 }).where(eq(AuditPolicyTable.organization_id, f.organizationId))
    holding.resolve()
    await release.promise
  })
  await holding.promise
  const workerId = createDenTypeId("worker")
  const append = f.db.transaction(async (tx) => {
    await tx.insert(WorkerTable).values({ id: workerId, org_id: f.organizationId, name: "Synthetic worker", destination: "local", status: "healthy" })
    return appendAuditEvent(tx, { context: f.context, policy: f.policy, event: f.event })
  })
  const rejected = assert.rejects(append, code("audit_policy_changed"))
  release.resolve()
  await Promise.all([update, rejected])
  assert.equal((await f.state()).event_count, 0)
  assert.equal((await f.db.select().from(WorkerTable).where(and(eq(WorkerTable.org_id, f.organizationId), eq(WorkerTable.id, workerId)))).length, 0)
})

dbTest("audit evidence and actor identity are detached from mutable caller objects before awaiting storage", async () => {
  const f = await fixture()
  const originalActor = f.context.actor.id
  const after: Record<string, unknown> = { name: "Committed" }
  const input: AuditEventInput = { ...f.event, changes: { before: null, after, changedFields: ["name"] } }
  const envelope = await f.db.transaction(async (tx) => {
    const pending = appendAuditEvent(tx, { context: f.context, policy: f.policy, event: input })
    after.name = "Uncommitted"
    f.context.actor.id = createDenTypeId("user")
    return pending
  })
  assert.equal(envelope?.changes?.after?.name, "Committed")
  assert.equal(envelope?.actor.id, originalActor)
  assert.equal(envelope?.operation.initiatingActor.id, originalActor)
})

dbTest("invalid client grouping hints retain all events under independent request operations", async () => {
  const f = await fixture()
  const firstContext = { ...f.context, correlationId: "not-a-uuid" }
  const first = await f.append(f.event, firstContext)
  const sameRequest = await f.append(f.event, firstContext)
  const next = await f.append(f.event, { ...firstContext, requestId: createDenTypeId("request") })
  assert.equal(first?.operationId, sameRequest?.operationId)
  assert.notEqual(first?.operationId, next?.operationId)
  assert.equal((await f.state()).retained_operations, 2)
  assert.equal((await f.state()).event_count, 3)
})

dbTest("disabled capture writes nothing; failed and denied outcomes remain unknown at operation level", async () => {
  const f = await fixture()
  assert.equal(await f.append(f.event, f.context, { ...f.policy, enabled: false }), null)
  assert.equal(await f.state(), undefined)
  for (const outcome of ["failed", "denied"] as const) {
    const envelope = await f.append({ ...f.event, category: "security", outcome, reasonCode: "permission_denied", changes: undefined }, { ...f.context, correlationId: randomUUID() })
    assert.equal(envelope?.outcome, outcome)
  }
  const rows = await f.db.select().from(AuditOperationTable).where(eq(AuditOperationTable.organization_id, f.organizationId))
  assert.ok(rows.every((row) => row.outcome === "unknown"))
})

dbTest("service actors do not require a user and resource history survives application deletion", async () => {
  const f = await fixture()
  const workerId = createDenTypeId("worker")
  await f.db.insert(WorkerTable).values({ id: workerId, org_id: f.organizationId, name: "Synthetic worker", destination: "local", status: "healthy" })
  const envelope = await f.append({ ...f.event, resources: [{ type: "worker", id: workerId, relationship: "target" }] }, { ...f.context, actor: { type: "service", id: "synthetic-worker" }, principalKey: "service:synthetic-worker" })
  assert.ok(envelope)
  await f.db.delete(WorkerTable).where(and(eq(WorkerTable.org_id, f.organizationId), eq(WorkerTable.id, workerId)))
  const [row] = await f.db.select().from(AuditEventTable).where(and(eq(AuditEventTable.org_id, f.organizationId), eq(AuditEventTable.id, normalizeDenTypeId("auditEvent", envelope.id))))
  assert.equal(row.actor_user_id, null)
  assert.equal(row.envelope?.resources[0].id, workerId)
  assert.equal((await f.db.select().from(AuditEventResourceTable).where(eq(AuditEventResourceTable.organization_id, f.organizationId))).length, 1)
})

dbTest("counter overflow, cross-tenant causal links and evicting parents fail closed", async () => {
  const f = await fixture()
  const other = await fixture()
  const foreign = await other.append()
  assert.ok(foreign)
  await assert.rejects(f.append(f.event, { ...f.context, causedByEventId: foreign.id }), code("audit_invalid_input"))
  assert.equal(await f.state(), undefined)
  const first = await f.append()
  assert.ok(first)
  await f.db.update(AuditStateTable).set({ event_count: Number.MAX_SAFE_INTEGER }).where(eq(AuditStateTable.organization_id, f.organizationId))
  await assert.rejects(f.append(), code("audit_counter_overflow"))
  assert.equal((await f.state()).last_sequence, 1)
  await f.db.update(AuditOperationTable).set({ retention_state: "evicting" }).where(and(eq(AuditOperationTable.organization_id, f.organizationId), eq(AuditOperationTable.id, normalizeDenTypeId("auditOperation", first.operationId))))
  await assert.rejects(f.append(), code("audit_operation_unavailable"))
})
