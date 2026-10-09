"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";
import { AnalyticsEmptyState, AnalyticsPageHeader, analyticsPageClass, analyticsSurfaceClass } from "../_features/analytics/analytics-layout";
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
    <li data-run-id={run.id} data-testid={`workflow-run-${run.id}`}>
      <DenCard>
        <h2 className="text-[15px] font-medium text-gray-950">
          {run.workflow ? (
            <Link data-testid={`workflow-run-link-${run.id}`} className="underline-offset-4 hover:underline" href={`/dashboard/library/workflows/${encodeURIComponent(run.workflow.configObjectId)}`}>
              {run.workflow.title}
            </Link>
          ) : run.source === "adhoc" ? "One-off task" : "Workflow run"}
        </h2>
        {run.workflow?.graph ? (
          <div data-testid={`workflow-run-visualization-${run.id}`} className="mt-4 max-h-96 overflow-auto rounded-xl border border-gray-100 bg-gray-50/50 px-4 pb-4" role="region" aria-label={`${run.workflow.title} workflow visualization`} tabIndex={0}>
            <WorkflowFlowDiagram graph={run.workflow.graph} />
          </div>
        ) : run.workflow ? (
          <p className="mt-3 text-[13px] text-gray-500">The visualization for this run is unavailable.</p>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-3 text-[12px] text-gray-500">
          <DenChip tone={run.status === "succeeded" ? "success" : "danger"}>
            {run.status === "succeeded" ? "Succeeded" : "Failed"}
          </DenChip>
          <time data-testid={`workflow-run-time-${run.id}`} dateTime={run.finishedAt}>{new Date(run.finishedAt).toLocaleString()}</time>
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
  const { activeOrg, orgContext } = useOrgDashboard();
  const entitled = orgContext?.entitlements.analytics === true;
  const { data: runs, isPending, isFetching, isError, refetch } = useQuery({
    queryKey: ["workflow-runs", orgContext?.organization.id],
    enabled: entitled,
    refetchInterval: 30_000,
    queryFn: async () => {
      const { response, payload } = await requestJson("/v1/workflow-runs", { method: "GET" }, 12000);
      if (!response.ok) throw new Error(getErrorMessage(payload, "Could not load workflow runs."));
      return getWorkflowRuns(payload);
    },
  });

  return <div className={analyticsPageClass}>
    <AnalyticsPageHeader orgSlug={activeOrg?.slug} active="workflows" title="Workflow Runs"
      description="Workflows are repeatable tasks you and your team can save, share, and run again. See their recent activity here."
      caption="Enterprise analytics · Saved and one-off workflow activity"
      action={entitled ? <DenButton variant="secondary" disabled={isFetching} onClick={() => void refetch()}>
        <RefreshCw className={`mr-2 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} aria-hidden="true" />Refresh runs
      </DenButton> : null} />
    {!entitled ? <EnterprisePlanNotice feature="Workflow Runs" /> : <>
      {isError ? <DenNotice tone="error" message="Could not load workflow runs. Try refreshing." /> : null}
      {isPending ? <p role="status" className="text-sm text-[#637291]">Loading workflow runs…</p>
        : runs?.length === 0 ? <div className={analyticsSurfaceClass}>
          <AnalyticsEmptyState title="No workflow runs yet">Run a saved workflow or a one-off task to see its activity here.</AnalyticsEmptyState>
        </div> : runs ? <ol className="space-y-4" aria-label="Workflow runs">
          {runs.map((run) => <WorkflowRunCard key={run.id} run={run} />)}
        </ol> : null}
    </>}
  </div>;
}
