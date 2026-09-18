"use client";

import { useDeferredValue, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { ChevronRight, LockKeyhole } from "lucide-react";
import type { GatewayUsageLimitPolicy, GatewayUsageStatus } from "@openwork/types/den/gateway-usage-limits";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenCombobox } from "../../_components/ui/combobox";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenTable } from "../../_components/ui/table";
import type { DenOrgMember, DenOrgTeam } from "../../_lib/den-org";
import { formatLimitMoney, useGatewayLimitsMutation, useGatewayMembers, useGatewayMemberUsage, useGatewayPolicies, type GatewayUsageMember } from "./gateway-usage-limits-data";
import { GatewayUsagePolicyEditor, timeframeLabels } from "./gateway-usage-policy-editor";

type Directory = { teams: DenOrgTeam[]; members: DenOrgMember[] };

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

function MemberSearch({ orgId, label, onSelect }: { orgId: string; label: string; onSelect: (member: GatewayUsageMember) => void }) {
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

function SelectedMemberUsage({ orgId, member, policies, teams, onChangePerson }: { orgId: string; member: GatewayUsageMember; policies: GatewayUsageLimitPolicy[]; teams: DenOrgTeam[]; onChangePerson: () => void }) {
  const usage = useGatewayMemberUsage(orgId, member.id);
  return <section aria-label={`Usage for ${member.name || member.email}`} className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <MemberInitials member={member} />
        <div className="min-w-0">
          <h4 className="truncate text-sm font-medium">{member.name || member.email}</h4>
          <p className="truncate text-xs text-[var(--ow-muted)]">{member.email}</p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <DenButton size="sm" variant="ghost" onClick={onChangePerson}>Change person</DenButton>
        <DenButton size="sm" variant="secondary" disabled={usage.isFetching} onClick={() => void usage.refetch()}>Refresh usage</DenButton>
      </div>
    </div>
    <GatewayLimitsQueryFeedback query={usage} label="member usage" />
    {!usage.isError && usage.data ? <GatewayMemberUsageDetails status={usage.data} policies={policies} teams={teams} /> : null}
  </section>;
}

function MemberInspector({ orgId, policies, teams }: { orgId: string; policies: GatewayUsageLimitPolicy[]; teams: DenOrgTeam[] }) {
  const [selected, setSelected] = useState<GatewayUsageMember | null>(null);
  return <section aria-label="Check User's Usage" className="flex flex-col gap-4">
    <h2 className="text-lg font-semibold">Check User&apos;s Usage</h2>
    {selected
      ? <SelectedMemberUsage key={selected.id} orgId={orgId} member={selected} policies={policies} teams={teams} onChangePerson={() => setSelected(null)} />
      : <MemberSearch orgId={orgId} label="Find person to inspect" onSelect={setSelected} />}
  </section>;
}

export function GatewayUsageLimitsSection({ orgId, teams }: { orgId: string } & Directory) {
  const policies = useGatewayPolicies(orgId);
  const mutation = useGatewayLimitsMutation(orgId);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<{ policy?: GatewayUsageLimitPolicy } | null>(null);
  const [archiving, setArchiving] = useState<GatewayUsageLimitPolicy | null>(null);
  const active = policies.data?.policies.filter((policy) => !policy.archivedAt) ?? [];
  const filtered = active.filter((policy) => policy.name.toLowerCase().includes(query.trim().toLowerCase()));
  const latestArchive = active.find((policy) => policy.id === archiving?.id);
  const staleArchive = Boolean(archiving && latestArchive?.revision !== archiving.revision);
  return <>
    {!policies.isError && active.length > 0 ? (
      <div className="mb-10">
        <MemberInspector key={orgId} orgId={orgId} policies={active} teams={teams} />
      </div>
    ) : null}
    <section aria-labelledby="gateway-usage-limits-heading" className="flex flex-col gap-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="gateway-usage-limits-heading" className="text-lg font-semibold">Policies</h2>
      <div className="flex shrink-0 items-center gap-3">
        <DenButton variant="secondary" disabled={policies.isFetching} onClick={() => void policies.refetch()}>Refresh policies</DenButton>
        <DenButton onClick={() => setEditor({})}>Create policy</DenButton>
      </div>
    </div>
    <DenInput type="search" aria-label="Search usage limit policies" placeholder="Search policies" value={query} onChange={(event) => setQuery(event.target.value)} />
    {active.length > 0 ? <details className="text-sm text-[var(--ow-muted)]">
      <summary className="cursor-pointer">How limits apply</summary>
      <div className="flex flex-col gap-2 pt-3">
        <p>Estimated USD for organization-provider Gateway traffic. Team and organization policies apply to each person individually, never as a shared pool. Each timeframe applies simultaneously; allowances are not added together.</p>
        <p>Calendar resets: daily at 05:00 UTC, Monday at 05:00 UTC weekly, and day 1 at 05:00 UTC monthly.</p>
      </div>
    </details> : null}
    <GatewayLimitsQueryFeedback query={policies} label="policies" />
    {!policies.isError && policies.data && active.length === 0 ? <DenCard className="py-10 text-center"><p className="text-sm text-[var(--ow-muted)]">No usage limits configured</p></DenCard> : null}
    {!policies.isError && policies.data && active.length > 0 ? <DenCard className="overflow-hidden p-0"><DenTable rows={filtered} getRowKey={(row) => row.id} headerTone="plain" rowClassName="align-top" emptyLabel="No policies match this search." columns={[
      { key: "policy", header: "Policy", width: "100%", render: (policy) => (
        <div className="flex min-w-64 flex-col gap-3">
          <div className="flex flex-col items-start gap-2">
            <span className="break-words font-medium">{policy.name}</span>
            <div className="flex flex-wrap gap-2">
              <DenBadge>{policy.hardLimit ? "Hard" : "Soft"}</DenBadge>
              <DenBadge>{policy.allowRequestReset ? "Increase requests on" : "Increase requests off"}</DenBadge>
            </div>
          </div>
          <dl aria-label={`Allowances for ${policy.name}`} className="flex flex-wrap gap-x-5 gap-y-2 text-sm tabular-nums">
            {policy.limits.map((limit) => (
              <div key={limit.timeframe} className="flex items-baseline gap-2">
                <dt className="text-[var(--ow-muted)]">{timeframeLabels[limit.timeframe]}</dt>
                <dd className="font-medium">{formatLimitMoney(limit.costLimitMicroUsd)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) },
      { key: "actions", header: "Actions", align: "right", render: (policy) => (
        <div className="flex justify-end gap-2">
          <DenButton size="sm" variant="secondary" disabled={policies.isFetching} aria-label={`Edit ${policy.name}`} onClick={() => setEditor({ policy })}>Edit</DenButton>
          <DenButton size="sm" variant="ghost" disabled={policies.isFetching} aria-label={`Archive ${policy.name}`} onClick={() => { mutation.reset(); setArchiving(policy); }}>Archive</DenButton>
        </div>
      ) },
    ]} /></DenCard> : null}
    {editor ? <GatewayUsagePolicyEditor orgId={orgId} policy={editor.policy} onClose={() => setEditor(null)} /> : null}
    <AlertDialog.Root open={Boolean(archiving)} onOpenChange={(open) => { if (!open && !mutation.isPending) setArchiving(null); }}>
      <AlertDialog.Portal><AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/30" /><AlertDialog.Popup className="fixed left-1/2 top-1/2 z-50 flex w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-2xl border border-[var(--ow-line)]/60 bg-[var(--dls-surface)] p-6">
        <AlertDialog.Title className="text-lg font-semibold">Archive {archiving?.name}?</AlertDialog.Title><AlertDialog.Description className="text-sm text-[var(--ow-muted)]">This stops the policy from applying to assigned people and teams. Consumption and history are retained; people without other policies become unlimited.</AlertDialog.Description>
        {mutation.error ? <DenNotice tone="error" message={mutation.error.message} /> : null}
        {staleArchive ? <DenNotice tone="error" message="This policy changed. Cancel and review the latest revision before archiving." /> : null}
        <div className="flex justify-end gap-3"><AlertDialog.Close disabled={mutation.isPending} className={buttonVariants({ variant: "secondary" })}>Cancel</AlertDialog.Close><DenButton variant="destructive" loading={mutation.isPending} disabled={staleArchive || policies.isError || policies.isFetching} onClick={() => { if (archiving) mutation.mutate({ type: "archive", policy: archiving }, { onSuccess: () => setArchiving(null) }); }}>Archive policy</DenButton></div>
      </AlertDialog.Popup></AlertDialog.Portal>
    </AlertDialog.Root>
    </section>
  </>;
}
