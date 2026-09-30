import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { AuditLogError, appendAuditEvent, auditOperationBinding, canonicalAuditJson, MAX_AUDIT_EVENT_BYTES, type AuditContext, type AuditEventInput, type AuditPolicy, type AuditTx } from "../src/audit-log"

function context(): AuditContext {
  const userId = createDenTypeId("user")
  const providerId = createDenTypeId("inferenceProvider")
  return { organizationId: createDenTypeId("organization"), actor: { type: "user", id: userId }, principalKey: `user:${userId}`, origin: "api", originTrust: "authenticated", requestId: createDenTypeId("request"), correlationId: randomUUID(), kind: "provider.configuration", scope: providerId, workflowStep: "update", workflowStepScope: providerId }
}
function policy(organizationId: string): AuditPolicy {
  return { organizationId, revision: 1, source: "operator", enabled: true, categories: ["change"], allowance: 100, excessMode: "keep_all", effectiveAt: "2026-01-01T00:00:00.000Z", captureStartedAt: null, attachmentWindowSeconds: 300 }
}
const event: AuditEventInput = { action: "provider.updated", category: "change", outcome: "succeeded", resources: [] }
const invalid = (error: unknown) => error instanceof AuditLogError && error.code === "audit_invalid_input"
const oversized = (error: unknown) => error instanceof AuditLogError && error.code === "audit_evidence_too_large"

test("binding joins valid UUID hints but isolates tenant, principal, workflow and scope", () => {
  const first = context()
  const key = auditOperationBinding(first)
  assert.match(key, /^[0-9a-f]{64}$/)
  assert.equal(auditOperationBinding({ ...first, requestId: createDenTypeId("request") }), key)
  assert.equal(auditOperationBinding({ ...first, correlationId: first.correlationId?.toUpperCase() }), key)
  for (const next of [
    { ...first, organizationId: createDenTypeId("organization") },
    { ...first, principalKey: `${first.principalKey}:credential:other` },
    { ...first, kind: "audit.access" },
    { ...first, scope: createDenTypeId("inferenceProvider") },
    { ...first, correlationId: randomUUID() },
  ]) assert.notEqual(auditOperationBinding(next), key)
})

test("invalid hints fall back to request identity and cannot become an unbounded binding", () => {
  const first = context()
  const key = auditOperationBinding(first, false)
  for (const correlationId of [null, "", "not-a-uuid", "0".repeat(36), "x".repeat(100000)]) {
    assert.equal(auditOperationBinding({ ...first, correlationId }), key)
    assert.notEqual(auditOperationBinding({ ...first, correlationId, requestId: createDenTypeId("request") }), key)
  }
  assert.throws(() => auditOperationBinding({ ...first, kind: "arbitrary.workflow" }), invalid)
})

test("only registered provider steps with valid resource scopes can use client grouping", () => {
  const first = context()
  const requestKey = auditOperationBinding(first, false)
  for (const change of [
    { workflowStep: undefined }, { workflowStep: "client-invented" }, { workflowStepScope: undefined },
    { workflowStepScope: createDenTypeId("inferenceProvider") },
    { workflowStep: "group.update", workflowStepScope: `${first.scope}/model-groups/${createDenTypeId("gatewayCredentialSet")}` },
    { workflowStep: "set.update", workflowStepScope: `${first.scope}/credential-sets/not-a-resource` },
    { workflowStep: "grant.update", workflowStepScope: `${first.scope}/access-grants/${createDenTypeId("inferenceProviderAccess")}/extra` },
    { workflowStepScope: "x".repeat(100000) },
  ]) assert.equal(auditOperationBinding({ ...first, ...change }), requestKey)
  for (const kind of ["audit.access", "audit.policy"]) {
    const context = { ...first, kind }
    assert.equal(auditOperationBinding(context), auditOperationBinding(context, false))
    assert.notEqual(auditOperationBinding(context), auditOperationBinding({ ...context, requestId: createDenTypeId("request") }))
  }
  const job = { ...first, jobRunId: createDenTypeId("automationRun") }
  assert.equal(auditOperationBinding(job), auditOperationBinding(job, false))
  assert.notEqual(auditOperationBinding({ ...first, workflowStep: "group.update", workflowStepScope: `${first.scope}/model-groups/${createDenTypeId("gatewayModelGroup")}` }), requestKey)
})

test("grant target claims accept only exact typed provider/group/set/audience tuples", () => {
  const first = context()
  const groupId = createDenTypeId("gatewayModelGroup")
  const setId = createDenTypeId("gatewayCredentialSet")
  const memberId = createDenTypeId("member")
  const teamId = createDenTypeId("team")
  const prefix = `${first.scope}/grant-target/${groupId}/${setId}`
  const target = { ...first, workflowStep: "grant.create" }
  const shared = auditOperationBinding(first)
  for (const audience of [`organization/${first.organizationId}`, `member/${memberId}`, `team/${teamId}`]) {
    assert.equal(auditOperationBinding({ ...target, workflowStepScope: `${prefix}/${audience}` }), shared)
  }
  for (const scope of [
    first.scope, `${prefix}/organization/${createDenTypeId("organization")}`, `${prefix}/organization/${memberId}`,
    `${prefix}/member/${teamId}`, `${prefix}/team/${memberId}`, `${prefix}/arbitrary/${memberId}`,
    `${prefix}/member/${memberId}/extra`, `${prefix}/member/`, `${prefix}/member/Bearer synthetic-secret`,
    `${first.scope}/grant-target/${setId}/${groupId}/member/${memberId}`,
    `${first.scope}/grant-target/not-a-group/${setId}/member/${memberId}`,
    `${createDenTypeId("inferenceProvider")}/grant-target/${groupId}/${setId}/member/${memberId}`,
    "client-provided-step-hash",
  ]) assert.equal(auditOperationBinding({ ...target, workflowStepScope: scope }), auditOperationBinding(target, false))
})

test("unknown actors do not group independent requests using the same UUID", () => {
  const first: AuditContext = { ...context(), actor: { type: "unknown", id: null }, principalKey: "unknown" }
  assert.notEqual(auditOperationBinding(first), auditOperationBinding({ ...first, requestId: createDenTypeId("request") }))
})

test("job-only identities are run-scoped and standalone events cannot share a perpetual identity", () => {
  const first: AuditContext = { ...context(), correlationId: null, requestId: null, actor: { type: "system", id: "scheduler" }, jobRunId: createDenTypeId("automationRun") }
  assert.equal(auditOperationBinding(first), auditOperationBinding(first))
  assert.notEqual(auditOperationBinding(first), auditOperationBinding({ ...first, jobRunId: createDenTypeId("automationRun") }))
  const standalone = { ...first, jobRunId: undefined }
  assert.notEqual(auditOperationBinding(standalone), auditOperationBinding(standalone))
})

test("disabled policy and excluded categories touch neither transaction nor evidence", async () => {
  const noDatabase = new Proxy({}, { get() { throw new Error("database must not be touched") } }) as AuditTx
  const input = { ...event }
  Object.defineProperty(input, "changes", { get() { throw new Error("evidence must not be read") } })
  const actor = context()
  assert.equal(await appendAuditEvent(noDatabase, { context: actor, policy: { ...policy(actor.organizationId), enabled: false }, event: input }), null)
  assert.equal(await appendAuditEvent(noDatabase, { context: actor, policy: { ...policy(actor.organizationId), categories: ["security"] }, event: input }), null)
})

test("canonical JSON is stable, UTF-8 measured and preserves null evidence", () => {
  assert.equal(canonicalAuditJson({ z: [false, null], a: { c: "café", b: 1 } }), '{"a":{"b":1,"c":"café"},"z":[false,null]}')
  const json = canonicalAuditJson({ name: "café" })
  assert.equal(Buffer.byteLength(json, "utf8"), json.length + 1)
  assert.equal(canonicalAuditJson(null, true), "null")
  assert.equal(canonicalAuditJson({ hasApiKey: true, credentialChanged: true, credentialMode: "org" }, true), '{"credentialChanged":true,"credentialMode":"org","hasApiKey":true}')
})

test("evidence rejects secret fields at any nesting level and never echoes rejected values", () => {
  for (const value of [
    { apiKey: "synthetic-secret" }, { nested: [{ refresh_token: "synthetic-secret" }] },
    { headers: { Authorization: "synthetic-secret" } }, { oauth: { client_secret: "synthetic-secret" } },
    { value: "Bearer synthetic-secret" }, { value: "enc:v1:synthetic-secret" },
    { value: "https://user:synthetic-secret@example.test/" }, { prompt: "synthetic-secret" },
  ]) assert.throws(() => canonicalAuditJson(value, true), (error: unknown) => invalid(error) && error instanceof Error && !error.message.includes("synthetic-secret"))
})

test("serialization rejects cycles, accessors, custom serializers, sparse arrays and non-JSON values", () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  let invoked = false
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { invoked = true; return "unsafe" } })
  for (const value of [cycle, accessor, { toJSON() { invoked = true; return "unsafe" } }, new Date(), [undefined], { value: undefined }, { value: Infinity }, { value: NaN }, { value: 1n }, new Array(2), JSON.parse('{"__proto__":{"unsafe":true}}')]) {
    assert.throws(() => canonicalAuditJson(value), invalid)
  }
  assert.equal(invoked, false)
})

test("bounded serializer rejects oversized bytes, depth and cardinality instead of truncating", () => {
  assert.throws(() => canonicalAuditJson({ value: "x".repeat(MAX_AUDIT_EVENT_BYTES) }), oversized)
  assert.throws(() => canonicalAuditJson({ values: Array.from({ length: 10 }, () => "界".repeat(10000)) }), oversized)
  assert.throws(() => canonicalAuditJson(Array(2049).fill(null)), oversized)
  let deep: unknown = "leaf"
  for (let i = 0; i < 18; i++) deep = { value: deep }
  assert.throws(() => canonicalAuditJson(deep), oversized)
})
