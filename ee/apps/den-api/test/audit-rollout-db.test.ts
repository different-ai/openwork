import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { createDenDb } from "@openwork-ee/den-db"
import { appendAuditEvent, readAuditPolicy } from "@openwork-ee/den-db/audit-log"
import { isAuditRetentionConfirmationCurrent } from "@openwork-ee/den-db/audit-accounting"
import { eq } from "@openwork-ee/den-db/drizzle"
import { AuditEventResourceTable, AuditEventTable, AuditOperationTable, AuditPolicyTable, AuditStateTable, AuditUsageFactTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { runAuditPilot } from "../scripts/audit-pilot.js"
import { AuditPilotError, initializeAuditPilot, previewPilotRetention, validatePilotConfig } from "../src/audit/pilot-policy.js"

const url = process.env.DEN_AUDIT_TEST_DATABASE_URL
if (url) {
  let valid = false
  try {
    const parsed = new URL(url)
    valid = parsed.protocol === "mysql:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) && /^\/audit_logs_test(?:_[a-z0-9_]+)?$/.test(parsed.pathname)
  } catch {}
  if (!valid) throw new Error("Only an explicitly owned disposable loopback audit_logs_test database is allowed; connection withheld.")
}
let instance: ReturnType<typeof createDenDb> | undefined
const queries: string[] = []
before(() => {
  if (url) instance = createDenDb({ databaseUrl: url, mode: "mysql", logger: { logQuery(query) { queries.push(query) } } })
})
after(async () => { if (instance && "end" in instance.client) await instance.client.end() })
const dbTest = (name: string, run: () => Promise<void>) => test(name, { skip: !url, timeout: 30000 }, run)
function database() { assert.ok(instance); return instance.db }
const code = (expected: string) => (error: unknown) => error instanceof AuditPilotError && error.code === expected
function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((complete) => { resolve = complete })
  return { promise, resolve }
}
async function fixture() {
  const db = database()
  const organizationId = createDenTypeId("organization")
  await db.insert(OrganizationTable).values({ id: organizationId, name: "Synthetic audit pilot", slug: `synthetic-${organizationId}` })
  const config = validatePilotConfig({ organizationId, source: "operator", allowance: 100, attachmentWindowSeconds: 300, excessMode: "keep_all" })
  const state = async () => (await db.select().from(AuditStateTable).where(eq(AuditStateTable.organization_id, organizationId)))[0]
  const events = () => db.select().from(AuditEventTable).where(eq(AuditEventTable.org_id, organizationId)).orderBy(AuditEventTable.sequence)
  return { db, organizationId, config, state, events }
}

dbTest("default dry-run verifies and locks org/state/policy without creating any row", async () => {
  const f = await fixture()
  queries.length = 0
  assert.equal((await initializeAuditPilot(f.db, f.config)).initialized, false)
  assert.ok(queries.some((query) => /organization.*for share/i.test(query)))
  assert.ok(queries.some((query) => /audit_state.*for share/i.test(query)))
  assert.ok(queries.some((query) => /audit_policy.*for share/i.test(query)))
  assert.equal(queries.some((query) => /^\s*(?:insert|update|delete)/i.test(query)), false)
  assert.equal(await f.state(), undefined)
  assert.equal(await readAuditPolicy(f.db, f.organizationId), null)
  assert.deepEqual(await f.events(), [])
})

dbTest("unknown organization fails before state creation in both modes", async () => {
  const f = await fixture()
  const organizationId = createDenTypeId("organization")
  const config = validatePilotConfig({ ...f.config, organizationId })
  for (const apply of [false, true]) {
    queries.length = 0
    await assert.rejects(initializeAuditPilot(f.db, config, apply), code("audit_pilot_organization_not_found"))
    assert.equal(queries.some((query) => /audit_(?:state|policy|event)/i.test(query)), false)
  }
})

dbTest("apply commits revision 1 and honest system lifecycle snapshot with capture flags OFF; legacy unchanged", async () => {
  const f = await fixture()
  const legacyId = createDenTypeId("auditEvent")
  await f.db.insert(AuditEventTable).values({ id: legacyId, org_id: f.organizationId, action: "synthetic.legacy", payload: { historical: "unchanged" } })
  const legacy = (await f.events())[0]
  const before = Date.now()
  queries.length = 0
  const result = await initializeAuditPilot(f.db, validatePilotConfig({ ...f.config, categories: [], operatorReference: "internal-123" }), true)
  const after = Date.now()
  assert.equal(result.initialized, true)
  const locks = queries.filter((query) => /for update/i.test(query))
  assert.match(locks[0], /organization/)
  assert.match(locks[1], /audit_state/)
  assert.match(locks[2], /audit_policy/)
  const policy = await readAuditPolicy(f.db, f.organizationId)
  assert.ok(policy)
  assert.equal(policy.revision, 1)
  assert.equal(policy.enabled, true)
  assert.deepEqual(policy.categories, ["lifecycle"])
  assert.ok(Date.parse(policy.effectiveAt) >= before && Date.parse(policy.effectiveAt) <= after)
  const rows = await f.events()
  assert.deepEqual(rows.find((row) => row.id === legacyId), legacy)
  const row = rows.find((row) => row.envelope)
  assert.ok(row?.envelope)
  const event = row.envelope
  assert.equal(row.actor_user_id, null)
  assert.equal(event.action, "audit.policy.enabled")
  assert.equal(event.category, "lifecycle")
  assert.equal(event.outcome, "succeeded")
  assert.deepEqual(event.actor, { type: "system", id: "den-api.audit-pilot:internal-123" })
  assert.deepEqual(event.operation.initiatingActor, event.actor)
  assert.equal(event.operation.originTrust, "reported")
  assert.equal(event.requestId, null)
  assert.equal(event.changes?.before, null)
  assert.deepEqual(event.changes?.after, {
    organizationId: f.organizationId, revision: 1, enabled: true, source: policy.source, categories: ["lifecycle"],
    allowance: policy.allowance, excessMode: policy.excessMode, effectiveAt: policy.effectiveAt, attachmentWindowSeconds: policy.attachmentWindowSeconds,
  })
  assert.equal(policy.captureStartedAt, event.recordedAt)
  const state = await f.state()
  assert.equal(state.retained_operations, 1)
  assert.equal(state.event_count, 1)
  assert.equal(state.last_sequence, 1)
  assert.equal(state.logical_bytes, event.logicalBytes)
  assert.equal((await f.db.select().from(AuditUsageFactTable).where(eq(AuditUsageFactTable.organization_id, f.organizationId))).length, 1)
  assert.equal((await f.db.select().from(AuditEventResourceTable).where(eq(AuditEventResourceTable.organization_id, f.organizationId))).length, 2)
})

dbTest("every existing policy is rejected unchanged, including disabled, future, paid and keep-all policies", async () => {
  for (const settings of [
    { enabled: false, revision: 1, excess_mode: "keep_all", effective_at: new Date() },
    { enabled: true, revision: 12, excess_mode: "delete_oldest", effective_at: new Date(Date.now() + 60000) },
    { enabled: true, revision: 3, excess_mode: "paid_overage", effective_at: new Date() },
  ] satisfies Array<Pick<typeof AuditPolicyTable.$inferInsert, "enabled" | "revision" | "excess_mode" | "effective_at">>) {
    const f = await fixture()
    await f.db.insert(AuditPolicyTable).values({ organization_id: f.organizationId, source: "operator", categories: ["read"], allowance: 1000, attachment_window_seconds: 300, ...settings })
    const original = await readAuditPolicy(f.db, f.organizationId)
    for (const apply of [false, true]) await assert.rejects(initializeAuditPilot(f.db, validatePilotConfig({ ...f.config, allowance: 0, excessMode: "delete_oldest" }), apply), code("audit_pilot_policy_exists"))
    assert.deepEqual(await readAuditPolicy(f.db, f.organizationId), original)
    assert.equal(await f.state(), undefined)
    assert.deepEqual(await f.events(), [])
  }
})

dbTest("required append insert failure rolls back policy/state/operation/facts atomically", async () => {
  const f = await fixture()
  await f.db.insert(AuditEventTable).values({ id: createDenTypeId("auditEvent"), org_id: f.organizationId, sequence: 1, action: "synthetic.sequence_conflict" })
  await assert.rejects(initializeAuditPilot(f.db, f.config, true))
  assert.equal(await readAuditPolicy(f.db, f.organizationId), null)
  assert.equal(await f.state(), undefined)
  assert.equal((await f.events()).length, 1)
  assert.equal((await f.db.select().from(AuditOperationTable).where(eq(AuditOperationTable.organization_id, f.organizationId))).length, 0)
  assert.equal((await f.db.select().from(AuditUsageFactTable).where(eq(AuditUsageFactTable.organization_id, f.organizationId))).length, 0)
})

dbTest("concurrent initializers converge to one revision/event; the loser rejects rather than updating", async () => {
  const f = await fixture()
  const results = await Promise.allSettled([initializeAuditPilot(f.db, f.config, true), initializeAuditPilot(f.db, f.config, true)])
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  for (const result of results) if (result.status === "rejected") assert.ok(code("audit_pilot_policy_exists")(result.reason))
  assert.equal((await f.events()).length, 1)
  assert.equal((await f.state()).retained_operations, 1)
})

dbTest("CLI outputs only safe status with flags false and default dry-run; apply is explicit", async () => {
  const f = await fixture()
  const output: string[] = []
  const errors: string[] = []
  let closes = 0
  const runtime = async () => ({ database: f.db, flags: { auditCaptureEnabled: false, auditVisibilityEnabled: false }, close: async () => { closes++ } })
  const args = ["--org-id", f.organizationId, "--source", "operator", "--allowance", "100", "--attachment-window-seconds", "300", "--excess-mode", "keep_all"]
  const io = { out: (text: string) => output.push(text), error: (text: string) => errors.push(text) }
  assert.equal(await runAuditPilot(args, io, runtime), 0)
  assert.equal(await readAuditPolicy(f.db, f.organizationId), null)
  assert.equal(await runAuditPilot([...args, "--apply"], io, runtime), 0)
  assert.equal(await runAuditPilot([...args, "--apply"], io, runtime), 1)
  assert.equal(closes, 3)
  assert.deepEqual(errors, ["audit_pilot_policy_exists"])
  assert.ok(output[0].includes('"initialized": false'))
  assert.ok(output[1].includes('"initialized": true'))
  assert.ok(output.every((value) => value.includes('"auditCaptureEnabled": false') && value.includes('"auditVisibilityEnabled": false')))
  assert.equal(output.join("").includes("mysql:"), false)
})

dbTest("retention preview is read-only, uses share-lock order and never counts or changes legacy rows", async () => {
  const f = await fixture()
  await initializeAuditPilot(f.db, validatePilotConfig({ ...f.config, allowance: 0, excessMode: "delete_oldest" }), true)
  await f.db.insert(AuditEventTable).values({ id: createDenTypeId("auditEvent"), org_id: f.organizationId, action: "synthetic.legacy" })
  const original = await f.events()
  queries.length = 0
  const protectedPreview = await previewPilotRetention(f.db, f.organizationId)
  const locks = queries.filter((query) => /for share/i.test(query))
  assert.match(locks[0], /organization/)
  assert.match(locks[1], /audit_state/)
  assert.match(locks[2], /audit_policy/)
  assert.ok(queries.some((query) => /audit_operation.*limit \?.*for share/i.test(query)))
  assert.equal(queries.some((query) => /^\s*(?:insert|update|delete)/i.test(query)), false)
  assert.equal(protectedPreview.preview.retainedOperations, 1)
  assert.equal(protectedPreview.preview.protectedCount, 1)
  assert.equal(protectedPreview.preview.candidateCount, 0)
  await f.db.update(AuditOperationTable).set({ attachment_expires_at: new Date(Date.now() - 1000) }).where(eq(AuditOperationTable.organization_id, f.organizationId))
  const expired = await previewPilotRetention(f.db, f.organizationId)
  assert.equal(expired.preview.candidateCount, 1)
  assert.equal(expired.preview.deletionEnabled, false)
  assert.equal(isAuditRetentionConfirmationCurrent(expired.preview, expired.confirmation), true)
  assert.equal(isAuditRetentionConfirmationCurrent(expired.preview, protectedPreview.confirmation), false)
  assert.equal(expired.confirmationIsInformationalOnly, true)
  assert.deepEqual(await f.events(), original)
  assert.equal((await f.state()).retained_operations, 1)
  await f.db.update(AuditPolicyTable).set({ excess_mode: "keep_all" }).where(eq(AuditPolicyTable.organization_id, f.organizationId))
  assert.equal((await previewPilotRetention(f.db, f.organizationId)).preview.candidateCount, 0)
})

dbTest("preview waits for an uncommitted appender state lock and sees one coherent committed snapshot", async () => {
  const f = await fixture()
  await initializeAuditPilot(f.db, f.config, true)
  const policy = await readAuditPolicy(f.db, f.organizationId)
  assert.ok(policy)
  const holding = deferred()
  const release = deferred()
  const writer = f.db.transaction(async (tx) => {
    await appendAuditEvent(tx, { policy, context: { organizationId: f.organizationId, actor: { type: "system", id: "synthetic-writer" }, principalKey: "synthetic-writer", kind: "audit.policy", scope: f.organizationId, origin: "platform_admin", originTrust: "reported", requestId: null }, event: { action: "synthetic.observed", category: "lifecycle", outcome: "unknown", resources: [] } })
    holding.resolve()
    await release.promise
  })
  await holding.promise
  let finished = false
  const pending = previewPilotRetention(f.db, f.organizationId).then((result) => { finished = true; return result })
  try { await delay(100); assert.equal(finished, false) } finally { release.resolve() }
  await writer
  assert.equal((await pending).preview.retainedOperations, 2)
})

dbTest("missing policy/state, unknown work and incoherent projections fail preview explicitly", async () => {
  const f = await fixture()
  await assert.rejects(previewPilotRetention(f.db, f.organizationId), code("audit_pilot_policy_missing"))
  await initializeAuditPilot(f.db, f.config, true)
  await f.db.update(AuditStateTable).set({ retained_operations: 2 }).where(eq(AuditStateTable.organization_id, f.organizationId))
  await assert.rejects(previewPilotRetention(f.db, f.organizationId), code("audit_pilot_retention_incomplete_snapshot"))
  await f.db.update(AuditStateTable).set({ retained_operations: 1 }).where(eq(AuditStateTable.organization_id, f.organizationId))
  await f.db.update(AuditOperationTable).set({ kind: "future.trusted_job" }).where(eq(AuditOperationTable.organization_id, f.organizationId))
  await assert.rejects(previewPilotRetention(f.db, f.organizationId), code("audit_pilot_retention_incomplete_snapshot"))
  await f.db.update(AuditPolicyTable).set({ excess_mode: "paid_overage" }).where(eq(AuditPolicyTable.organization_id, f.organizationId))
  await assert.rejects(previewPilotRetention(f.db, f.organizationId), code("audit_pilot_retention_unsupported_policy"))
})

dbTest("10000-operation snapshot is bounded/exact; 10001 errors before loading operations, never approximates", async () => {
  const f = await fixture()
  await initializeAuditPilot(f.db, validatePilotConfig({ ...f.config, allowance: 0, excessMode: "delete_oldest" }), true)
  const old = new Date(Date.now() - 60000)
  await f.db.update(AuditOperationTable).set({ attachment_expires_at: old }).where(eq(AuditOperationTable.organization_id, f.organizationId))
  for (let start = 1; start < 10000; start += 500) {
    await f.db.insert(AuditOperationTable).values(Array.from({ length: Math.min(500, 10000 - start) }, () => ({
      id: createDenTypeId("auditOperation"), organization_id: f.organizationId, binding_key: randomUUID(),
      kind: "audit.access", scope: "synthetic", principal_key: "synthetic", initiating_actor: { type: "system", id: "synthetic" },
      origin: "api", origin_trust: "reported", first_recorded_at: old, attachment_expires_at: old, event_count: 1,
    } satisfies typeof AuditOperationTable.$inferInsert)))
  }
  await f.db.update(AuditStateTable).set({ retained_operations: 10000 }).where(eq(AuditStateTable.organization_id, f.organizationId))
  const result = await previewPilotRetention(f.db, f.organizationId)
  assert.equal(result.preview.retainedOperations, 10000)
  assert.equal(result.preview.candidateCount, 1000)
  assert.equal(result.preview.selectionComplete, false)
  assert.equal(result.preview.remainingEligibleDeletions, 9000)
  await f.db.update(AuditStateTable).set({ retained_operations: 10001 }).where(eq(AuditStateTable.organization_id, f.organizationId))
  queries.length = 0
  await assert.rejects(previewPilotRetention(f.db, f.organizationId), code("audit_pilot_retention_incomplete_snapshot"))
  assert.equal(queries.some((query) => /from `audit_operation`/i.test(query)), false)
})
