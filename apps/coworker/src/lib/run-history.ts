/**
 * One vocabulary for responsibility runs wherever they come from: local runs
 * on this Mac or OpenWork Cloud Automation runs. Pure, so the copy for every
 * outcome is unit-tested and the rows only render what these return.
 */
import type { AutomationRun } from "@openwork/types/automations";
import type { LocalResponsibilityRun } from "./bridge.ts";

export type RunOutcome = "queued" | "running" | "succeeded" | "failed" | "missed" | "cancelled";

export type RunEntry = {
  id: string;
  outcome: RunOutcome;
  /** How the run came about, in plain words; empty when it is the ordinary schedule. */
  how: string;
  /** Best timestamp to sort and show: finish, else start, else queue time. */
  at: number;
  durationMs: number | null;
  /** The coworker's own closing words (local) or Den's result summary (cloud). */
  summary: string;
  error: string;
  /** Native thread to open, when this Mac has it. */
  threadId: string;
};

const HOW: Record<LocalResponsibilityRun["trigger"], string> = {
  scheduled: "",
  recovery: "Recovered after a missed time",
  manual: "Started by you",
  resume: "Resumed",
};

export function describeRunOutcome(outcome: RunOutcome): string {
  switch (outcome) {
    case "queued":
      return "Waiting for a free slot";
    case "running":
      return "Running";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "missed":
      return "Missed";
    default:
      return "Cancelled";
  }
}

export function localRunEntry(run: LocalResponsibilityRun): RunEntry {
  const at = run.finishedAt ?? (run.startedAt || run.queuedAt || 0);
  return {
    id: run.id,
    outcome: run.status,
    how: HOW[run.trigger],
    at,
    durationMs: run.finishedAt && run.startedAt ? Math.max(0, run.finishedAt - run.startedAt) : null,
    summary: run.summary,
    error: run.error,
    threadId: run.threadId,
  };
}

/** Den's run statuses in the product's words: a skipped occurrence is a missed one. */
function cloudOutcome(status: AutomationRun["status"]): RunOutcome {
  if (status === "succeeded") return "succeeded";
  if (status === "running" || status === "claimed") return "running";
  if (status === "queued") return "queued";
  if (status === "skipped") return "missed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

export function cloudRunEntry(run: AutomationRun): RunEntry {
  return {
    id: run.id,
    outcome: cloudOutcome(run.status),
    how: run.trigger === "manual" ? "Started by you" : run.trigger === "recovery" ? "Recovered after a missed time" : "",
    at: run.finishedAt ?? run.startedAt ?? run.createdAt,
    durationMs: run.finishedAt !== null && run.startedAt !== null ? Math.max(0, run.finishedAt - run.startedAt) : null,
    summary: run.resultSummary?.trim() ?? "",
    error: run.error?.message.trim() ?? "",
    threadId: "",
  };
}

/** "4s", "2m 10s", "1h 5m" — enough precision to compare runs, never more. */
export function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

/** Counts for a small trend line: "5 runs · 4 succeeded · 1 failed". */
export function summarizeRuns(entries: ReadonlyArray<RunEntry>): string {
  const finished = entries.filter((entry) => entry.outcome !== "queued" && entry.outcome !== "running");
  if (finished.length === 0) return "";
  const succeeded = finished.filter((entry) => entry.outcome === "succeeded").length;
  const failed = finished.filter((entry) => entry.outcome === "failed").length;
  const missed = finished.filter((entry) => entry.outcome === "missed").length;
  const parts = [`${finished.length} run${finished.length === 1 ? "" : "s"}`];
  if (succeeded) parts.push(`${succeeded} succeeded`);
  if (failed) parts.push(`${failed} failed`);
  if (missed) parts.push(`${missed} missed`);
  return parts.join(" · ");
}
