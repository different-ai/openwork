import type { AuditActor, AuditEventInput, AuditOrigin } from "@openwork-ee/den-db/audit-log"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../env.js"
import type { AuditJobOutcomeEventType } from "./job-outcomes.js"
import { appendAuditEventInOwnTransaction, readEffectiveAuditPolicyWithRetry, auditLogsFeatureEnabled, auditOperationOutcome, logAuditOutcomeLost } from "./request-capture.js"

// Background job outcomes (src/audit/job-outcomes.ts). Never throws into the
// job: a lost outcome is logged [audit-outcome-lost] and the job continues.
// No-op unless the organization has the auditLogs feature (features registry), capture is
// on, an enabled policy exists (lazy default allowed) and "execution" is selected.

export type AuditJobOutcome = Readonly<{
  organizationId: string
  /** Job row id (automation run, sync event); binds the operation as ["job", id]. */
  jobRunId: string
  kind: string
  action: AuditJobOutcomeEventType
  actor: AuditActor
  /** Shared by every event of the job operation (binding input). */
  principalKey: string
  initiatingActor?: AuditActor
  origin: AuditOrigin
  resources: AuditEventInput["resources"]
  outcome: AuditEventInput["outcome"]
  reasonCode?: string
  changes?: AuditEventInput["changes"]
  idempotencyKey: string
}>

const REASON_CODE = /^[a-z][a-z0-9_.-]{0,127}$/

export function auditJobReasonCode(value: string | null | undefined, fallback: string): string {
  return value && REASON_CODE.test(value) ? value : fallback
}

/** True when the event was appended (or already present for the idempotency key). */
export async function recordAuditJobOutcome(input: AuditJobOutcome): Promise<boolean> {
  if (!env.auditCaptureEnabled) return false
  try {
    const organizationId = normalizeDenTypeId("organization", input.organizationId)
    if (!(await auditLogsFeatureEnabled(organizationId))) return false
    const policy = await readEffectiveAuditPolicyWithRetry(organizationId)
    if (!policy || !policy.categories.includes("execution")) return false
    await appendAuditEventInOwnTransaction({
      policy,
      context: {
        organizationId, actor: input.actor, principalKey: input.principalKey,
        ...(input.initiatingActor ? { initiatingActor: input.initiatingActor } : {}),
        origin: input.origin, originTrust: "authenticated", requestId: null,
        kind: input.kind, scope: input.jobRunId, jobRunId: input.jobRunId,
      },
    }, {
      action: input.action, category: "execution", outcome: input.outcome, resources: input.resources,
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      ...(input.changes ? { changes: input.changes } : {}),
      idempotencyKey: input.idempotencyKey,
    }, auditOperationOutcome(input.outcome))
    return true
  } catch (error) {
    logAuditOutcomeLost({ requestId: null, organizationId: input.organizationId, action: input.action, error })
    return false
  }
}
