"use client";

import type { ReactNode } from "react";
import type { GatewayUsageGroupBy } from "@openwork/types/den/gateway-usage";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton } from "../../_components/ui/button";
import { AUTOMATION_CARD_CLASS, CARD_TITLE_CLASS } from "../../_components/ui/dashboard-styles";
import { DenNotice } from "../../_components/ui/notice";
import { getAiGatewayPersonRoute } from "../../_lib/den-org";
import { formatUsageCost } from "../_features/analytics/stacked-daily-chart";
import { gatewayUsageModelFamily, gatewayUsageTotals, useGatewayUsage, type GatewayUsageTotal } from "./gateway-usage-data";
import { RowLane, RowList } from "../_features/computers/computer-rows";
import { GATEWAY_LANE, GatewayRow, InitialsTile } from "./gateway-rows";
import { getProviderIconSlug } from "./llm-provider-data";

const MUTED = "text-[color:var(--dls-text-secondary)]";

const VISIBLE_ROWS = 5;

export function initials(label: string): string {
  return label.split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
}

export function ShareBar({ value, max, label }: { value: number; max: number; label: string }) {
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span role="img" aria-label={label} className="block h-1 w-24 shrink-0 overflow-hidden rounded-full bg-[var(--dls-hover)]">
      <span className="block h-1 rounded-full bg-[var(--dls-text-primary)]" style={{ width: `${width}%` }} />
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
    <section aria-label={title} data-testid={testId} className={`${AUTOMATION_CARD_CLASS} flex min-w-0 flex-col p-4`}>
      <h3 className={`${CARD_TITLE_CLASS} mb-2`}>{title}</h3>
      {query.isPending ? <p role="status" className={`py-4 text-[13px] ${MUTED}`}>Loading…</p>
        : query.isError ? (
          <div className="flex flex-col items-start gap-3 py-2">
            <DenNotice tone="error" message={query.error.message} />
            <DenButton size="sm" variant="secondary" onClick={() => void query.refetch()}>Retry</DenButton>
          </div>
        ) : rows.length === 0 ? <p role="status" className={`py-4 text-[13px] ${MUTED}`}>No requests in the last 31 days.</p>
          : (
            <div className="[&_[role=row]:last-child]:border-b-0">
              <RowList label={title}>
                {rows.slice(0, VISIBLE_ROWS).map((row) => (
                  <GatewayRow
                    key={row.id}
                    rowTestId={`${testId}-row`}
                    lead={renderLead(row)}
                    name={row.label}
                    href={href?.(row)}
                    stretch
                    lanes={<>
                      <RowLane lane={GATEWAY_LANE.share} className="flex-col justify-center gap-1">
                        <ShareBar value={row.costMicroUsd} max={max} label={shareLabel(row, total)} />
                        <span className={`text-[11px] leading-4 ${MUTED}`}>{shareLabel(row, total)}</span>
                      </RowLane>
                      <RowLane lane={GATEWAY_LANE.amount} className="font-medium text-[color:var(--dls-text-primary)]">
                        {row.unpriced && row.costMicroUsd === 0 ? "Unknown" : formatUsageCost(row.costMicroUsd)}
                      </RowLane>
                    </>}
                  />
                ))}
              </RowList>
            </div>
          )}
      {hidden.length > 0 ? (
        <p className={`border-t border-[var(--den-list-line)] pt-3 text-[12px] ${MUTED}`}>
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
          <InitialsTile>{initials(row.label)}</InitialsTile>
        )}
      />
      <BreakdownCard
        title="Models people use"
        groupBy="model"
        orgId={orgId}
        testId="gateway-spend-models"
        renderLead={(row) => <ModelMark seriesId={row.id} label={row.label} tile />}
      />
    </div>
  );
}

export function ModelMark({ seriesId, label, tile = false }: { seriesId: string; label: string; /** The 32px row tile instead of the 28px mark. */ tile?: boolean }) {
  const family = gatewayUsageModelFamily(seriesId);
  const size = tile ? "size-8 rounded-lg" : "size-7 rounded-[8px]";
  return family
    ? <DenBrandMark name={family} simpleIconSlug={getProviderIconSlug(family)} className={`${size} shrink-0`} imageClassName="h-4 w-4" />
    : <span aria-hidden="true" className={`flex ${size} shrink-0 items-center justify-center bg-[var(--dls-hover)] text-[10px] font-semibold text-[color:var(--dls-text-secondary)]`}>{initials(label)}</span>;
}
