/**
 * How an organization's plan reads in Den: the plan name, its users against
 * the limit and its optional end date. Shared by /admin and the Billing page so
 * both say the same thing. The end date is a calendar date (`YYYY-MM-DD`) and
 * is formatted in UTC, the calendar it is stored in.
 */

import type { BillingPlanSummary, BillingPlanTier } from "@openwork/types/den/billing-plans";
import type { DenOrgSummary } from "./den-org";

export type PlanTierName = BillingPlanTier;

export function planName(tier: PlanTierName): string {
  return tier === "enterprise" ? "Enterprise" : tier === "team" ? "Team" : "Free";
}

/** Workspace identity comes from Den, not the signed-in person's role. */
export function organizationPlanLabel(organization: Pick<DenOrgSummary, "planTier" | "isSandbox">): string | null {
  if (organization.isSandbox) return "Sandbox";
  return organization.planTier ? `${planName(organization.planTier)} plan` : null;
}

function parseCalendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

/** "Nov 22" or, with `year`, "Nov 22, 2026". Unparseable values are returned as they are. */
export function formatPlanDate(value: string, options: { year?: boolean } = {}): string {
  const date = parseCalendarDate(value);
  if (!date) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(options.year ? { year: "numeric" } : {}), timeZone: "UTC" });
}

/** Whether the end date has passed (the end date itself is still the plan's last day). */
export function planEnded(endsAt: string | null, now = new Date()): boolean {
  return endsAt !== null && endsAt < now.toISOString().slice(0, 10);
}

/** "ends Nov 22" / "ended Nov 22", or null when the plan has no end date. */
export function planEndLabel(endsAt: string | null, ended: boolean, options: { year?: boolean } = {}): string | null {
  if (!endsAt) return null;
  return `${ended ? "ended" : "ends"} ${formatPlanDate(endsAt, options)}`;
}

export function countLabel(value: number, singular: string, plural = `${singular}s`): string {
  return `${new Intl.NumberFormat("en-US").format(value)} ${value === 1 ? singular : plural}`;
}

/**
 * "7 of 20 users · ends Nov 22, 2026" for a Team or Enterprise plan OpenWork
 * set (it has a user limit and no Stripe bill); null otherwise.
 */
export function planUsageLabel(plan: Pick<BillingPlanSummary, "tier" | "source" | "people" | "userLimit" | "endsAt">, now = new Date()): string | null {
  if (plan.tier === "free" || plan.source === "stripe" || plan.userLimit === null) return null;
  const end = planEndLabel(plan.endsAt, planEnded(plan.endsAt, now), { year: true });
  return `${plan.people} of ${plan.userLimit} users${end ? ` · ${end}` : ""}`;
}
