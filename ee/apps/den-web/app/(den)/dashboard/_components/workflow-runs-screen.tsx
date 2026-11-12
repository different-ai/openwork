"use client";

import { RefreshButton } from "../_features/computers/computer-parts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronRight, RefreshCw, Workflow } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { EnterprisePlanNotice } from "./enterprise-plan-notice";
import { AnalyticsEmptyState, AnalyticsErrorState, AnalyticsPageHeader, analyticsPageClass, analyticsSurfaceClass } from "../_features/analytics/analytics-layout";
import { WorkflowFlowDiagram } from "./workflow-flow-diagram";
import { ListRow, RowLane, RowLaneLabel, RowList, RowListHeader, RowListSkeleton, StatusLane } from "../_features/computers/computer-rows";
import { focusRing, secondaryText } from "../_features/computers/computer-parts";
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

/** Fixed lanes for the runs list, so rows line up like Computers. Literal classes, so Tailwind generates each one. */
const RUN_LANE = {
  status: "flex w-28",
  duration: "hidden w-20 tabular-nums @md:block",
} as const;

function WorkflowRunRow({ run }: { run: WorkflowRun }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const succeeded = run.status === "succeeded";
  const previewId = `run-preview-${run.id}`;
  return <div role="presentation" data-run-id={run.id} data-testid={`workflow-run-${run.id}`} data-analytics-row>
    <ListRow icon={Workflow}
      name={run.workflow ? run.workflow.title : run.source === "adhoc" ? "One-off task" : "Workflow run"}
      testId={run.workflow ? `workflow-run-link-${run.id}` : undefined}
      href={run.workflow ? `/dashboard/library/workflows/${encodeURIComponent(run.workflow.configObjectId)}` : undefined}
      secondLine={<time data-testid={`workflow-run-time-${run.id}`} dateTime={run.finishedAt}>{new Date(run.finishedAt).toLocaleString()}</time>}
      lanes={<>
        <StatusLane lane={RUN_LANE.status} label={succeeded ? "Succeeded" : "Failed"} tone={succeeded ? "success" : "danger"} />
        <RowLane lane={RUN_LANE.duration} className={secondaryText}>{formatDuration(run.durationMs)}</RowLane>
      </>}
      action={<button type="button" aria-label="Details" title="Details" data-testid={`workflow-run-preview-${run.id}`} aria-expanded={previewOpen} aria-controls={previewId} onClick={() => setPreviewOpen(!previewOpen)}
        className={`flex size-7 shrink-0 items-center justify-center rounded-md ${secondaryText} transition-colors hover:bg-[var(--dls-hover)] hover:text-[color:var(--dls-text-primary)] ${focusRing}`}>
        <ChevronRight size={16} strokeWidth={1.5} aria-hidden className={`transition-transform duration-150 motion-reduce:transition-none ${previewOpen ? "rotate-90" : ""}`} />
      </button>}>
      {previewOpen ? <div id={previewId}>
        {run.workflow ? run.workflow.graph ? <div data-testid={`workflow-run-visualization-${run.id}`} role="region" aria-label={`${run.workflow.title} workflow visualization`} className="pb-3">
          <WorkflowFlowDiagram graph={run.workflow.graph} />
        </div> : <p className="pb-3 text-[13px] text-[var(--dls-text-secondary)]">The visualization for this run is unavailable.</p> : null}
        <WorkflowRunTechnicalDetails run={run} />
      </div> : null}
    </ListRow>
  </div>;
}

function WorkflowRunTechnicalDetails({ run }: { run: WorkflowRun }) {
  return <details className="text-xs text-[var(--dls-text-secondary)]">
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
      action={entitled && !isError ? <RefreshButton refreshing={isFetching} onRefresh={() => void refetch()} /> : null} />
    {!entitled ? <EnterprisePlanNotice feature="Workflow run history" detail="Run history is unavailable on this plan." /> : <>
      {isError ? !runs ? <AnalyticsErrorState title="Couldn't load workflow runs" onRetry={() => void refetch()} retrying={isFetching} /> : <DenNotice tone="neutral" presentation="inline" message="Couldn't refresh. Showing the last runs." action={<DenButton variant="secondary" size="sm" disabled={isFetching} onClick={() => void refetch()}>Retry</DenButton>} /> : null}
      {isPending ? <div role="status" aria-label="Loading workflow runs"><RowListSkeleton rows={4} /></div>
        : intro.size === "box" || intro.size === "fullscreen" ? intro.element
        : runs?.length === 0 ? <div className={analyticsSurfaceClass}>
          <AnalyticsEmptyState title="No workflow runs yet">Run a saved workflow or a one-off task to see its activity here.</AnalyticsEmptyState>
        </div> : runs ? <RowList label="Workflow runs" header={<RowListHeader lead="Run" menu>
          <RowLaneLabel lane={RUN_LANE.status}>Status</RowLaneLabel>
          <RowLaneLabel lane={RUN_LANE.duration}>Duration</RowLaneLabel>
        </RowListHeader>}>
          {runs.map((run) => <WorkflowRunRow key={run.id} run={run} />)}
        </RowList> : null}
    </>}
  </div>;
}
