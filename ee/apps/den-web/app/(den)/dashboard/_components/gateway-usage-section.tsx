"use client";

import { Popover } from "@base-ui/react/popover";
import type { GatewayUsageGroupBy } from "@openwork/types/den/gateway-usage";
import { Filter, Search } from "lucide-react";
import { useId, useState } from "react";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSelect } from "../../_components/ui/select";
import { formatUsageCost, StackedDailyChart } from "../_features/analytics/stacked-daily-chart";
import { useGatewayUsage } from "./gateway-usage-data";

export function GatewayUsageSection({ orgId }: { orgId: string }) {
  const id = useId();
  const [groupBy, setGroupBy] = useState<GatewayUsageGroupBy>("model");
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [filterIds, setFilterIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const query = useGatewayUsage(orgId, groupBy, filterIds);
  const loading = query.isPending || query.isFetching || query.isPlaceholderData;
  const usage = !loading && !query.isError ? query.data : undefined;
  const noTeams = groupBy === "team" && usage?.emptyReason === "no_teams";
  const filterKind = groupBy === "model" ? "providers" : groupBy === "team" ? "teams" : "people";
  const selectedLabel = filterIds.length === 1 ? (groupBy === "model" ? "provider" : groupBy === "team" ? "team" : "person") : filterKind;
  const options = query.data?.filterOptions;
  const matches = options?.filter((option) => option.label.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const isCost = metric === "cost";
  const missing = usage ? (isCost ? usage.unpricedRequests : usage.unreportedRequests) : undefined;
  const hasMissing = missing === null || (typeof missing === "number" && missing > 0);
  const unknownCost = isCost && usage?.totalCostMicroUsd === 0 && hasMissing;
  const valueLabel = isCost
    ? (groupBy === "team" ? "Team cost · USD" : "Cost · USD")
    : (groupBy === "team" ? "Team-attributed tokens" : "Reported tokens");
  const chartSeries = usage
    ? usage.series.filter((series) => !isCost || usage.daily.some((day) => typeof day.costValues[series.id] === "number"))
    : [];
  const chartDays = usage?.daily.map((day) => ({
    date: day.date,
    total: isCost
      ? (day.totalCostMicroUsd === 0 && Object.values(day.costValues).some((value) => value === null) ? null : day.totalCostMicroUsd)
      : day.totalTokens,
    values: isCost ? day.costValues : day.values,
  }));

  return (
    <section aria-labelledby={`${id}-heading`} className="mb-10 min-w-0" data-testid="gateway-usage">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${id}-heading`} className="text-lg font-semibold tracking-tight text-gray-950">Usage</h2>
        <p className="text-xs text-gray-500">Last 31 days &middot; UTC</p>
      </div>
      <DenCard className="min-w-0">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div className="min-w-0">
            <p className="text-xs text-gray-500">{valueLabel}</p>
            {usage ? <p className="mt-1 break-words text-3xl font-semibold tracking-tight text-gray-950 tabular-nums">{noTeams ? "—" : isCost ? (unknownCost ? "Unknown" : formatUsageCost(usage.totalCostMicroUsd)) : usage.totalTokens.toLocaleString()}</p>
              : <p role="status" className="mt-2 text-sm text-gray-500">{loading ? "Loading usage..." : "Usage unavailable"}</p>}
            <p className="mt-2 text-xs text-gray-500">Gateway providers only. OpenWork Models not included.</p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <span id={`${id}-metric-label`} className="text-xs font-medium text-gray-600">Show</span>
              <div role="group" aria-labelledby={`${id}-metric-label`} className="flex h-10 items-center gap-1 rounded-lg bg-gray-100 p-1">
                <button type="button" aria-pressed={!isCost} onClick={() => setMetric("tokens")} className={`h-full rounded-md px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${!isCost ? "bg-white text-gray-950" : "text-gray-500 hover:text-gray-900"}`}>Tokens</button>
                <button type="button" aria-pressed={isCost} onClick={() => setMetric("cost")} className={`h-full rounded-md px-3 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${isCost ? "bg-white text-gray-950" : "text-gray-500 hover:text-gray-900"}`}>Cost</button>
              </div>
            </div>
            <div className="grid gap-1.5">
              <label htmlFor={`${id}-group`} className="text-xs font-medium text-gray-600">Group By</label>
              <DenSelect id={`${id}-group`} aria-label="Group By" className="w-36" value={groupBy} onChange={(event) => {
                const value = event.target.value;
                if (value !== "model" && value !== "team" && value !== "person") return;
                setGroupBy(value);
                setFilterIds([]);
                setSearch("");
                setFilterOpen(false);
              }}>
                <option value="model">Model</option>
                <option value="team">Team</option>
                <option value="person">Person</option>
              </DenSelect>
            </div>
            <Popover.Root open={filterOpen} onOpenChange={(open) => { setFilterOpen(open); if (!open) setSearch(""); }}>
              <Popover.Trigger disabled={noTeams} className={buttonVariants({ variant: "secondary", className: "focus-visible:outline-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:opacity-50" })} aria-label={`Filter by ${filterKind}${filterIds.length ? `, ${filterIds.length} selected` : ", all included"}`}>
                <Filter className="size-4" aria-hidden="true" />
                Filter
                {!noTeams && filterIds.length > 0 ? <DenBadge>{filterIds.length}</DenBadge> : null}
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
                  <Popover.Popup className="max-h-[calc(100dvh-2rem)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-gray-200 bg-white p-4 text-gray-900 outline-none">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <Popover.Title className="text-sm font-semibold">Filter by {filterKind}</Popover.Title>
                      <DenButton variant="ghost" size="sm" disabled={!filterIds.length} onClick={() => setFilterIds([])}>Clear</DenButton>
                    </div>
                    <Popover.Description className="mb-3 text-xs text-gray-500">Select one or more {filterKind}. No selection includes all.</Popover.Description>
                    <DenInput type="search" icon={Search} aria-label={`Search ${filterKind}`} placeholder={`Search ${filterKind}...`} value={search} onChange={(event) => setSearch(event.target.value)} />
                    <fieldset className="mt-3 max-h-64 overflow-y-auto">
                      <legend className="sr-only">Included {filterKind}</legend>
                      {matches?.map((option) => <label key={option.id} className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2.5 text-sm hover:bg-gray-50">
                        <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-blue-600" checked={filterIds.includes(option.id)} onChange={(event) => {
                          const checked = event.target.checked;
                          setFilterIds((current) => checked ? [...current, option.id] : current.filter((value) => value !== option.id));
                        }} />
                        <span className="min-w-0 break-words">{option.label}</span>
                      </label>)}
                      {!options ? <p role="status" className="px-2 py-4 text-xs text-gray-500">{query.isError ? "Filter options unavailable. Retry usage below." : "Loading filter options..."}</p>
                        : matches?.length === 0 ? <p role="status" className="px-2 py-4 text-xs text-gray-500">{options.length ? `No ${filterKind} match your search.` : `No ${filterKind} available.`}</p> : null}
                    </fieldset>
                    <div className="mt-3 flex justify-end border-t border-gray-100 pt-3">
                      <Popover.Close className={buttonVariants({ variant: "secondary", size: "sm" })}>Done</Popover.Close>
                    </div>
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
          </div>
        </div>

        {!noTeams ? <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
          <p>{filterIds.length ? `${filterIds.length} ${selectedLabel} selected` : `All ${filterKind}`}</p>
          {filterIds.length > 0 ? <DenButton variant="ghost" size="sm" onClick={() => setFilterIds([])}>Clear filters</DenButton> : null}
        </div> : null}
        {groupBy === "team" && !noTeams ? <p className="mt-2 max-w-3xl text-xs leading-5 text-gray-500">Usage is grouped by current team membership. People in multiple teams are counted in each, so team totals can exceed model or person totals.</p> : null}

        <div className="mt-6" aria-busy={loading}>
          {loading ? <div role="status" className="flex min-h-64 items-center justify-center rounded-xl bg-gray-50 text-sm text-gray-500">Loading daily usage...</div>
            : query.isError ? <div className="grid min-h-64 content-center justify-items-start gap-4">
              <DenNotice tone="error" message={query.error.message} />
              <DenButton variant="secondary" onClick={() => void query.refetch()}>Retry usage</DenButton>
            </div>
              : noTeams ? <div role="status" className="flex min-h-64 flex-col items-center justify-center gap-2 text-center">
                <p className="text-base font-medium text-gray-900">No teams yet</p>
                <p className="max-w-md text-sm text-gray-500">Create a team to view usage grouped by team, or switch Group By to Model or Person.</p>
              </div>
                : usage && chartDays ? <StackedDailyChart daily={chartDays} series={chartSeries} valueLabel={valueLabel} valueFormat={isCost ? "usd" : "tokens"} emptyLabel={isCost ? (unknownCost ? "Cost estimates are not available for these requests yet." : "No recorded cost in this period for the selected filters.") : filterIds.length ? "No reported tokens match these filters." : "No reported Gateway tokens in this period."} /> : null}
        </div>
        {usage && !noTeams && !isCost && hasMissing ? <DenNotice className="mt-5" tone="warning" message={missing === null ? "Some historical requests may not have reported token usage. These totals may be incomplete."
            : `${missing?.toLocaleString()} ${groupBy === "team" ? "team-attributed " : ""}${missing === 1 ? "request did" : "requests did"} not report token usage. These totals include reported tokens only.`} /> : null}
        {isCost ? <div role="note" className="mt-5 text-xs leading-5 text-gray-500">
          <p>Costs are approximate based on publicly listed model prices when each request was recorded. They do not reflect any contract or discount agreements you may have. If no cost data is available for a model, it is not shown.</p>
          {usage && !noTeams && hasMissing ? <p className="mt-1">
            {missing === null
              ? "Cost coverage is unknown for some historical requests."
              : `${missing?.toLocaleString()} ${groupBy === "team" ? "team-attributed " : ""}${missing === 1 ? "request has" : "requests have"} no cost estimate.`} Cost includes known costs only; missing costs are not treated as free.
          </p> : null}
        </div> : null}
      </DenCard>
    </section>
  );
}
