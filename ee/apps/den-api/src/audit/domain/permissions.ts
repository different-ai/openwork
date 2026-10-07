import type { PermissionSetTable } from "@openwork-ee/den-db/schema"
import type { AuditChangeEventInput } from "../request-capture.js"
import { auditChangeEvent, auditText, auditTime, organizationParent, relatedResource, targetResource, type AuditSnapshot } from "./snapshot.js"

// permission_set.created / permission_set.permissions_changed / permission_set.archived
// (legacy organization.permission_set.*). Permission keys are listed as sorted
// string arrays, never used as snapshot keys.

export type PermissionSetAuditRow = Pick<typeof PermissionSetTable.$inferSelect, "id" | "name" | "defaultKey" | "createdAt" | "archivedAt">

export type PermissionSetAuditState = {
  set: PermissionSetAuditRow
  teamId: string | null
  allowedKeys: readonly string[]
}

function keyList(keys: readonly string[]): string[] {
  return [...new Set(keys.map((key) => auditText(key, 128)).filter((key): key is string => key !== null))].sort()
}

function serializePermissionSet(state: PermissionSetAuditState): AuditSnapshot {
  return {
    id: state.set.id,
    name: auditText(state.set.name),
    kind: state.set.defaultKey === null ? "team" : `${state.set.defaultKey}_default`,
    teamId: state.teamId,
    allowed: keyList(state.allowedKeys),
    createdAt: auditTime(state.set.createdAt),
    archivedAt: auditTime(state.set.archivedAt),
  }
}

function resources(organizationId: string, state: PermissionSetAuditState) {
  return [
    targetResource("permission_set", state.set.id, state.set.name),
    state.teamId ? relatedResource("team", state.teamId) : null,
    organizationParent(organizationId),
  ]
}

export function permissionSetCreatedEvent(organizationId: string, state: PermissionSetAuditState): AuditChangeEventInput | null {
  return auditChangeEvent({ action: "permission_set.created", resources: resources(organizationId, state), before: null, after: serializePermissionSet(state) })
}

/** `granted` / `revoked` annotate the event; the change itself is the `allowed` list. */
export function permissionSetPermissionsChangedEvent(
  organizationId: string,
  before: PermissionSetAuditState,
  after: PermissionSetAuditState,
  delta: { granted: readonly string[]; revoked: readonly string[] },
): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: "permission_set.permissions_changed",
    resources: resources(organizationId, after),
    before: serializePermissionSet(before),
    after: serializePermissionSet(after),
    annotations: { granted: keyList(delta.granted), revoked: keyList(delta.revoked) },
  })
}

/** Archiving also soft-removes the set's team link; the set row and its history stay. */
export function permissionSetArchivedEvent(organizationId: string, before: PermissionSetAuditState, after: PermissionSetAuditState): AuditChangeEventInput | null {
  return auditChangeEvent({ action: "permission_set.archived", resources: resources(organizationId, before), before: serializePermissionSet(before), after: serializePermissionSet(after) })
}
