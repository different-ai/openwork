import { createHash, randomUUID } from "node:crypto"
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { createDenDb } from "./client"
import { auditEventEnvelopeSchema, type AuditActor, type AuditCategory, type AuditEventEnvelope, type AuditPolicy } from "@openwork/types/den/audit"
export type { AuditActor, AuditCategory, AuditEventEnvelope, AuditPolicy } from "@openwork/types/den/audit"
import { AuditEventResourceTable, AuditOperationStepTable, AuditOperationTable, AuditPolicyTable, AuditStateTable, AuditUsageFactTable, PlatformAuditEventTable } from "./schema/audit"
import { AuditEventTable } from "./schema/workers"

export type AuditDatabase = ReturnType<typeof createDenDb>["db"]
export type AuditTx = Parameters<Parameters<AuditDatabase["transaction"]>[0]>[0]
export type AuditOrigin = "api" | "cloud_ui" | "mcp" | "scheduler" | "webhook" | "platform_admin"
export type AuditContext = {
  organizationId: string
  actor: AuditActor
  principalKey: string
  initiatingActor?: AuditActor
  origin: AuditOrigin
  originTrust: "authenticated" | "reported"
  requestId: string | null
  correlationId?: string | null
  kind: string
  scope: string
  workflowStep?: string
  workflowStepScope?: string
  jobRunId?: string
  causedByEventId?: string
}
export type AuditEventInput = {
  action: string
  category: AuditCategory
  outcome: "succeeded" | "failed" | "denied" | "unknown"
  resources: Array<{ type: string; id: string; relationship: "target" | "parent" | "related"; label?: string }>
  changes?: { before: Record<string, unknown> | null; after: Record<string, unknown> | null; changedFields: string[] }
  reasonCode?: string
  idempotencyKey?: string
  /** Request template context; route is the registered template, never the concrete URL. */
  http?: AuditHttpContext
}
export type AuditHttpContext = { method: string; route: string; status?: number }

export const MAX_AUDIT_EVENT_BYTES = 262_144
const categories: AuditCategory[] = ["change", "security", "execution", "access", "read", "request", "lifecycle"]
// Operation kinds are declared by den-api's route/domain registries; storage only
// enforces their shape. Workflow correlation stays limited to AUDIT_WORKFLOW_REGISTRY.
const kindPattern = /^[a-z][a-z0-9_.-]{0,127}$/
const origins: AuditOrigin[] = ["api", "cloud_ui", "mcp", "scheduler", "webhook", "platform_admin"]
export const AUDIT_WORKFLOW_REGISTRY = {
  "provider.configuration": {
    status: "pilot",
    charging: "disabled",
    maximumStepClaims: 128,
    maximumRequestsPerStepScope: 1,
    claimPolicy: "Accepted client grouping persists one claim per workflow step and resource scope. Request-bound fallbacks cannot accept other requests and do not consume shared claims.",
    scopeAuthority: "Verified provider ID, validated route IDs and allowlisted validated grant-target identities, never client workflow metadata or hashes.",
    fallback: "Missing/invalid steps or scopes, repeated resource steps from a different request, exhausted step claims, and expired hints use a request-bound operation. Every event for that request reuses its fallback. No record is dropped.",
    createScope: "Group and credential-set creates conservatively claim the provider scope once per step; further creates use request operations. Grant creates claim provider/group/set/audience-kind/typed-audience-id targets derived after request validation; organization audiences use the authenticated organization ID.",
    lateJobs: "Not supported by client grouping; job contexts ignore correlation hints.",
    steps: {
      create: "provider", update: "provider", delete: "provider",
      "models.enable": "provider",
      "group.create": "provider", "group.update": "model-groups", "group.delete": "model-groups",
      "set.create": "provider", "set.update": "credential-sets", "set.delete": "credential-sets",
      "grant.create": "grant-target", "grant.update": "access-grants", "grant.delete": "access-grants",
      "catalog.refresh": "provider",
    },
  },
} satisfies Record<string, { status: string; charging: string; maximumStepClaims: number; maximumRequestsPerStepScope: 1; claimPolicy: string; scopeAuthority: string; fallback: string; createScope: string; lateJobs: string; steps: Record<string, "provider" | "model-groups" | "credential-sets" | "access-grants" | "grant-target"> }>
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sensitiveKey = /^(?:api[-_]?keys?|(?:client[-_]?)?secrets?|passwords?|private[-_]?keys?|access[-_]?tokens?|refresh[-_]?tokens?|tokens?|authorization|cookies?|set-cookie|headers?|body|prompt|messages|ciphertext)$/i

export class AuditLogError extends Error {
  constructor(readonly code: "audit_invalid_input" | "audit_evidence_too_large" | "audit_policy_changed" | "audit_policy_not_configured" | "audit_operation_unavailable" | "audit_idempotency_mismatch" | "audit_counter_overflow" | "audit_storage_inconsistent") {
    super(code)
    this.name = "AuditLogError"
  }
}

function fail(): never { throw new AuditLogError("audit_invalid_input") }
function text(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail()
}
function integer(value: number, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail()
  return value
}
function add(left: number, right: number) {
  if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0 || !Number.isSafeInteger(left + right)) throw new AuditLogError("audit_counter_overflow")
  return left + right
}
function digest(value: string) { return createHash("sha256").update(value, "utf8").digest("hex") }

export function canonicalAuditJson(value: unknown, checkEvidence = false): string {
  const seen = new Set<object>()
  let nodes = 0
  let bytes = 0
  const charge = (value: string) => {
    bytes += Buffer.byteLength(value, "utf8")
    if (bytes > MAX_AUDIT_EVENT_BYTES) throw new AuditLogError("audit_evidence_too_large")
    return value
  }
  function visit(value: unknown, depth: number): string {
    if (++nodes > 16_384 || depth > 16) throw new AuditLogError("audit_evidence_too_large")
    if (value === null) return charge("null")
    if (typeof value === "boolean") return charge(String(value))
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail()
      return charge(JSON.stringify(value))
    }
    if (typeof value === "string") {
      if (value.length > 65_536) throw new AuditLogError("audit_evidence_too_large")
      if (checkEvidence && (/(?:\bBearer\s+|\bBasic\s+|-----BEGIN [A-Z ]*PRIVATE KEY-----|enc:v1:)/i.test(value) || /https?:\/\/[^\s/]+@/i.test(value))) fail()
      return charge(JSON.stringify(value))
    }
    if (typeof value !== "object" || seen.has(value)) fail()
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        if (value.length > 2048) throw new AuditLogError("audit_evidence_too_large")
        const entries: string[] = []
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
          if (!descriptor || !("value" in descriptor)) fail()
          entries.push(visit(descriptor.value, depth + 1))
        }
        charge("[]" + ",".repeat(Math.max(0, entries.length - 1)))
        return `[${entries.join(",")}]`
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail()
      if (Object.getOwnPropertySymbols(value).length) fail()
      const keys = Object.getOwnPropertyNames(value).sort()
      if (keys.length > 2048) throw new AuditLogError("audit_evidence_too_large")
      const entries: string[] = []
      for (const key of keys) {
        if (["__proto__", "constructor", "prototype", "toJSON"].includes(key) || checkEvidence && sensitiveKey.test(key)) fail()
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor?.enumerable || !("value" in descriptor)) fail()
        entries.push(`${charge(JSON.stringify(key) + ":")}${visit(descriptor.value, depth + 1)}`)
      }
      charge("{}" + ",".repeat(Math.max(0, entries.length - 1)))
      return `{${entries.join(",")}}`
    } finally { seen.delete(value) }
  }
  return visit(value, 0)
}

function actor(input: AuditActor): AuditActor {
  if (!["user", "service", "system", "unknown"].includes(input.type)) fail()
  if (input.id !== null) text(input.id, 255)
  if (input.type !== "unknown" && input.id === null) fail()
  if (input.type === "user" && input.id !== null) normalizeDenTypeId("user", input.id)
  if (input.memberId !== undefined) normalizeDenTypeId("member", input.memberId)
  if (input.credentialId !== undefined) text(input.credentialId, 255)
  return { type: input.type, id: input.id, ...(input.memberId === undefined ? {} : { memberId: input.memberId }), ...(input.credentialId === undefined ? {} : { credentialId: input.credentialId }) }
}

function validateContext(context: AuditContext) {
  const organizationId = normalizeDenTypeId("organization", context.organizationId)
  if (typeof context.kind !== "string" || !kindPattern.test(context.kind)) fail()
  text(context.principalKey, 512)
  text(context.scope, 512)
  if (!origins.includes(context.origin) || !["authenticated", "reported"].includes(context.originTrust)) fail()
  if (context.requestId !== null) text(context.requestId, 128)
  if (context.jobRunId !== undefined) text(context.jobRunId, 128)
  if (context.causedByEventId !== undefined) normalizeDenTypeId("auditEvent", context.causedByEventId)
  return { organizationId, actor: actor(context.actor), initiatingActor: actor(context.initiatingActor ?? context.actor) }
}

function policyValue(row: typeof AuditPolicyTable.$inferSelect): AuditPolicy {
  const value: AuditPolicy = {
    organizationId: row.organization_id,
    revision: row.revision,
    source: row.source,
    enabled: row.enabled,
    categories: row.categories,
    allowance: row.allowance,
    excessMode: row.excess_mode,
    effectiveAt: row.effective_at.toISOString(),
    captureStartedAt: row.capture_started_at?.toISOString() ?? null,
    attachmentWindowSeconds: row.attachment_window_seconds,
  }
  validatePolicy(value)
  return value
}
function validatePolicy(policy: AuditPolicy) {
  normalizeDenTypeId("organization", policy.organizationId)
  integer(policy.revision, 1, 4_294_967_295)
  integer(policy.allowance)
  integer(policy.attachmentWindowSeconds, 1, 86_400)
  if (!["cloud", "operator"].includes(policy.source) || !["delete_oldest", "paid_overage", "keep_all"].includes(policy.excessMode) || typeof policy.enabled !== "boolean") fail()
  if (!Array.isArray(policy.categories) || policy.categories.length > categories.length || new Set(policy.categories).size !== policy.categories.length || policy.categories.some((value) => !categories.includes(value))) fail()
  if (!Number.isFinite(Date.parse(policy.effectiveAt)) || policy.captureStartedAt !== null && !Number.isFinite(Date.parse(policy.captureStartedAt))) fail()
}
function policyIdentity(policy: AuditPolicy) {
  return canonicalAuditJson({ organizationId: policy.organizationId, revision: policy.revision, source: policy.source, enabled: policy.enabled, categories: [...policy.categories].sort(), allowance: policy.allowance, excessMode: policy.excessMode, effectiveAt: new Date(policy.effectiveAt).toISOString(), attachmentWindowSeconds: policy.attachmentWindowSeconds })
}

export async function readAuditPolicy(database: AuditDatabase | AuditTx, organizationId: string): Promise<AuditPolicy | null> {
  const [row] = await database.select().from(AuditPolicyTable).where(eq(AuditPolicyTable.organization_id, normalizeDenTypeId("organization", organizationId))).limit(1)
  return row ? policyValue(row) : null
}

function workflowClaim(context: AuditContext) {
  if (context.kind !== "provider.configuration" || !context.requestId || context.jobRunId || context.actor.type === "unknown" || context.actor.id === null || typeof context.correlationId !== "string" || !uuid.test(context.correlationId)) return null
  const workflow = AUDIT_WORKFLOW_REGISTRY[context.kind]
  const rule = Object.entries(workflow.steps).find(([step]) => step === context.workflowStep)
  if (!rule || typeof context.workflowStepScope !== "string" || context.workflowStepScope.length > 512) return null
  const [step, resource] = rule
  const scope = context.workflowStepScope
  try {
    if (normalizeDenTypeId("inferenceProvider", context.scope) !== context.scope) return null
    if (resource === "provider") {
      if (scope !== context.scope) return null
    } else if (resource === "grant-target") {
      const [providerId, collection, groupId, setId, audienceKind, audienceId, extra] = scope.split("/")
      if (providerId !== context.scope || collection !== "grant-target" || !groupId || !setId || !audienceId || extra !== undefined) return null
      if (normalizeDenTypeId("gatewayModelGroup", groupId) !== groupId || normalizeDenTypeId("gatewayCredentialSet", setId) !== setId) return null
      if (audienceKind === "organization") {
        if (normalizeDenTypeId("organization", audienceId) !== audienceId || audienceId !== context.organizationId) return null
      } else if (audienceKind === "member" || audienceKind === "team") {
        if (normalizeDenTypeId(audienceKind, audienceId) !== audienceId) return null
      } else return null
    } else {
      const [providerId, collection, resourceId, extra] = scope.split("/")
      if (providerId !== context.scope || collection !== resource || !resourceId || extra !== undefined) return null
      const type = resource === "model-groups" ? "gatewayModelGroup" : resource === "credential-sets" ? "gatewayCredentialSet" : "inferenceProviderAccess"
      if (normalizeDenTypeId(type, resourceId) !== resourceId) return null
    }
  } catch { return null }
  return { step, scope, hash: digest(canonicalAuditJson([step, scope])), maximum: workflow.maximumStepClaims, requestId: context.requestId }
}

export function auditOperationBinding(context: AuditContext, useCorrelation = true): string {
  validateContext(context)
  const hint = useCorrelation && workflowClaim(context)
    ? ["correlation", context.correlationId?.toLowerCase()]
    : context.requestId ? ["request", context.requestId] : context.jobRunId ? ["job", context.jobRunId] : ["standalone", randomUUID()]
  return digest(canonicalAuditJson([context.organizationId, context.principalKey, context.kind, context.scope, hint]))
}

function httpValue(input: AuditHttpContext): AuditHttpContext {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail()
  if (typeof input.method !== "string" || !/^[A-Z]{1,16}$/.test(input.method)) fail()
  text(input.route, 512)
  if (input.status !== undefined) integer(input.status, 100, 599)
  return { method: input.method, route: input.route, ...(input.status === undefined ? {} : { status: input.status }) }
}

function eventValue(input: AuditEventInput): Omit<AuditEventInput, "idempotencyKey"> {
  text(input.action, 128)
  if (!/^[a-z][a-z0-9_.-]*$/.test(input.action) || !categories.includes(input.category) || !["succeeded", "failed", "denied", "unknown"].includes(input.outcome)) fail()
  if (!Array.isArray(input.resources) || input.resources.length > 256) throw new AuditLogError("audit_evidence_too_large")
  const resources = input.resources.map((resource) => {
    text(resource.type, 64)
    text(resource.id, 255)
    if (!/^[a-z][a-z0-9_.-]*$/.test(resource.type) || !["target", "parent", "related"].includes(resource.relationship)) fail()
    if (resource.label !== undefined) text(resource.label, 255)
    return { type: resource.type, id: resource.id, relationship: resource.relationship, ...(resource.label === undefined ? {} : { label: resource.label }) }
  }).sort((a, b) => {
    const left = canonicalAuditJson(a)
    const right = canonicalAuditJson(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
  if (new Set(resources.map((resource) => canonicalAuditJson([resource.type, resource.id, resource.relationship]))).size !== resources.length) fail()
  if (input.reasonCode !== undefined && !/^[a-z][a-z0-9_.-]{0,127}$/.test(input.reasonCode)) fail()
  let changes: AuditEventInput["changes"]
  if (input.changes) {
    if (!Array.isArray(input.changes.changedFields) || input.changes.changedFields.length > 256) fail()
    const changedFields = [...new Set(input.changes.changedFields)].sort()
    for (const field of changedFields) text(field, 255)
    for (const snapshot of [input.changes.before, input.changes.after]) {
      if (snapshot !== null && (typeof snapshot !== "object" || Array.isArray(snapshot))) fail()
      canonicalAuditJson(snapshot, true)
    }
    const snapshotCopy = (snapshot: Record<string, unknown> | null): Record<string, unknown> | null => {
      const copy: unknown = JSON.parse(canonicalAuditJson(snapshot, true))
      if (copy === null) return null
      if (typeof copy !== "object" || Array.isArray(copy)) return fail()
      return Object.fromEntries(Object.entries(copy))
    }
    changes = { before: snapshotCopy(input.changes.before), after: snapshotCopy(input.changes.after), changedFields }
  }
  const http = input.http === undefined ? undefined : httpValue(input.http)
  const event = { action: input.action, category: input.category, outcome: input.outcome, resources, ...(changes ? { changes } : {}), ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }), ...(http ? { http } : {}) }
  canonicalAuditJson(event)
  return event
}

// Audit writes never lock rows: no per-organization counter or sequence is
// maintained on the write path. Events are ordered by their time-ordered
// TypeID; tenant totals (audit_state) are recomputed by refreshAuditUsageCounts
// on a schedule. A policy change racing an append can let one event through
// just after capture turns off (or miss one just after it turns on).

/**
 * A stored envelope as the current schema. Version 1 envelopes carried a
 * per-organization sequence; it is dropped and they are served as version 2.
 */
export function parseStoredAuditEnvelope(value: unknown): AuditEventEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const entries = Object.entries(value)
  const legacy = entries.some(([key, version]) => key === "schemaVersion" && version === 1)
  const current = legacy ? Object.fromEntries([...entries.filter(([key]) => key !== "sequence" && key !== "schemaVersion"), ["schemaVersion", 2]]) : value
  const parsed = auditEventEnvelopeSchema.safeParse(current)
  return parsed.success ? parsed.data : null
}

function affectedRows(result: unknown): number | null {
  if (Array.isArray(result)) return affectedRows(result[0])
  if (typeof result !== "object" || result === null) return null
  if ("rowsAffected" in result && typeof result.rowsAffected === "number") return result.rowsAffected
  if ("affectedRows" in result && typeof result.affectedRows === "number") return result.affectedRows
  return null
}

async function readStoredPolicy(database: AuditDatabase | AuditTx, organizationId: string) {
  const [row] = await database.select().from(AuditPolicyTable).where(eq(AuditPolicyTable.organization_id, normalizeDenTypeId("organization", organizationId))).limit(1)
  return row
}

function assertStoredPolicyMatches(storedPolicy: typeof AuditPolicyTable.$inferSelect | undefined, policy: AuditPolicy, now = new Date()): asserts storedPolicy is typeof AuditPolicyTable.$inferSelect {
  if (!storedPolicy || policyIdentity(policyValue(storedPolicy)) !== policyIdentity(policy) || storedPolicy.effective_at > now) throw new AuditLogError("audit_policy_changed")
}

/** Plain read: the stored policy still has the identity the caller captured. */
export async function assertAuditPolicyCurrent(database: AuditDatabase | AuditTx, policy: AuditPolicy): Promise<void> {
  validatePolicy(policy)
  assertStoredPolicyMatches(await readStoredPolicy(database, policy.organizationId), policy)
}

export async function setAuditCaptureState(tx: AuditTx, input: { context: AuditContext; captureOn: boolean; expectedRevision: number }): Promise<void> {
  const identity = validateContext(input.context)
  integer(input.expectedRevision)
  if (typeof input.captureOn !== "boolean" || input.context.kind !== "audit.policy" || input.context.scope !== identity.organizationId || identity.actor.type !== "user" || !identity.actor.memberId || input.context.origin !== "api" || input.context.originTrust !== "authenticated" || !input.context.requestId || input.context.initiatingActor || input.context.correlationId || input.context.jobRunId || input.context.causedByEventId) fail()
  const { captureOn, expectedRevision } = input
  const context: AuditContext = { organizationId: identity.organizationId, actor: identity.actor, principalKey: input.context.principalKey, kind: "audit.policy", scope: identity.organizationId, origin: "api", originTrust: "authenticated", requestId: input.context.requestId }
  const existing = await readAuditPolicy(tx, identity.organizationId)
  if (!existing) {
    if (expectedRevision !== 0) throw new AuditLogError("audit_policy_changed")
    if (captureOn) throw new AuditLogError("audit_policy_not_configured")
    return
  }
  if (existing.revision !== expectedRevision) throw new AuditLogError("audit_policy_changed")
  const before = existing
  if (before.enabled === captureOn) return
  const now = new Date()
  const after: AuditPolicy = { ...before, enabled: captureOn, revision: add(before.revision, 1), effectiveAt: now.toISOString() }
  validatePolicy(after)
  // Optimistic concurrency: the revision guard replaces a row lock. A
  // concurrent writer that bumped the revision first makes this update miss.
  const result = await tx.update(AuditPolicyTable).set({ enabled: after.enabled, revision: after.revision, effective_at: now })
    .where(and(eq(AuditPolicyTable.organization_id, identity.organizationId), eq(AuditPolicyTable.revision, expectedRevision)))
  if (affectedRows(result) === 0) throw new AuditLogError("audit_policy_changed")
  const snapshot = (policy: AuditPolicy) => ({ captureOn: policy.enabled, revision: policy.revision, effectiveAt: policy.effectiveAt })
  await appendAuditEventCore(tx, { context, policy: after, event: {
    action: captureOn ? "audit.capture.enabled" : "audit.capture.disabled", category: "lifecycle", outcome: "succeeded",
    resources: [{ type: "audit_policy", id: identity.organizationId, relationship: "target" }],
    changes: { before: snapshot(before), after: snapshot(after), changedFields: ["captureOn", "revision", "effectiveAt"] },
    idempotencyKey: `capture:${after.revision}`,
  } })
}

/** Operation outcome projection (audit_operation.outcome); never part of the event envelope or its content hash. */
export type AuditOperationOutcome = "succeeded" | "failed" | "unknown"
const operationOutcomes: AuditOperationOutcome[] = ["succeeded", "failed", "unknown"]
type AppendAuditEventInput = { context: AuditContext; policy: AuditPolicy; event: AuditEventInput; operationOutcome?: AuditOperationOutcome }
type OperationRow = typeof AuditOperationTable.$inferSelect

/**
 * Appends one event. `operationOutcome` (request/service/job outcome events only)
 * updates the operation's outcome projection in the same transaction; an
 * idempotent replay of an existing event changes nothing.
 */
export async function appendAuditEvent(tx: AuditTx, input: AppendAuditEventInput): Promise<AuditEventEnvelope | null> {
  if (!input.policy.enabled || !input.policy.categories.includes(input.event.category)) return null
  return appendAuditEventCore(tx, input)
}

async function appendAuditEventCore(tx: AuditTx, input: AppendAuditEventInput): Promise<AuditEventEnvelope> {
  const operationOutcome = input.operationOutcome
  if (operationOutcome !== undefined && !operationOutcomes.includes(operationOutcome)) fail()
  const context = { ...input.context }
  const policy = { ...input.policy, categories: [...input.policy.categories] }
  validatePolicy(policy)
  const identity = validateContext(context)
  context.actor = identity.actor
  context.initiatingActor = identity.initiatingActor
  if (identity.organizationId !== policy.organizationId) fail()
  const organizationId = identity.organizationId
  const event = eventValue(input.event)
  const idempotencyKey = input.event.idempotencyKey
  if (idempotencyKey !== undefined) text(idempotencyKey, 512)
  const claim = workflowClaim(context)
  const contentHash = digest(canonicalAuditJson({ actor: identity.actor, initiatingActor: identity.initiatingActor, origin: context.origin, originTrust: context.originTrust, ...(claim ? { workflow: { step: claim.step, scope: claim.scope } } : {}), ...(context.jobRunId ? { jobRunId: context.jobRunId } : {}), ...(context.causedByEventId ? { causedByEventId: context.causedByEventId } : {}), event }))
  const now = new Date()
  const storedPolicy = await readStoredPolicy(tx, organizationId)
  assertStoredPolicyMatches(storedPolicy, policy, now)

  // Every read below is a plain read. Rows only ever touched by one request
  // (its operation, its events) are written; nothing shared by the whole
  // organization is read-modified-written, so appends never queue on each other.
  const findOperation = async (key: string) => (await tx.select().from(AuditOperationTable).where(and(eq(AuditOperationTable.organization_id, organizationId), eq(AuditOperationTable.binding_key, key))).limit(1))[0]
  const matchesContext = (operation: OperationRow) => operation.kind === context.kind && operation.scope === context.scope && operation.principal_key === context.principalKey && operation.origin === context.origin && operation.origin_trust === context.originTrust && canonicalAuditJson(operation.initiating_actor) === canonicalAuditJson(identity.initiatingActor)
  const requestBinding = auditOperationBinding(context, false)
  let bindingKey = requestBinding
  let operation: OperationRow | undefined = await findOperation(requestBinding)
  let claimStep = false
  if (!operation && claim) {
    bindingKey = auditOperationBinding(context)
    operation = await findOperation(bindingKey)
    if (operation?.retention_state === "evicting") throw new AuditLogError("audit_operation_unavailable")
    if (!operation) claimStep = true
    else {
      const claims = await tx.select({ hash: AuditOperationStepTable.step_hash, requestId: AuditOperationStepTable.request_id }).from(AuditOperationStepTable)
        .where(and(eq(AuditOperationStepTable.organization_id, organizationId), eq(AuditOperationStepTable.operation_id, operation.id))).limit(claim.maximum + 1)
      const existingClaim = claims.find((entry) => entry.hash === claim.hash)
      // Without a lock the claim cap is a soft bound: concurrent claims can pass it by a few.
      if (operation.attachment_expires_at <= now || !matchesContext(operation) || existingClaim && existingClaim.requestId !== claim.requestId || !existingClaim && claims.length >= claim.maximum) {
        bindingKey = requestBinding
        operation = undefined
      } else claimStep = !existingClaim
    }
  }
  while (operation && operation.attachment_expires_at <= now) {
    if (operation.retention_state === "evicting") throw new AuditLogError("audit_operation_unavailable")
    bindingKey = digest(canonicalAuditJson([bindingKey, "expired", operation.id]))
    operation = await findOperation(bindingKey)
  }
  if (operation && (operation.retention_state !== "retained" || !matchesContext(operation))) throw new AuditLogError("audit_operation_unavailable")
  if (operation && idempotencyKey !== undefined) {
    const [duplicate] = await tx.select().from(AuditEventTable).where(and(eq(AuditEventTable.org_id, organizationId), eq(AuditEventTable.operation_id, operation.id), eq(AuditEventTable.idempotency_key, digest(idempotencyKey)))).limit(1)
    if (duplicate) {
      if (duplicate.content_hash !== contentHash) throw new AuditLogError("audit_idempotency_mismatch")
      const stored = parseStoredAuditEnvelope(duplicate.envelope)
      if (!stored || stored.organizationId !== organizationId || stored.operationId !== operation.id) throw new AuditLogError("audit_storage_inconsistent")
      return stored
    }
  }
  if (context.causedByEventId) {
    const [cause] = await tx.select({ id: AuditEventTable.id }).from(AuditEventTable).where(and(eq(AuditEventTable.org_id, organizationId), eq(AuditEventTable.id, normalizeDenTypeId("auditEvent", context.causedByEventId)))).limit(1)
    if (!cause) fail()
  }

  // Creates the operation for a binding, or joins the one a concurrent append
  // of the same request created first (the unique binding index decides).
  const ensureOperation = async (key: string): Promise<OperationRow> => {
    const createdId = createDenTypeId("auditOperation")
    await tx.insert(AuditOperationTable).values({
      id: createdId, organization_id: organizationId, binding_key: key, kind: context.kind, scope: context.scope, principal_key: context.principalKey,
      initiating_actor: identity.initiatingActor, origin: context.origin, origin_trust: context.originTrust, first_recorded_at: now,
      attachment_expires_at: new Date(now.getTime() + policy.attachmentWindowSeconds * 1000), event_count: 0, logical_bytes: 0,
    }).onDuplicateKeyUpdate({ set: { id: sql`${AuditOperationTable.id}` } })
    const row = await findOperation(key)
    if (!row) throw new AuditLogError("audit_storage_inconsistent")
    if (row.retention_state !== "retained" || !matchesContext(row)) throw new AuditLogError("audit_operation_unavailable")
    if (row.id === createdId) {
      await tx.insert(AuditUsageFactTable).values({ id: createDenTypeId("auditUsageFact"), organization_id: organizationId, operation_id: row.id, delta: 1, effective_at: now, policy_revision: policy.revision, allowance: policy.allowance, excess_mode: policy.excessMode })
        .onDuplicateKeyUpdate({ set: { id: sql`${AuditUsageFactTable.id}` } })
    }
    return row
  }
  if (!operation) operation = await ensureOperation(bindingKey)
  if (claimStep && claim) {
    await tx.insert(AuditOperationStepTable).values({ organization_id: organizationId, operation_id: operation.id, step_hash: claim.hash, workflow_step: claim.step, step_scope: claim.scope, request_id: claim.requestId })
      .onDuplicateKeyUpdate({ set: { step_hash: sql`${AuditOperationStepTable.step_hash}` } })
    const [owner] = await tx.select({ requestId: AuditOperationStepTable.request_id }).from(AuditOperationStepTable)
      .where(and(eq(AuditOperationStepTable.organization_id, organizationId), eq(AuditOperationStepTable.operation_id, operation.id), eq(AuditOperationStepTable.step_hash, claim.hash))).limit(1)
    if (!owner) throw new AuditLogError("audit_storage_inconsistent")
    // Another request claimed the same step at the same moment: this request
    // keeps its own request-bound operation instead.
    if (owner.requestId !== claim.requestId) operation = await ensureOperation(requestBinding)
  }

  const eventId = createDenTypeId("auditEvent")
  const envelopeWithoutBytes: Omit<AuditEventEnvelope, "logicalBytes"> = {
    schemaVersion: 2,
    id: eventId,
    organizationId,
    operationId: operation.id,
    operation: { kind: context.kind, scope: context.scope, origin: operation.origin, originTrust: operation.origin_trust, initiatingActor: operation.initiating_actor, startedAt: operation.first_recorded_at.toISOString() },
    actor: identity.actor,
    ...event,
    occurredAt: now.toISOString(),
    recordedAt: now.toISOString(),
    requestId: context.requestId,
    ...(context.jobRunId ? { jobRunId: context.jobRunId } : {}),
    ...(context.causedByEventId ? { causedByEventId: context.causedByEventId } : {}),
  }
  const logicalBytes = Buffer.byteLength(canonicalAuditJson(envelopeWithoutBytes), "utf8")
  const envelope: AuditEventEnvelope = { ...envelopeWithoutBytes, logicalBytes }
  await tx.insert(AuditEventTable).values({
    id: eventId, org_id: organizationId, actor_user_id: identity.actor.type === "user" && identity.actor.id ? normalizeDenTypeId("user", identity.actor.id) : null,
    action: event.action, operation_id: operation.id, envelope, logical_bytes: logicalBytes,
    idempotency_key: idempotencyKey === undefined ? null : digest(idempotencyKey), content_hash: contentHash, created_at: now,
  })
  if (event.resources.length) await tx.insert(AuditEventResourceTable).values(event.resources.map((resource) => ({
    id: createDenTypeId("auditEventResource"), organization_id: organizationId, event_id: eventId, operation_id: operation.id,
    resource_type: resource.type, resource_id: resource.id, relationship: resource.relationship, label: resource.label ?? null,
  })))
  // Relative increment on this request's own operation row; never a shared counter.
  await tx.update(AuditOperationTable).set({
    event_count: sql`${AuditOperationTable.event_count} + 1`,
    logical_bytes: sql`${AuditOperationTable.logical_bytes} + ${logicalBytes}`,
    ...(operationOutcome ? { outcome: operationOutcome } : {}),
  }).where(and(eq(AuditOperationTable.organization_id, organizationId), eq(AuditOperationTable.id, operation.id)))
  if (storedPolicy.capture_started_at === null) {
    await tx.update(AuditPolicyTable).set({ capture_started_at: now }).where(and(eq(AuditPolicyTable.organization_id, organizationId), isNull(AuditPolicyTable.capture_started_at)))
  }
  return envelope
}

export type AuditUsageRefreshSummary = { organizations: number; refreshedAt: string }

/**
 * Recomputes every organization's audit_state totals from the stored rows.
 * Run on a schedule (den-api POST /internal/audit/usage/refresh); the append
 * path never touches audit_state. Plain aggregate reads, one upsert per
 * organization, no transaction and no row locks held across statements.
 */
export async function refreshAuditUsageCounts(database: AuditDatabase, options: { organizationIds?: readonly string[] } = {}): Promise<AuditUsageRefreshSummary> {
  const organizationIds = options.organizationIds
    ? options.organizationIds.map((id) => normalizeDenTypeId("organization", id))
    : (await database.select({ id: AuditPolicyTable.organization_id }).from(AuditPolicyTable)).map((row) => row.id)
  for (const organizationId of organizationIds) {
    const [operations] = await database.select({ value: sql<number>`count(*)`.mapWith(Number) }).from(AuditOperationTable)
      .where(and(eq(AuditOperationTable.organization_id, organizationId), eq(AuditOperationTable.retention_state, "retained")))
    const [events] = await database.select({ count: sql<number>`count(*)`.mapWith(Number), bytes: sql<number>`coalesce(sum(${AuditEventTable.logical_bytes}), 0)`.mapWith(Number) }).from(AuditEventTable)
      .where(and(eq(AuditEventTable.org_id, organizationId), isNotNull(AuditEventTable.envelope), isNotNull(AuditEventTable.operation_id)))
    const totals = { retained_operations: operations?.value ?? 0, event_count: events?.count ?? 0, logical_bytes: events?.bytes ?? 0 }
    if (!Object.values(totals).every((value) => Number.isSafeInteger(value) && value >= 0)) throw new AuditLogError("audit_counter_overflow")
    const updatedAt = new Date()
    await database.insert(AuditStateTable).values({ organization_id: organizationId, ...totals, updated_at: updatedAt })
      .onDuplicateKeyUpdate({ set: { ...totals, updated_at: updatedAt } })
  }
  return { organizations: organizationIds.length, refreshedAt: new Date().toISOString() }
}

export type PlatformAuditEventInput = {
  requestId: string | null
  method: string
  /** Registered route template, never a concrete URL. */
  route: string
  action: string
  outcome: "succeeded" | "failed" | "denied" | "unknown"
  status: number
  reasonCode?: string | null
  /** Only authenticated user/service ids; unknown requires a null id. */
  actor: { type: "user" | "service" | "unknown"; id: string | null; credentialId?: string | null }
  origin: AuditOrigin
  /**
   * Resource reference: the declared type with a validated path id, or a resource the
   * handler named. Type organization only for an id taken from trusted authenticated
   * context (never from untrusted input); there is no organization attribution column.
   */
  target?: { type: string; id: string | null } | null
  occurredAt?: Date
  /**
   * Row id generated by the caller once per logical record, so a retried insert
   * after an ambiguous commit collides on the primary key instead of duplicating.
   */
  id?: string
}

/** Tenantless request evidence: never an organization id, IP, user agent, header or body. */
export async function appendPlatformAuditEvent(database: AuditDatabase | AuditTx, input: PlatformAuditEventInput): Promise<string> {
  const http = httpValue({ method: input.method, route: input.route, status: input.status })
  text(input.action, 128)
  if (!kindPattern.test(input.action) || !["succeeded", "failed", "denied", "unknown"].includes(input.outcome) || !origins.includes(input.origin)) fail()
  const reasonCode = input.reasonCode ?? null
  if (reasonCode !== null && !kindPattern.test(reasonCode)) fail()
  if (input.requestId !== null) text(input.requestId, 128)
  if (!["user", "service", "unknown"].includes(input.actor.type)) fail()
  if (input.actor.type === "unknown" ? input.actor.id !== null : input.actor.id === null) fail()
  if (input.actor.id !== null) text(input.actor.id, 255)
  if (input.actor.type === "user" && input.actor.id !== null) normalizeDenTypeId("user", input.actor.id)
  const credentialId = input.actor.credentialId ?? null
  if (credentialId !== null) text(credentialId, 255)
  const target = input.target ?? null
  if (target !== null) {
    text(target.type, 64)
    if (!kindPattern.test(target.type)) fail()
    if (target.id !== null) text(target.id, 255)
  }
  const occurredAt = input.occurredAt ?? new Date()
  if (!Number.isFinite(occurredAt.getTime())) fail()
  const id = input.id === undefined ? createDenTypeId("platformAuditEvent") : normalizeDenTypeId("platformAuditEvent", input.id)
  await database.insert(PlatformAuditEventTable).values({
    id, occurred_at: occurredAt, request_id: input.requestId, method: http.method, route: http.route, action: input.action,
    outcome: input.outcome, status: input.status, reason_code: reasonCode, actor_type: input.actor.type, actor_id: input.actor.id,
    credential_id: credentialId, origin: input.origin, target_type: target?.type ?? null, target_id: target?.id ?? null,
  })
  return id
}
