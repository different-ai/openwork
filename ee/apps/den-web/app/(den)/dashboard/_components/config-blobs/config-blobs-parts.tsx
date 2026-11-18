"use client";

import type { ConfigChangeRequestStatus, ConfigPlanSummary } from "@openwork/types/den/config-blobs";
import { DenChip } from "../../../_components/ui/chip";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { CONFIG_STATUS_PRESENTATION, formatSummaryCounts, isTransientStatus } from "./config-blobs-model";

/** Settings › Config renders once the organization has loaded. */
export function useConfigOrgReady(): { ready: boolean } {
  const { orgContext, orgBusy } = useOrgDashboard();
  return { ready: !orgBusy && Boolean(orgContext) };
}

export function ConfigStatusChip({ status }: { status: ConfigChangeRequestStatus }) {
  const { label, tone } = CONFIG_STATUS_PRESENTATION[status];
  return (
    <DenChip tone={tone} spinning={isTransientStatus(status)} data-testid="config-status-chip" data-status={status}>
      {label}
    </DenChip>
  );
}

/** `+3 ~5 −0`: adds, changes (with renames), removals. */
export function ConfigCounts({ summary }: { summary: ConfigPlanSummary | null }) {
  const counts = formatSummaryCounts(summary);
  if (!counts || !summary) return null;
  return (
    <span
      className="inline-flex items-center gap-2 font-mono text-[12px] text-gray-500"
      aria-label={`${summary.create} to add, ${summary.update + summary.rename} to change, ${summary.delete} to remove`}
      data-testid="config-counts"
    >
      <span className={summary.create > 0 ? "text-gray-900" : undefined}>{counts.create}</span>
      <span className={summary.update + summary.rename > 0 ? "text-gray-900" : undefined}>{counts.update}</span>
      <span className={summary.delete > 0 ? "text-red-700" : undefined}>{counts.remove}</span>
    </span>
  );
}

export function ConfigRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-6 py-4" aria-hidden="true">
      <div className="min-w-0 flex-1 space-y-2">
        <DenSkeleton className="h-4 w-48" />
        <DenSkeleton className="h-3 w-72" />
      </div>
      <DenSkeleton className="h-5 w-20 rounded-full" />
    </div>
  );
}
