"use client";

import { useState } from "react";
import { Check, LockKeyhole } from "lucide-react";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenInput } from "../../_components/ui/input";
import { DenLineItemRow, DenMarkTile } from "../../_components/ui/line-item-row";
import { DenNotice } from "../../_components/ui/notice";
import { DenSectionHeader } from "../../_components/ui/section-header";
import { formatMoneyMinor } from "../../_lib/den-flow";
import {
  billingNotConfiguredMessage,
  defaultTeamPeople,
  peopleLabel,
  PLAN_MAX_ADD_PEOPLE,
  quotePlan,
  type BillingPlans,
  type BillingPlanSummary,
} from "../../_lib/billing-checkout";
import { planUsageLabel } from "../../_lib/plan-display";

const TIER_NAMES: Record<BillingPlanSummary["tier"], string> = { free: "Free", team: "Team", enterprise: "Enterprise" };

/**
 * The workspace's plan, first on Billing: which plan it is on, the people it
 * counts, and starting Team for every person at $10.
 * Add-ons such as OpenWork Models stay separate purchases below.
 */
export function BillingPlanCard({
  plan,
  plans,
  seatQuantity,
  seatInterval,
  canManageBilling,
  canOpenPortal,
  requestedAddPeople,
  busy,
  notSold,
  onStartTeam,
  onOpenPortal,
}: {
  plan: BillingPlanSummary;
  plans: BillingPlans;
  /** Quantity on the active plan subscription, when there is one. */
  seatQuantity: number | null;
  seatInterval: string;
  canManageBilling: boolean;
  canOpenPortal: boolean;
  requestedAddPeople: number | null;
  busy: "plan-checkout" | "portal" | null;
  /** The last Start Team answered 503 billing_not_configured. */
  notSold: boolean;
  onStartTeam: (addPeople: number) => void;
  onOpenPortal: () => void;
}) {
  const [teamPeople, setTeamPeople] = useState(() => defaultTeamPeople(plan, requestedAddPeople));
  const minimum = Math.max(1, plan.people);
  const people = Math.min(plan.people + PLAN_MAX_ADD_PEOPLE, Math.max(minimum, teamPeople));
  const team = plans.team;
  const quote = quotePlan({ plan: "team", people: plan.people, addPeople: people - plan.people });
  const paidByStripe = plan.source === "stripe" && plan.tier !== "free";
  const unitAmount = team.unitAmount;
  const billedPeople = seatQuantity ?? plan.people;
  const teamSold = team.available && !notSold;
  const adminSetUsage = planUsageLabel(plan);

  return (
    <DenCard className="mb-6" data-testid="billing-plan-card">
      <DenSectionHeader
        title="Plan"
        description={adminSetUsage ?? peopleLabel(plan)}
        action={
          plan.tier === "free"
            ? <DenBadge tone="neutral">Free</DenBadge>
            : <DenBadge tone="success" icon={Check}>{TIER_NAMES[plan.tier]}</DenBadge>
        }
      />

      <div className="mt-4 border-t border-gray-200">
        {plan.tier !== "free" ? (
          <DenLineItemRow
            leading={<DenMarkTile label={`${billedPeople}x`} active />}
            title={TIER_NAMES[plan.tier]}
            description={paidByStripe
              ? `${billedPeople} ${billedPeople === 1 ? "person" : "people"} × ${formatMoneyMinor(unitAmount, team.currency)}`
              : "Included for this workspace"}
            value={paidByStripe ? formatMoneyMinor(billedPeople * unitAmount, team.currency) : formatMoneyMinor(0, team.currency)}
            valueCaption={`per ${seatInterval}`}
          />
        ) : teamSold ? (
          <div className="flex flex-wrap items-end justify-between gap-4 pt-4" data-testid="billing-plan-team-offer">
            <div className="grid gap-1">
              <p className="text-[14px] font-medium text-gray-950">Team</p>
              <p className="text-[13px] text-gray-500" data-testid="billing-plan-team-quote">
                {quote.people} {quote.people === 1 ? "person" : "people"} × {formatMoneyMinor(quote.unitAmount, team.currency)} = {formatMoneyMinor(quote.monthlyTotal, team.currency)} per {team.interval}
              </p>
            </div>
            <div className="flex items-end gap-3">
              <label className="grid gap-1 text-[12px] text-gray-500">
                People on Team
                <DenInput
                  type="number"
                  className="!h-8 w-24 !px-3"
                  min={minimum}
                  max={plan.people + PLAN_MAX_ADD_PEOPLE}
                  value={people}
                  disabled={!canManageBilling}
                  onChange={(event) => {
                    const next = Number.parseInt(event.target.value, 10);
                    if (Number.isFinite(next)) setTeamPeople(next);
                  }}
                />
              </label>
              <DenButton
                size="sm"
                disabled={!canManageBilling}
                loading={busy === "plan-checkout"}
                onClick={() => onStartTeam(people - plan.people)}
              >
                Start Team
              </DenButton>
            </div>
          </div>
        ) : (
          <DenNotice
            className="mt-4"
            tone="neutral"
            icon={LockKeyhole}
            message={billingNotConfiguredMessage("team")}
          />
        )}
      </div>

      {paidByStripe ? (
        <div className="mt-4 flex justify-end">
          <DenButton variant="secondary" size="sm" disabled={!canOpenPortal} loading={busy === "portal"} onClick={onOpenPortal}>
            Manage plan
          </DenButton>
        </div>
      ) : null}
    </DenCard>
  );
}
