import type { OrganizationTable } from "@openwork-ee/den-db/schema"
import { openWorkWebPaidSource } from "../core/providers/openwork-web-paid-source.js"
import { isOpenWorkWebAvailable } from "../openwork-web-availability.js"
import { countJoinedPeopleMembers } from "../organization-member-counts.js"
import { readOrganizationOpenWorkWebComplimentaryAccess } from "./access.js"
import { composeOpenWorkWebSummary, NO_OPENWORK_WEB_BILLING } from "./resolve.js"

type OrgId = typeof OrganizationTable.$inferSelect.id

/** The OpenWork Web offer, access and (when billing is present) paid subscription for an organization. */
export async function getOpenWorkWebSummary(organizationId: OrgId) {
  const paidSource = openWorkWebPaidSource()
  const [billing, joinedMemberCount, complimentaryAccess] = await Promise.all([
    paidSource ? paidSource.billingSummary(organizationId) : Promise.resolve(NO_OPENWORK_WEB_BILLING),
    countJoinedPeopleMembers(organizationId),
    readOrganizationOpenWorkWebComplimentaryAccess(organizationId),
  ])
  return composeOpenWorkWebSummary({
    deploymentAvailable: isOpenWorkWebAvailable(),
    joinedMemberCount,
    complimentaryAccess,
    billing,
  })
}
