"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ScrollText } from "lucide-react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenCard } from "../../_components/ui/card";
import { DenChip } from "../../_components/ui/chip";
import { WorkflowFlowDiagram } from "./workflow-flow-diagram";
import {
  getWorkflowRuns,
  getErrorMessage,
  requestJson,
  type WorkflowRun,
} from "../../_lib/den-flow";

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(1)} s`;
}

function WorkflowRunCard({ run }: { run: WorkflowRun }) {
  return (
    <li data-run-id={run.id}>
      <DenCard>
        <h2 className="text-[15px] font-medium text-gray-950">
          {run.workflow ? (
            <Link data-testid={`workflow-run-link-${run.id}`} className="underline-offset-4 hover:underline" href={`/dashboard/library/workflows/${encodeURIComponent(run.workflow.configObjectId)}`}>
              {run.workflow.title}
            </Link>
          ) : run.source === "adhoc" ? "One-off task" : "Workflow run"}
        </h2>
        {run.workflow?.graph ? (
          <div className="mt-4 max-h-96 overflow-auto rounded-xl border border-gray-100 bg-gray-50/50 px-4 pb-4" role="region" aria-label={`${run.workflow.title} workflow visualization`} tabIndex={0}>
            <WorkflowFlowDiagram graph={run.workflow.graph} />
          </div>
        ) : run.workflow ? (
          <p className="mt-3 text-[13px] text-gray-500">The visualization for this run is unavailable.</p>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-3 text-[12px] text-gray-500">
          <DenChip tone={run.status === "succeeded" ? "success" : "danger"}>
            {run.status === "succeeded" ? "Succeeded" : "Failed"}
          </DenChip>
          <time dateTime={run.finishedAt}>{new Date(run.finishedAt).toLocaleString()}</time>
        </div>
        <details className="mt-4 border-t border-gray-100 pt-3 text-[12px] text-gray-500">
          <summary data-testid={`workflow-run-details-${run.id}`} className="cursor-pointer font-medium">Technical details</summary>
          <dl className="mt-3 space-y-2">
            <div><dt>Source</dt><dd className="break-all font-mono">{run.source}</dd></div>
            <div><dt>Tool calls</dt><dd>{run.toolCallCount}{run.toolCalls.length > 0 ? <span className="ml-2 break-all font-mono">{run.toolCalls.map((call) => call.name).join(", ")}</span> : null}</dd></div>
            <div><dt>Duration</dt><dd>{formatDuration(run.durationMs)}</dd></div>
            {run.errorMessage ? <div><dt>Error</dt><dd className="break-words text-red-700">{run.errorMessage}</dd></div> : null}
          </dl>
        </details>
      </DenCard>
    </li>
  );
}

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
      description="Workflows are repeatable tasks you and your team can save, share, and run again. See their recent activity here."
      colors={["#EEF2FF", "#6366F1", "#C7D2FE", "#A5B4FC"]}
    >
      {error ? <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{error}</div> : null}
      {loading ? (
        <DenCard><p className="text-[13px] text-gray-500">Loading Workflow runs...</p></DenCard>
      ) : runs.length === 0 ? (
        <DenCard><p className="text-[13px] text-gray-500">No Workflow runs yet.</p></DenCard>
      ) : (
        <ol className="space-y-4" aria-label="Workflow runs">
          {runs.map((run) => <WorkflowRunCard key={run.id} run={run} />)}
        </ol>
      )}
    </DashboardPageTemplate>
  );
}
