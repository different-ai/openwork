import type { SsoConnectionTable, SsoProviderTable } from "@openwork-ee/den-db/schema"
import type { AuditChangeEventInput } from "../request-capture.js"
import { auditChangeEvent, auditText, auditTime, organizationParent, targetResource, type AuditSnapshot } from "./snapshot.js"

// sso_connection.registered / .enabled / .disabled / .deleted (legacy
// organization.sso.*). Never oidcConfig/samlConfig (client secrets, keys,
// certificates), configRevision/lastTestedRevision (HMAC of the configuration),
// domainVerificationToken, lastError (IdP free text) or activeTest* state.
// A re-registration replaces the IdP configuration: recorded as the opaque
// "configuration" marker, never its contents.

export type SsoConnectionAuditRow = Pick<typeof SsoConnectionTable.$inferSelect, "id" | "providerId" | "kind" | "issuer" | "domain" | "status" | "signInPath" | "testStatus" | "lastTestedAt" | "createdAt">
export type SsoProviderAuditRow = Pick<typeof SsoProviderTable.$inferSelect, "domainVerified">

export function serializeSsoConnection(row: SsoConnectionAuditRow, provider: SsoProviderAuditRow | null): AuditSnapshot {
  return {
    id: row.id, providerId: auditText(row.providerId), kind: auditText(row.kind, 16), issuer: auditText(row.issuer, 2048), domain: auditText(row.domain),
    status: auditText(row.status, 32), signInPath: auditText(row.signInPath, 2048), testStatus: auditText(row.testStatus, 32),
    lastTestedAt: auditTime(row.lastTestedAt), domainVerified: provider ? provider.domainVerified : null, createdAt: auditTime(row.createdAt),
  }
}

function resources(organizationId: string, row: SsoConnectionAuditRow) {
  return [targetResource("sso_connection", row.id), organizationParent(organizationId)]
}

export type SsoConnectionAuditState = Readonly<{ connection: SsoConnectionAuditRow; provider: SsoProviderAuditRow | null }>

export function ssoConnectionRegisteredEvent(organizationId: string, before: SsoConnectionAuditState | null, after: SsoConnectionAuditState): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: "sso_connection.registered", resources: resources(organizationId, after.connection),
    before: before ? serializeSsoConnection(before.connection, before.provider) : null, after: serializeSsoConnection(after.connection, after.provider),
    markers: before ? ["configuration"] : [],
  })
}

/** enable/disable: a status that did not change emits nothing. */
export function ssoConnectionStatusEvent(organizationId: string, before: SsoConnectionAuditState, after: SsoConnectionAuditState): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: after.connection.status === "enabled" ? "sso_connection.enabled" : "sso_connection.disabled", resources: resources(organizationId, after.connection),
    before: serializeSsoConnection(before.connection, before.provider), after: serializeSsoConnection(after.connection, after.provider),
  })
}

export function ssoConnectionDeletedEvent(organizationId: string, before: SsoConnectionAuditState): AuditChangeEventInput | null {
  return auditChangeEvent({ action: "sso_connection.deleted", resources: resources(organizationId, before.connection), before: serializeSsoConnection(before.connection, before.provider), after: null })
}
