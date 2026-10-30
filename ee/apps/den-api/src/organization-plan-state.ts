import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable, OrgSubscriptionTable } from "@openwork-ee/den-db/schema"
import type { OrganizationPlanState, PlanPaidBy } from "@openwork/types/den/billing-plans"
import { countBillingUsersForOrganizations } from "./billing-users.js"
import { db } from "./db.js"
import { parseOrganizationPlan } from "./entitlements.js"
import { env } from "./env.js"
import { normalizeOrganizationMetadata } from "./organization-limits.js"
import { isSeatBillingGateEnabled, planPaidBy, resolveOrganizationPlanState, utcDate } from "./organization-plan.js"

type OrgId = typeof OrganizationTable.$inferSelect.id
type OrganizationRow = { id: OrgId; metadata: Record<string, unknown> | string | null | undefined }

export function seatBillingGateEnabled() {
  return isSeatBillingGateEnabled({ orgMode: env.orgMode, stripeSecretKey: env.stripe.secretKey, stripeSeatPriceId: env.stripe.seatPriceId })
}

/** Who pays for each organization's plan, from its stored Team (seat) subscription. */
async function paidByForOrganizations(organizationIds: readonly OrgId[]): Promise<Map<OrgId, PlanPaidBy>> {
  const result = new Map<OrgId, PlanPaidBy>()
  if (organizationIds.length === 0) return result
  const rows = await db
    .select({
      organizationId: OrgSubscriptionTable.organization_id,
      status: OrgSubscriptionTable.status,
    })
    .from(OrgSubscriptionTable)
    .where(and(inArray(OrgSubscriptionTable.organization_id, [...organizationIds]), eq(OrgSubscriptionTable.type, "seat")))
  for (const organizationId of organizationIds) {
    const seat = rows.find((row) => row.organizationId === organizationId) ?? null
    result.set(organizationId, planPaidBy({ seat }))
  }
  return result
}

/** Resolved plans for several organizations at once (admin lists). */
export async function getOrganizationPlanStates(organizations: readonly OrganizationRow[], now = new Date()): Promise<Map<OrgId, OrganizationPlanState>> {
  const ids = organizations.map((organization) => organization.id)
  const [usersByOrg, paidByOrg] = await Promise.all([countBillingUsersForOrganizations(ids), paidByForOrganizations(ids)])
  const gateEnabled = seatBillingGateEnabled()
  const today = utcDate(now)
  const result = new Map<OrgId, OrganizationPlanState>()
  for (const organization of organizations) {
    const metadata = normalizeOrganizationMetadata(organization.metadata).metadata
    result.set(organization.id, resolveOrganizationPlanState({
      plan: parseOrganizationPlan(metadata),
      metadata,
      users: usersByOrg.get(organization.id) ?? 0,
      paidBy: paidByOrg.get(organization.id) ?? "none",
      gateEnabled,
      today,
    }))
  }
  return result
}

/**
 * One organization's resolved plan, read fresh so a plan a platform admin
 * just set applies to the next invitation, sign-in or SCIM request. Null when
 * the organization does not exist.
 */
export async function getOrganizationPlanState(organizationId: OrgId): Promise<OrganizationPlanState | null> {
  const [organization] = await db
    .select({ id: OrganizationTable.id, metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)
  if (!organization) return null
  return (await getOrganizationPlanStates([organization])).get(organization.id) ?? null
}
