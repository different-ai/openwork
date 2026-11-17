import { Armchair, Building2, CalendarClock, CreditCard, DoorOpen, Gauge, MoonStar, UsersRound, type LucideIcon } from "lucide-react";
import type { OutreachPlay } from "@openwork/types/den/admin-organization";
import { DenBadge } from "../../app/(den)/_components/ui/badge";

export const shortDate = (value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

// What each reason asks of the person working the list.
export const PLAY: Record<OutreachPlay, { label: string; ask: string; icon: LucideIcon; tone: string }> = {
  follow_up: { label: "Follow up", ask: "You wrote and no reply is recorded. Nudge once, or close it.", icon: CalendarClock, tone: "text-[var(--dls-accent)]" },
  payment: { label: "Payment failed", ask: "Flag the failed payment before access is interrupted.", icon: CreditCard, tone: "text-[var(--ow-warning)]" },
  cancelling: { label: "Leaving", ask: "Ask what was missing while they still remember.", icon: DoorOpen, tone: "text-[var(--ow-warning)]" },
  team_no_plan: { label: "Team, no plan", ask: "Several people use it here. Offer the Team plan and a setup session.", icon: UsersRound, tone: "text-[var(--ow-success)]" },
  seats_full: { label: "Seats full", ask: "Offer help adding more people.", icon: Armchair, tone: "text-[var(--ow-success)]" },
  company: { label: "Same company", ask: "Colleagues use it in separate workspaces. Offer one shared workspace.", icon: Building2, tone: "text-[var(--ow-success)]" },
  free_limit: { label: "Hit free limit", ask: "They ran out of free model use. Offer the Models add-on.", icon: Gauge, tone: "text-[var(--dls-accent)]" },
  quiet_paying: { label: "Paying, quiet", ask: "Paying but no tasks seen. Check in before renewal.", icon: MoonStar, tone: "text-[var(--dls-text-secondary)]" },
};

type Billing = { plan: "free" | "team" | "enterprise"; paying: boolean; modelsAddOn: boolean };
type Outreach = { status: "not_contacted" | "contacted"; lastContactedAt: string | null };
const PLAN_LABEL: Record<Billing["plan"], string> = { free: "Free", team: "Team", enterprise: "Enterprise" };

// Matches the sales sheet's "Paying or not paying" and "Plan they are on" columns.
export function BillingCell({ billing }: { billing: Billing }) {
  return <div className="whitespace-nowrap">
    <DenBadge size="sm" tone={billing.paying ? "success" : "neutral"}>{billing.paying ? "Paying" : "Not paying"}</DenBadge>
    <p className="mt-1 text-xs text-[var(--dls-text-secondary)]">{PLAN_LABEL[billing.plan]}{billing.modelsAddOn ? " + Models add-on" : ""}</p>
  </div>;
}

export function OutreachCell({ outreach }: { outreach: Outreach }) {
  return <div className="whitespace-nowrap">
    <DenBadge size="sm" tone={outreach.status === "contacted" ? "info" : "warning"}>{outreach.status === "contacted" ? "Contacted" : "Not contacted"}</DenBadge>
    {outreach.lastContactedAt ? <p className="mt-1 text-xs text-[var(--dls-text-secondary)]">Last {shortDate(outreach.lastContactedAt)}</p> : null}
  </div>;
}
