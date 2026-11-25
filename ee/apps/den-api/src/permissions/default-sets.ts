import {
  ensureDefaultPermissionSets,
  reconcileDefaultPermissionSets,
  type DefaultPermissionSets,
} from "@openwork-ee/den-db/permissions"
import type { OrganizationTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"

type OrganizationId = typeof OrganizationTable.$inferSelect.id

export async function ensureCurrentDefaultPermissionSets(organizationId: OrganizationId): Promise<DefaultPermissionSets> {
  const sets = await ensureDefaultPermissionSets(db, organizationId)
  await reconcileDefaultPermissionSets(db, { organizationId })
  return sets
}
