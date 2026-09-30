"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { Globe, Plus, Trash2, User, Users } from "lucide-react";
import {
  gatewayUsagePolicyWriteSchema, gatewayUsageTimeframes,
  type GatewayUsageLimitPolicy, type GatewayUsagePolicyWrite, type GatewayUsageTimeframe,
} from "@openwork/types/den/gateway-usage-limits";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenCombobox } from "../../_components/ui/combobox";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { DenSwitch } from "../../_components/ui/switch";
import { getAiGatewayLimitRoute, getAiGatewayLimitsRoute, type DenOrgMember, type DenOrgTeam } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { formatUsageCost } from "../_features/analytics/stacked-daily-chart";
import {
  GatewayLimitsWriteUncertainError, microUsdDecimal, timeframePeriods, useGatewayLimitsMutation, useGatewayPolicies,
} from "./gateway-usage-limits-data";
import { gatewayUsageTotals, useGatewayUsage } from "./gateway-usage-data";

const CARD = "rounded-[12px] border border-gray-100 bg-white p-4";
const CARD_TITLE = "text-[13px] font-medium text-gray-900";

export type GatewayLimitTarget = { memberId: string } | { teamId: string };
type Who = { organization: boolean; teamIds: string[]; memberIds: string[] };
type Amounts = Record<GatewayUsageTimeframe, { enabled: boolean; value: string }>;

const periodTitles: Record<GatewayUsageTimeframe, string> = { day: "Per day", week: "Per week", month: "Per month" };

function whoFromPolicy(policy: GatewayUsageLimitPolicy): Who {
  return {
    organization: policy.assignments.some((assignment) => assignment.organization),
    teamIds: policy.assignments.flatMap((assignment) => assignment.teamId ? [assignment.teamId] : []),
    memberIds: policy.assignments.flatMap((assignment) => assignment.memberId ? [assignment.memberId] : []),
  };
}

function whoFromTarget(target?: GatewayLimitTarget): Who {
  if (!target) return { organization: true, teamIds: [], memberIds: [] };
  return "memberId" in target
    ? { organization: false, teamIds: [], memberIds: [target.memberId] }
    : { organization: false, teamIds: [target.teamId], memberIds: [] };
}

function amountsFromPolicy(policy?: GatewayUsageLimitPolicy): Amounts {
  const amounts: Amounts = { day: { enabled: false, value: "" }, week: { enabled: false, value: "" }, month: { enabled: !policy, value: "" } };
  for (const limit of policy?.limits ?? []) amounts[limit.timeframe] = { enabled: true, value: microUsdDecimal(limit.costLimitMicroUsd) };
  return amounts;
}

export function describeWho(who: Who, teams: DenOrgTeam[], members: DenOrgMember[]): string {
  if (who.organization) return "Everyone";
  const names = [
    ...who.teamIds.map((id) => teams.find((team) => team.id === id)?.name ?? "Removed team"),
    ...who.memberIds.map((id) => members.find((member) => member.id === id)?.user.name ?? "Removed person"),
  ];
  return names.join(", ");
}

function dailyResetTime() {
  const reset = new Date();
  reset.setUTCHours(5, 0, 0, 0);
  return reset.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

export function GatewayLimitEditorScreen({ policyId, target }: { policyId?: string; target?: GatewayLimitTarget }) {
  const { orgId, orgSlug, orgContext } = useOrgDashboard();
  if (!orgId || !orgContext) return <p role="status" className="text-sm text-gray-500">Loading…</p>;
  return <GatewayLimitEditor key={`${orgId}:${policyId ?? "new"}`} orgId={orgId} orgSlug={orgSlug} policyId={policyId} target={target} teams={orgContext.teams} members={orgContext.members} />;
}

type EditorProps = { orgId: string; orgSlug: string | null | undefined; teams: DenOrgTeam[]; members: DenOrgMember[] };

export function GatewayLimitEditor({ orgId, orgSlug, policyId, target, teams, members }: EditorProps & { policyId?: string; target?: GatewayLimitTarget }) {
  const policies = useGatewayPolicies(orgId);
  if (!policyId) return <GatewayLimitForm orgId={orgId} orgSlug={orgSlug} target={target} teams={teams} members={members} />;
  if (policies.isPending) return <p role="status" className="text-sm text-gray-500">Loading limit…</p>;
  if (policies.isError) {
    return (
      <div className="flex flex-col items-start gap-3" role="alert">
        <DenNotice tone="error" message={policies.error.message} />
        <DenButton variant="secondary" onClick={() => void policies.refetch()}>Retry</DenButton>
      </div>
    );
  }
  const policy = policies.data.policies.find((entry) => entry.id === policyId);
  if (!policy || policy.archivedAt) return <DenNotice tone="info" message="This limit was deleted or does not exist." />;
  return <GatewayLimitForm orgId={orgId} orgSlug={orgSlug} policy={policy} teams={teams} members={members} />;
}

function GatewayLimitForm({ orgId, orgSlug, policy, target, teams, members }: EditorProps & { policy?: GatewayUsageLimitPolicy; target?: GatewayLimitTarget }) {
  const id = useId();
  const router = useRouter();
  const policies = useGatewayPolicies(orgId);
  const mutation = useGatewayLimitsMutation(orgId);
  const [who, setWho] = useState<Who>(() => policy ? whoFromPolicy(policy) : whoFromTarget(target));
  const [amounts, setAmounts] = useState<Amounts>(() => amountsFromPolicy(policy));
  const [hardLimit, setHardLimit] = useState(policy?.hardLimit ?? true);
  const [allowRequestReset, setAllowRequestReset] = useState(policy?.allowRequestReset ?? true);
  const [revision] = useState(policy?.revision);
  const [adding, setAdding] = useState<"person" | "team" | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const whoLabel = describeWho(who, teams, members);
  const draft: GatewayUsagePolicyWrite = {
    name: policy?.name ?? (whoLabel.slice(0, 120) || "Spend limit"),
    hardLimit,
    allowRequestReset,
    limits: gatewayUsageTimeframes.filter((timeframe) => amounts[timeframe].enabled).map((timeframe) => ({ timeframe, costUsd: amounts[timeframe].value.trim() })),
  };
  const validation = gatewayUsagePolicyWriteSchema.safeParse(draft);
  const issues = submitted && !validation.success ? validation.error.issues : [];
  const noTargets = !policy && !who.organization && who.teamIds.length === 0 && who.memberIds.length === 0;
  const latest = policies.data?.policies.find((entry) => entry.id === policy?.id);
  const changed = Boolean(policy && (!latest || latest.revision !== revision || latest.archivedAt));
  const uncertain = error instanceof GatewayLimitsWriteUncertainError;
  const blocked = busy || changed || uncertain || policies.isError;
  const singleMember = !who.organization && who.teamIds.length === 0 && who.memberIds.length === 1 ? who.memberIds[0] : undefined;
  const resetTime = dailyResetTime();
  const resetCopy: Record<GatewayUsageTimeframe, string> = {
    day: `Resets every day at ${resetTime}`,
    week: `Resets Monday at ${resetTime}`,
    month: "Resets on the 1st",
  };

  const memberOptions = members.filter((member) => !who.memberIds.includes(member.id)).map((member) => ({ value: member.id, label: member.user.name || member.user.email, description: member.user.email }));
  const teamOptions = teams.filter((team) => !who.teamIds.includes(team.id)).map((team) => ({ value: team.id, label: team.name, description: `${team.memberIds.length} ${team.memberIds.length === 1 ? "member" : "members"}` }));

  async function save() {
    setSubmitted(true);
    if (!validation.success || noTargets || blocked) return;
    setBusy(true);
    setError(null);
    try {
      const saved = policy && revision
        ? await persistEdit(policy, revision, validation.data)
        : await mutation.mutateAsync({ type: "save", body: validation.data });
      if (!policy) {
        for (const targetRequest of assignmentTargets(who)) await mutation.mutateAsync({ type: "assign", policyId: saved.id, target: targetRequest });
      }
      router.push(getAiGatewayLimitsRoute(orgSlug));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError : new Error("Could not save this limit."));
      setBusy(false);
    }
  }

  async function persistEdit(current: GatewayUsageLimitPolicy, currentRevision: number, body: GatewayUsagePolicyWrite) {
    const unchanged = current.hardLimit === body.hardLimit && current.allowRequestReset === body.allowRequestReset
      && current.limits.length === body.limits.length
      && body.limits.every((limit) => current.limits.some((existing) => existing.timeframe === limit.timeframe && microUsdDecimal(existing.costLimitMicroUsd) === limit.costUsd));
    const saved = unchanged ? current : await mutation.mutateAsync({ type: "save", policy: { id: current.id, revision: currentRevision }, body });
    const before = whoFromPolicy(current);
    for (const assignment of current.assignments) {
      const keep = assignment.organization ? who.organization
        : assignment.teamId ? who.teamIds.includes(assignment.teamId)
          : assignment.memberId ? who.memberIds.includes(assignment.memberId) : true;
      if (!keep) await mutation.mutateAsync({ type: "unassign", policyId: current.id, assignmentId: assignment.id });
    }
    const additions = assignmentTargets({
      organization: who.organization && !before.organization,
      teamIds: who.teamIds.filter((teamId) => !before.teamIds.includes(teamId)),
      memberIds: who.memberIds.filter((memberId) => !before.memberIds.includes(memberId)),
    });
    for (const addition of additions) await mutation.mutateAsync({ type: "assign", policyId: current.id, target: addition });
    return saved;
  }

  async function remove() {
    if (!policy || !latest || blocked) return;
    setBusy(true);
    setError(null);
    try {
      await mutation.mutateAsync({ type: "archive", policy: { id: latest.id, revision: latest.revision } });
      router.push(getAiGatewayLimitsRoute(orgSlug, latest.id));
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError : new Error("Could not delete this limit."));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col" data-testid="gateway-limit-editor">
      <h2 className="text-[20px] font-medium tracking-[-0.01em] text-gray-950">{policy ? policy.name : "New spend limit"}</h2>

      <section className={`${CARD} mt-5`} aria-labelledby={`${id}-who`}>
        <h3 id={`${id}-who`} className={CARD_TITLE}>Who</h3>
        <div className="mt-3 flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500"><Globe className="h-4 w-4" aria-hidden="true" /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-gray-900">Everyone in the organization</span>
            <span className="block text-[12px] text-gray-500">{who.organization ? "Each person gets these amounts, including people who join later." : "Only the people and teams you add below."}</span>
          </span>
          <DenSwitch checked={who.organization} aria-label="Everyone in the organization" testId="gateway-limit-everyone"
            onChange={(checked) => setWho((current) => ({ ...current, organization: checked, ...(checked ? { teamIds: [], memberIds: [] } : {}) }))} />
        </div>
        {!who.organization && (who.teamIds.length > 0 || who.memberIds.length > 0) ? (
          <ul className="mt-3 divide-y divide-gray-100 border-t border-gray-100">
            {who.teamIds.map((teamId) => {
              const team = teams.find((entry) => entry.id === teamId);
              return (
                <li key={teamId} className="flex items-center gap-3 py-2.5" data-testid="gateway-limit-who-row">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500"><Users className="h-4 w-4" aria-hidden="true" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-gray-900">{team?.name ?? "Removed team"}</span>
                    <span className="block text-[12px] text-gray-500">{team ? `${team.memberIds.length} ${team.memberIds.length === 1 ? "member" : "members"}, future members included` : "No longer in the directory"}</span>
                  </span>
                  <DenButton size="sm" variant="secondary" type="button" onClick={() => setWho((current) => ({ ...current, teamIds: current.teamIds.filter((entry) => entry !== teamId) }))}>Remove</DenButton>
                </li>
              );
            })}
            {who.memberIds.map((memberId) => {
              const member = members.find((entry) => entry.id === memberId);
              return (
                <li key={memberId} className="flex items-center gap-3 py-2.5" data-testid="gateway-limit-who-row">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500"><User className="h-4 w-4" aria-hidden="true" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-gray-900">{member?.user.name ?? "Removed person"}</span>
                    <span className="block text-[12px] text-gray-500">{member?.user.email ?? "No longer in the directory"}</span>
                  </span>
                  <DenButton size="sm" variant="secondary" type="button" onClick={() => setWho((current) => ({ ...current, memberIds: current.memberIds.filter((entry) => entry !== memberId) }))}>Remove</DenButton>
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" data-testid="gateway-limit-add-person" onClick={() => setAdding(adding === "person" ? null : "person")} className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50"><Plus className="h-3 w-3" aria-hidden="true" />Add person</button>
          <button type="button" data-testid="gateway-limit-add-team" onClick={() => setAdding(adding === "team" ? null : "team")} className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50"><Plus className="h-3 w-3" aria-hidden="true" />Add team</button>
          {adding ? (
            <div className="w-[280px]">
              <DenCombobox ariaLabel={adding === "team" ? "Team" : "Person"} value="" options={adding === "team" ? teamOptions : memberOptions}
                placeholder={adding === "team" ? "Choose a team…" : "Choose a person…"} searchPlaceholder={adding === "team" ? "Search teams" : "Search people"} emptyLabel={adding === "team" ? "No teams to add" : "No people to add"}
                onChange={(value) => {
                  setWho((current) => ({ organization: false, teamIds: adding === "team" ? [...current.teamIds, value] : current.teamIds, memberIds: adding === "person" ? [...current.memberIds, value] : current.memberIds }));
                  setAdding(null);
                }} />
            </div>
          ) : null}
        </div>
        {submitted && noTargets ? <p role="alert" className="mt-2 text-[12px] text-[var(--ow-danger)]">Choose who this limit applies to.</p> : null}
      </section>

      <section className={`${CARD} mt-3`} aria-labelledby={`${id}-amounts`}>
        <h3 id={`${id}-amounts`} className={CARD_TITLE}>How much, for each person</h3>
        <p className="mt-0.5 text-[12px] text-gray-500">Turn on any mix. Whichever runs out first applies.</p>
        <ul className="mt-3 max-w-[520px] divide-y divide-gray-100 rounded-[10px] border border-gray-100">
          {gatewayUsageTimeframes.map((timeframe) => {
            const row = amounts[timeframe];
            const issue = issues.find((entry) => entry.path[0] === "limits" && draft.limits[Number(entry.path[1])]?.timeframe === timeframe);
            return (
              <li key={timeframe} className="flex items-center gap-3 px-3 py-2.5" data-testid={`gateway-limit-period-${timeframe}`}>
                <DenSwitch checked={row.enabled} aria-label={`Limit ${periodTitles[timeframe].toLowerCase()}`}
                  onChange={(checked) => setAmounts((current) => ({ ...current, [timeframe]: { ...current[timeframe], enabled: checked } }))} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-[13px] font-medium ${row.enabled ? "text-gray-900" : "text-gray-500"}`}>{periodTitles[timeframe]}</span>
                  <span className="block text-[12px] text-gray-500">{resetCopy[timeframe]}</span>
                  {issue ? <span className="block text-[12px] text-[var(--ow-danger)]">Enter an amount like 20 or 12.50.</span> : null}
                </span>
                {row.enabled ? (
                  <label className="flex w-32 items-center gap-1.5">
                    <span className="text-[13px] text-gray-500" aria-hidden="true">$</span>
                    <DenInput aria-label={`Amount ${timeframePeriods[timeframe]}`} inputMode="decimal" value={row.value} maxLength={32} aria-invalid={Boolean(issue)} data-testid={`gateway-limit-amount-${timeframe}`}
                      onChange={(event) => setAmounts((current) => ({ ...current, [timeframe]: { ...current[timeframe], value: event.target.value } }))} />
                  </label>
                ) : <span className="w-32 text-[12px] text-gray-400">Off</span>}
              </li>
            );
          })}
        </ul>
        {issues.some((issue) => issue.path[0] === "limits" && issue.path.length === 1) ? <p role="alert" className="mt-2 text-[12px] text-[var(--ow-danger)]">Turn on at least one period.</p> : null}
        {singleMember ? <MemberSpend orgId={orgId} memberId={singleMember} /> : null}
      </section>

      <section className={`${CARD} mt-3`} aria-labelledby={`${id}-reached`}>
        <h3 id={`${id}-reached`} className={CARD_TITLE}>When someone reaches it</h3>
        <fieldset className="mt-2 flex flex-col">
          <legend className="sr-only">When someone reaches it</legend>
          <label className="flex cursor-pointer items-start gap-2.5 py-2">
            <input type="radio" name={`${id}-enforcement`} checked={hardLimit} onChange={() => setHardLimit(true)} className="mt-0.5 h-4 w-4 accent-gray-900" data-testid="gateway-limit-hard" />
            <span><span className="block text-[13px] font-medium text-gray-900">Pause their models</span><span className="block text-[12px] text-gray-500">Until it resets, or until you give more.</span></span>
          </label>
          <label className="flex cursor-pointer items-start gap-2.5 py-2">
            <input type="radio" name={`${id}-enforcement`} checked={!hardLimit} onChange={() => setHardLimit(false)} className="mt-0.5 h-4 w-4 accent-gray-900" data-testid="gateway-limit-soft" />
            <span><span className="block text-[13px] font-medium text-gray-900">Only warn</span><span className="block text-[12px] text-gray-500">Requests keep working and the limit shows as over.</span></span>
          </label>
        </fieldset>
        <div className="mt-2 flex items-center gap-3 border-t border-gray-100 pt-3">
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-gray-900">Let them ask for 25% more</span>
            <span className="block text-[12px] text-gray-500">Requests show up in Limits for you to approve.</span>
          </span>
          <DenSwitch checked={allowRequestReset} aria-label="Let them ask for 25% more" onChange={setAllowRequestReset} />
        </div>
      </section>

      {error ? <DenNotice className="mt-4" tone="error" message={error.message} /> : null}
      {changed ? <DenNotice className="mt-4" tone="error" message="This limit changed or was deleted somewhere else. Your edits were not saved. Reload the page to see the latest version." /> : null}

      <DenStickyActionBar summary={<span>{whoLabel || "No one yet"}{draft.limits.length ? ` · ${draft.limits.map((limit) => `${limit.costUsd ? `$${limit.costUsd}` : "—"} ${timeframePeriods[limit.timeframe]}`).join(", ")}` : ""}</span>}>
        {policy ? (
          <DenButton variant="secondary" disabled={blocked} data-testid="gateway-limit-delete" onClick={() => void remove()}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />Delete limit
          </DenButton>
        ) : null}
        <Link href={getAiGatewayLimitsRoute(orgSlug)} className={buttonVariants({ variant: "secondary" })}>Cancel</Link>
        <DenButton data-testid="gateway-limit-save" loading={busy} disabled={blocked} onClick={() => void save()}>{policy ? "Save changes" : "Save limit"}</DenButton>
      </DenStickyActionBar>
    </div>
  );
}

type AssignmentTarget = { organization: true } | { memberId: string } | { teamId: string };

function assignmentTargets(who: Who): AssignmentTarget[] {
  const targets: AssignmentTarget[] = [];
  if (who.organization) targets.push({ organization: true });
  for (const teamId of who.teamIds) targets.push({ teamId });
  for (const memberId of who.memberIds) targets.push({ memberId });
  return targets;
}

function MemberSpend({ orgId, memberId }: { orgId: string; memberId: string }) {
  const usage = useGatewayUsage(orgId, "person", [memberId]);
  const total = usage.data ? gatewayUsageTotals(usage.data).find((row) => row.id === memberId) : undefined;
  if (!usage.data) return null;
  return <p className="mt-3 text-[12px] text-gray-500" data-testid="gateway-limit-member-spend">Spent in the last 31 days: <span className="font-medium text-gray-900">{formatUsageCost(total?.costMicroUsd ?? 0)}</span></p>;
}

export function GatewayLimitEditLink({ orgSlug, policyId, label }: { orgSlug: string | null | undefined; policyId: string; label: string }) {
  return <Link href={getAiGatewayLimitRoute(orgSlug, policyId)} aria-label={label} className={buttonVariants({ variant: "secondary", size: "sm" })}>Edit</Link>;
}
