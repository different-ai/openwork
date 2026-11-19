"use client";

import type { ConfigApplyReport, ConfigApplyReportItem, ConfigAreaKey } from "@openwork/types/den/config-blobs";
import { ChevronRight, CircleAlert, CircleCheck, CircleDashed, CircleMinus, LoaderCircle, type LucideIcon } from "lucide-react";
import { DenChip } from "../../../_components/ui/chip";
import {
  CONFIG_ITEM_STATUS_PRESENTATION,
  CONFIG_OP_LABELS,
  CONFIG_RUN_STATUS_PRESENTATION,
  RESTORE_ACTION_LABEL,
  formatApplyStep,
  formatDuration,
  formatRelativeTime,
  formatRunCounts,
  runDurationMs,
  runFailure,
  runIrreversible,
  runRequester,
} from "./config-blobs-model";

const ITEM_ICONS: Record<ConfigApplyReportItem["status"], { icon: LucideIcon; className: string }> = {
  applied: { icon: CircleCheck, className: "text-emerald-600" },
  noop: { icon: CircleMinus, className: "text-gray-400" },
  failed: { icon: CircleAlert, className: "text-red-600" },
  not_reached: { icon: CircleDashed, className: "text-gray-400" },
  skipped: { icon: CircleDashed, className: "text-gray-400" },
};

/**
 * "Apply runs": one row per apply attempt (newest first), each opening its
 * report: per item what was written, and for the failed item what failed,
 * where, what was already written and what was not reached.
 */
export function ConfigApplyRuns({ runs, areaLabel, canRestore }: {
  runs: readonly ConfigApplyReport[];
  areaLabel: (area: ConfigAreaKey) => string;
  /** Whether "Restore previous config" is offered on this request (named in the next steps). */
  canRestore: boolean;
}) {
  if (runs.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="config-apply-runs-title" data-testid="config-apply-runs">
      <h2 id="config-apply-runs-title" className="text-[14px] font-semibold text-gray-950">Apply runs</h2>
      <div className="flex flex-col divide-y divide-gray-100 border-y border-gray-100">
        {runs.map((run, index) => (
          <ApplyRun key={run.runId} run={run} areaLabel={areaLabel} canRestore={canRestore} defaultOpen={index === 0 && run.status !== "applied"} />
        ))}
      </div>
    </section>
  );
}

function ApplyRun({ run, areaLabel, canRestore, defaultOpen }: {
  run: ConfigApplyReport;
  areaLabel: (area: ConfigAreaKey) => string;
  canRestore: boolean;
  defaultOpen: boolean;
}) {
  const status = CONFIG_RUN_STATUS_PRESENTATION[run.status];
  const duration = formatDuration(runDurationMs(run));
  const failure = runFailure(run, areaLabel);
  const irreversible = runIrreversible(run, areaLabel);
  const warnings = [...run.warnings, ...run.items.flatMap((item) => item.warnings.map((warning) => `${item.name}: ${warning}`))];
  return (
    <details className="group py-2" open={defaultOpen} data-testid="config-apply-run" data-status={run.status} data-attempt={run.attempt}>
      <summary className="flex min-h-9 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <ChevronRight className="size-3.5 shrink-0 text-gray-400 transition-transform duration-150 ease-out group-open:rotate-90" strokeWidth={1.5} aria-hidden="true" />
        <span className="font-medium text-gray-900">Attempt {run.attempt}</span>
        <DenChip tone={status.tone} spinning={run.status === "running"}>{status.label}</DenChip>
        <span className="text-gray-500">{formatRunCounts(run.counts)}</span>
        <span className="ml-auto text-gray-500">
          {formatRelativeTime(run.startedAt)}{duration ? `, took ${duration}` : ""}
        </span>
      </summary>
      <div className="flex flex-col gap-3 pb-1 pl-5 pt-2">
        <p className="text-[12px] text-gray-500" data-testid="config-apply-run-who">
          Requested by {runRequester(run)}. Ran as {run.runsAs?.name ?? "the last approver"}.
        </p>
        {failure ? <FailureBox failure={failure} areaLabel={areaLabel} canRestore={canRestore} /> : null}
        <ul className="flex flex-col divide-y divide-gray-100 text-[13px]" data-testid="config-apply-run-items">
          {run.items.map((item) => <RunItem key={`${item.area}:${item.ref}`} item={item} areaLabel={areaLabel(item.area)} />)}
        </ul>
        {irreversible.length > 0 ? (
          <div className="text-[12px] text-gray-700" data-testid="config-apply-run-irreversible">
            <p className="font-medium text-gray-900">{RESTORE_ACTION_LABEL} can't undo:</p>
            <ul className="list-disc pl-4">{irreversible.map((line) => <li key={line}>{line}</li>)}</ul>
          </div>
        ) : null}
        {warnings.length > 0 ? (
          <div className="text-[12px] text-gray-600">
            <p className="font-medium text-gray-900">Warnings</p>
            <ul className="list-disc pl-4">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function RunItem({ item, areaLabel }: { item: ConfigApplyReportItem; areaLabel: string }) {
  const presentation = CONFIG_ITEM_STATUS_PRESENTATION[item.status];
  const inFlight = item.status === "not_reached" && item.startedAt !== null;
  const { icon: Icon, className } = inFlight ? { icon: LoaderCircle, className: "animate-spin text-sky-600" } : ITEM_ICONS[item.status];
  const duration = item.status === "applied" || item.status === "failed" ? formatDuration(item.durationMs) : "";
  return (
    <li className="flex flex-col gap-1 py-2" data-testid="config-apply-run-item" data-status={item.status}>
      <div className="flex min-h-6 items-center gap-2">
        <Icon className={`size-4 shrink-0 ${className}`} strokeWidth={1.5} aria-hidden="true" />
        <span className="sr-only">{inFlight ? "Applying" : presentation.label}</span>
        <span className="min-w-0 truncate font-medium text-gray-900">{item.name}</span>
        <span className="min-w-0 truncate text-gray-500">{areaLabel}</span>
        <span className="shrink-0 text-gray-500">{CONFIG_OP_LABELS[item.op]}</span>
        <span className="ml-auto shrink-0 text-[12px] text-gray-500">{item.status === "applied" ? duration : presentation.label}</span>
      </div>
      {item.steps.length > 0 && item.status !== "failed" ? (
        <ul className="flex flex-col gap-0.5 pl-6 text-[12px] text-gray-600">
          {item.steps.map((step, index) => <li key={`${index}:${step.action}:${step.target}`}>{formatApplyStep(step)}</li>)}
        </ul>
      ) : null}
    </li>
  );
}

function FailureBox({ failure, areaLabel, canRestore }: {
  failure: NonNullable<ReturnType<typeof runFailure>>;
  areaLabel: (area: ConfigAreaKey) => string;
  canRestore: boolean;
}) {
  const nothingWritten = failure.written.length === 0;
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-red-200 bg-red-50 px-3 py-2.5 text-[13px] text-red-900" role="group" aria-label="What failed" data-testid="config-apply-run-failure">
      <p className="font-medium">
        {failure.interrupted ? "The apply stopped part-way at " : "Failed at "}
        <span data-testid="config-apply-run-failure-where">{failure.where}</span>
      </p>
      <p className="text-red-800" data-testid="config-apply-run-failure-message">{failure.message}</p>
      {failure.failedStep ? <p className="text-[12px] text-red-800">The write that failed: {failure.failedStep}</p> : null}
      <div className="text-[12px] text-red-800">
        <p className="font-medium">{nothingWritten ? "Nothing was written for this item." : "Already written for this item:"}</p>
        {!nothingWritten ? <ul className="list-disc pl-4">{failure.written.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}</ul> : null}
      </div>
      {failure.notReached.length > 0 ? (
        <div className="text-[12px] text-red-800">
          <p className="font-medium">Not reached ({failure.notReached.length}):</p>
          <p>{failure.notReached.map((item) => `${item.name} (${areaLabel(item.area)})`).join(", ")}</p>
        </div>
      ) : null}
      <p className="text-[12px] text-red-800">
        Next: fix the problem and upload the file again; the items already done show as unchanged.
        {canRestore ? ` Or use ${RESTORE_ACTION_LABEL} to put back what was here before.` : ""}
      </p>
    </div>
  );
}
