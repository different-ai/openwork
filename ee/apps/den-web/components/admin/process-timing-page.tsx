"use client";

import { useEffect, useState } from "react";
import { processTimingSummarySchema, type ProcessTimingReport, type ProcessTimingSummary } from "@openwork/types/den/diagnostics";
import { DenButton } from "../../app/(den)/_components/ui/button";
import { DenNotice } from "../../app/(den)/_components/ui/notice";
import { DenPageHeader } from "../../app/(den)/_components/ui/page-header";
import { DenSegmented } from "../../app/(den)/_components/ui/segmented";
import { DenSkeleton } from "../../app/(den)/_components/ui/skeleton";
import { DenTable, type DenTableColumn } from "../../app/(den)/_components/ui/table";
import { AdminAccessScreen } from "./admin-access-screen";
import { requestAdmin, type AdminResult } from "./admin-request";

type ProcessRow = ProcessTimingSummary["processes"][number];
type StepRow = ProcessTimingSummary["steps"][number];
type RunRow = ProcessTimingSummary["latestRuns"][number];

const processLabels = { check: "Checks", world: "Test environments", evals: "Evaluations" };
const environmentLabel = (value: string) => value === "ci" ? "CI" : "Local";
const duration = (value: number | null) => value === null ? "No data" : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} s`;
const failureRate = (value: number | null) => value === null ? "No data" : `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
const rowKey = (row: ProcessRow) => `${row.process}:${row.environment}`;
const sharedColumns: DenTableColumn<ProcessRow>[] = [
  { key: "process", header: "Process", render: (row) => processLabels[row.process] },
  { key: "environment", header: "Where", render: (row) => environmentLabel(row.environment) },
  { key: "runs", header: "Runs", align: "right", render: (row) => row.runCount.toLocaleString() },
  { key: "median", header: "Typical time (median)", align: "right", render: (row) => duration(row.medianSeconds) },
  { key: "p90", header: "Slower runs (90th percentile)", align: "right", render: (row) => duration(row.p90Seconds) },
  { key: "failures", header: "Failure rate", align: "right", render: (row) => failureRate(row.failureRate) },
];
const stepColumns: DenTableColumn<StepRow>[] = [
  { key: "step", header: "Step", render: (row) => <span className="font-mono">{row.step}</span> },
  ...sharedColumns,
];
const runColumns: DenTableColumn<RunRow>[] = [
  { key: "started", header: "Started", render: (row) => new Date(row.startedAt).toLocaleString() },
  { key: "process", header: "Process", render: (row) => processLabels[row.process] },
  { key: "environment", header: "Where", render: (row) => environmentLabel(row.environment) },
  { key: "duration", header: "Total time", align: "right", render: (row) => duration(row.totalSeconds) },
  { key: "outcome", header: "Result", render: (row) => row.outcome === "fail" ? <span className="text-[var(--destructive)]">Failed</span> : "Passed" },
  { key: "commit", header: "Revision", render: (row) => row.commit ? <span className="font-mono" title={row.commit}>{row.commit.slice(0, 8)}</span> : "Unknown" },
];

function parseSummary(payload: unknown) {
  const result = processTimingSummarySchema.safeParse(payload);
  return result.success ? result.data : null;
}

export function ProcessTimingPage() {
  const [days, setDays] = useState("14");
  const [process, setProcess] = useState<"all" | ProcessTimingReport["process"]>("all");
  const [environment, setEnvironment] = useState<"all" | ProcessTimingReport["environment"]>("all");
  const [state, setState] = useState<AdminResult<ProcessTimingSummary> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ days });
    if (process !== "all") query.set("process", process);
    if (environment !== "all") query.set("environment", environment);
    setLoading(true);
    void requestAdmin(`/v1/admin/process-timing?${query}`, parseSummary, controller.signal).then((result) => {
      if (!controller.signal.aborted) { setState(result); setLoading(false); }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setState({ access: "error", message: "Timing reports could not be verified. Try again." });
        setLoading(false);
      }
    });
    return () => controller.abort();
  }, [days, process, environment, attempt]);
  if (state && state.access !== "ready" && state.access !== "error") return <AdminAccessScreen state={state.access} message={state.message} />;
  const report = state?.access === "ready" ? state.data : null;
  return <div className="flex flex-col gap-5" data-testid="admin-process-timing">
    <DenPageHeader size="compact" title="Development process timing" action={<DenButton variant="secondary" onClick={() => setAttempt((value) => value + 1)}>Refresh</DenButton>} />
    <div className="flex flex-wrap gap-3">
      <DenSegmented aria-label="Time window" value={days} onChange={setDays} options={[{ value: "7", label: "7 days" }, { value: "14", label: "14 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} />
      <DenSegmented aria-label="Process" value={process} onChange={setProcess} options={[{ value: "all", label: "All processes" }, { value: "check", label: "Checks" }, { value: "world", label: "Test environments" }, { value: "evals", label: "Evaluations" }]} />
      <DenSegmented aria-label="Environment" value={environment} onChange={setEnvironment} options={[{ value: "all", label: "Everywhere" }, { value: "local", label: "Local" }, { value: "ci", label: "CI" }]} />
    </div>
    {state?.access === "error" ? <DenNotice message={state.message} action={<DenButton variant="plain" onClick={() => setAttempt((value) => value + 1)}>Try again</DenButton>} /> : null}
    {loading ? <div className="grid gap-3" role="status" aria-label="Loading timing reports">{[1, 2, 3, 4, 5].map((row) => <DenSkeleton key={row} className="h-10 w-full" />)}</div> : null}
    {!loading && report ? <>
      {!report.reportingEnabled ? <DenNotice tone="neutral" message="Reporting is off until a deployment administrator sets PROCESS_TIMING_INGEST_KEY." /> : null}
      {!report.latestRuns.length ? <DenNotice tone="neutral" message={report.reportingEnabled ? "No runs have been reported yet for these filters. Run checks, a test environment, or evaluations with reporting configured." : "No runs have been reported yet. Reporting is off until the ingest key is set."} /> : <>
        <section aria-label="Total process times"><DenTable density="compact" columns={sharedColumns} rows={report.processes} getRowKey={rowKey} /></section>
        <section aria-labelledby="timing-steps"><h2 id="timing-steps" className="mb-3 text-sm font-medium">Step times</h2><DenTable density="compact" columns={stepColumns} rows={report.steps} getRowKey={(row) => `${rowKey(row)}:${row.step}`} emptyLabel="No measured steps." /></section>
        <section aria-labelledby="timing-runs"><h2 id="timing-runs" className="mb-3 text-sm font-medium">Latest 50 runs</h2><DenTable density="compact" columns={runColumns} rows={report.latestRuns} getRowKey={(row) => row.runId} /></section>
      </>}
    </> : null}
  </div>;
}
