"use client";

import { AGENT_RESPONSIBILITY_COPY, type WorkbotProactiveHealth } from "@openwork/types/den/workbot-proactive";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenTable, type DenTableColumn } from "../../_components/ui/table";
import { useWorkbotProactiveHealth } from "./workbot-proactive-data";

/**
 * Manage › Workbot › Members' agents, last 7 days: per responsibility, how often agents checked, how often they had
 * nothing to say, how many messages went out and how many members muted it. Counts only.
 */

type Row = WorkbotProactiveHealth["responsibilities"][number];

function share(part: number, whole: number) {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

export function WorkbotProactiveHealthTable({ health }: { health: WorkbotProactiveHealth }) {
  const columns: DenTableColumn<Row>[] = [
    { key: "responsibility", header: "Responsibility", render: (row) => <span className="font-medium text-gray-900">{AGENT_RESPONSIBILITY_COPY[row.id].label}</span> },
    { key: "checks", header: "Checks", align: "right", width: "96px", render: (row) => row.checks.toLocaleString("en-US") },
    { key: "quiet", header: "Stayed quiet", align: "right", width: "120px", render: (row) => share(row.quiet, row.checks) },
    { key: "sent", header: "Messages", align: "right", width: "104px", render: (row) => row.sent.toLocaleString("en-US") },
    { key: "muted", header: "Muted by", align: "right", width: "120px", render: (row) => `${row.muted} of ${health.members}` },
  ];
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white" data-testid="workbot-proactive-health">
      <DenTable columns={columns} rows={health.responsibilities} getRowKey={(row) => row.id} density="compact" headerTone="plain"
        emptyLabel="No checks in the last 7 days." />
    </div>
  );
}

export function WorkbotProactiveHealthSection({ orgId }: { orgId: string }) {
  const query = useWorkbotProactiveHealth(orgId, Boolean(orgId));
  return (
    <section aria-label="Last 7 days" className="grid gap-2" data-section="workbot-proactive-health">
      <h2 className="px-1 text-[13px] font-medium text-gray-500">Last 7 days</h2>
      {query.isError ? (
        <DenNotice
          tone="error"
          message={query.error instanceof Error ? query.error.message : "Couldn't load agent health."}
          action={<DenButton variant="secondary" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>Try again</DenButton>}
        />
      ) : query.data ? (
        <WorkbotProactiveHealthTable health={query.data} />
      ) : (
        <div className="grid gap-2 rounded-2xl border border-gray-100 bg-white px-6 py-4" data-testid="workbot-proactive-health-skeleton">
          {[0, 1, 2, 3].map((index) => <DenSkeleton key={index} className="h-5 w-full" />)}
        </div>
      )}
    </section>
  );
}
