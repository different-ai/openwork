"use client";

import { RefreshButton } from "../computers/computer-parts";
import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { DenButton } from "../../../_components/ui/button";
import { DenNotice } from "../../../_components/ui/notice";
import { CARD_TITLE_CLASS } from "../../../_components/ui/dashboard-styles";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { AnalyticsEmptyState, AnalyticsErrorState, AnalyticsLoading, AnalyticsPageHeader, analyticsPageClass, analyticsSurfaceClass } from "../analytics/analytics-layout";
import { StatCard } from "../analytics/stat-card";
import { TrendChart } from "../analytics/trend-chart";
import { useWorkbotUsage, useWorkbotUsageAvailable } from "./use-workbot-usage";
import { formatWorkbotCost, formatWorkbotCount, WORKBOT_SURFACE_LABELS, workbotCostShare, workbotCountingSince, workbotMemberLabel } from "./workbot-usage-data";

type CostRow = { key: string; label: string; detail?: string; costMicroUsd: number; requests: number };

/** One titled list of costs, most expensive first, each with its share of the largest as a bar (title only, DESIGN.md P2). */
function CostList({ title, rows, total, testId, footer }: {
  title: string; rows: CostRow[]; total: number; testId: string; footer?: ReactNode;
}) {
  const max = Math.max(1, ...rows.map((row) => row.costMicroUsd));
  return <section className={`${analyticsSurfaceClass} p-4`} data-testid={testId}>
    <h3 className={CARD_TITLE_CLASS}>{title}</h3>
    <ul className="mt-4 space-y-3">
      {rows.map((row) => <li key={row.key}>
        <div className="flex items-baseline justify-between gap-3 text-[12px]">
          <span className="min-w-0 truncate font-medium text-[var(--dls-text-primary)]" title={row.detail ?? row.label}>
            {row.label}{row.detail ? <span className="ml-2 font-normal text-[var(--dls-text-secondary)]">{row.detail}</span> : null}
          </span>
          <span className="shrink-0 tabular-nums text-[var(--dls-text-secondary)]">
            <span className="font-medium text-[var(--dls-text-primary)]">{formatWorkbotCost(row.costMicroUsd)}</span>
            {" · "}{workbotCostShare(row.costMicroUsd, total)}{" · "}{formatWorkbotCount(row.requests)} requests
          </span>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--dls-hover)]" aria-hidden="true">
          <div className="h-full rounded-full bg-[var(--dls-accent)]" style={{ width: `${(row.costMicroUsd / max) * 100}%` }} />
        </div>
      </li>)}
    </ul>
    {footer ? <p className="mt-4 text-xs leading-5 text-[var(--dls-text-secondary)]">{footer}</p> : null}
  </section>;
}

export function WorkbotUsageScreen() {
  const { activeOrg } = useOrgDashboard();
  const available = useWorkbotUsageAvailable();
  const { data, isLoading, isFetching, isError, refetch } = useWorkbotUsage();
  const since = data ? workbotCountingSince(data) : null;
  const totals = data?.totals;
  const cost = totals?.costMicroUsd ?? 0;
  const tokens = (totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0);

  return <div className={analyticsPageClass}>
    <AnalyticsPageHeader orgSlug={activeOrg?.slug} active="workbot" title="Workbot"
      caption={since ? <span data-testid="workbot-usage-since">{since}</span> : undefined}
      action={available && data ? <RefreshButton refreshing={isFetching} onRefresh={() => void refetch()} /> : null} />

    {!available ? (
      <div className={analyticsSurfaceClass}><AnalyticsEmptyState title="Workbot usage isn't available here">It needs the View usage analytics permission, and may not be turned on for this workspace yet.</AnalyticsEmptyState></div>
    ) : isError && !data ? <AnalyticsErrorState title="Couldn't load Workbot usage" onRetry={() => void refetch()} retrying={isFetching} />
    : isLoading || !data || !totals ? <AnalyticsLoading label="Loading Workbot usage" />
    : totals.requests === 0 ? (
      <div className={analyticsSurfaceClass} data-testid="workbot-usage-empty">
        <AnalyticsEmptyState title="No Workbot spend recorded yet">
          What Workbot spends on models appears here as people use it. Use from before this view was added is not included.
        </AnalyticsEmptyState>
      </div>
    ) : <>
      {isError ? <DenNotice tone="neutral" presentation="inline" message="Could not refresh Workbot usage. Showing the last available data." action={<DenButton variant="secondary" size="sm" disabled={isFetching} onClick={() => void refetch()}>Retry</DenButton>} /> : null}
      <p className="text-xs text-[var(--dls-text-secondary)]">Last {data.days} days · UTC</p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="workbot-usage-summary">
        <StatCard title="Model cost" value={formatWorkbotCost(cost)}
          sub={totals.members > 0 ? `${formatWorkbotCost(Math.round(cost / totals.members))} per person` : undefined} />
        <StatCard title="People" value={formatWorkbotCount(totals.members)} sub="Used Workbot in this period" />
        <StatCard title="Model requests" value={formatWorkbotCount(totals.requests)}
          sub={`${formatWorkbotCost(Math.round(cost / totals.requests))} per request`} />
        <StatCard title="Tokens" value={formatWorkbotCount(tokens)}
          sub={`${formatWorkbotCount(totals.inputTokens)} in · ${formatWorkbotCount(totals.outputTokens)} out`} />
      </div>

      {totals.unpricedRequests > 0 ? <DenNotice tone="neutral" presentation="inline"
        message={`${formatWorkbotCount(totals.unpricedRequests)} ${totals.unpricedRequests === 1 ? "request has" : "requests have"} no known price and ${totals.unpricedRequests === 1 ? "is" : "are"} not in the cost.`} /> : null}

      <TrendChart title="Cost per day" subtitle="US dollars" intervalLabel=""
        weeks={data.daily.map((day) => ({ weekStart: day.day }))}
        series={[{ label: "Cost", values: data.daily.map((day) => day.costMicroUsd) }]}
        formatValue={formatWorkbotCost} emptyLabel="No cost recorded yet" />

      <div className="grid gap-3 lg:grid-cols-2">
        <CostList testId="workbot-usage-surfaces" title="Where it ran"
          total={cost} rows={data.surfaces.map((row) => ({ key: row.surface, label: WORKBOT_SURFACE_LABELS[row.surface], costMicroUsd: row.costMicroUsd, requests: row.requests }))} />
        <CostList testId="workbot-usage-models" title="Models"
          total={cost} rows={data.models.map((row) => ({ key: row.model, label: row.model || "Unknown model", costMicroUsd: row.costMicroUsd, requests: row.requests }))} />
      </div>

      <CostList testId="workbot-usage-members" title="People"
        total={cost} rows={data.members.map((row) => ({ key: row.memberId, label: workbotMemberLabel(row), detail: row.name && row.email ? row.email : undefined, costMicroUsd: row.costMicroUsd, requests: row.requests }))}
        footer={totals.members > data.members.length ? `Showing the ${data.members.length} people with the highest cost of ${formatWorkbotCount(totals.members)}.` : undefined} />

      <p className="border-t border-[var(--den-list-line)] pt-4 text-xs leading-5 text-[var(--dls-text-secondary)]">
        Cost as the AI Gateway recorded it, including use covered by an included allowance. Never what people asked or what Workbot answered.
      </p>
    </>}
  </div>;
}
