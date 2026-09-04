"use client";

import { CalendarClock, Trash2 } from "lucide-react";
import type { WorkflowArtifactSnapshot, WorkflowDetail } from "@openwork/types/workflows";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenChip } from "../../_components/ui/chip";
import { DenList, DenListRow } from "../../_components/ui/list-row";
import { DenSectionHeader } from "../../_components/ui/section-header";
import { DenSwitch } from "../../_components/ui/switch";
import { WorkflowArtifactResult } from "./workflow-artifact-result";
import { WorkflowFlowDiagram } from "./workflow-flow-diagram";
import { workflowDiagramInput } from "./use-workflow-detail-state";

export type WorkflowRunsTabProps = {
  detail: WorkflowDetail;
  snapshots: WorkflowArtifactSnapshot[];
  selectedSnapshot: WorkflowArtifactSnapshot | null;
  selectedReceiptId: string | null;
  technical: boolean;
  pending: boolean;
  automationCount: number;
  automateHref: string | null;
  onTechnicalChange: (checked: boolean) => void;
  onSelectRun: (receiptId: string) => void;
  onDeleteRun: (receiptId: string) => void;
  onUpdateAutomation: (input: {
    automationId: string;
    pluginId: string;
    configObjectVersionId: string;
    input: unknown;
  }) => void;
};

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

export function WorkflowRunsTab({
  detail,
  snapshots,
  selectedSnapshot,
  selectedReceiptId,
  technical,
  pending,
  automationCount,
  automateHref,
  onTechnicalChange,
  onSelectRun,
  onDeleteRun,
  onUpdateAutomation,
}: WorkflowRunsTabProps) {
  const selectedVersion = selectedSnapshot
    ? detail.versions.find((version) => version.id === selectedSnapshot.configObjectVersionId) ?? detail.currentVersion
    : detail.currentVersion;

  return (
    <div className="grid gap-6" data-tab="runs" role="tabpanel" aria-label="Runs">
      <DenCard>
        <DenSectionHeader
          title="Past runs"
          description="Choose a run to see the steps it took and the result it saved."
          action={<DenChip tone="neutral" size="sm">{snapshots.length}</DenChip>}
        />
        <div className="mt-5">
          {snapshots.length === 0 ? (
            <p className="text-[13px] text-gray-400">No runs yet.</p>
          ) : (
            <DenList>
              {snapshots.map((snapshot) => (
                <DenListRow
                  key={snapshot.receiptId}
                  focused={snapshot.receiptId === selectedReceiptId}
                  onClick={() => onSelectRun(snapshot.receiptId)}
                  ariaLabel={`View run from ${formatDate(snapshot.finishedAt)}`}
                  title={formatDate(snapshot.finishedAt)}
                  chips={
                    <>
                      <DenChip tone={snapshot.status === "failed" ? "danger" : "success"}>
                        {snapshot.status === "failed" ? "Failed" : "Succeeded"}
                      </DenChip>
                      {snapshot.contentDeletedAt ? <DenChip tone="neutral">Result removed</DenChip> : null}
                    </>
                  }
                  meta={
                    <span>
                      {snapshot.source === "manual" ? "Manual" : "Scheduled"}
                      {technical ? ` · ${snapshot.receiptId}` : ""}
                    </span>
                  }
                  action={
                    !snapshot.contentDeletedAt && detail.canManage ? (
                      <DenButton
                        variant="ghost"
                        size="xs"
                        icon={Trash2}
                        aria-label="Delete this run's saved result"
                        disabled={pending}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!window.confirm("Delete this run's saved input and result? Its date and status will remain.")) return;
                          onDeleteRun(snapshot.receiptId);
                        }}
                      />
                    ) : null
                  }
                />
              ))}
            </DenList>
          )}
        </div>
      </DenCard>

      <DenCard>
        <DenSectionHeader
          title="Selected run"
          description={selectedSnapshot ? `${formatDate(selectedSnapshot.finishedAt)} · ${selectedSnapshot.source === "manual" ? "Manual" : "Scheduled"}` : "Choose a past run above."}
          action={selectedSnapshot ? (
            <span className="flex items-center gap-2 text-[12px] text-gray-500">
              Show technical details
              <DenSwitch
                checked={technical}
                onChange={onTechnicalChange}
                size="sm"
                aria-label="Show selected run technical details"
              />
            </span>
          ) : null}
        />
        {selectedSnapshot ? (
          <div className="mt-5 grid gap-6">
            {selectedVersion.graph ? (
              <WorkflowFlowDiagram
                graph={selectedVersion.graph}
                technical={technical}
                inputValues={workflowDiagramInput(selectedSnapshot, selectedVersion.exampleInput)}
                run={{
                  toolCalls: selectedSnapshot.toolCalls,
                  status: selectedSnapshot.status,
                  errorMessage: selectedSnapshot.errorMessage,
                  finishedAt: selectedSnapshot.finishedAt,
                }}
              />
            ) : null}
            <WorkflowArtifactResult
              snapshot={selectedSnapshot}
              freshness={selectedSnapshot.receiptId === detail.latestSnapshot?.receiptId ? detail.freshness : undefined}
              lastSuccessful={selectedSnapshot.receiptId === detail.latestSuccessfulSnapshot?.receiptId}
              technical={technical}
            />
          </div>
        ) : null}
      </DenCard>

      <DenCard>
        <DenSectionHeader
          title="Versions"
          description="Schedules stay on their saved version until you update them."
        />
        <DenList className="mt-5">
          {detail.versions.map((version, index) => (
            <DenListRow
              key={version.id}
              title={index === 0 ? "Current" : "Earlier"}
              chips={index === 0 ? <DenChip tone="success">Current</DenChip> : <DenChip tone="neutral">Earlier</DenChip>}
              meta={
                <span>
                  {new Date(version.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  {` · ${version.automationReferences.length} schedule${version.automationReferences.length === 1 ? "" : "s"}`}
                  {technical ? ` · ${version.id}` : ""}
                </span>
              }
              action={detail.canManage && index > 0 && version.automationReferences.length > 0 ? (
                <div className="flex flex-col items-end gap-2">
                  {version.automationReferences.map((reference) => (
                    <DenButton
                      key={reference.id}
                      variant="secondary"
                      size="xs"
                      disabled={pending}
                      onClick={() => {
                        if (!window.confirm(`Update ${reference.name} to the current version? Its schedule and saved input will stay the same.`)) return;
                        onUpdateAutomation({
                          automationId: reference.id,
                          pluginId: detail.pluginId,
                          configObjectVersionId: detail.currentVersion.id,
                          input: reference.input,
                        });
                      }}
                    >
                      Update {reference.name}
                    </DenButton>
                  ))}
                </div>
              ) : null}
            />
          ))}
        </DenList>
      </DenCard>

      <DenCard>
        <DenSectionHeader
          title="Schedules"
          description={automationCount === 0 ? "No schedules yet." : `${automationCount} active schedule${automationCount === 1 ? "" : "s"}.`}
          action={
            <div className="flex items-center gap-3">
              <DenChip tone="neutral" size="sm">{automationCount}</DenChip>
              {detail.canManage && automateHref ? (
                <DenButton href={automateHref} target="_blank" rel="noopener noreferrer" icon={CalendarClock}>
                  Automate
                </DenButton>
              ) : null}
            </div>
          }
        />
      </DenCard>
    </div>
  );
}
