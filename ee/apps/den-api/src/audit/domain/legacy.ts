import { randomUUID } from "node:crypto"
import type { AuditTx } from "@openwork-ee/den-db/audit-log"
import { AuditEventTable } from "@openwork-ee/den-db/schema"
import { buildOrganizationAuditEvent, logOrganizationAuditAlert, logOrganizationAuditEvent, recordOrganizationAuditEvent, type OrganizationAuditEvent } from "../../audit-events.js"
import { db } from "../../db.js"
import { appendAuditChanges, logAuditOutcomeLost, type AuditChangeCapture, type AuditChangeEventInput } from "../request-capture.js"
import { withAuditRetry } from "../retry.js"

// Single-writer legacy bridge (design §5, LEGACY_ACTION_BRIDGE). With tenant
// change capture active the domain emitter appends the operation change event
// inside the business transaction and the legacy audit_event row is NOT
// written; otherwise the legacy row is written exactly as before. The
// `[audit-alert]` operator line is logged once per action either way.

export type LegacyAuditRecord = Parameters<typeof buildOrganizationAuditEvent>[0]

/**
 * Appends domain change events inside the caller's business transaction
 * (after its business row locks), dropping no-op (null) events. Returns the
 * appended event ids. A failure throws and rolls the mutation back.
 */
export async function appendDomainChanges(tx: AuditTx, capture: AuditChangeCapture | null, events: readonly (AuditChangeEventInput | null)[]): Promise<string[]> {
  const present = events.filter((event): event is AuditChangeEventInput => event !== null)
  return appendAuditChanges(tx, capture, present)
}

/**
 * For effects already committed outside a den transaction (better-auth
 * createApiKey / generateSCIMToken / registerSSOProvider, multi-step repairs):
 * a fresh transaction fences the organization, reads the resulting rows and
 * appends, retried as a whole on transient database failures (src/audit/retry.ts).
 * Events without their own idempotency key get one fixed for this call, so a
 * replay after an ambiguous commit returns the stored events. Failure cannot
 * roll the effect back: it logs [audit-outcome-lost] and returns no ids, never throws.
 */
export async function appendDomainChangesAfterCommit(
  capture: AuditChangeCapture | null,
  action: string,
  build: (tx: AuditTx) => Promise<readonly (AuditChangeEventInput | null)[]>,
): Promise<string[]> {
  if (!capture) return []
  const callKey = randomUUID()
  try {
    return await withAuditRetry(() => db.transaction(async (tx) => {
      const events = (await build(tx)).map((event, index) => event && event.idempotencyKey === undefined ? { ...event, idempotencyKey: `${action}:after-commit:${callKey}:${index}` } : event)
      return appendDomainChanges(tx, capture, events)
    }), { label: action, idempotent: Boolean(capture.context.requestId || capture.context.jobRunId), requestId: capture.context.requestId ?? null, organizationId: capture.context.organizationId })
  } catch (error) {
    logAuditOutcomeLost({ requestId: capture.context.requestId, organizationId: capture.context.organizationId, action, error })
    return []
  }
}

function logBridgedAuditAlert(capture: AuditChangeCapture, record: LegacyAuditRecord, auditEventIds: readonly string[]) {
  logOrganizationAuditAlert({
    auditEventId: auditEventIds[0] ?? null, organizationId: capture.context.organizationId, actorUserId: record.actorUserId ?? null,
    action: record.action, payload: record.payload ?? null, requestId: capture.context.requestId,
  })
}

/**
 * After the business commit: capture active → only the `[audit-alert]` line
 * (pointing at the appended operation event, null on a no-op); otherwise the
 * unchanged legacy row plus its alert line. Never both stores.
 */
export async function finishLegacyAuditAction(capture: AuditChangeCapture | null, record: LegacyAuditRecord, auditEventIds: readonly string[] = []): Promise<void> {
  if (!capture) {
    await recordOrganizationAuditEvent(record)
    return
  }
  logBridgedAuditAlert(capture, record, auditEventIds)
}

export type LegacyOrChanges = Readonly<{ record: LegacyAuditRecord; legacyEvent: OrganizationAuditEvent | null; auditEventIds: string[] }>

/**
 * In-transaction single writer for routes whose legacy row was already written
 * atomically (platform-admin settings): the legacy row in the same transaction
 * without capture, otherwise the change events. Pair with logLegacyOrChanges
 * after commit.
 */
export async function writeLegacyOrChangesInTx(tx: AuditTx, capture: AuditChangeCapture | null, record: LegacyAuditRecord, events: readonly (AuditChangeEventInput | null)[]): Promise<LegacyOrChanges> {
  if (!capture) {
    const legacyEvent = buildOrganizationAuditEvent(record)
    await tx.insert(AuditEventTable).values(legacyEvent)
    return { record, legacyEvent, auditEventIds: [] }
  }
  return { record, legacyEvent: null, auditEventIds: await appendDomainChanges(tx, capture, events) }
}

/** The `[audit-alert]` line for a committed writeLegacyOrChangesInTx result. */
export function logLegacyOrChanges(capture: AuditChangeCapture | null, written: LegacyOrChanges): void {
  if (written.legacyEvent) logOrganizationAuditEvent(written.legacyEvent)
  else if (capture) logBridgedAuditAlert(capture, written.record, written.auditEventIds)
}
