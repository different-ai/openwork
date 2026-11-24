import type { PermissionKey } from "@openwork/types/den/permissions"
import type { PermissionDatabase } from "@openwork-ee/den-db/permissions"
import type { MemberTable } from "@openwork-ee/den-db/schema"
import { resolvePermissionsForMember } from "./resolve.js"

type OrganizationId = typeof MemberTable.$inferSelect.organizationId
type MemberId = typeof MemberTable.$inferSelect.id

export class PermissionRevokedError extends Error {
  constructor(readonly key: PermissionKey) {
    super(`permission_revoked:${key}`)
    this.name = "PermissionRevokedError"
  }
}

export async function requireHeldInTransaction(tx: PermissionDatabase, input: { organizationId: OrganizationId; memberId: MemberId; key: PermissionKey }): Promise<void> {
  const actor = await resolvePermissionsForMember({ organizationId: input.organizationId, memberId: input.memberId, database: tx })
  if (!actor.has(input.key)) throw new PermissionRevokedError(input.key)
}
