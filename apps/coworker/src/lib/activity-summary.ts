/**
 * The grammar for a coworker's current state and recent work, shared by the
 * conversation header and the Activity panel. Kept pure so the copy for every
 * state (including the empty ones) is unit-tested, and so one fact is said in
 * one place: the header owns the one-word state, the live row in the transcript
 * owns the moment-to-moment phrase, the panel owns the subject and the history.
 */
import type { LocalResponsibility } from "./bridge.ts";
import type { CoworkerActivity, RecentWork } from "./threads.ts";

/** Recent activity stays scannable: a handful of entries, never a log. */
export const RECENT_WORK_LIMIT = 4;

/** Colour is reserved for what needs a person: amber asks, rose reports a failure, mist is everything else. */
export type StatusTone = "mist" | "amber" | "rose";

/** The header's one word, its colour, and what the tooltip adds. */
export type HeaderStatus = {
  word: string;
  tone: StatusTone;
};

/** The header reads "Checking status" until the first activity arrives. */
export const CHECKING_STATUS = "Checking status";
/** The header's word while the AI service itself is unavailable. */
export const AI_UNAVAILABLE = "AI unavailable";

/**
 * The moment-to-moment phases the live row in the transcript already names
 * ("Editor is thinking…"); the header folds them into one steady word.
 */
export const HEADER_COLLAPSED_LABELS: ReadonlySet<string> = new Set(["Sending", "Thinking", "Using a tool"]);
export const HEADER_WORKING_WORD = "Working";

/** States where something went wrong and a person should look. */
export const FAILURE_LABELS: ReadonlySet<string> = new Set([AI_UNAVAILABLE, "Not responding", "Reply failed", "Response delayed", "Run failed"]);

/** Plain text, no dot: mist unless the coworker is asking for something (amber) or reporting a failure (rose). */
export function describeHeaderStatus(activity: CoworkerActivity | undefined, engineManaged: boolean): HeaderStatus {
  if (!engineManaged) return { word: AI_UNAVAILABLE, tone: "rose" };
  if (!activity) return { word: CHECKING_STATUS, tone: "mist" };
  const word = HEADER_COLLAPSED_LABELS.has(activity.label) ? HEADER_WORKING_WORD : activity.label;
  if (FAILURE_LABELS.has(word)) return { word, tone: "rose" };
  if (activity.state === "attention" || (activity.state === "retrying" && Boolean(activity.reason))) return { word, tone: "amber" };
  return { word, tone: "mist" };
}

/** "7:40 AM" in the person's locale; empty when the time is unknown. */
export function clockTime(timestamp: number): string {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * What the status tooltip adds to the one word: why, when the word alone does
 * not say, and since when. Never the phrase the transcript's live row shows.
 * Empty when there is nothing to add.
 */
export function describeStatusDetail(activity: CoworkerActivity | undefined, engineManaged: boolean): string {
  if (!engineManaged || !activity) return "";
  const parts: string[] = [];
  switch (activity.state) {
    case "retrying":
      parts.push(activity.reason ? `The AI model is unavailable: ${activity.reason}` : "Retrying after an interruption");
      break;
    case "attention":
    case "offline":
    case "starting":
      if (activity.detail) parts.push(activity.detail);
      break;
    default:
      break;
  }
  const since = clockTime(activity.updatedAt);
  if (since) parts.push(`since ${since}`);
  return parts.join(" · ");
}

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
 * What the Activity panel's "now" row should say. Finished work is never named
 * here — the Recent list below owns it — and the state word is never repeated:
 * the header says "Retrying" or "Needs you" once, and this row names what it is
 * about.
 */
export function describeNow(activity: CoworkerActivity | undefined): NowSummary {
  // Until the first activity arrives the header already says it is checking; the row stays quiet.
  if (!activity) return { subject: "", note: "", needsYou: false };
  // A turn that needs words: the same line as the conversation and the rail, under the subject.
  if (activity.summary) return { subject: activity.detail, note: activity.summary, needsYou: /^(Waiting|Needs you)/.test(activity.label) };
  switch (activity.state) {
    case "working":
      return { subject: activity.detail, note: activity.workers?.subject ? "A Worker, working on it" : "", needsYou: false };
    case "retrying":
      if (activity.reason) {
        return { subject: activity.detail, note: `The AI model is unavailable: ${activity.reason}. Choose another AI model to continue.`, needsYou: true };
      }
      return { subject: activity.detail, note: "", needsYou: false };
    case "attention":
      // Permission and question requests wait on the person; a failed run only
      // needs a look, so it is named without asking for a reply.
      return { subject: activity.detail, note: "", needsYou: /^(Waiting|Needs you)/.test(activity.label) };
    case "recent":
      return { subject: "", note: "", needsYou: false };
    case "starting":
      return { subject: "", note: "", needsYou: false };
    case "offline":
      return { subject: "", note: activity.detail || "The workspace is not answering. Restart AI from AI & local setup if this continues.", needsYou: false };
    default:
      return { subject: "", note: "Waiting for the first assignment.", needsYou: false };
  }
}

/** Plain result word for one Recent activity entry, in the same words the responsibility list uses. */
export function describeOutcome(entry: Pick<RecentWork, "outcome">): string {
  if (entry.outcome === "succeeded") return "Done";
  if (entry.outcome === "failed") return "Didn't finish";
  return "Finished";
}

/**
 * Finished assignments plus finished local responsibility runs, newest first,
 * bounded so the list stays scannable. A run that is still going is not
 * recent work, and the discussion thread never appears (it is filtered before
 * it reaches `activity.recent`). A responsibility run executes as a native
 * thread, so the thread it produced is listed once, as the run.
 */
export function mergeRecentWork(
  activity: Pick<CoworkerActivity, "recent"> | undefined,
  responsibilities: ReadonlyArray<Pick<LocalResponsibility, "id" | "name" | "latestRun">>,
  limit: number = RECENT_WORK_LIMIT,
): RecentWork[] {
  const runs: RecentWork[] = [];
  for (const item of responsibilities) {
    const run = item.latestRun;
    if (!run || run.status === "running" || run.status === "queued" || !run.finishedAt) continue;
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
  const runThreads = new Set(runs.map((run) => run.threadId).filter((threadId): threadId is string => Boolean(threadId)));
  const assignments = (activity?.recent ?? []).filter((entry) => !entry.threadId || !runThreads.has(entry.threadId));
  return [...assignments, ...runs]
    .sort((left, right) => right.finishedAt - left.finishedAt)
    .slice(0, limit);
}
