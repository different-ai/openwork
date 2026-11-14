"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronRight, Clock } from "lucide-react";
import {
  formatGatewayMoney,
  formatGatewayReset,
  formatGatewaySpend,
  gatewayBucketExhausted,
  gatewayCanAskForMore,
  gatewayIncreaseMicroUsd,
  gatewayMemberSeriesTotals,
  gatewayMemberUsageMetrics,
  gatewayModelCostComparison,
  gatewayPercentLeft,
  gatewayPeriodLabels,
  gatewayUsageLimitGroups,
  type GatewayListedPrice,
  type GatewayMemberUsageResponse,
} from "@openwork/types/den/gateway-member-usage";
import type { GatewayUsageBucket, GatewayUsageStatus } from "@openwork/types/den/gateway-usage-limits";
import { DenBadge } from "../../../_components/ui/badge";
import { DenButton } from "../../../_components/ui/button";
import { AUTOMATION_CARD_CLASS, CARD_TITLE_CLASS, DASHBOARD_PAGE_CLASS, SECTION_TITLE_CLASS } from "../../../_components/ui/dashboard-styles";
import { DenNotice } from "../../../_components/ui/notice";
import { DenPageHeader } from "../../../_components/ui/page-header";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { DenTextarea } from "../../../_components/ui/textarea";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { GatewayUsageCoverageNotice } from "../../_components/gateway-usage-coverage-notice";
import { ModelMark, ShareBar } from "../../_components/gateway-spend-breakdown";
import { StackedDailyChart } from "../analytics/stacked-daily-chart";
import { StatCard, StatStrip } from "../analytics/stat-card";
import { useSeriesColors } from "../analytics/use-series-colors";
import { useAskForMoreUsage, useMyGatewayLimits, useMyGatewayUsage } from "./my-usage-data";

const MUTED = "text-[color:var(--dls-text-secondary)]";
const INK = "text-[color:var(--dls-text-primary)]";
const ROW = "border-b border-[var(--den-list-line)] last:border-b-0";
const COSTS_DOCS = "https://openworklabs.com/docs/ai-gateway/token-costs";

export function MyUsageScreen() {
  const { orgId, orgContext } = useOrgDashboard();
  if (!orgId || !orgContext) return <div className={`${DASHBOARD_PAGE_CLASS} grid gap-4`} role="status" aria-label="Loading your usage"><DenSkeleton className="h-6 w-32" /><DenSkeleton className="h-24 w-full" /></div>;
  return <MyUsage key={orgId} orgId={orgId} />;
}

function MyUsage({ orgId }: { orgId: string }) {
  const usage = useMyGatewayUsage(orgId);
  const period = usage.data ? `Past ${usage.data.usage.days} days, UTC (${usage.data.usage.from} to ${usage.data.usage.to})` : "Past 30 days, UTC";
  return (
    <div className={`${DASHBOARD_PAGE_CLASS} grid gap-10`} data-testid="my-usage">
      <DenPageHeader size="compact" title="My Usage" state={period} />
      <SpendLimits orgId={orgId} />
      <PastUsage query={usage} />
      <ModelCatalog query={usage} />
    </div>
  );
}

function Section({ title, detail, testId, children }: { title: string; detail?: ReactNode; testId: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} data-testid={testId} className="min-w-0">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={id} className={SECTION_TITLE_CLASS}>{title}</h2>
        {detail ? <p className={`text-[12px] ${MUTED}`}>{detail}</p> : null}
      </div>
      {children}
    </section>
  );
}

function ErrorRetry({ message, onRetry, busy }: { message: string; onRetry: () => void; busy: boolean }) {
  return (
    <div className="flex flex-col items-start gap-3 p-4" role="alert">
      <DenNotice tone="error" message={message} />
      <DenButton size="sm" variant="secondary" disabled={busy} onClick={onRetry}>Try again</DenButton>
    </div>
  );
}

/* ---------- Spend limits ---------- */

function SpendLimits({ orgId }: { orgId: string }) {
  const limits = useMyGatewayLimits(orgId);
  const ask = useAskForMoreUsage(orgId);
  const [askingId, setAskingId] = useState<string | null>(null);
  const status = limits.data;
  const groups = status ? gatewayUsageLimitGroups(status) : [];
  const labelled = groups.some((group) => group.providerName !== null);
  return (
    <Section title="Spend limits" testId="my-usage-limits" detail={groups.length ? "Set by your organization" : undefined}>
      <div className={`${AUTOMATION_CARD_CLASS} min-w-0`}>
        {limits.isPending ? <div role="status" aria-label="Loading spend limits" className="grid gap-3 p-4"><DenSkeleton className="h-4 w-40" /><DenSkeleton className="h-10 w-full" /></div>
          : limits.isError ? <ErrorRetry message={limits.error.message} busy={limits.isFetching} onRetry={() => void limits.refetch()} />
            : !groups.length ? (
              <div className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="my-usage-no-limit">
                <span className={`text-[13px] font-medium ${INK}`}>No limit</span>
                <span className={`text-[13px] ${MUTED}`}>Nothing pauses your models.</span>
              </div>
            ) : groups.map((group) => (
              <div key={group.key} className={ROW} data-testid={group.providerName === null ? "my-usage-default-limit" : "my-usage-provider-limit"}>
                {labelled ? <h3 className={`px-4 pt-3 text-[12px] font-medium ${INK}`}>{group.providerName === null ? "Other providers" : `Only ${group.providerName}`}</h3> : null}
                <ul>
                  {group.buckets.map((bucket) => (
                    <LimitRow key={bucket.id} bucket={bucket} asking={askingId === bucket.id} stale={limits.isError}
                      pending={ask.isPending} error={ask.isError ? ask.error.message : null}
                      onAsk={() => { ask.reset(); setAskingId(bucket.id); }}
                      onCancel={() => { ask.reset(); setAskingId(null); }}
                      onSubmit={(reason) => ask.mutate({ bucketId: bucket.id, reason }, { onSuccess: () => setAskingId(null) })} />
                  ))}
                </ul>
              </div>
            ))}
        {status ? <LimitDetails status={status} /> : null}
      </div>
    </Section>
  );
}

function LimitRow({ bucket, asking, stale, pending, error, onAsk, onCancel, onSubmit }: {
  bucket: GatewayUsageBucket; asking: boolean; stale: boolean; pending: boolean; error: string | null;
  onAsk: () => void; onCancel: () => void; onSubmit: (reason: string) => void;
}) {
  const left = gatewayPercentLeft(bucket);
  const period = gatewayPeriodLabels[bucket.timeframe];
  const amount = formatGatewayMoney(gatewayIncreaseMicroUsd(bucket));
  const askable = gatewayCanAskForMore(bucket);
  const reset = formatGatewayReset(bucket.resetAt, Date.now());
  const request = bucket.resetRequestStatus === "pending"
    ? <span className={`flex items-center gap-1.5 text-[12px] ${INK}`}><Clock className="size-3.5" aria-hidden="true" />Asked for {amount} more, waiting for an admin</span>
    : askable ? (asking ? null : <DenButton size="sm" disabled={stale || pending} onClick={onAsk}>Ask for {amount} more</DenButton>)
      : bucket.resetRequestStatus === "approved" && bucket.extensionMicroUsd > 0 ? <span className={`text-[12px] ${INK}`}>Added {formatGatewayMoney(bucket.extensionMicroUsd)}</span>
        : bucket.resetRequestStatus === "denied" ? <span className={`text-[12px] ${MUTED}`}>Request declined</span>
          : bucket.allowRequestReset ? <span className={`text-[12px] ${MUTED}`}>You can ask for more once it runs out</span> : null;
  return (
    <li aria-label={`${period} limit`} className={`flex flex-col gap-2 px-4 py-3 ${ROW}`} data-testid="my-usage-limit-row">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="min-w-0 flex-1">
          <span className={`block text-[13px] font-medium ${INK}`}>{period}</span>
          <span className={`block text-[12px] ${MUTED}`}>
            <time dateTime={bucket.resetAt} title={new Date(bucket.resetAt).toLocaleString()}>{gatewayBucketExhausted(bucket) ? `Used up. ${reset}` : reset}</time>
            {bucket.hardLimit ? ". Pauses at the limit" : ". Only warns at the limit"}
          </span>
        </span>
        <span className="flex w-44 flex-col gap-1">
          <ShareBar value={Math.min(bucket.usedMicroUsd, bucket.allowanceMicroUsd)} max={bucket.allowanceMicroUsd} label={`${formatGatewayMoney(bucket.usedMicroUsd)} of ${formatGatewayMoney(bucket.allowanceMicroUsd)} used`} />
          <span className={`text-[11px] tabular-nums ${MUTED}`} data-testid="my-usage-limit-used">{formatGatewayMoney(bucket.usedMicroUsd)} of {formatGatewayMoney(bucket.allowanceMicroUsd)} used</span>
        </span>
        <span className={`w-16 text-right text-[13px] font-medium tabular-nums ${INK}`}>{left}% left</span>
        {request ? <span className="flex min-w-[10rem] justify-end">{request}</span> : null}
      </div>
      {asking && askable ? <AskForm amount={amount} period={period} pending={pending} error={error} onCancel={onCancel} onSubmit={onSubmit} /> : null}
    </li>
  );
}

function AskForm({ amount, period, pending, error, onCancel, onSubmit }: {
  amount: string; period: string; pending: boolean; error: string | null; onCancel: () => void; onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const id = useId();
  const trimmed = reason.trim();
  return (
    <form className="grid max-w-xl gap-2" onSubmit={(event) => {
      event.preventDefault();
      if (!pending && trimmed && trimmed.length <= 2000) onSubmit(trimmed);
    }}>
      <label htmlFor={id} className={`text-[12px] font-medium ${INK}`}>Ask for {amount} more {period.toLowerCase()}. What do you need it for?</label>
      <DenTextarea id={id} rows={3} required maxLength={2000} value={reason} autoFocus disabled={pending} onChange={(event) => setReason(event.target.value)} />
      {error ? <p role="alert" className={`text-[12px] ${MUTED}`}>{error} Check your limits before asking again.</p> : null}
      <div className="flex items-center justify-end gap-2">
        <DenButton type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>Cancel</DenButton>
        <DenButton type="submit" size="sm" disabled={pending || !trimmed}>{pending ? "Sending…" : "Send request"}</DenButton>
      </div>
    </form>
  );
}

function LimitDetails({ status }: { status: GatewayUsageStatus }) {
  const { coverage } = status;
  const rows: [string, string][] = [];
  if (coverage.trackingStartedAt) rows.push(["Counting since", new Date(coverage.trackingStartedAt).toLocaleString()]);
  if (coverage.historicalCoverage === "unknown" || coverage.historicalUnknownReason != null) rows.push(["Spend before that", "Not counted"]);
  if (coverage.unpricedRequests > 0) rows.push(["Requests without a price yet", coverage.unpricedRequests.toLocaleString()]);
  if ((coverage.incompleteRequests ?? 0) > 0) rows.push(["Requests still being counted", (coverage.incompleteRequests ?? 0).toLocaleString()]);
  rows.push(["Chats still running", "Added when they finish"]);
  if (coverage.lastSettlementAt) rows.push(["Last updated", new Date(coverage.lastSettlementAt).toLocaleString()]);
  return (
    <details className={`group border-t border-[var(--den-list-line)] px-4 py-3 text-[12px] ${MUTED}`}>
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />How limits are counted
      </summary>
      <dl className="grid max-w-sm gap-1.5 ps-5 pt-3">
        {rows.map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt>{label}</dt><dd className={INK}>{value}</dd></div>)}
      </dl>
    </details>
  );
}

/* ---------- Past 30 days ---------- */

type UsageQuery = ReturnType<typeof useMyGatewayUsage>;

function PastUsage({ query }: { query: UsageQuery }) {
  const id = useId();
  const [metric, setMetric] = useState<"tokens" | "cost">("cost");
  const data = query.data;
  const usage = data?.usage;
  const metrics = usage ? gatewayMemberUsageMetrics(usage) : null;
  const totals = usage ? gatewayMemberSeriesTotals(usage) : [];
  const colors = useSeriesColors(usage?.series.map((series) => series.id) ?? [], "my-usage");
  const isCost = metric === "cost";
  const loading = query.isPending;
  const missing = usage ? (isCost ? usage.unpricedRequests : usage.unreportedRequests) : 0;
  const unknownCost = isCost && usage?.totalCostMicroUsd === 0 && missing !== 0;
  const chartSeries = usage ? usage.series.filter((series) => usage.daily.some((day) => isCost ? typeof day.costValues[series.id] === "number" : (day.values[series.id] ?? 0) > 0)) : [];
  const chartDays = usage?.daily.map((day) => ({
    date: day.date,
    total: isCost ? (day.totalCostMicroUsd === 0 && Object.values(day.costValues).some((value) => value === null) ? null : day.totalCostMicroUsd) : day.totalTokens,
    values: isCost ? day.costValues : Object.fromEntries(Object.entries(day.values).filter(([, value]) => value > 0)),
  }));
  const value = (text: string | null) => loading ? "…" : text ?? "—";
  const spendTotal = totals.reduce((sum, row) => sum + row.costMicroUsd, 0);
  return (
    <Section title="Past 30 days" testId="my-usage-past" detail="All AI Gateway models, including OpenWork Models">
      {query.isError ? <div className={AUTOMATION_CARD_CLASS}><ErrorRetry message={query.error.message} busy={query.isFetching} onRetry={() => void query.refetch()} /></div> : (
        <div className="grid gap-4">
          <StatStrip label="Your usage in the past 30 days" columns="grid-cols-2 lg:grid-cols-4">
            <StatCard title="Spend" value={value(metrics ? (metrics.spendMicroUsd === null ? "Unknown" : formatGatewaySpend(metrics.spendMicroUsd)) : null)}
              sub={metrics && metrics.unpricedRequests !== 0 ? (metrics.unpricedRequests === null ? "Some older requests may be missing a price" : `${metrics.unpricedRequests.toLocaleString()} without a price yet`) : "Approximate, at listed prices"} />
            <StatCard title="Requests" value={value(metrics?.requests == null ? null : metrics.requests.toLocaleString())} />
            <StatCard title="Tokens" value={value(metrics ? metrics.tokens.toLocaleString() : null)} sub="Reported by providers" />
            <StatCard title="Top model" value={value(metrics ? metrics.topModel?.label ?? "None yet" : null)}
              sub={metrics?.topModel ? `${formatGatewaySpend(metrics.topModel.costMicroUsd)}, ${metrics.topModel.tokens.toLocaleString()} tokens` : undefined} />
          </StatStrip>

          <div className={`${AUTOMATION_CARD_CLASS} min-w-0 p-4`} data-testid="my-usage-chart">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h3 className={CARD_TITLE_CLASS}>By model, per day</h3>
              <div className="flex items-center gap-2">
                <span id={`${id}-metric`} className={`text-[12px] ${MUTED}`}>Show</span>
                <div role="group" aria-labelledby={`${id}-metric`} className="flex h-8 items-center gap-0.5 rounded-lg bg-[var(--dls-hover)] p-0.5">
                  {(["cost", "tokens"] as const).map((option) => (
                    <button key={option} type="button" aria-pressed={metric === option} onClick={() => setMetric(option)}
                      className={`h-full rounded-md px-3 text-[12px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--dls-text-secondary)] ${metric === option ? `bg-[var(--dls-surface)] ${INK}` : `${MUTED} hover:text-[color:var(--dls-text-primary)]`}`}>
                      {option === "cost" ? "Cost" : "Tokens"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {loading ? <DenSkeleton role="status" aria-label="Loading your usage" className="block h-52 w-full rounded-xl" />
              : usage && chartDays ? <StackedDailyChart daily={chartDays} series={chartSeries} colors={colors}
                valueLabel={isCost ? "Cost in USD" : "Reported tokens"} valueFormat={isCost ? "usd" : "tokens"}
                emptyLabel={isCost ? (unknownCost ? "Cost estimates aren’t available for these requests yet." : "No recorded cost in the past 30 days.") : "No reported tokens in the past 30 days."} /> : null}
            {usage && !isCost ? <GatewayUsageCoverageNotice usage={usage} /> : null}
            {isCost ? <p role="note" className={`mt-4 text-[12px] leading-5 ${MUTED}`}>Costs are approximate, from each model’s listed price when the request was recorded. <a href={COSTS_DOCS} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-[color:var(--dls-text-primary)]">How costs are calculated</a></p> : null}
          </div>

          {totals.length ? (
            <div className={`${AUTOMATION_CARD_CLASS} min-w-0 px-4 py-2`} data-testid="my-usage-models">
              <ul aria-label="Your spend by model">
                {totals.map((row) => (
                  <li key={row.id} className={`flex items-center gap-3 py-2.5 ${ROW}`} data-testid="my-usage-model-row">
                    <ModelMark seriesId={row.id} label={row.label} />
                    <span className={`min-w-0 flex-1 truncate text-[13px] font-medium ${INK}`}>{row.label}</span>
                    <span className={`hidden w-36 text-right text-[12px] tabular-nums sm:block ${MUTED}`}>{row.tokens.toLocaleString()} tokens</span>
                    <ShareBar value={row.costMicroUsd} max={totals[0]?.costMicroUsd ?? 0} label={spendTotal > 0 ? `${Math.round((row.costMicroUsd / spendTotal) * 100)}% of your spend` : "No recorded cost"} />
                    <span className={`w-20 shrink-0 text-right text-[13px] font-medium tabular-nums ${INK}`}>{row.unpriced && !row.costMicroUsd ? "Unknown" : formatGatewaySpend(row.costMicroUsd)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Section>
  );
}

/* ---------- Model catalog & cost comparison ---------- */

function priceLine(price: GatewayListedPrice): string {
  const usd = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  const cache = price.cacheRead !== null ? `, ${usd(price.cacheRead)} cached` : "";
  const tiers = price.contextTiers.length ? `, more above ${Math.round(price.contextTiers[0].above / 1000)}k context` : "";
  return `${usd(price.input)} in, ${usd(price.output)} out${cache} per 1M tokens${tiers}`;
}

function comparisonNote(data: GatewayMemberUsageResponse, measured: number, unmeasured: number | null): string {
  if (!measured) return "Once you use a model, this shows what your usage would cost on each one.";
  const left = unmeasured ? ` ${unmeasured.toLocaleString()} ${unmeasured === 1 ? "request" : "requests"} without reported tokens ${unmeasured === 1 ? "is" : "are"} left out.` : "";
  return `What your ${measured.toLocaleString()} ${measured === 1 ? "request" : "requests"} in the past ${data.usage.days} days would have cost on each model, at its listed price.${left}`;
}

function ModelCatalog({ query }: { query: UsageQuery }) {
  const data = query.data;
  const comparison = data ? gatewayModelCostComparison(data) : null;
  return (
    <Section title="Models you can use" testId="my-usage-catalog">
      <div className={`${AUTOMATION_CARD_CLASS} min-w-0`}>
        {query.isPending ? <div role="status" aria-label="Loading models" className="grid gap-3 p-4"><DenSkeleton className="h-4 w-56" /><DenSkeleton className="h-24 w-full" /></div>
          : query.isError ? <ErrorRetry message={query.error.message} busy={query.isFetching} onRetry={() => void query.refetch()} />
            : !data || !comparison ? null
              : !comparison.rows.length ? <p role="status" className={`px-4 py-3 text-[13px] ${MUTED}`} data-testid="my-usage-no-models">No AI Gateway models are shared with you yet. Ask an admin for access.</p>
                : (
                  <>
                    <p className={`border-b border-[var(--den-list-line)] px-4 py-3 text-[12px] leading-5 ${MUTED}`} data-testid="my-usage-comparison-note">
                      {comparisonNote(data, comparison.mix.measuredRequests, comparison.unmeasuredRequests)}
                    </p>
                    <ul aria-label="Models you can use, cheapest for your usage first" className="px-4">
                      {comparison.rows.map((row) => (
                        <li key={`${row.model.providerName}:${row.model.seriesId}`} className={`flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 ${ROW}`} data-testid="my-usage-catalog-row">
                          <ModelMark seriesId={row.model.seriesId} label={row.model.name} />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-2">
                              <span className={`truncate text-[13px] font-medium ${INK}`}>{row.model.name}</span>
                              {row.inUse ? <DenBadge size="sm" tone="info">What you use now</DenBadge> : null}
                            </span>
                            <span className={`block truncate text-[12px] ${MUTED}`}>{row.model.providerName}{row.model.price ? `: ${priceLine(row.model.price)}` : ""}</span>
                          </span>
                          <span className="flex w-36 shrink-0 flex-col items-end" data-testid="my-usage-catalog-estimate">
                            {row.estimateMicroUsd === null
                              ? <span className={`text-[12px] ${MUTED}`}>No listed price</span>
                              : comparison.mix.measuredRequests
                                ? <>
                                  <span className={`text-[13px] font-medium tabular-nums ${INK}`}>{formatGatewaySpend(row.estimateMicroUsd)}</span>
                                  <span className={`text-[11px] ${MUTED}`}>for your usage</span>
                                </>
                                : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
      </div>
    </Section>
  );
}
