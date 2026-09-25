import { z } from "zod"

// This header is only an interaction hint. The server selects the workflow,
// authenticates its principal and binds the hint to an organization and scope.
export const AUDIT_CORRELATION_HEADER = "X-OpenWork-Audit-Correlation"
export const auditCategorySchema = z.enum(["change", "security", "execution", "access", "read", "request", "lifecycle"])
export const auditOriginSchema = z.enum(["api", "cloud_ui", "mcp", "scheduler", "webhook", "platform_admin"])
export const auditOutcomeSchema = z.enum(["succeeded", "failed", "denied", "unknown"])
export const auditOperationOutcomeSchema = z.enum(["running", "succeeded", "failed", "partial", "unknown"])
export const auditExcessModeSchema = z.enum(["delete_oldest", "paid_overage", "keep_all"])
export const auditActorSchema = z.object({
  type: z.enum(["user", "service", "system", "unknown"]),
  id: z.string().nullable(),
  memberId: z.string().optional(),
  credentialId: z.string().optional(),
}).strict()
export const auditResourceSchema = z.object({
  type: z.string(), id: z.string(), relationship: z.enum(["target", "parent", "related"]), label: z.string().optional(),
}).strict()
export const auditChangesSchema = z.object({
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  changedFields: z.array(z.string()),
}).strict()
export const auditPolicySchema = z.object({
  organizationId: z.string(), revision: z.number().int().positive(), source: z.enum(["cloud", "operator"]),
  enabled: z.boolean(), categories: z.array(auditCategorySchema), allowance: z.number().int().nonnegative().safe(),
  excessMode: auditExcessModeSchema, effectiveAt: z.string().datetime(), captureStartedAt: z.string().datetime().nullable(),
  attachmentWindowSeconds: z.number().int().min(1).max(86400),
}).strict()
export const auditEventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), organizationId: z.string(), operationId: z.string(),
  sequence: z.number().int().positive().safe(),
  operation: z.object({
    kind: z.string(), scope: z.string(), origin: auditOriginSchema, originTrust: z.enum(["authenticated", "reported"]),
    initiatingActor: auditActorSchema, startedAt: z.string().datetime(),
  }).strict(),
  actor: auditActorSchema, action: z.string(), category: auditCategorySchema, outcome: auditOutcomeSchema,
  occurredAt: z.string().datetime(), recordedAt: z.string().datetime(), requestId: z.string().nullable(),
  jobRunId: z.string().optional(), causedByEventId: z.string().optional(), resources: z.array(auditResourceSchema),
  changes: auditChangesSchema.optional(), reasonCode: z.string().optional(), logicalBytes: z.number().int().nonnegative().safe(),
}).strict()
export const auditOperationSummarySchema = z.object({
  id: z.string(), kind: z.string(), scope: z.string(), action: z.string(), initiatingActor: auditActorSchema,
  origin: auditOriginSchema, originTrust: z.enum(["authenticated", "reported"]), startedAt: z.string().datetime(),
  outcome: auditOperationOutcomeSchema, eventCount: z.number().int().nonnegative().safe(), logicalBytes: z.number().int().nonnegative().safe(),
  resources: z.array(auditResourceSchema),
}).strict()
export const auditOperationsResponseSchema = z.object({
  operations: z.array(auditOperationSummarySchema), nextCursor: z.string().nullable(), snapshotSequence: z.number().int().nonnegative().safe(),
}).strict()
export const auditEventTypesResponseSchema = z.object({
  eventTypes: z.array(z.string().min(1).max(128).regex(/^[a-z][a-z0-9_.-]*$/)).refine((values) => new Set(values).size === values.length),
}).strict()
export const auditEventsResponseSchema = z.object({
  events: z.array(auditEventEnvelopeSchema), nextCursor: z.string().nullable(), snapshotSequence: z.number().int().nonnegative().safe(),
}).strict()
export const auditEntitlementSchema = z.object({
  enabled: z.boolean(), source: z.enum(["enterprise_plan", "self_hosted", "none"]),
}).strict()
export const auditCaptureUpdateSchema = z.object({
  captureOn: z.boolean(), expectedRevision: z.number().int().nonnegative().safe(),
}).strict()
export const auditUsageResponseSchema = z.object({
  entitlement: auditEntitlementSchema, captureOn: z.boolean(), captureAvailable: z.boolean(),
  policy: auditPolicySchema.nullable(), captureEnabled: z.boolean(), retainedOperations: z.number().int().nonnegative().safe(),
  eventCount: z.number().int().nonnegative().safe(), logicalBytes: z.number().int().nonnegative().safe(),
  oldestAvailableAt: z.string().datetime().nullable(), measuredAt: z.string().datetime().nullable(),
  billing: z.literal("disabled"), cleanup: z.literal("dry_run"), drains: z.literal("not_configured"),
}).strict()

export type AuditCategory = z.infer<typeof auditCategorySchema>
export type AuditActor = z.infer<typeof auditActorSchema>
export type AuditPolicy = z.infer<typeof auditPolicySchema>
export type AuditEventEnvelope = z.infer<typeof auditEventEnvelopeSchema>
export type AuditOperationSummary = z.infer<typeof auditOperationSummarySchema>
export type AuditOperationsResponse = z.infer<typeof auditOperationsResponseSchema>
export type AuditEventsResponse = z.infer<typeof auditEventsResponseSchema>
export type AuditEventTypesResponse = z.infer<typeof auditEventTypesResponseSchema>
export type AuditEntitlement = z.infer<typeof auditEntitlementSchema>
export type AuditCaptureUpdate = z.infer<typeof auditCaptureUpdateSchema>
export type AuditUsageResponse = z.infer<typeof auditUsageResponseSchema>
export type AuditOperationContext = Readonly<{ correlationId: string }>

/** Create once per interaction and pass explicitly, including across reauthentication. */
export function createAuditOperationContext(): AuditOperationContext {
  return Object.freeze({ correlationId: globalThis.crypto.randomUUID() })
}
export function auditOperationHeaders(context?: AuditOperationContext): Record<string, string> {
  return context ? { [AUDIT_CORRELATION_HEADER]: context.correlationId } : {}
}
