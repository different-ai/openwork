"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Lock } from "lucide-react";
import type { AdminOrganizationDetail } from "@openwork/types/den/admin-organization";
import { organizationPlanStateSchema, type OrganizationPlanState } from "@openwork/types/den/billing-plans";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenInput } from "../../app/(den)/_components/ui/input";
import { DenSelect } from "../../app/(den)/_components/ui/select";
import { DenSwitch } from "../../app/(den)/_components/ui/switch";
import { countLabel, formatPlanDate, planName, type PlanTierName } from "../../app/(den)/_lib/plan-display";
import type { AdminFeatureAccessFailure } from "./admin-organization-feature-controls";
import { sendAdmin } from "./admin-request";

type Organization = AdminOrganizationDetail["organization"];
type Draft = { tier: PlanTierName; users: string; endsAt: string };

const FREE_USERS = 5;
const organizationPath = (organizationId: string) => `/v1/admin/organizations/${encodeURIComponent(organizationId)}`;

function draftFrom(plan: OrganizationPlanState): Draft {
  return {
    tier: plan.tier,
    users: String(plan.seats ?? plan.userLimit ?? FREE_USERS),
    endsAt: plan.endsAt ?? "",
  };
}

function subscriptionLabel(organization: Organization): string {
  const team = organization.subscriptions?.team ?? null;
  return team ? `Team · ${team.status.replace(/_/g, " ")}` : "No Team subscription";
}

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="flex min-h-11 items-center justify-between gap-4 border-t border-[var(--dls-border)] py-2 text-[13px]">
      <span className="font-medium text-[color:var(--dls-text-primary)]">{label}</span>
      <div className="min-w-0 text-right text-[color:var(--dls-text-secondary)]">{children}</div>
    </div>
  );
}

/**
 * /admin › organization › Billing: the one place a platform admin sets an
 * organization's plan and how many users it may have (enforced the same way
 * by invitations, SSO and SCIM), plus its Team subscription in Stripe and
 * complimentary OpenWork Web. Enterprise is set here and invoiced outside
 * OpenWork; it is never linked to Stripe.
 */
export function AdminOrganizationBilling({ organization, onSaved, onAccessFailure }: {
  organization: Organization;
  onSaved: () => void;
  onAccessFailure: (failure: AdminFeatureAccessFailure) => void;
}) {
  const [plan, setPlan] = useState<OrganizationPlanState | null>(organization.plan ?? null);
  const [draft, setDraft] = useState<Draft | null>(organization.plan ? draftFrom(organization.plan) : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webDraft, setWebDraft] = useState<{ enabled: boolean; reason: string } | null>(null);
  const [webSaving, setWebSaving] = useState(false);
  const [webError, setWebError] = useState<string | null>(null);

  useEffect(() => {
    if (!organization.plan) return;
    setPlan(organization.plan);
    setDraft(draftFrom(organization.plan));
  }, [organization.plan]);

  if (!plan || !draft) {
    return <p role="status" className="py-5 text-[13px] text-[color:var(--dls-text-secondary)]">This Den API does not report plans yet. Deploy the matching Den API to manage the plan here.</p>;
  }

  const saved = draftFrom(plan);
  const changed = draft.tier !== saved.tier || draft.users !== saved.users || (draft.tier !== "free" && draft.endsAt !== saved.endsAt);
  const users = Number(draft.users);
  const usersValid = Number.isInteger(users) && users >= FREE_USERS && users <= 100_000;
  const paidInStripe = plan.paidBy !== "none";
  // Setting Enterprise does not touch Stripe: a workspace still paying for Team
  // by card keeps being charged, and no user limit applies while it pays.
  const teamStillBilled = plan.paidBy === "stripe_team" && draft.tier === "enterprise";
  const joined = organization.people?.joined ?? plan.users;
  const invited = organization.people?.invited ?? 0;
  const limit = plan.userLimit;
  const share = limit ? Math.min(100, Math.round((plan.users / limit) * 100)) : 0;
  const web = organization.openworkWeb ?? null;
  const webLocked = Boolean(web && !web.complimentaryAccess && web.hasOngoingSubscription);

  async function savePlan(event: FormEvent) {
    event.preventDefault();
    if (!draft || !usersValid) return;
    setSaving(true);
    setError(null);
    const result = await sendAdmin(`${organizationPath(organization.id)}/plan`, "PATCH", {
      tier: draft.tier,
      seatLimit: users,
      ...(draft.tier === "free" ? {} : { endsAt: draft.endsAt || null }),
    });
    setSaving(false);
    if (!result.ok) {
      if (result.status === 401 || result.status === 403) onAccessFailure({ access: result.status === 401 ? "signed-out" : "forbidden", message: result.message });
      else setError(result.message);
      return;
    }
    const record = typeof result.payload === "object" && result.payload !== null && "organization" in result.payload ? result.payload.organization : null;
    const next = organizationPlanStateSchema.safeParse(typeof record === "object" && record !== null && "plan" in record ? record.plan : null);
    if (next.success) {
      setPlan(next.data);
      setDraft(draftFrom(next.data));
    }
    onSaved();
  }

  async function saveWebAccess(event: FormEvent) {
    event.preventDefault();
    if (!webDraft) return;
    setWebSaving(true);
    setWebError(null);
    const result = await sendAdmin(`${organizationPath(organization.id)}/openwork-web-access`, "PUT", { enabled: webDraft.enabled, reason: webDraft.reason.trim() });
    setWebSaving(false);
    if (!result.ok) {
      setWebError(result.message);
      return;
    }
    setWebDraft(null);
    onSaved();
  }

  return (
    <section data-testid="admin-organization-billing" aria-labelledby="admin-billing-plan-title" className="py-5 text-[color:var(--dls-text-primary)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="admin-billing-plan-title" className="text-sm font-semibold">Plan</h2>
        {plan.ended && plan.endsAt ? (
          <span data-testid="admin-billing-ended" className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">Ended {formatPlanDate(plan.endsAt, { year: true })}</span>
        ) : null}
      </div>

      <div className="mt-3 max-w-xl" data-testid="admin-billing-usage">
        <p className="text-[13px] tabular-nums">
          {limit === null
            ? `${countLabel(plan.users, "user")} · ${paidInStripe ? "no limit, Stripe bills every user" : "no limit"}`
            : `${plan.users} of ${limit} users in use · ${joined} joined, ${invited} invited`}
        </p>
        {limit !== null ? (
          <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[var(--dls-hover)]" aria-hidden="true">
            <div className={`h-full rounded-full ${plan.users >= limit ? "bg-slate-800" : "bg-slate-500"}`} style={{ width: `${Math.max(share, 2)}%` }} />
          </div>
        ) : null}
        {plan.ended ? <p className="mt-2 text-xs text-[color:var(--dls-text-secondary)]">Still active. Nothing changes until an admin edits the plan.</p> : null}
        {paidInStripe ? (
          <p data-testid="admin-billing-stripe-plan" className="mt-2 text-xs text-[color:var(--dls-text-secondary)]">
            <Lock className="mr-1 inline" size={12} aria-hidden="true" />{planName("team")} · paid in Stripe. Stripe sets this plan. Change or cancel it in Stripe.
          </p>
        ) : null}
      </div>

      <form className="mt-4 grid max-w-xl gap-3" onSubmit={savePlan} data-testid="admin-billing-plan-form">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid min-w-0 gap-1.5 text-xs font-medium text-[color:var(--dls-text-secondary)]">
            Plan
            <DenSelect aria-label="Plan" value={draft.tier} disabled={saving}
              onChange={(event) => {
                const tier = event.target.value === "team" || event.target.value === "enterprise" ? event.target.value : "free";
                setDraft({ ...draft, tier });
              }}>
              <option value="free">Free</option>
              <option value="team">Team</option>
              <option value="enterprise">Enterprise</option>
            </DenSelect>
          </label>
          <label className="grid min-w-0 gap-1.5 text-xs font-medium text-[color:var(--dls-text-secondary)]">
            Users allowed
            <DenInput aria-label="Users allowed" type="number" min={FREE_USERS} max={100000} step={1} required value={draft.users} disabled={saving}
              onChange={(event) => setDraft({ ...draft, users: event.target.value })} />
          </label>
          <label className="grid min-w-0 gap-1.5 text-xs font-medium text-[color:var(--dls-text-secondary)]">
            Ends (optional)
            <DenInput aria-label="Ends (optional)" type="date" value={draft.tier === "free" ? "" : draft.endsAt} disabled={saving || draft.tier === "free"}
              onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })} />
            {draft.tier === "free" ? <span className="font-normal">Not available on Free</span> : null}
          </label>
        </div>
        {!usersValid ? <p className="text-xs text-[color:var(--dls-text-secondary)]">Users allowed is a whole number, at least {FREE_USERS}.</p> : null}
        {teamStillBilled ? (
          <p role="status" data-testid="admin-billing-team-still-billed" className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
            This workspace still pays for Team by card. Saving Enterprise does not change Stripe: the card keeps being charged and the users allowed are not enforced until you cancel the Team subscription in Stripe.
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <DenButton type="submit" size="sm" loading={saving} disabled={!changed || !usersValid} data-testid="admin-billing-save-plan">Save plan</DenButton>
          {changed ? <DenButton type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(saved)}>Discard</DenButton> : null}
        </div>
        {error ? <p role="alert" className="text-xs text-red-700">{error}</p> : null}
      </form>

      <div className="mt-6 max-w-xl">
        <Row label="Stripe" testId="admin-billing-stripe-row">{subscriptionLabel(organization)}</Row>
        <Row label="OpenWork Web" testId="admin-billing-web-row">
          {web ? (
            <span className="inline-flex items-center gap-2">
              {webLocked ? <span className="text-xs"><Lock className="mr-1 inline" size={12} aria-hidden="true" />Paid subscription · {web.subscriptionStatus?.replace(/_/g, " ") ?? "ongoing"}</span>
                : <span className="text-xs">{web.complimentaryAccess ? "Complimentary" : web.hasAccess ? "Paid" : "Off"}</span>}
              <DenSwitch aria-label="Complimentary OpenWork Web" size="sm" checked={webDraft?.enabled ?? web.complimentaryAccess} disabled={webLocked || webSaving}
                testId="admin-billing-web-switch"
                onChange={(enabled) => setWebDraft(enabled === web.complimentaryAccess ? null : { enabled, reason: "" })} />
            </span>
          ) : "Not reported"}
        </Row>
        {webLocked ? <p className="pb-2 text-right text-xs text-[color:var(--dls-text-secondary)]">Cancel or finish the paid OpenWork Web subscription in Stripe to give complimentary access.</p> : null}
        {webDraft ? (
          <form className="flex flex-wrap items-end justify-end gap-2 pb-3" onSubmit={saveWebAccess}>
            <label className="grid min-w-0 flex-1 gap-1 text-xs text-[color:var(--dls-text-secondary)]">
              Reason for the audit log
              <DenInput aria-label="Reason for the audit log" required minLength={3} maxLength={500} value={webDraft.reason} disabled={webSaving}
                onChange={(event) => setWebDraft({ ...webDraft, reason: event.target.value })} />
            </label>
            <DenButton type="submit" size="sm" loading={webSaving} disabled={webDraft.reason.trim().length < 3}>{webDraft.enabled ? "Give OpenWork Web" : "Remove OpenWork Web"}</DenButton>
            <DenButton type="button" size="sm" variant="ghost" disabled={webSaving} onClick={() => { setWebDraft(null); setWebError(null); }}>Cancel</DenButton>
            {webError ? <p role="alert" className="w-full text-right text-xs text-red-700">{webError}</p> : null}
          </form>
        ) : null}
      </div>
    </section>
  );
}
