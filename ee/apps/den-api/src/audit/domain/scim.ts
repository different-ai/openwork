import type { AuditCategory } from "@openwork/types/den/audit"
import type { ScimProviderTable } from "@openwork-ee/den-db/schema"
import type { AuditChangeCapture, AuditChangeEventInput } from "../request-capture.js"
import { auditChangeEvent, auditText, auditTime, organizationParent, targetResource, type AuditSnapshot } from "./snapshot.js"

// scim_connection.token_rotated / .deleted / .reconciled and
// scim_group_mapping.updated (legacy organization.scim.*). The bearer token
// (encrypted scimToken) is never read into evidence: rotation is the opaque
// "credentialMaterial" marker, never the value or a hash of it.

export type ScimConnectionAuditRow = Pick<typeof ScimProviderTable.$inferSelect, "id" | "providerId" | "groupMappingMode" | "createdAt">
export type ScimReconciliationResult = Readonly<{ checked: number; repaired: number; failures: number }>

export function serializeScimConnection(row: ScimConnectionAuditRow): AuditSnapshot {
  return { id: row.id, providerId: auditText(row.providerId), groupMappingMode: auditText(row.groupMappingMode, 32), createdAt: auditTime(row.createdAt) }
}

function resources(organizationId: string, row: ScimConnectionAuditRow) {
  return [targetResource("scim_connection", row.id), organizationParent(organizationId)]
}

/** `before` null when the connector is created by this rotation. */
export function scimTokenRotatedEvent(organizationId: string, before: ScimConnectionAuditRow | null, after: ScimConnectionAuditRow): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: "scim_connection.token_rotated", resources: resources(organizationId, after),
    before: before ? serializeScimConnection(before) : null, after: serializeScimConnection(after), markers: ["credentialMaterial"],
  })
}

export function scimConnectionDeletedEvent(organizationId: string, row: ScimConnectionAuditRow): AuditChangeEventInput | null {
  return auditChangeEvent({ action: "scim_connection.deleted", resources: resources(organizationId, row), before: serializeScimConnection(row), after: null })
}

/** No-op (mode unchanged) emits nothing. */
export function scimGroupMappingUpdatedEvent(organizationId: string, before: ScimConnectionAuditRow, nextMode: string): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: "scim_group_mapping.updated", resources: resources(organizationId, before),
    before: { groupMappingMode: auditText(before.groupMappingMode, 32) }, after: { groupMappingMode: auditText(nextMode, 32) },
  })
}

/**
 * A reconciliation run is system work, not a resource state change: execution
 * category when selected (else change), counts only as the run summary.
 */
export function scimReconciledEvent(capture: AuditChangeCapture, connection: ScimConnectionAuditRow | null, result: ScimReconciliationResult): AuditChangeEventInput | null {
  const category: AuditCategory = capture.policy.categories.includes("execution") ? "execution" : "change"
  return auditChangeEvent({
    action: "scim_connection.reconciled", category,
    resources: [connection ? targetResource("scim_connection", connection.id) : targetResource("scim_connection", `collection:scim_connection`), organizationParent(capture.context.organizationId)],
    before: null, after: { checked: result.checked, repaired: result.repaired, failures: result.failures },
  })
}
