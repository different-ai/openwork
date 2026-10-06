"use client";

import { RefreshCw } from "lucide-react";
import type {
  WorkflowArtifactSnapshot,
  WorkflowDetail,
} from "@openwork/types/workflows";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenChip } from "../../_components/ui/chip";
import { DenSectionHeader } from "../../_components/ui/section-header";
import { DenSwitch } from "../../_components/ui/switch";
import { DenTextarea } from "../../_components/ui/textarea";
import { WorkflowArtifactResult } from "./workflow-artifact-result";
import { WorkflowFlowDiagram } from "./workflow-flow-diagram";
import { formFieldsFromSchema, WorkflowInputForm } from "./workflow-input-form";
import { summarizeGraph } from "./workflow-plain-language";
import {
  workflowDiagramInput,
  type WorkflowFields,
} from "./use-workflow-detail-state";

export type WorkflowOverviewTabProps = {
  detail: WorkflowDetail;
  fields: WorkflowFields;
  technical: boolean;
  showJsonInput: boolean;
  parsedInputSchema: unknown;
  hasInputForm: boolean;
  inputFormValue: Record<string, unknown>;
  pending: boolean;
  onTechnicalChange: (checked: boolean) => void;
  onShowJsonInputChange: (show: boolean) => void;
  onInputChange: (value: string) => void;
  onRun: () => void;
};

function replay(snapshot: WorkflowArtifactSnapshot | null) {
  return snapshot ? {
    toolCalls: snapshot.toolCalls,
    status: snapshot.status,
    errorMessage: snapshot.errorMessage,
    finishedAt: snapshot.finishedAt,
  } : null;
}

export function WorkflowOverviewTab({
  detail,
  fields,
  technical,
  showJsonInput,
  parsedInputSchema,
  hasInputForm,
  inputFormValue,
  pending,
  onTechnicalChange,
  onShowJsonInputChange,
  onInputChange,
  onRun,
}: WorkflowOverviewTabProps) {
  const latestReplay = detail.latestSnapshot ?? detail.latestSuccessfulSnapshot;
  const latestResult = detail.latestSnapshot ?? detail.latestSuccessfulSnapshot;
  const replayVersion = latestReplay
    ? detail.versions.find((version) => version.id === latestReplay.configObjectVersionId) ?? detail.currentVersion
    : detail.currentVersion;
  const graphSummary = replayVersion.graph ? summarizeGraph(replayVersion.graph) : null;
  const flowInput = workflowDiagramInput(latestReplay, replayVersion.exampleInput);

  return (
    <div className="grid gap-6" data-tab="overview" data-testid="workflow-overview" role="tabpanel" aria-label="Overview">
      <DenCard>
        <form
          aria-label="Run workflow"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (detail.canRun && !pending) onRun();
          }}
        >
          <DenSectionHeader title="Run workflow" description="Check the details below, then run. Your result will appear here." />
          {detail.canRun ? (
            <fieldset disabled={pending} className="mt-5 min-w-0 space-y-5">
              {hasInputForm ? (
                formFieldsFromSchema(parsedInputSchema)?.length === 0 ? (
                  <p className="text-[13px] text-gray-500">No details needed. This workflow is ready to run.</p>
                ) : (
                  <WorkflowInputForm
                    schema={parsedInputSchema}
                    value={inputFormValue}
                    onChange={(next) => onInputChange(JSON.stringify(next, null, 2))}
                  />
                )
              ) : (
                <p className="text-[13px] text-gray-500">This workflow uses structured input. Review its saved values under Advanced input before running.</p>
              )}
              <div className="text-[12px] text-gray-500">
                <DenButton type="button" variant="ghost" size="xs" aria-expanded={showJsonInput} onClick={() => onShowJsonInputChange(!showJsonInput)}>
                  Advanced input
                </DenButton>
                {showJsonInput ? <label className="mt-3 block">
                  Workflow input (JSON)
                  <DenTextarea
                    aria-label="Run input details"
                    className="mt-2 min-h-32 font-mono text-[11px]"
                    value={fields.input}
                    onChange={(event) => onInputChange(event.currentTarget.value)}
                  />
                </label> : null}
              </div>
              <div className="border-t border-gray-100 pt-4">
                <DenButton type="submit" icon={RefreshCw} loading={pending} className="w-full sm:w-auto">
                  {pending ? "Running…" : "Run workflow"}
                </DenButton>
              </div>
            </fieldset>
          ) : (
            <p className="mt-5 text-[13px] text-gray-500">You do not have permission to run this workflow.</p>
          )}
        </form>
      </DenCard>

      <DenCard>
        <DenSectionHeader
          title="Latest result"
          description="The saved result from the most recent run."
        />
        <div className="mt-5">
          {latestResult ? (
            <WorkflowArtifactResult
              snapshot={latestResult}
              freshness={latestResult.receiptId === detail.latestSnapshot?.receiptId ? detail.freshness : undefined}
              lastSuccessful={latestResult.receiptId === detail.latestSuccessfulSnapshot?.receiptId}
              technical={technical}
            />
          ) : (
            <p className="text-[13px] text-gray-400">Run this workflow to see its first result.</p>
          )}
        </div>
      </DenCard>

      <DenCard>
        <DenSectionHeader
          title="How it works"
          description={graphSummary?.sentence ?? "A picture of this workflow is not available yet."}
          action={
            <div className="flex flex-wrap items-center gap-3">
              {graphSummary ? (
                <DenChip tone="neutral" size="sm">
                  {graphSummary.stepCount} step{graphSummary.stepCount === 1 ? "" : "s"}
                </DenChip>
              ) : null}
              <span className="flex items-center gap-2 text-[12px] text-gray-500">
                Show technical details
                <DenSwitch
                  checked={technical}
                  onChange={onTechnicalChange}
                  size="sm"
                  aria-label="Show technical details"
                />
              </span>
            </div>
          }
        />
        {replayVersion.graph ? (
          <div className="mt-5">
            <WorkflowFlowDiagram
              graph={replayVersion.graph}
              technical={technical}
              inputValues={flowInput}
              run={replay(latestReplay)}
            />
          </div>
        ) : null}
      </DenCard>

    </div>
  );
}
