import { createHash, randomUUID } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { createDenDb } from "./client"
import type { AuditActor, AuditCategory, AuditEventEnvelope, AuditPolicy } from "@openwork/types/den/audit"
export type { AuditActor, AuditCategory, AuditEventEnvelope, AuditPolicy } from "@openwork/types/den/audit"
import { AuditEventResourceTable, AuditOperationStepTable, AuditOperationTable, AuditPolicyTable, AuditStateTable, AuditUsageFactTable } from "./schema/audit"
import { AuditEventTable } from "./schema/workers"

export type AuditDatabase = ReturnType<typeof createDenDb>["db"]
export type AuditTx = Parameters<Parameters<AuditDatabase["transaction"]>[0]>[0]
export type AuditContext = {
  organizationId: string
  actor: AuditActor
  principalKey: string
  initiatingActor?: AuditActor
  origin: "api" | "cloud_ui" | "mcp" | "scheduler" | "webhook" | "platform_admin"
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
}

export const MAX_AUDIT_EVENT_BYTES = 262_144
const categories: AuditCategory[] = ["change", "security", "execution", "access", "read", "request", "lifecycle"]
const kinds = new Set(["provider.configuration", "audit.access", "audit.policy"])
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
  if (!kinds.has(context.kind)) fail()
  text(context.principalKey, 512)
  text(context.scope, 512)
  if (!["api", "cloud_ui", "mcp", "scheduler", "webhook", "platform_admin"].includes(context.origin) || !["authenticated", "reported"].includes(context.originTrust)) fail()
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
  const event = { action: input.action, category: input.category, outcome: input.outcome, resources, ...(changes ? { changes } : {}), ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }) }
  canonicalAuditJson(event)
  return event
}

async function lockAuditPolicyState(tx: AuditTx, inputOrganizationId: string) {
  const organizationId = normalizeDenTypeId("organization", inputOrganizationId)
  await tx.insert(AuditStateTable).values({ organization_id: organizationId }).onDuplicateKeyUpdate({ set: { organization_id: sql`${AuditStateTable.organization_id}` } })
  const [state] = await tx.select().from(AuditStateTable).where(eq(AuditStateTable.organization_id, organizationId)).limit(1).for("update")
  if (!state) throw new AuditLogError("audit_storage_inconsistent")
  const [storedPolicy] = await tx.select().from(AuditPolicyTable).where(eq(AuditPolicyTable.organization_id, organizationId)).limit(1).for("update")
  return { state, storedPolicy }
}

export async function assertAuditPolicyCurrent(tx: AuditTx, policy: AuditPolicy): Promise<void> {
  validatePolicy(policy)
  const { storedPolicy } = await lockAuditPolicyState(tx, policy.organizationId)
  if (!storedPolicy || policyIdentity(policyValue(storedPolicy)) !== policyIdentity(policy) || storedPolicy.effective_at > new Date()) throw new AuditLogError("audit_policy_changed")
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
  const { storedPolicy } = await lockAuditPolicyState(tx, identity.organizationId)
  if (!storedPolicy || storedPolicy.revision !== expectedRevision) throw new AuditLogError("audit_policy_changed")
  const before = policyValue(storedPolicy)
  if (before.enabled === captureOn) return
  const now = new Date()
  const after: AuditPolicy = { ...before, enabled: captureOn, revision: add(before.revision, 1), effectiveAt: now.toISOString() }
  validatePolicy(after)
  await tx.update(AuditPolicyTable).set({ enabled: after.enabled, revision: after.revision, effective_at: now }).where(eq(AuditPolicyTable.organization_id, identity.organizationId))
  const snapshot = (policy: AuditPolicy) => ({ captureOn: policy.enabled, revision: policy.revision, effectiveAt: policy.effectiveAt })
  await appendAuditEventCore(tx, { context, policy: after, event: {
    action: captureOn ? "audit.capture.enabled" : "audit.capture.disabled", category: "lifecycle", outcome: "succeeded",
    resources: [{ type: "audit_policy", id: identity.organizationId, relationship: "target" }],
    changes: { before: snapshot(before), after: snapshot(after), changedFields: ["captureOn", "revision", "effectiveAt"] },
    idempotencyKey: `capture:${after.revision}`,
  } })
}

export async function appendAuditEvent(tx: AuditTx, input: { context: AuditContext; policy: AuditPolicy; event: AuditEventInput }): Promise<AuditEventEnvelope | null> {
  if (!input.policy.enabled || !input.policy.categories.includes(input.event.category)) return null
  return appendAuditEventCore(tx, input)
}

async function appendAuditEventCore(tx: AuditTx, input: { context: AuditContext; policy: AuditPolicy; event: AuditEventInput }): Promise<AuditEventEnvelope> {
  const context = { ...input.context }
  const policy = { ...input.policy, categories: [...input.policy.categories] }
  validatePolicy(policy)
  const identity = validateContext(context)
  context.actor = identity.actor
  context.initiatingActor = identity.initiatingActor
  if (identity.organizationId !== policy.organizationId) fail()
  const event = eventValue(input.event)
  const idempotencyKey = input.event.idempotencyKey
  if (idempotencyKey !== undefined) text(idempotencyKey, 512)
  const claim = workflowClaim(context)
  const contentHash = digest(canonicalAuditJson({ actor: identity.actor, initiatingActor: identity.initiatingActor, origin: context.origin, originTrust: context.originTrust, ...(claim ? { workflow: { step: claim.step, scope: claim.scope } } : {}), ...(context.jobRunId ? { jobRunId: context.jobRunId } : {}), ...(context.causedByEventId ? { causedByEventId: context.causedByEventId } : {}), event }))
  const { state, storedPolicy } = await lockAuditPolicyState(tx, identity.organizationId)
  if (!storedPolicy || policyIdentity(policyValue(storedPolicy)) !== policyIdentity(policy)) throw new AuditLogError("audit_policy_changed")
  const now = new Date()
  if (storedPolicy.effective_at > now) throw new AuditLogError("audit_policy_changed")
  const requestBinding = auditOperationBinding(context, false)
  let bindingKey = requestBinding
  const findOperation = async (key: string) => (await tx.select().from(AuditOperationTable).where(and(eq(AuditOperationTable.organization_id, identity.organizationId), eq(AuditOperationTable.binding_key, key))).limit(1).for("update"))[0]
  const matchesContext = (operation: typeof AuditOperationTable.$inferSelect) => operation.kind === context.kind && operation.scope === context.scope && operation.principal_key === context.principalKey && operation.origin === context.origin && operation.origin_trust === context.originTrust && canonicalAuditJson(operation.initiating_actor) === canonicalAuditJson(identity.initiatingActor)
  let operation: typeof AuditOperationTable.$inferSelect | undefined = await findOperation(requestBinding)
  let insertClaim = false
  if (!operation && claim) {
    bindingKey = auditOperationBinding(context)
    operation = await findOperation(bindingKey)
    if (operation?.retention_state === "evicting") throw new AuditLogError("audit_operation_unavailable")
    if (!operation) insertClaim = true
    else {
      const claims = await tx.select({ hash: AuditOperationStepTable.step_hash, requestId: AuditOperationStepTable.request_id }).from(AuditOperationStepTable)
        .where(and(eq(AuditOperationStepTable.organization_id, identity.organizationId), eq(AuditOperationStepTable.operation_id, operation.id))).limit(claim.maximum + 1).for("update")
      if (claims.length > claim.maximum) throw new AuditLogError("audit_storage_inconsistent")
      const existingClaim = claims.find((entry) => entry.hash === claim.hash)
      if (operation.attachment_expires_at <= now || !matchesContext(operation) || existingClaim && existingClaim.requestId !== claim.requestId || !existingClaim && claims.length >= claim.maximum) {
        bindingKey = requestBinding
        operation = undefined
      } else insertClaim = !existingClaim
    }
  }
  while (operation && operation.attachment_expires_at <= now) {
    if (operation.retention_state === "evicting") throw new AuditLogError("audit_operation_unavailable")
    bindingKey = digest(canonicalAuditJson([bindingKey, "expired", operation.id]))
    operation = await findOperation(bindingKey)
  }
  if (operation && (operation.retention_state !== "retained" || !matchesContext(operation))) throw new AuditLogError("audit_operation_unavailable")
  if (operation && idempotencyKey !== undefined) {
    const [duplicate] = await tx.select().from(AuditEventTable).where(and(eq(AuditEventTable.org_id, identity.organizationId), eq(AuditEventTable.operation_id, operation.id), eq(AuditEventTable.idempotency_key, digest(idempotencyKey)))).limit(1).for("update")
    if (duplicate) {
      if (duplicate.content_hash !== contentHash) throw new AuditLogError("audit_idempotency_mismatch")
      if (!duplicate.envelope || duplicate.envelope.organizationId !== identity.organizationId || duplicate.envelope.operationId !== operation.id) throw new AuditLogError("audit_storage_inconsistent")
      return duplicate.envelope
    }
  }
  if (context.causedByEventId) {
    const [cause] = await tx.select({ id: AuditEventTable.id }).from(AuditEventTable).where(and(eq(AuditEventTable.org_id, identity.organizationId), eq(AuditEventTable.id, normalizeDenTypeId("auditEvent", context.causedByEventId)))).limit(1).for("update")
    if (!cause) fail()
  }
  const operationId = operation?.id ?? createDenTypeId("auditOperation")
  const eventId = createDenTypeId("auditEvent")
  const envelopeWithoutBytes: Omit<AuditEventEnvelope, "logicalBytes"> = {
    schemaVersion: 1,
    id: eventId,
    organizationId: identity.organizationId,
    operationId,
    sequence: add(state.last_sequence, 1),
    operation: { kind: context.kind, scope: context.scope, origin: operation?.origin ?? context.origin, originTrust: operation?.origin_trust ?? context.originTrust, initiatingActor: operation?.initiating_actor ?? identity.initiatingActor, startedAt: (operation?.first_recorded_at ?? now).toISOString() },
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
  const operationEventCount = add(operation?.event_count ?? 0, 1)
  const operationBytes = add(operation?.logical_bytes ?? 0, logicalBytes)
  const retainedOperations = add(state.retained_operations, operation ? 0 : 1)
  const eventCount = add(state.event_count, 1)
  const totalBytes = add(state.logical_bytes, logicalBytes)
  if (!operation) {
    await tx.insert(AuditOperationTable).values({
      id: operationId, organization_id: identity.organizationId, binding_key: bindingKey, kind: context.kind, scope: context.scope, principal_key: context.principalKey,
      initiating_actor: identity.initiatingActor, origin: context.origin, origin_trust: context.originTrust, first_recorded_at: now,
      attachment_expires_at: new Date(now.getTime() + policy.attachmentWindowSeconds * 1000), event_count: operationEventCount, logical_bytes: operationBytes,
    })
    await tx.insert(AuditUsageFactTable).values({ id: createDenTypeId("auditUsageFact"), organization_id: identity.organizationId, operation_id: operationId, delta: 1, effective_at: now, policy_revision: policy.revision, allowance: policy.allowance, excess_mode: policy.excessMode })
  } else {
    await tx.update(AuditOperationTable).set({ event_count: operationEventCount, logical_bytes: operationBytes }).where(and(eq(AuditOperationTable.organization_id, identity.organizationId), eq(AuditOperationTable.id, operationId)))
  }
  if (insertClaim && claim) await tx.insert(AuditOperationStepTable).values({ organization_id: identity.organizationId, operation_id: operationId, step_hash: claim.hash, workflow_step: claim.step, step_scope: claim.scope, request_id: claim.requestId })
  await tx.insert(AuditEventTable).values({
    id: eventId, org_id: identity.organizationId, actor_user_id: identity.actor.type === "user" && identity.actor.id ? normalizeDenTypeId("user", identity.actor.id) : null,
    action: event.action, operation_id: operationId, sequence: envelope.sequence, envelope, logical_bytes: logicalBytes,
    idempotency_key: idempotencyKey === undefined ? null : digest(idempotencyKey), content_hash: contentHash, created_at: now,
  })
  if (event.resources.length) await tx.insert(AuditEventResourceTable).values(event.resources.map((resource) => ({
    id: createDenTypeId("auditEventResource"), organization_id: identity.organizationId, event_id: eventId, operation_id: operationId,
    resource_type: resource.type, resource_id: resource.id, relationship: resource.relationship, label: resource.label ?? null,
  })))
  await tx.update(AuditStateTable).set({ last_sequence: envelope.sequence, retained_operations: retainedOperations, event_count: eventCount, logical_bytes: totalBytes, updated_at: now }).where(eq(AuditStateTable.organization_id, identity.organizationId))
  if (storedPolicy.capture_started_at === null) await tx.update(AuditPolicyTable).set({ capture_started_at: now }).where(eq(AuditPolicyTable.organization_id, identity.organizationId))
  return envelope
}
