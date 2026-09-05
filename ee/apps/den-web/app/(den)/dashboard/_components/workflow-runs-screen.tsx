"use client";

import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenCard } from "../../_components/ui/card";
import { DenTable, type DenTableColumn } from "../../_components/ui/table";
import {
  getWorkflowRuns,
  getErrorMessage,
  requestJson,
  type WorkflowRun,
} from "../../_lib/den-flow";

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(1)} s`;
}

const columns: readonly DenTableColumn<WorkflowRun>[] = [
  {
    key: "status",
    header: "Status",
    render: (run) => (
      <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${run.status === "succeeded" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
        {run.status === "succeeded" ? "Succeeded" : "Failed"}
      </span>
    ),
  },
  {
    key: "source",
    header: "Source",
    render: (run) => (
      <span className="block max-w-[280px] truncate font-mono text-[12px] text-gray-700" title={run.source}>
        {run.source}
      </span>
    ),
  },
  {
    key: "tools",
    header: "Tool calls",
    render: (run) => (
      <div className="max-w-[360px] text-[12px] text-gray-600">
        <span className="font-medium text-gray-900">{run.toolCallCount}</span>
        {run.toolCalls.length > 0 ? <span className="ml-2 break-words text-gray-400">{run.toolCalls.map((call) => call.name).join(", ")}</span> : null}
      </div>
    ),
  },
  { key: "duration", header: "Duration", render: (run) => <span className="text-gray-600">{formatDuration(run.durationMs)}</span> },
  { key: "when", header: "When", render: (run) => <span className="whitespace-nowrap text-gray-500">{new Date(run.createdAt).toLocaleString()}</span> },
];

export function WorkflowRunsScreen() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void requestJson("/v1/workflow-runs", { method: "GET" }, 12000)
      .then(({ response, payload }) => {
        if (!response.ok) throw new Error(getErrorMessage(payload, `Failed to load Workflow runs (${response.status}).`));
        if (active) setRuns(getWorkflowRuns(payload));
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Failed to load Workflow runs.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <DashboardPageTemplate
      icon={ScrollText}
      title="Workflow Runs"
      description="Review recent Workflow run activity and the capabilities each run called."
      colors={["#EEF2FF", "#6366F1", "#C7D2FE", "#A5B4FC"]}
    >
      {error ? <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{error}</div> : null}
      <DenCard className="!p-0">
        {loading ? (
          <p className="px-6 py-5 text-[13px] text-gray-500">Loading Workflow runs...</p>
        ) : (
          <DenTable columns={columns} rows={runs} getRowKey={(run) => run.id} emptyLabel="No Workflow runs yet." />
        )}
      </DenCard>
    </DashboardPageTemplate>
  );
}
