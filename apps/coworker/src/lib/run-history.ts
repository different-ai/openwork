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
  recovery: "Caught up after a missed time",
  manual: "Started by you",
  resume: "Picked up where it stopped",
};

/** The outcome in the words a person would use: what happened, not a status code. */
export function describeRunOutcome(outcome: RunOutcome): string {
  switch (outcome) {
    case "queued":
      return "Waiting its turn";
    case "running":
      return "Working on it";
    case "succeeded":
      return "Done";
    case "failed":
      return "Didn't finish";
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
    how: run.trigger === "manual" ? "Started by you" : run.trigger === "recovery" ? "Caught up after a missed time" : "",
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

/** Counts for a small trend line: "Ran 5 times · 4 done · 1 didn't finish". */
export function summarizeRuns(entries: ReadonlyArray<RunEntry>): string {
  const finished = entries.filter((entry) => entry.outcome !== "queued" && entry.outcome !== "running");
  if (finished.length === 0) return "";
  const done = finished.filter((entry) => entry.outcome === "succeeded").length;
  const unfinished = finished.filter((entry) => entry.outcome === "failed").length;
  const missed = finished.filter((entry) => entry.outcome === "missed").length;
  const parts = [finished.length === 1 ? "Ran once" : finished.length === 2 ? "Ran twice" : `Ran ${finished.length} times`];
  if (finished.length === 1) {
    parts.push(done ? "done" : unfinished ? "didn't finish" : missed ? "missed" : "cancelled");
    return parts.join(" · ");
  }
  if (done) parts.push(`${done} done`);
  if (unfinished) parts.push(`${unfinished} didn't finish`);
  if (missed) parts.push(`${missed} missed`);
  return parts.join(" · ");
}
