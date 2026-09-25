import type { AuditEventEnvelope, AuditOperationSummary, AuditPolicy, AuditUsageResponse } from "@openwork/types/den/audit";
import { parseOrgContextPayload } from "../app/(den)/_lib/den-org";
import type { useOrgDashboard } from "../app/(den)/dashboard/_providers/org-dashboard-provider";

export const auditEventTypes = { eventTypes: ["provider.credential.updated", "provider.updated"] };
export const auditScope = { orgId: "org-a", memberId: "member-a" };
export const auditOperation: AuditOperationSummary = {
  id: "operation-a", kind: "provider.save", scope: "provider-a", action: "provider.updated",
  initiatingActor: { type: "user", id: "user-a" }, origin: "cloud_ui", originTrust: "authenticated",
  startedAt: "2026-09-25T10:00:00.000Z", outcome: "partial", eventCount: 3, logicalBytes: 900,
  resources: [{ type: "provider", id: "provider-a", relationship: "target", label: "Team models" }],
};
export const auditEvent: AuditEventEnvelope = {
  schemaVersion: 1, id: "event-a", organizationId: "org-a", operationId: "operation-a", sequence: 1,
  operation: { kind: "provider.save", scope: "provider-a", origin: "cloud_ui", originTrust: "authenticated", initiatingActor: auditOperation.initiatingActor, startedAt: auditOperation.startedAt },
  actor: auditOperation.initiatingActor, action: "provider.updated", category: "change", outcome: "succeeded",
  occurredAt: auditOperation.startedAt, recordedAt: auditOperation.startedAt, requestId: "request-a",
  resources: auditOperation.resources, changes: { before: { name: "Old models" }, after: { name: "Team models" }, changedFields: ["name"] }, logicalBytes: 300,
};
export const auditPolicy: AuditPolicy = { organizationId: "org-a", revision: 1, source: "operator", enabled: true, categories: ["change", "security"], allowance: 10000, excessMode: "delete_oldest", effectiveAt: auditOperation.startedAt, captureStartedAt: auditOperation.startedAt, attachmentWindowSeconds: 120 };
export const auditUsage: AuditUsageResponse = {
  entitlement: { enabled: true, source: "self_hosted" }, captureOn: true, captureAvailable: true,
  policy: auditPolicy,
  captureEnabled: true, retainedOperations: 20, eventCount: 43, logicalBytes: 12000, oldestAvailableAt: auditOperation.startedAt, measuredAt: auditOperation.startedAt,
  billing: "disabled", cleanup: "dry_run", drains: "not_configured",
};
export function operationsPage(operations = [auditOperation], nextCursor: string | null = null) {
  return { operations, nextCursor, snapshotSequence: 10 };
}
export function eventsPage(events = [auditEvent], nextCursor: string | null = null) {
  return { events, nextCursor, snapshotSequence: 10 };
}
export function auditDashboard(orgId = "org-a", role = "owner"): ReturnType<typeof useOrgDashboard> {
  const orgContext = parseOrgContextPayload({
    organization: { id: orgId, name: "Test workspace", slug: orgId },
    currentMember: { id: `member-${orgId}`, userId: "user-a", role, isOwner: role === "owner" },
    members: [{ id: "member-a", userId: "user-a", role: "owner", user: { id: "user-a", name: "Test owner", email: "owner@example.test" } }],
  });
  if (!orgContext) throw new Error("Invalid audit fixture");
  const noop = async () => {};
  return {
    orgId, orgSlug: orgId, orgDirectory: [], activeOrg: null, orgContext, orgSelectionOpen: false, orgBusy: false, orgError: null,
    mutationBusy: null, reauthDialogOpen: false, orgSettingsCompletion: null, clearOrgSettingsCompletion: noop,
    refreshOrgData: noop, createOrganization: noop, updateOrganizationName: noop, updateOrganizationSettings: noop, deleteOrganization: noop,
    switchOrganization: noop, inviteMember: noop, startSeatCheckout: noop, cancelInvitation: noop, updateMemberRole: noop, removeMember: noop,
    transferOwnership: noop, createTeam: noop, updateTeam: noop, deleteTeam: noop, createRole: noop, updateRole: noop, deleteRole: noop,
    runReauthableAction: async (_label, action) => action(),
  };
}
