import type { AuditChangeEventInput } from "../request-capture.js"
import { auditChangeEvent, targetResource } from "./snapshot.js"

function organizationTarget(organizationId: string) {
  return [targetResource("organization", organizationId)]
}

export function dpaSignedUpdatedEvent(organizationId: string, before: boolean | null, after: boolean, reasonProvided: boolean): AuditChangeEventInput | null {
  return auditChangeEvent({ action: "organization.dpa_signed.updated", resources: organizationTarget(organizationId), before: { dpaSigned: before }, after: { dpaSigned: after }, annotations: { reasonProvided } })
}

export function complimentaryAccessEvent(organizationId: string, before: boolean, after: boolean, reasonProvided: boolean): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: after ? "organization.complimentary_access.granted" : "organization.complimentary_access.revoked", resources: organizationTarget(organizationId),
    before: { openworkWebComplimentaryAccess: before }, after: { openworkWebComplimentaryAccess: after }, annotations: { reasonProvided },
  })
}
