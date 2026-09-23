"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useDeferredValue, useState } from "react";
import { ChevronRight, Gauge, Globe, LockKeyhole, User, Users } from "lucide-react";
import type { GatewayUsageLimitPolicy, GatewayUsageStatus } from "@openwork/types/den/gateway-usage-limits";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenCombobox } from "../../_components/ui/combobox";
import { DenNotice } from "../../_components/ui/notice";
import { DenTable } from "../../_components/ui/table";
import { getAiGatewayLimitRoute, getAiGatewayLimitsRoute, getAiGatewayPersonRoute, getNewAiGatewayLimitRoute, type DenOrgMember, type DenOrgTeam } from "../../_lib/den-org";
import { describeWho } from "./gateway-limit-editor-screen";
import { formatLimitMoney, timeframeLabels, timeframePeriods, useGatewayLimitsMutation, useGatewayMembers, useGatewayPolicies, type GatewayUsageMember } from "./gateway-usage-limits-data";

type Directory = { teams: DenOrgTeam[]; members: DenOrgMember[] };
type OrgSlug = string | null | undefined;

export function GatewayLimitsQueryFeedback({ query, label }: { query: { isPending: boolean; isError: boolean; error: Error | null; refetch: () => unknown }; label: string }) {
  if (query.isError) return <div className="flex flex-col gap-3" role="alert"><DenNotice tone="error" message={query.error?.message ?? `Could not load ${label}.`} /><DenButton variant="secondary" onClick={() => void query.refetch()}>Retry {label}</DenButton></div>;
  if (query.isPending) return <p role="status" className="text-sm text-[var(--ow-muted)]">Loading {label}…</p>;
  return null;
}

export function GatewayLimitTimestamp({ value }: { value: string }) {
  return <time dateTime={value} title={value}>{new Date(value).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short", hour12: false })} UTC</time>;
}

function MemberInitials({ member }: { member: GatewayUsageMember }) {
  return <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--ow-line)] text-xs font-semibold uppercase">
    {(member.name || member.email).split(" ").map((part) => part[0]).join("").slice(0, 2)}
  </span>;
}

export function MemberSearch({ orgId, label, onSelect }: { orgId: string; label: string; onSelect: (member: GatewayUsageMember) => void }) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const results = useGatewayMembers(orgId, deferredQuery);
  const pending = results.isPending || results.isFetching || deferredQuery !== query;
  const optionsDisabled = pending || results.isError;
  return <div className="flex flex-col gap-3">
    <DenCombobox
      ariaLabel={label}
      value=""
      placeholder="Select a person"
      searchPlaceholder="Search people by name or email"
      emptyLabel="No people match"
      searchFeedback={optionsDisabled ? <GatewayLimitsQueryFeedback query={{ ...results, isPending: pending, isError: deferredQuery === query && results.isError }} label="people" /> : null}
      maxSearchLength={200}
      serverFiltered
      optionsDisabled={optionsDisabled}
      onSearchChange={setQuery}
      options={(results.isError ? [] : results.data?.members ?? []).map((member) => ({
        value: member.id,
        label: member.name || member.email,
        description: member.email,
        icon: <MemberInitials member={member} />,
      }))}
      onChange={(id) => {
        if (optionsDisabled) return;
        const member = results.data?.members.find((person) => person.id === id);
        if (member) onSelect(member);
      }}
    />
  </div>;
}

function GatewayUsageCoverage({ coverage }: { coverage: GatewayUsageStatus["coverage"] }) {
  const historicalUnknown = coverage.historicalCoverage === "unknown" || coverage.historicalUnknownReason != null;
  const incomplete = !coverage.complete || historicalUnknown || coverage.unpricedRequests > 0
    || (coverage.incompleteRequests ?? 0) > 0 || (coverage.quarantinedRequests ?? 0) > 0;
  const history = !historicalUnknown ? "" : coverage.historicalUnknownReason === "tracking_not_started"
    ? "Usage tracking has not started. Earlier usage is unknown."
    : coverage.historicalUnknownReason === "period_predates_tracking"
      ? "This period includes time before usage tracking started. Earlier usage is unknown."
      : coverage.historicalUnknownReason === "legacy_counter"
        ? "Usage history includes older counters with unknown coverage."
        : "Historical usage coverage is unknown.";
  const details = [
    history,
    coverage.unpricedRequests > 0 ? `${coverage.unpricedRequests} recorded requests have unresolved cost. Unknown cost is not zero.` : "",
    (coverage.incompleteRequests ?? 0) > 0 ? `${coverage.incompleteRequests} recorded requests have incomplete accounting.` : "",
    (coverage.quarantinedRequests ?? 0) > 0 ? `${coverage.quarantinedRequests} unresolved historical requests are quarantined and have not been charged again.` : "",
  ].filter(Boolean).join(" ");
  return <>
    {incomplete ? <DenNotice tone="warning" message={`Accounting is incomplete. ${details}${details ? " " : ""}Known costs are a subtotal, not complete spend.`} />
      : <p className="text-sm text-[var(--ow-muted)]">Recorded accounting complete. All costs are estimates.</p>}
    {coverage.settlementReady !== true ? typeof coverage.pendingRequests === "number" && coverage.pendingRequests > 0 ? <p role="status" className="text-sm text-[var(--ow-muted)]">{coverage.pendingRequests} tracked requests are awaiting settlement.</p>
      : coverage.pendingRequests === null ? <p role="status" className="text-sm text-[var(--ow-muted)]">Pending settlement count is unavailable.</p>
        : coverage.settlementReady === false ? <p role="status" className="text-sm text-[var(--ow-muted)]">Settlement is not yet confirmed.</p> : null : null}
    {coverage.trackingStartedAt || coverage.lastSettlementAt || coverage.settlementReady === true ? <details className="group text-sm text-[var(--ow-muted)]">
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={16} aria-hidden="true" className="shrink-0 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
        Accounting details
      </summary>
      <div className="flex flex-col gap-2 pt-3">
        {coverage.trackingStartedAt ? <p>Usage tracking started: <GatewayLimitTimestamp value={coverage.trackingStartedAt} /></p> : null}
        {coverage.settlementReady === true ? <p>No tracked requests are awaiting settlement.</p> : null}
        {coverage.lastSettlementAt ? <p>Last settlement: <GatewayLimitTimestamp value={coverage.lastSettlementAt} /></p> : null}
      </div>
    </details> : null}
  </>;
}

export function GatewayMemberUsageDetails({ status, policies, teams }: { status: GatewayUsageStatus; policies: GatewayUsageLimitPolicy[]; teams: DenOrgTeam[] }) {
  const matchingPolicies = policies.filter((policy) => !policy.archivedAt && policy.assignments.some((assignment) => assignment.organization || assignment.memberId === status.memberId || teams.some((team) => team.id === assignment.teamId && team.memberIds.includes(status.memberId))));
  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center gap-3"><DenBadge tone={status.state === "over_limit" ? "warning" : "neutral"} icon={status.state === "blocked" ? LockKeyhole : undefined}>{status.state === "unlimited" ? "Unlimited" : status.state === "blocked" ? "Blocked" : status.state === "over_limit" ? "Over allowance" : "Within allowance"}</DenBadge><span className="text-xs text-[var(--ow-muted)]">Updated <GatewayLimitTimestamp value={status.serverTime} /></span></div>
    {status.state === "unlimited" ? <p>No usage limit policy assigned. Other provider, subscription, and service limits still apply.</p> : null}
    {status.state === "over_limit" ? <DenNotice tone="warning" message="Over the estimated usage allowance. Requests are still allowed under these soft limits." /> : null}
    {status.state === "blocked" ? <DenNotice tone="warning" message="An exhausted hard limit blocks further Gateway requests. All blocking buckets must clear before access is restored." /> : null}
    <GatewayUsageCoverage coverage={status.coverage} />
    {status.buckets.length > 0 ? <DenCard className="overflow-hidden p-0">
      <DenTable rows={status.buckets} getRowKey={(bucket) => bucket.id} headerTone="plain" rowClassName="align-top" columns={[
        { key: "policy", header: "Policy", width: "100%", render: (bucket) => (
          <div className="flex min-w-64 flex-col gap-3">
            <div className="flex flex-col items-start gap-2">
              <span className="break-words font-medium">{bucket.policyName} - {timeframeLabels[bucket.timeframe]}</span>
              <div className="flex flex-wrap gap-2">
                <DenBadge>{bucket.hardLimit ? "Hard" : "Soft"}</DenBadge>
                <DenBadge>{bucket.allowRequestReset ? "Increase requests on" : "Increase requests off"}</DenBadge>
              </div>
            </div>
            <dl aria-label={`Allowances for ${bucket.policyName} - ${timeframeLabels[bucket.timeframe]}`} className="flex flex-wrap gap-x-5 gap-y-2 text-sm tabular-nums">
              <div className="flex items-baseline gap-2"><dt className="text-[var(--ow-muted)]">Base</dt><dd className="font-medium">{formatLimitMoney(bucket.baseAllowanceMicroUsd)}</dd></div>
              <div className="flex items-baseline gap-2"><dt className="text-[var(--ow-muted)]">Extension</dt><dd className="font-medium">{formatLimitMoney(bucket.extensionMicroUsd)}</dd></div>
              <div className="flex items-baseline gap-2"><dt className="text-[var(--ow-muted)]">Total</dt><dd className="font-medium">{formatLimitMoney(bucket.allowanceMicroUsd)}</dd></div>
            </dl>
          </div>
        ) },
        { key: "usage", header: "Usage", align: "right", render: (bucket) => (
          <div className="flex flex-col gap-1 whitespace-nowrap text-sm tabular-nums">
            <span className="font-medium">{formatLimitMoney(bucket.usedMicroUsd)} used</span>
            <span className={bucket.remainingMicroUsd < 0 ? "text-[var(--ow-warning)]" : "text-[var(--ow-muted)]"}>{bucket.remainingMicroUsd < 0 ? `${formatLimitMoney(-bucket.remainingMicroUsd)} over allowance` : `${formatLimitMoney(bucket.remainingMicroUsd)} remaining`}</span>
            <span className="mt-1 text-xs text-[var(--ow-muted)]">Resets <GatewayLimitTimestamp value={bucket.resetAt} /></span>
          </div>
        ) },
      ]} renderRowDetail={(bucket) => <details className="group text-sm">
        <summary aria-label={`Effective policy and assignment context for ${bucket.policyName} - ${timeframeLabels[bucket.timeframe]}`} className="flex cursor-pointer list-none items-center gap-2 text-[var(--ow-muted)] [&::-webkit-details-marker]:hidden">
          <ChevronRight size={16} aria-hidden="true" className="shrink-0 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
          Effective policy and assignment context
        </summary>
        <div className="flex flex-col gap-2 pt-3">
          <dl className="flex flex-wrap gap-x-4 gap-y-1">
            <div className="flex gap-1"><dt>Increase requests</dt><dd>{bucket.allowRequestReset ? "Allowed" : "Disabled"}</dd></div>
            <div className="flex gap-1"><dt>Request status</dt><dd>{bucket.resetRequestStatus ?? (bucket.canRequestReset ? "Eligible to request an increase" : "Not currently eligible to request an increase")}</dd></div>
          </dl>
          <p>The highest allowance wins for each timeframe and supplies its hard-limit and increase-request settings. Ties prefer hard limits, then increase permission, then policy ID.</p>
          <section aria-label="Server-selected assignment snapshot" className="flex flex-col gap-2">
            <h5 className="font-medium">Server-selected snapshot</h5>
            <dl className="flex flex-wrap gap-x-4 gap-y-1">
              <div className="flex gap-1"><dt>Policy</dt><dd>{bucket.policyName}</dd></div>
              <div className="flex gap-1"><dt>Revision</dt><dd>{bucket.policyRevision ?? "Unavailable in this snapshot"}</dd></div>
            </dl>
            {bucket.provenance?.length ? <ul className="flex flex-col gap-2">{bucket.provenance.map((source) => <li key={source.assignmentId}>
              {source.kind === "organization" ? "Everyone in the org" : source.kind === "direct" ? "Direct assignment" : `Team: ${source.teamName}`}
            </li>)}</ul> : <p className="text-[var(--ow-muted)]">No assignment provenance supplied for this snapshot.</p>}
          </section>
          <h5 className="font-medium">Current-directory policy comparison</h5>
          <p className="text-[var(--ow-muted)]">These comparison policies and memberships are from the current organization directory, not the server-selected snapshot above.</p>
          <ul className="flex flex-col gap-2">{matchingPolicies.flatMap((policy) => policy.limits.filter((limit) => limit.timeframe === bucket.timeframe).map((limit) => <li key={policy.id}>
            <dl className="flex flex-wrap gap-x-4 gap-y-1">
              <div className="flex gap-1"><dt>Policy</dt><dd>{policy.name}</dd></div>
              <div className="flex gap-1"><dt>Revision</dt><dd>{policy.revision}</dd></div>
              <div className="flex gap-1"><dt>Allowance</dt><dd>{formatLimitMoney(limit.costLimitMicroUsd)}</dd></div>
              <div className="flex gap-1"><dt>Selection</dt><dd>{policy.id === bucket.policyId ? "Selected policy" : "Not selected"}</dd></div>
              <div className="flex gap-1"><dt>Assignments</dt><dd>{policy.assignments.flatMap((assignment) => {
                if (assignment.organization) return ["Everyone in the org"];
                if (assignment.memberId === status.memberId) return ["Direct assignment"];
                const team = teams.find((item) => item.id === assignment.teamId && item.memberIds.includes(status.memberId));
                return team ? [`Team: ${team.name}`] : [];
              }).join(", ")}</dd></div>
            </dl>
          </li>))}</ul>
        </div>
      </details>} />
    </DenCard> : null}
  </div>;
}

const periodOrder = { day: 0, week: 1, month: 2 };

export function describeLimitAmounts(policy: GatewayUsageLimitPolicy): string {
  return [...policy.limits].sort((a, b) => periodOrder[a.timeframe] - periodOrder[b.timeframe])
    .map((limit) => `${formatLimitMoney(limit.costLimitMicroUsd)} ${timeframePeriods[limit.timeframe]}`).join(", ");
}

function policyWho(policy: GatewayUsageLimitPolicy, teams: DenOrgTeam[], members: DenOrgMember[]) {
  return describeWho({
    organization: policy.assignments.some((assignment) => assignment.organization),
    teamIds: policy.assignments.flatMap((assignment) => assignment.teamId ? [assignment.teamId] : []),
    memberIds: policy.assignments.flatMap((assignment) => assignment.memberId ? [assignment.memberId] : []),
  }, teams, members);
}

function LimitIcon({ policy }: { policy: GatewayUsageLimitPolicy }) {
  const Icon = policy.assignments.some((assignment) => assignment.organization) ? Globe
    : policy.assignments.every((assignment) => assignment.memberId) && policy.assignments.length > 0 ? User : Users;
  return <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500"><Icon className="h-4 w-4" aria-hidden="true" /></span>;
}

function DeletedLimitNote({ orgId, orgSlug, policy }: { orgId: string; orgSlug: OrgSlug; policy: GatewayUsageLimitPolicy }) {
  const router = useRouter();
  const mutation = useGatewayLimitsMutation(orgId);
  if (!policy.archivedAt) return null;
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 text-[13px] text-gray-700" data-testid="gateway-limit-deleted">
      <span className="h-1.5 w-1.5 rounded-full bg-gray-400" aria-hidden="true" />
      <span>Deleted {policy.name}. It no longer applies to anyone.</span>
      <DenButton variant="ghost" size="sm" className="h-auto px-1 py-0 text-[13px] underline underline-offset-4" loading={mutation.isPending}
        data-testid="gateway-limit-undo"
        onClick={() => mutation.mutate({ type: "restore", policy: { id: policy.id, revision: policy.revision } }, { onSuccess: () => router.replace(getAiGatewayLimitsRoute(orgSlug)) })}>
        Undo
      </DenButton>
      {mutation.error ? <DenNotice tone="error" message={mutation.error.message} /> : null}
    </div>
  );
}

function PersonLookup({ orgId, orgSlug }: { orgId: string; orgSlug: OrgSlug }) {
  const router = useRouter();
  return (
    <section aria-label="Check someone's usage" className="flex max-w-md flex-col gap-2">
      <h3 className="text-[13px] font-medium text-gray-900">Check someone&apos;s usage</h3>
      <MemberSearch orgId={orgId} label="Find a person" onSelect={(member) => router.push(getAiGatewayPersonRoute(orgSlug, member.id))} />
    </section>
  );
}

export function GatewayUsageLimitsSection({ orgId, orgSlug, teams, members }: { orgId: string; orgSlug: OrgSlug } & Directory) {
  const policies = useGatewayPolicies(orgId);
  const searchParams = useSearchParams();
  const deletedId = searchParams?.get("deleted") ?? null;
  const active = policies.data?.policies.filter((policy) => !policy.archivedAt) ?? [];
  const deleted = deletedId ? policies.data?.policies.find((policy) => policy.id === deletedId) : undefined;
  return (
    <section aria-labelledby="gateway-usage-limits-heading" className="flex flex-col gap-5" data-testid="gateway-limits">
      {deleted ? <DeletedLimitNote orgId={orgId} orgSlug={orgSlug} policy={deleted} /> : null}
      <GatewayLimitsQueryFeedback query={policies} label="limits" />
      {!policies.isError && policies.data && active.length === 0 ? (
        <DenCard className="flex flex-col items-center gap-4 px-8 py-16 text-center" data-testid="gateway-limits-empty">
          <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-gray-50 text-gray-600"><Gauge className="h-[18px] w-[18px]" aria-hidden="true" /></span>
          <span className="flex flex-col gap-1">
            <h2 id="gateway-usage-limits-heading" className="text-[15px] font-medium text-gray-950">No spend limits yet</h2>
            <span className="text-[13px] text-gray-500">Set a daily, weekly or monthly amount for everyone, a team or one person.</span>
          </span>
          <Link href={getNewAiGatewayLimitRoute(orgSlug)} className={buttonVariants({ variant: "primary", size: "sm" })} data-testid="gateway-limit-new">New limit</Link>
          <span className="text-[12px] text-gray-500">OpenWork Models has its own included usage.</span>
        </DenCard>
      ) : null}
      {!policies.isError && active.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="gateway-usage-limits-heading" className="text-[16px] font-medium tracking-[-0.01em] text-gray-950">Limits</h2>
            <Link href={getNewAiGatewayLimitRoute(orgSlug)} className={buttonVariants({ variant: "primary", size: "sm" })} data-testid="gateway-limit-new">New limit</Link>
          </div>
          <ul className="divide-y divide-gray-100 overflow-hidden rounded-[12px] border border-gray-100 bg-white" aria-label="Spend limits">
            {active.map((policy) => {
              const who = policyWho(policy, teams, members);
              return (
                <li key={policy.id} className="flex items-center gap-3 px-4 py-3" data-testid="gateway-limit-row" data-policy-id={policy.id}>
                  <LimitIcon policy={policy} />
                  <span className="flex min-w-0 flex-[1.2] flex-col">
                    <span className="truncate text-[13px] font-medium text-gray-900">{policy.name}</span>
                    <span className="truncate text-[12px] text-gray-500">{who || "Not applied to anyone yet"}</span>
                  </span>
                  <span className="min-w-0 flex-1 text-[13px] tabular-nums text-gray-700">{describeLimitAmounts(policy)} each</span>
                  <span className="w-28 shrink-0 text-[12px] text-gray-600">{policy.hardLimit ? "Pauses them" : "Only warns"}</span>
                  <Link href={getAiGatewayLimitRoute(orgSlug, policy.id)} aria-label={`Edit ${policy.name}`} className={buttonVariants({ variant: "secondary", size: "sm" })}>Edit</Link>
                </li>
              );
            })}
          </ul>
          <PersonLookup orgId={orgId} orgSlug={orgSlug} />
        </>
      ) : null}
    </section>
  );
}
