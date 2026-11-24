import type { OrganizationTable } from "@openwork-ee/den-db/schema"
import type { BillingPlanTier, OrganizationPlanState } from "@openwork/types/den/billing-plans"
import { z } from "zod"
import { updateOrganizationMetadata } from "./organization-metadata.js"
import { normalizeOrganizationMetadata } from "./organization-limits.js"
import { MAX_PLAN_USERS, applyAdminPlan, normalizePlanEndDate } from "./organization-plan.js"
import { getOrganizationPlanState } from "./organization-plan-state.js"

type OrgId = typeof OrganizationTable.$inferSelect.id

export const adminOrganizationPlanInputSchema = z.object({
  tier: z.enum(["free", "team", "enterprise"]),
  seatLimit: z.number().int().min(1).max(MAX_PLAN_USERS).describe("Users allowed, counting pending invitations. Never fewer than 5; smaller values are raised to 5."),
  endsAt: z.string().nullable().optional().describe("Optional end date for a Team or Enterprise plan, YYYY-MM-DD. Display only: nothing changes when it passes. null clears it; not allowed on Free."),
}).superRefine((value, context) => {
  if (value.endsAt === undefined || value.endsAt === null) return
  if (value.tier === "free") context.addIssue({ code: "custom", path: ["endsAt"], message: "A Free plan has no end date." })
  else if (!normalizePlanEndDate(value.endsAt)) context.addIssue({ code: "custom", path: ["endsAt"], message: "Use a date such as 2026-11-22." })
})
export type AdminOrganizationPlanInput = z.infer<typeof adminOrganizationPlanInputSchema>

export async function setOrganizationPlanByAdmin(organizationId: OrgId, input: { tier: BillingPlanTier; seatLimit: number; endsAt?: string | null }): Promise<OrganizationPlanState> {
  const now = new Date()
  await updateOrganizationMetadata(organizationId, (current) => applyAdminPlan(normalizeOrganizationMetadata(current).metadata, input, now))
  const state = await getOrganizationPlanState(organizationId)
  if (!state) throw new Error("organization_not_found")
  return state
}
