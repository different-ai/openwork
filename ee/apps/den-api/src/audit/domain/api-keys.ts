import { AuthApiKeyTable } from "@openwork-ee/den-db/schema"
import type { AuditChangeEventInput } from "../request-capture.js"
import { auditChangeEvent, auditText, auditTime, organizationParent, relatedResource, targetResource, type AuditSnapshot } from "./snapshot.js"

// api_key.created / api_key.deleted (legacy organization.api_key.*) and
// api_key.revoked (implicit revocation when a member's access changes).
// Allowlist: never `key` (hash), `start` (plaintext-derived), permissions,
// request counters or refill state.

/** Select only these columns for audit reads: the key hash never leaves the database. */
export const apiKeyAuditColumns = {
  id: AuthApiKeyTable.id, name: AuthApiKeyTable.name, prefix: AuthApiKeyTable.prefix, enabled: AuthApiKeyTable.enabled, expiresAt: AuthApiKeyTable.expiresAt,
  rateLimitEnabled: AuthApiKeyTable.rateLimitEnabled, rateLimitMax: AuthApiKeyTable.rateLimitMax, rateLimitTimeWindow: AuthApiKeyTable.rateLimitTimeWindow, createdAt: AuthApiKeyTable.createdAt,
}
export type ApiKeyAuditRow = Pick<typeof AuthApiKeyTable.$inferSelect, "id" | "name" | "prefix" | "enabled" | "expiresAt" | "rateLimitEnabled" | "rateLimitMax" | "rateLimitTimeWindow" | "createdAt">
export type ApiKeyAuditOwner = Readonly<{ userId: string; memberId: string }>
export type ApiKeyRevocationReason = "member_role_changed" | "member_removed" | "ownership_transferred" | "role_permissions_changed" | "member_access_changed"

export function serializeApiKey(row: ApiKeyAuditRow, owner: ApiKeyAuditOwner): AuditSnapshot {
  return {
    id: row.id, name: auditText(row.name), prefix: auditText(row.prefix, 64), enabled: row.enabled, expiresAt: auditTime(row.expiresAt),
    rateLimitEnabled: row.rateLimitEnabled, rateLimitMax: row.rateLimitMax, rateLimitTimeWindow: row.rateLimitTimeWindow,
    ownerUserId: owner.userId, ownerMemberId: owner.memberId, createdAt: auditTime(row.createdAt),
  }
}

function resources(organizationId: string, row: ApiKeyAuditRow, owner: ApiKeyAuditOwner) {
  return [targetResource("api_key", row.id, row.name), organizationParent(organizationId), relatedResource("member", owner.memberId)]
}

export function apiKeyCreatedEvent(organizationId: string, row: ApiKeyAuditRow, owner: ApiKeyAuditOwner): AuditChangeEventInput | null {
  return auditChangeEvent({ action: "api_key.created", resources: resources(organizationId, row, owner), before: null, after: serializeApiKey(row, owner) })
}

export function apiKeyDeletedEvent(organizationId: string, row: ApiKeyAuditRow, owner: ApiKeyAuditOwner): AuditChangeEventInput | null {
  return auditChangeEvent({ action: "api_key.deleted", resources: resources(organizationId, row, owner), before: serializeApiKey(row, owner), after: null })
}

/** Implicit revocation (enabled → false); a key that was already disabled emits nothing. */
export function apiKeyRevokedEvent(organizationId: string, row: ApiKeyAuditRow, owner: ApiKeyAuditOwner, reason: ApiKeyRevocationReason): AuditChangeEventInput | null {
  return auditChangeEvent({
    action: "api_key.revoked", resources: resources(organizationId, row, owner), reasonCode: reason,
    before: serializeApiKey(row, owner), after: serializeApiKey({ ...row, enabled: false }, owner),
  })
}
