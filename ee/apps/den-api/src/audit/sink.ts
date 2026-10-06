import { AuditLogError, appendAuditEvent, type AuditContext, type AuditPolicy, type AuditTx } from "@openwork-ee/den-db/audit-log"
import type { AuditActor, AuditEventTypeDeclaration, AuditSink, AuditSinkContext } from "../core/audit/types.js"
import { readAuditAvailability, readEffectiveAuditPolicy } from "./capture.js"

/**
 * Decides whether audit capture is effective for an organization, inside the
 * capture transaction and under the organization row share lock.
 *
 * Today's gate: literal `capabilities.auditLogs` AND audit entitlement (Enterprise
 * plan or self-hosted installation entitlement) AND the deployment capture
 * switch. M-auditLogs swaps in the W0-03 module-state resolver here.
 */
export interface AuditCaptureGate {
  isEffective(tx: AuditTx, organizationId: string): Promise<boolean>
}

export const legacyAuditCaptureGate: AuditCaptureGate = {
  async isEffective(tx, organizationId) {
    const { env } = await import("../env.js")
    if (!("auditCaptureEnabled" in env) || env.auditCaptureEnabled !== true) return false
    const availability = await readAuditAvailability(tx, organizationId, true)
    return availability.featureEnabled && availability.entitlement.enabled
  },
}

function principalKey(actor: AuditActor): string {
  if (actor.type === "user") return `user:${actor.id}:member:${actor.memberId ?? "none"}:credential:${actor.credentialId ?? "session"}`
  return `${actor.type}:${actor.id ?? "unknown"}`
}

export function toAuditContext(ctx: AuditSinkContext): AuditContext {
  return {
    organizationId: ctx.organizationId,
    actor: ctx.actor,
    principalKey: principalKey(ctx.actor),
    origin: ctx.origin,
    originTrust: "authenticated",
    requestId: ctx.requestId,
    ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
    kind: ctx.kind,
    scope: ctx.scope,
    ...(ctx.workflowStep === undefined ? {} : { workflowStep: ctx.workflowStep }),
    ...(ctx.workflowStepScope === undefined ? {} : { workflowStepScope: ctx.workflowStepScope }),
  }
}

export function createAuditLogsSink(input: {
  eventTypeFor: (kind: AuditSinkContext["kind"]) => AuditEventTypeDeclaration | null
  gate?: AuditCaptureGate
  // Test seams; production uses the operation store.
  readPolicy?: (tx: AuditTx, organizationId: string) => Promise<AuditPolicy | null>
  append?: typeof appendAuditEvent
}): AuditSink {
  const gate = input.gate ?? legacyAuditCaptureGate
  const readPolicy = input.readPolicy ?? ((tx, organizationId) => readEffectiveAuditPolicy(tx, organizationId, true))
  const append = input.append ?? appendAuditEvent
  return async (tx, ctx) => {
    const declaration = input.eventTypeFor(ctx.kind)
    if (!declaration) throw new AuditLogError("audit_invalid_input")
    if (!await gate.isEffective(tx, ctx.organizationId)) return null
    const policy = await readPolicy(tx, ctx.organizationId)
    if (!policy?.enabled) return null
    const context = toAuditContext(ctx)
    return {
      async record(event) {
        if (!declaration.actions.includes(event.action) || !declaration.categories.includes(event.category)) throw new AuditLogError("audit_invalid_input")
        if (!policy.categories.includes(event.category)) return false
        return (await append(tx, { context, policy, event })) !== null
      },
    }
  }
}
