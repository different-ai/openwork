/**
 * The Activity sidebar's grammar for a coworker's current state and recent
 * work. Kept pure so the copy for every state (including the empty ones) is
 * unit-tested; the sidebar only renders what these return and never repeats
 * one fact in two places.
 */
import type { LocalResponsibility } from "./bridge";
import { RECENT_WORK_LIMIT, type CoworkerActivity, type RecentWork } from "./threads.ts";

/** Compact relative time for the sidebar: "now", "12m", "3h", "2d"; empty when unknown. */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
  if (!timestamp) return "";
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export type NowSummary = {
  /** The thread title or request the coworker is on; empty when there is nothing to name. */
  subject: string;
  /** One supporting line; empty when the status word already says everything. */
  note: string;
  /** Whether the person is being asked for something right now. */
  needsYou: boolean;
};

/**
 * What the Current activity card should say. Finished work is never named
 * here — the Recent activity list below owns it — so an idle coworker gets
 * exactly one status word, not the same fact in several phrasings.
 */
export function describeNow(activity: CoworkerActivity | undefined): NowSummary {
  if (!activity) return { subject: "", note: "Checking status…", needsYou: false };
  switch (activity.state) {
    case "working":
      return { subject: activity.detail, note: "", needsYou: false };
    case "retrying":
      return { subject: activity.detail, note: "Retrying after an interruption", needsYou: false };
    case "attention":
      // Permission and question requests wait on the person; a failed run only
      // needs a look, so it is named without asking for a reply.
      return { subject: activity.detail, note: "", needsYou: /^(Waiting|Needs you)/.test(activity.label) };
    case "recent":
      return { subject: "", note: "", needsYou: false };
    case "offline":
      return { subject: "", note: activity.detail || "OpenWork cannot read this workspace right now.", needsYou: false };
    default:
      return { subject: "", note: "Waiting for the first assignment.", needsYou: false };
  }
}

/** Plain result word for one Recent activity entry. */
export function describeOutcome(entry: Pick<RecentWork, "outcome">): string {
  if (entry.outcome === "succeeded") return "Succeeded";
  if (entry.outcome === "failed") return "Failed";
  return "Finished";
}

/**
 * Finished assignments plus finished local responsibility runs, newest first,
 * bounded so the list stays scannable. A run that is still going is not
 * recent work, and the discussion thread never appears (it is filtered before
 * it reaches `activity.recent`).
 */
export function mergeRecentWork(
  activity: Pick<CoworkerActivity, "recent"> | undefined,
  responsibilities: ReadonlyArray<Pick<LocalResponsibility, "id" | "name" | "latestRun">>,
  limit: number = RECENT_WORK_LIMIT,
): RecentWork[] {
  const runs: RecentWork[] = [];
  for (const item of responsibilities) {
    const run = item.latestRun;
    if (!run || run.status === "running" || !run.finishedAt) continue;
    runs.push({
      id: `${item.id}:${run.id}`,
      title: item.name,
      kind: "responsibility",
      outcome: run.status,
      finishedAt: run.finishedAt,
      ...(run.threadId ? { threadId: run.threadId } : {}),
      ...(run.error ? { error: run.error } : {}),
    });
  }
  return [...(activity?.recent ?? []), ...runs]
    .sort((left, right) => right.finishedAt - left.finishedAt)
    .slice(0, limit);
}
