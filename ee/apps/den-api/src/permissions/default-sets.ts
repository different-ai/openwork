import {
  ensureDefaultPermissionSets,
  reconcileDefaultPermissionSets,
  type DefaultPermissionSets,
} from "@openwork-ee/den-db/permissions"
import type { OrganizationTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { appLogger } from "../observability/logger.js"

type OrganizationId = typeof OrganizationTable.$inferSelect.id

const logger = appLogger.child({ component: "permissions" })

/**
 * Creates the organization's Member and Admin default sets if missing and adds
 * any catalog keys new since they were seeded (docs/permissions/overview.md,
 * section 8). Idempotent.
 */
export async function ensureCurrentDefaultPermissionSets(organizationId: OrganizationId): Promise<DefaultPermissionSets> {
  const sets = await ensureDefaultPermissionSets(db, organizationId)
  await reconcileDefaultPermissionSets(db, { organizationId })
  return sets
}

/**
 * Seeds the default sets when a platform admin turns Permissions on for one
 * organization. Never throws: the toggle has already been written, and
 * resolution seeds lazily on first use if this fails.
 */
export async function seedDefaultPermissionSetsOnEnable(organizationId: OrganizationId): Promise<void> {
  try {
    await ensureCurrentDefaultPermissionSets(organizationId)
  } catch (error) {
    logger.error("seeding default permission sets on enable failed; resolution will seed lazily", {
      organization_id: organizationId,
      error,
    })
  }
}
