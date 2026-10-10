import type { PermissionKey } from "@openwork/types/den/permissions"
import type { PermissionDatabase } from "@openwork-ee/den-db/permissions"
import type { MemberTable } from "@openwork-ee/den-db/schema"
import { resolvePermissionsForMember } from "./resolve.js"

type OrganizationId = typeof MemberTable.$inferSelect.organizationId
type MemberId = typeof MemberTable.$inferSelect.id

/** Thrown inside a write transaction when the actor no longer holds the key, so the transaction rolls back. */
export class PermissionRevokedError extends Error {
  constructor(readonly key: PermissionKey) {
    super(`permission_revoked:${key}`)
    this.name = "PermissionRevokedError"
  }
}

/**
 * Re-checks inside a write transaction the key the route already checked
 * against the request's permissions (where the recent sign-in is enforced):
 * the actor is resolved through `tx`, so a revocation committed after the
 * route check is seen before the write. Throws PermissionRevokedError.
 */
export async function requireHeldInTransaction(tx: PermissionDatabase, input: { organizationId: OrganizationId; memberId: MemberId; key: PermissionKey }): Promise<void> {
  const actor = await resolvePermissionsForMember({ organizationId: input.organizationId, memberId: input.memberId, database: tx })
  if (!actor.has(input.key)) throw new PermissionRevokedError(input.key)
}
