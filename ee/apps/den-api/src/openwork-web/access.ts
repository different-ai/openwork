import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { openWorkWebPaidSource } from "../core/providers/openwork-web-paid-source.js"
import { db } from "../db.js"
import { isOpenWorkWebAvailable } from "../openwork-web-availability.js"
import { hasOpenWorkWebComplimentaryAccess } from "./complimentary.js"
import { resolveOpenWorkWebAccess } from "./resolve.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type OrganizationMetadata = Record<string, unknown> | string | null | undefined

export async function readOrganizationOpenWorkWebComplimentaryAccess(organizationId: OrgId) {
  const rows = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)
  return hasOpenWorkWebComplimentaryAccess(rows[0]?.metadata)
}

async function hasEligiblePaidSubscription(organizationId: OrgId) {
  return (await openWorkWebPaidSource()?.hasEligibleSubscription(organizationId)) ?? false
}

/**
 * Whether the organization may use OpenWork Web (Cloud instances, workers,
 * remote sessions). Pass `metadata` when the caller already read the
 * organization row; otherwise it is read here.
 */
export async function getOpenWorkWebAccess(organizationId: OrgId, options: { metadata?: OrganizationMetadata } = {}) {
  const [hasEligibleSubscription, complimentaryAccess] = await Promise.all([
    hasEligiblePaidSubscription(organizationId),
    options.metadata === undefined
      ? readOrganizationOpenWorkWebComplimentaryAccess(organizationId)
      : Promise.resolve(hasOpenWorkWebComplimentaryAccess(options.metadata)),
  ])
  return resolveOpenWorkWebAccess({
    deploymentAvailable: isOpenWorkWebAvailable(),
    hasEligibleSubscription,
    complimentaryAccess,
  })
}
