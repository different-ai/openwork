import type { OrganizationWebOriginTable } from "@openwork-ee/den-db/schema"
import type { AuditChangeEventInput } from "../request-capture.js"
import { auditChangeEvent, auditText, auditTime, organizationParent, targetResource, type AuditSnapshot } from "./snapshot.js"

// web_origin.approved / web_origin.removed (legacy organization.web_origin.*).

export type WebOriginAuditRow = Pick<typeof OrganizationWebOriginTable.$inferSelect, "id" | "origin" | "createdByOrgMemberId" | "createdAt">

export function serializeWebOrigin(row: WebOriginAuditRow): AuditSnapshot {
  return { id: row.id, origin: auditText(row.origin), createdByMemberId: row.createdByOrgMemberId, createdAt: auditTime(row.createdAt) }
}

function resources(organizationId: string, row: WebOriginAuditRow) {
  return [targetResource("web_origin", row.id, row.origin), organizationParent(organizationId)]
}

export function webOriginApprovedEvent(organizationId: string, row: WebOriginAuditRow): AuditChangeEventInput | null {
  return auditChangeEvent({ action: "web_origin.approved", resources: resources(organizationId, row), before: null, after: serializeWebOrigin(row) })
}

export function webOriginRemovedEvent(organizationId: string, row: WebOriginAuditRow): AuditChangeEventInput | null {
  return auditChangeEvent({ action: "web_origin.removed", resources: resources(organizationId, row), before: serializeWebOrigin(row), after: null })
}
