"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";
import { AnalyticsEmptyState, AnalyticsErrorState, AnalyticsPageHeader, analyticsPageClass, analyticsSurfaceClass } from "../_features/analytics/analytics-layout";
import { WorkflowFlowDiagram } from "./workflow-flow-diagram";
import { ItemPanel, ItemRow, ItemRowsSkeleton } from "./item-list";
import { LetterTile } from "./item-logo";
import { workflowRunsIntroFacts } from "./analytics-intro-facts";
import { useFeatureIntro } from "../_features/feature-intros";
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
  const [previewOpen, setPreviewOpen] = useState(false);
  return <li data-run-id={run.id} data-testid={`workflow-run-${run.id}`} data-analytics-row>
    <ItemRow logo={<LetterTile name={run.workflow?.title ?? "One-off task"} />}
      title={run.workflow ? <span data-testid={`workflow-run-link-${run.id}`}>{run.workflow.title}</span> : run.source === "adhoc" ? "One-off task" : "Workflow run"}
      href={run.workflow ? `/dashboard/library/workflows/${encodeURIComponent(run.workflow.configObjectId)}` : undefined}
      description={<><span className={run.status === "failed" ? "text-[var(--ow-danger)] sm:hidden" : "sm:hidden"}>{run.status === "succeeded" ? "Succeeded" : "Failed"} </span><time data-testid={`workflow-run-time-${run.id}`} dateTime={run.finishedAt}>{new Date(run.finishedAt).toLocaleString()}</time></>}
      comparison={<span className={`hidden shrink-0 text-[13px] sm:block ${run.status === "failed" ? "text-[var(--ow-danger)]" : "text-[var(--dls-text-secondary)]"}`}>{run.status === "succeeded" ? "Succeeded" : "Failed"}</span>}
      action={<DenButton variant="plain" size="inline" data-testid={`workflow-run-preview-${run.id}`} aria-expanded={previewOpen} aria-controls={`run-preview-${run.id}`} onClick={() => setPreviewOpen(!previewOpen)}><ChevronRight size={16} strokeWidth={1.5} aria-hidden className={previewOpen ? "rotate-90" : undefined} />Details</DenButton>} />
    {previewOpen ? <div id={`run-preview-${run.id}`}>
      {run.workflow ? run.workflow.graph ? <div data-testid={`workflow-run-visualization-${run.id}`} role="region" aria-label={`${run.workflow.title} workflow visualization`} className="px-5 pb-3">
        <WorkflowFlowDiagram graph={run.workflow.graph} />
      </div> : <p className="px-5 pb-3 text-[13px] text-[var(--dls-text-secondary)]">The visualization for this run is unavailable.</p> : null}
      <WorkflowRunTechnicalDetails run={run} />
    </div> : null}
  </li>;
}

function WorkflowRunTechnicalDetails({ run }: { run: WorkflowRun }) {
  return <details className="px-5 pb-3 text-xs text-[var(--dls-text-secondary)]">
    <summary data-testid={`workflow-run-details-${run.id}`} className="cursor-pointer font-medium">Technical details</summary>
    <dl className="mt-3 flex flex-col gap-2">
      <div><dt>Source</dt><dd className="break-all font-mono">{run.source}</dd></div>
      <div><dt>Tool calls</dt><dd>{run.toolCallCount}{run.toolCalls.length > 0 ? <span className="ml-2 break-all font-mono">{run.toolCalls.map((call) => call.name).join(", ")}</span> : null}</dd></div>
      <div><dt>Duration</dt><dd>{formatDuration(run.durationMs)}</dd></div>
      {run.errorMessage ? <div><dt>Error</dt><dd className="break-words text-[var(--ow-danger)]">{run.errorMessage}</dd></div> : null}
    </dl>
  </details>;
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
  // With `featureIntros` on, a box replaces "No workflow runs yet".
  const intro = useFeatureIntro("analytics.workflow-runs", entitled ? workflowRunsIntroFacts(runs) : null);

  return <div className={analyticsPageClass}>
    <AnalyticsPageHeader orgSlug={activeOrg?.slug} active="workflows" title="Workflow Runs"
      action={entitled && !isError ? <DenButton variant="secondary" disabled={isFetching} onClick={() => void refetch()}>
        <RefreshCw className={`mr-2 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} aria-hidden="true" />Refresh runs
      </DenButton> : null} />
    {!entitled ? <EnterprisePlanNotice feature="Workflow run history" detail="Run history is unavailable on this plan." /> : <>
      {isError ? !runs ? <AnalyticsErrorState title="Couldn't load workflow runs" onRetry={() => void refetch()} retrying={isFetching} /> : <DenNotice tone="neutral" presentation="inline" message="Couldn't refresh. Showing the last runs." action={<DenButton variant="secondary" size="sm" disabled={isFetching} onClick={() => void refetch()}>Retry</DenButton>} /> : null}
      {isPending ? <ItemPanel><ItemRowsSkeleton label="Loading workflow runs" rows={4} /></ItemPanel>
        : intro.size === "box" || intro.size === "fullscreen" ? intro.element
        : runs?.length === 0 ? <div className={analyticsSurfaceClass}>
          <AnalyticsEmptyState title="No workflow runs yet">Run a saved workflow or a one-off task to see its activity here.</AnalyticsEmptyState>
        </div> : runs ? <ol className="divide-y divide-[var(--dls-border)] rounded-2xl border border-[var(--dls-border)] bg-[var(--dls-surface)]" aria-label="Workflow runs">
          {runs.map((run) => <WorkflowRunCard key={run.id} run={run} />)}
        </ol> : null}
    </>}
  </div>;
}
