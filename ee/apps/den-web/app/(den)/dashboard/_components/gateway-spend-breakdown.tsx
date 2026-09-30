"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { GatewayUsageGroupBy } from "@openwork/types/den/gateway-usage";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { getAiGatewayPersonRoute } from "../../_lib/den-org";
import { formatUsageCost } from "../_features/analytics/stacked-daily-chart";
import { gatewayUsageModelFamily, gatewayUsageTotals, useGatewayUsage, type GatewayUsageTotal } from "./gateway-usage-data";
import { getProviderIconSlug } from "./llm-provider-data";

const VISIBLE_ROWS = 5;

export function initials(label: string): string {
  return label.split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
}

export function ShareBar({ value, max, label }: { value: number; max: number; label: string }) {
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span role="img" aria-label={label} className="block h-1 w-24 shrink-0 overflow-hidden rounded-full bg-gray-100">
      <span className="block h-1 rounded-full bg-gray-900" style={{ width: `${width}%` }} />
    </span>
  );
}

function totalCost(rows: GatewayUsageTotal[]) {
  return rows.reduce((sum, row) => sum + row.costMicroUsd, 0);
}

function shareLabel(row: GatewayUsageTotal, total: number) {
  return total > 0 ? `${Math.round((row.costMicroUsd / total) * 100)}% of spend` : "No recorded cost";
}

function BreakdownCard({ title, groupBy, orgId, testId, renderLead, href }: {
  title: string;
  groupBy: GatewayUsageGroupBy;
  orgId: string;
  testId: string;
  renderLead: (row: GatewayUsageTotal) => ReactNode;
  href?: (row: GatewayUsageTotal) => string;
}) {
  const query = useGatewayUsage(orgId, groupBy, []);
  const rows = query.data ? gatewayUsageTotals(query.data) : [];
  const total = totalCost(rows);
  const max = rows[0]?.costMicroUsd ?? 0;
  const hidden = rows.slice(VISIBLE_ROWS);
  return (
    <section aria-label={title} data-testid={testId} className="flex min-w-0 flex-col rounded-[12px] border border-gray-100 bg-white">
      <h3 className="border-b border-gray-100 px-4 py-3 text-[14px] font-medium text-gray-950">{title}</h3>
      {query.isPending ? <p role="status" className="px-4 py-6 text-[13px] text-gray-500">Loading…</p>
        : query.isError ? (
          <div className="flex flex-col items-start gap-3 px-4 py-4">
            <DenNotice tone="error" message={query.error.message} />
            <DenButton size="sm" variant="secondary" onClick={() => void query.refetch()}>Retry</DenButton>
          </div>
        ) : rows.length === 0 ? <p role="status" className="px-4 py-6 text-[13px] text-gray-500">No requests in the last 31 days.</p>
          : (
            <ul className="divide-y divide-gray-100">
              {rows.slice(0, VISIBLE_ROWS).map((row) => {
                const content = (
                  <>
                    {renderLead(row)}
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900">{row.label}</span>
                    <span className="flex w-28 shrink-0 flex-col gap-1">
                      <ShareBar value={row.costMicroUsd} max={max} label={shareLabel(row, total)} />
                      <span className="text-[11px] text-gray-500">{shareLabel(row, total)}</span>
                    </span>
                    <span className="w-20 shrink-0 text-right text-[13px] font-medium tabular-nums text-gray-950">
                      {row.unpriced && row.costMicroUsd === 0 ? "Unknown" : formatUsageCost(row.costMicroUsd)}
                    </span>
                  </>
                );
                return (
                  <li key={row.id} data-testid={`${testId}-row`}>
                    {href ? (
                      <Link href={href(row)} className="flex h-[52px] items-center gap-3 px-4 hover:bg-gray-50">{content}</Link>
                    ) : <div className="flex h-[52px] items-center gap-3 px-4">{content}</div>}
                  </li>
                );
              })}
            </ul>
          )}
      {hidden.length > 0 ? (
        <p className="border-t border-gray-100 px-4 py-3 text-[12px] text-gray-500">
          {hidden.length} more · {formatUsageCost(totalCost(hidden))}
        </p>
      ) : null}
    </section>
  );
}

export function GatewaySpendBreakdown({ orgId, orgSlug }: { orgId: string; orgSlug: string | null | undefined }) {
  return (
    <div className="mb-10 grid gap-4 lg:grid-cols-2" data-testid="gateway-spend-breakdown">
      <BreakdownCard
        title="Who spends it"
        groupBy="person"
        orgId={orgId}
        testId="gateway-spend-people"
        href={(row) => getAiGatewayPersonRoute(orgSlug, row.id)}
        renderLead={(row) => (
          <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-semibold text-gray-700">{initials(row.label)}</span>
        )}
      />
      <BreakdownCard
        title="Models people use"
        groupBy="model"
        orgId={orgId}
        testId="gateway-spend-models"
        renderLead={(row) => <ModelMark seriesId={row.id} label={row.label} />}
      />
    </div>
  );
}

export function ModelMark({ seriesId, label }: { seriesId: string; label: string }) {
  const family = gatewayUsageModelFamily(seriesId);
  return family
    ? <DenBrandMark name={family} simpleIconSlug={getProviderIconSlug(family)} className="h-7 w-7 shrink-0 rounded-[8px]" imageClassName="h-4 w-4" />
    : <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-gray-100 text-[10px] font-semibold text-gray-500">{initials(label)}</span>;
}
