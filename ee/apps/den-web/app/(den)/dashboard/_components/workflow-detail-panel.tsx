"use client";

import { ArrowLeft } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenNotice } from "../../_components/ui/notice";
import { DenPageHeader } from "../../_components/ui/page-header";
import { useWorkflowDetailState } from "./use-workflow-detail-state";
import { WorkflowOverviewTab } from "./workflow-overview-tab";

export function WorkflowDetailPanel({ configObjectId, onClose }: { configObjectId: string; onClose: () => void }) {
  const state = useWorkflowDetailState(configObjectId);

  if (state.loading || !state.detail || !state.fields) {
    return (
      <div data-testid="den-workflow-detail-panel">
        <DenCard>{state.error ?? "Loading workflow…"}</DenCard>
      </div>
    );
  }

  return (
    <div className="grid gap-6" data-testid="den-workflow-detail-panel">
      <DenButton
        variant="ghost"
        size="sm"
        icon={ArrowLeft}
        className="justify-self-start"
        onClick={() => state.close(onClose)}
      >
        Back
      </DenButton>
      <DenPageHeader
        title={state.detail.title}
        description={state.detail.description || "A saved, repeatable workflow you can run whenever you need it."}
      />
      {state.error ? <DenNotice tone="error" message={state.error} /> : null}
      {state.detail.freshness.state === "needs_attention" ? (
        <DenNotice
          tone="warning"
          message={`${state.detail.freshness.reason} You can still open the last successful result.`}
        />
      ) : null}
      <WorkflowOverviewTab
        detail={state.detail}
        fields={state.fields}
        views={state.views}
        technical={state.technical}
        showJsonInput={state.showJsonInput}
        parsedInputSchema={state.parsedInputSchema}
        hasInputForm={state.hasInputForm}
        inputFormValue={state.inputFormValue}
        pending={state.pending}
        viewPending={state.viewPending}
        canManageDisplays={state.detail.canManage}
        onTechnicalChange={state.setTechnical}
        onShowJsonInputChange={state.setShowJsonInput}
        onInputChange={(value) => state.update("input", value)}
        onRun={state.runNow}
        onActivateView={state.activateView}
        onRetireView={state.retireView}
      />
    </div>
  );
}
