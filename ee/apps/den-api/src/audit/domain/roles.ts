import type { OrganizationRoleTable } from "@openwork-ee/den-db/schema"
import type { AuditChangeEventInput } from "../request-capture.js"
import { auditChangeEvent, auditText, auditTime, organizationParent, targetResource, type AuditSnapshot } from "./snapshot.js"

export type RoleAuditRow = Pick<typeof OrganizationRoleTable.$inferSelect, "id" | "role" | "permission" | "createdAt">

function permissions(value: string): string[] {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return [] }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
  const entries: string[] = []
  for (const [resource, actions] of Object.entries(parsed)) {
    if (!Array.isArray(actions)) continue
    for (const action of actions) {
      if (typeof action === "string") {
        const entry = auditText(`${resource}:${action}`, 128)
        if (entry) entries.push(entry)
      }
    }
  }
  return [...new Set(entries)].sort()
}

export function serializeRole(row: RoleAuditRow): AuditSnapshot {
  return { id: row.id, role: auditText(row.role), permissions: permissions(row.permission), createdAt: auditTime(row.createdAt) }
}

function resources(organizationId: string, row: RoleAuditRow) {
  return [targetResource("role", row.id, row.role), organizationParent(organizationId)]
}

export function roleCreatedEvent(organizationId: string, row: RoleAuditRow): AuditChangeEventInput | null {
  return auditChangeEvent({ action: "role.created", resources: resources(organizationId, row), before: null, after: serializeRole(row) })
}

export function roleUpdatedEvent(organizationId: string, before: RoleAuditRow, after: RoleAuditRow): AuditChangeEventInput | null {
  return auditChangeEvent({ action: "role.updated", resources: resources(organizationId, after), before: serializeRole(before), after: serializeRole(after) })
}

export function roleDeletedEvent(organizationId: string, row: RoleAuditRow): AuditChangeEventInput | null {
  return auditChangeEvent({ action: "role.deleted", resources: resources(organizationId, row), before: serializeRole(row), after: null })
}
