import { randomUUID } from "node:crypto"
import type { AuditTx } from "@openwork-ee/den-db/audit-log"
import { AuditEventTable } from "@openwork-ee/den-db/schema"
import { buildOrganizationAuditEvent, logOrganizationAuditAlert, logOrganizationAuditEvent, recordOrganizationAuditEvent, type OrganizationAuditEvent } from "../../audit-events.js"
import { db } from "../../db.js"
import { appendAuditChanges, logAuditOutcomeLost, type AuditChangeCapture, type AuditChangeEventInput } from "../request-capture.js"
import { withAuditRetry } from "../retry.js"

export type LegacyAuditRecord = Parameters<typeof buildOrganizationAuditEvent>[0]

export async function appendDomainChanges(tx: AuditTx, capture: AuditChangeCapture | null, events: readonly (AuditChangeEventInput | null)[]): Promise<string[]> {
  const present = events.filter((event): event is AuditChangeEventInput => event !== null)
  return appendAuditChanges(tx, capture, present)
}

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

export async function finishLegacyAuditAction(capture: AuditChangeCapture | null, record: LegacyAuditRecord, auditEventIds: readonly string[] = []): Promise<void> {
  if (!capture) {
    await recordOrganizationAuditEvent(record)
    return
  }
  logBridgedAuditAlert(capture, record, auditEventIds)
}

export type LegacyOrChanges = Readonly<{ record: LegacyAuditRecord; legacyEvent: OrganizationAuditEvent | null; auditEventIds: string[] }>

export async function writeLegacyOrChangesInTx(tx: AuditTx, capture: AuditChangeCapture | null, record: LegacyAuditRecord, events: readonly (AuditChangeEventInput | null)[]): Promise<LegacyOrChanges> {
  if (!capture) {
    const legacyEvent = buildOrganizationAuditEvent(record)
    await tx.insert(AuditEventTable).values(legacyEvent)
    return { record, legacyEvent, auditEventIds: [] }
  }
  return { record, legacyEvent: null, auditEventIds: await appendDomainChanges(tx, capture, events) }
}

export function logLegacyOrChanges(capture: AuditChangeCapture | null, written: LegacyOrChanges): void {
  if (written.legacyEvent) logOrganizationAuditEvent(written.legacyEvent)
  else if (capture) logBridgedAuditAlert(capture, written.record, written.auditEventIds)
}
