/**
 * Workers: long-lived sub-agents a coworker (or the person) starts for one
 * goal. The main process owns their records and turns (`electron/workers.mjs`);
 * this module gives the interface the words for them and reads back the
 * review turn that wakes the coworker so it renders as one action line.
 */

export type WorkerLifespan =
  | { kind: "until"; at: number }
  | { kind: "turns"; max: number; used: number }
  | { kind: "open" };

export type WorkerStatus = "starting" | "running" | "waiting" | "paused" | "finished" | "cancelled" | "failed";

export type WorkerSummary = {
  schemaVersion: 1;
  id: string;
  slug: string;
  name: string;
  goal: string;
  /** The Worker's native thread; empty until its first turn was accepted. */
  threadId: string;
  spawnedBy: "coworker" | "person";
  spawnedFromThreadId: string;
  status: WorkerStatus;
  /** Why a waiting Worker waits: for a free turn on this Mac, or for a decision. */
  waitingFor: "" | "turn" | "decision";
  lifespan: WorkerLifespan;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  lastFindingAt: number | null;
  steerCount: number;
  error: string;
};

export type WorkerEventKind = "finding" | "status" | "steer" | "review";

export type WorkerEvent = {
  id: string;
  at: number;
  kind: WorkerEventKind;
  text: string;
  /** For findings: an ordinary finding, a decision the Worker waits for, or its final one. */
  report?: "finding" | "decision" | "done";
  /** Who steered or stopped: the coworker or the person. */
  by?: "coworker" | "person";
  reviewThreadId?: string;
  findingIds?: string[];
  error?: string;
};

/** Everything that still counts as a live Worker for the coworker. */
export function isLiveWorker(worker: Pick<WorkerSummary, "status">): boolean {
  return worker.status !== "finished" && worker.status !== "cancelled" && worker.status !== "failed";
}

/** Plain words for how long a Worker lives. */
export function describeLifespan(lifespan: WorkerLifespan, now = Date.now()): string {
  if (lifespan.kind === "until") {
    const at = new Date(lifespan.at);
    const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (at.toDateString() === new Date(now).toDateString()) return `Until ${time}`;
    if (at.toDateString() === new Date(now + 86_400_000).toDateString()) return `Until tomorrow ${time}`;
    const withinWeek = lifespan.at - now < 6 * 86_400_000;
    return `Until ${at.toLocaleDateString(undefined, withinWeek ? { weekday: "long" } : { month: "short", day: "numeric" })} ${time}`;
  }
  if (lifespan.kind === "turns") {
    const left = Math.max(0, lifespan.max - lifespan.used);
    return `${left} of ${lifespan.max} turn${lifespan.max === 1 ? "" : "s"} left`;
  }
  return "Until you stop it";
}

/** The status words shared with responsibilities, plus the two states only Workers have. */
export function describeWorkerStatus(worker: Pick<WorkerSummary, "status" | "waitingFor">): string {
  switch (worker.status) {
    case "starting":
      return "Starting";
    case "running":
      return "Working on it";
    case "waiting":
      return worker.waitingFor === "decision" ? "Waiting for a decision" : "Waiting its turn";
    case "paused":
      return "Paused";
    case "finished":
      return "Done";
    case "cancelled":
      return "Stopped";
    case "failed":
      return "Didn't finish";
  }
}

/** Must match `REVIEW_OPENER` in `electron/workers.mjs`, which writes the review turn. */
export const REVIEW_OPENER = "Review these updates from your Workers.";

export type WorkerReviewUpdate = {
  worker: string;
  kind: "finding" | "decision" | "done" | "failed";
  text: string;
};

export type WorkerReview = {
  updates: WorkerReviewUpdate[];
};

const UPDATE_LINE = /^Worker "(.+?)" (reported|needs a decision|finished|didn't finish): (.*)$/;

function updateKind(verb: string): WorkerReviewUpdate["kind"] {
  switch (verb) {
    case "needs a decision":
      return "decision";
    case "finished":
      return "done";
    case "didn't finish":
      return "failed";
    default:
      return "finding";
  }
}

/**
 * Read back the message the app sent to wake the coworker, so the transcript
 * shows "Reviewed 2 updates from Workers" instead of the scaffolding. Anything
 * else returns null and renders as an ordinary message.
 */
export function parseWorkerReview(text: string): WorkerReview | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(REVIEW_OPENER)) return null;
  const lines = trimmed.split("\n");
  const start = lines.indexOf("New updates:");
  if (start < 0) return null;
  const updates: WorkerReviewUpdate[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = UPDATE_LINE.exec(line);
    if (!match) {
      // Update text may run over several lines; they belong to the last update.
      if (updates.length > 0 && line.trim() && !line.startsWith("Review these updates.")) {
        const last = updates[updates.length - 1];
        if (last) last.text = `${last.text}\n${line}`;
      }
      continue;
    }
    const [, worker = "", verb = "", rest = ""] = match;
    updates.push({ worker, kind: updateKind(verb), text: rest });
  }
  return { updates: updates.map((update) => ({ ...update, text: update.text.trim() })) };
}

/** The one line the conversation shows for a review turn. */
export function describeReview(review: WorkerReview): string {
  const count = review.updates.length;
  const workers = new Set(review.updates.map((update) => update.worker));
  if (count === 1) {
    const [only] = review.updates;
    return `Reviewed an update from ${only?.worker ?? "a Worker"}`;
  }
  return `Reviewed ${count} updates from ${workers.size === 1 ? [...workers][0] : "Workers"}`;
}
