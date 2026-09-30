"use client";

import Link from "next/link";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { getAiGatewayLimitRoute, getAiGatewayProvidersRoute, getAiGatewayUsersTeamsRoute, getNewAiGatewayLimitRoute, type DenOrgMember, type DenOrgTeam } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { formatUsageCost } from "../_features/analytics/stacked-daily-chart";
import { accessReason, directoryAccess, memberSubject, providerAudienceLabel } from "./gateway-directory-data";
import { initials, ModelMark, ShareBar } from "./gateway-spend-breakdown";
import { useGatewayAccessProviders } from "./gateway-subject-access-data";
import { gatewayUsageTotals, useGatewayUsage } from "./gateway-usage-data";
import { formatLimitMoney, timeframePeriods, useGatewayMemberUsage, useGatewayPolicies } from "./gateway-usage-limits-data";
import { GatewayLimitsQueryFeedback, GatewayMemberUsageDetails } from "./gateway-usage-limits-section";
import { getProviderIconSlug } from "./llm-provider-data";

const CARD = "rounded-[12px] border border-gray-100 bg-white p-4";
const CARD_TITLE = "text-[13px] font-medium text-gray-900";

export function GatewayPersonScreen({ memberId }: { memberId: string }) {
  const { orgId, orgSlug, orgContext } = useOrgDashboard();
  if (!orgId || !orgContext) return <p role="status" className="text-sm text-gray-500">Loading…</p>;
  const member = orgContext.members.find((entry) => entry.id === memberId);
  if (!member) return <DenNotice tone="info" message="This person is not in your organization." />;
  return <GatewayPerson key={`${orgId}:${memberId}`} orgId={orgId} orgSlug={orgSlug} member={member} teams={orgContext.teams} members={orgContext.members} />;
}

export function GatewayPerson({ orgId, orgSlug, member, teams, members }: { orgId: string; orgSlug: string | null | undefined; member: DenOrgMember; teams: DenOrgTeam[]; members: DenOrgMember[] }) {
  const name = member.user.name || member.user.email;
  const memberTeams = teams.filter((team) => team.memberIds.includes(member.id));
  return (
    <div className="flex flex-col gap-3" data-testid="gateway-person">
      <Link href={getAiGatewayUsersTeamsRoute(orgSlug)} className="inline-flex w-fit items-center gap-1.5 text-[12px] text-gray-500 hover:text-gray-900">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />Back to Users &amp; Teams
      </Link>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <span aria-hidden="true" className="flex size-10 items-center justify-center rounded-full bg-gray-100 text-[13px] font-semibold text-gray-700">{initials(name)}</span>
        <h2 className="text-[20px] font-medium tracking-[-0.01em] text-gray-950">{name}</h2>
        {memberTeams.map((team) => <DenBadge key={team.id}>{team.name}</DenBadge>)}
      </div>
      <PersonSpend orgId={orgId} memberId={member.id} />
      <PersonAccess orgId={orgId} orgSlug={orgSlug} member={member} teams={teams} members={members} />
      <PersonLimit orgId={orgId} orgSlug={orgSlug} memberId={member.id} name={name} teams={teams} />
      <PersonModels orgId={orgId} memberId={member.id} />
    </div>
  );
}

function PersonSpend({ orgId, memberId }: { orgId: string; memberId: string }) {
  const usage = useGatewayUsage(orgId, "person", [memberId]);
  const total = usage.data ? gatewayUsageTotals(usage.data).find((row) => row.id === memberId) : undefined;
  return (
    <section className={CARD} aria-label="Last 31 days" data-testid="gateway-person-spend">
      <h3 className={CARD_TITLE}>Last 31 days</h3>
      {usage.isPending ? <p role="status" className="mt-2 text-[13px] text-gray-500">Loading…</p>
        : usage.isError ? <ErrorRetry message={usage.error.message} onRetry={() => void usage.refetch()} />
          : (
            <div className="mt-1 flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <span className="text-[24px] font-semibold tracking-[-0.02em] tabular-nums text-gray-950">{total?.unpriced && !total.costMicroUsd ? "Unknown" : formatUsageCost(total?.costMicroUsd ?? 0)}</span>
              <span className="text-[13px] text-gray-500">{(total?.tokens ?? 0).toLocaleString()} tokens</span>
            </div>
          )}
    </section>
  );
}

function PersonAccess({ orgId, orgSlug, member, teams, members }: { orgId: string; orgSlug: string | null | undefined; member: DenOrgMember; teams: DenOrgTeam[]; members: DenOrgMember[] }) {
  const providers = useGatewayAccessProviders(orgId);
  const granted = providers.data ? directoryAccess(providers.data, memberSubject(member, teams)) : [];
  const withheld = (providers.data ?? []).filter((provider) => provider.status !== "disabled" && !granted.some((entry) => entry.provider.id === provider.id));
  return (
    <section className={CARD} aria-label="What they can use" data-testid="gateway-person-access">
      <div className="flex items-center justify-between gap-3">
        <h3 className={CARD_TITLE}>What they can use</h3>
        <Link href={getAiGatewayProvidersRoute(orgSlug)} className="text-[12px] font-medium text-gray-700 hover:text-gray-950">Change in AI Providers</Link>
      </div>
      {providers.isPending ? <p role="status" className="mt-2 text-[13px] text-gray-500">Loading…</p>
        : providers.isError ? <ErrorRetry message={providers.error.message} onRetry={() => void providers.refetch()} />
          : granted.length === 0 && withheld.length === 0 ? <p role="status" className="mt-2 text-[13px] text-gray-500">No providers yet. Add one in AI Providers.</p>
            : (
              <ul className="mt-1 divide-y divide-gray-100">
                {granted.map(({ provider, sources }) => (
                  <li key={provider.id} className="flex items-center gap-3 py-2.5" data-testid="gateway-person-access-row">
                    <DenBrandMark name={provider.name} simpleIconSlug={getProviderIconSlug(provider.providerId)} className="h-7 w-7 shrink-0 rounded-[8px]" imageClassName="h-4 w-4" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{provider.name}</span>
                    <span className="shrink-0 text-[12px] text-gray-500">{accessReason(sources, teams)}</span>
                  </li>
                ))}
                {withheld.map((provider) => (
                  <li key={provider.id} className="flex items-center gap-3 py-2.5 opacity-60" data-testid="gateway-person-access-withheld">
                    <DenBrandMark name={provider.name} simpleIconSlug={getProviderIconSlug(provider.providerId)} className="h-7 w-7 shrink-0 rounded-[8px]" imageClassName="h-4 w-4" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-gray-700">{provider.name}</span>
                    <DenBadge>{providerAudienceLabel(provider, teams, members)}</DenBadge>
                  </li>
                ))}
              </ul>
            )}
    </section>
  );
}

function PersonLimit({ orgId, orgSlug, memberId, name, teams }: { orgId: string; orgSlug: string | null | undefined; memberId: string; name: string; teams: DenOrgTeam[] }) {
  const status = useGatewayMemberUsage(orgId, memberId);
  const policies = useGatewayPolicies(orgId);
  const active = policies.data?.policies.filter((policy) => !policy.archivedAt) ?? [];
  return (
    <section className={CARD} aria-label="Spend limit" data-testid="gateway-person-limit">
      <h3 className={CARD_TITLE}>Spend limit</h3>
      <div className="mt-2">
        <GatewayLimitsQueryFeedback query={status} label="spend limit" />
      </div>
      {!status.isError && status.data ? (
        status.data.state === "unlimited" ? (
          <div className="flex flex-wrap items-center gap-3">
            <DenBadge>No limit</DenBadge>
            <span className="min-w-0 flex-1 text-[13px] text-gray-500">Nothing pauses {name}&apos;s models.</span>
            <Link href={getNewAiGatewayLimitRoute(orgSlug, { memberId })} className={buttonVariants({ variant: "secondary", size: "sm" })} data-testid="gateway-person-set-limit">Set a limit</Link>
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-2">
              <DenBadge tone={status.data.state === "within_limit" ? "neutral" : "warning"}>
                {status.data.state === "blocked" ? "Paused" : status.data.state === "over_limit" ? "Over the limit" : "Within the limit"}
              </DenBadge>
            </div>
            <ul className="divide-y divide-gray-100">
              {status.data.buckets.map((bucket) => (
                <li key={bucket.id} className="flex flex-wrap items-center gap-3 py-2.5" data-testid="gateway-person-limit-row">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-gray-900">{formatLimitMoney(bucket.allowanceMicroUsd)} {timeframePeriods[bucket.timeframe]}</span>
                    <span className="block text-[12px] text-gray-500">{bucket.policyName} · {bucket.hardLimit ? "pauses at the limit" : "only warns"}</span>
                  </span>
                  <span className="flex w-36 flex-col gap-1">
                    <ShareBar value={Math.min(bucket.usedMicroUsd, bucket.allowanceMicroUsd)} max={bucket.allowanceMicroUsd} label={`${formatLimitMoney(bucket.usedMicroUsd)} of ${formatLimitMoney(bucket.allowanceMicroUsd)} used`} />
                    <span className="text-[11px] tabular-nums text-gray-500">{formatLimitMoney(bucket.usedMicroUsd)} used</span>
                  </span>
                  {active.some((policy) => policy.id === bucket.policyId)
                    ? <Link href={getAiGatewayLimitRoute(orgSlug, bucket.policyId)} className={buttonVariants({ variant: "secondary", size: "sm" })}>Edit</Link>
                    : null}
                </li>
              ))}
            </ul>
            <details className="group mt-2 text-[12px] text-gray-500">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-3.5 w-3.5 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
                Technical details
              </summary>
              <div className="pt-3">
                <GatewayMemberUsageDetails status={status.data} policies={active} teams={teams} />
              </div>
            </details>
          </>
        )
      ) : null}
    </section>
  );
}

function PersonModels({ orgId, memberId }: { orgId: string; memberId: string }) {
  const usage = useGatewayUsage(orgId, "model", [], memberId);
  const rows = usage.data ? gatewayUsageTotals(usage.data) : [];
  const max = rows[0]?.costMicroUsd ?? 0;
  return (
    <section className={CARD} aria-label="Models they use" data-testid="gateway-person-models">
      <h3 className={CARD_TITLE}>Models they use</h3>
      {usage.isPending ? <p role="status" className="mt-2 text-[13px] text-gray-500">Loading…</p>
        : usage.isError ? <ErrorRetry message={usage.error.message} onRetry={() => void usage.refetch()} />
          : rows.length === 0 ? <p role="status" className="mt-2 text-[13px] text-gray-500">No requests in the last 31 days.</p>
            : (
              <ul className="mt-1 divide-y divide-gray-100">
                {rows.map((row) => (
                  <li key={row.id} className="flex items-center gap-3 py-2.5" data-testid="gateway-person-model-row">
                    <ModelMark seriesId={row.id} label={row.label} />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{row.label}</span>
                    <ShareBar value={row.costMicroUsd} max={max} label={`${formatUsageCost(row.costMicroUsd)} spent`} />
                    <span className="w-20 shrink-0 text-right text-[13px] font-medium tabular-nums text-gray-950">{row.unpriced && !row.costMicroUsd ? "Unknown" : formatUsageCost(row.costMicroUsd)}</span>
                  </li>
                ))}
              </ul>
            )}
    </section>
  );
}

function ErrorRetry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mt-2 flex flex-col items-start gap-3" role="alert">
      <DenNotice tone="error" message={message} />
      <DenButton size="sm" variant="secondary" onClick={onRetry}>Retry</DenButton>
    </div>
  );
}
