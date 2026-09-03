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

/** Must match `WORKER_THREAD_TITLE_PREFIX` in `electron/workers.mjs`, which titles the Worker's thread. */
export const WORKER_THREAD_TITLE_PREFIX = "Worker: ";

/** The Worker's name from its thread title; only used for threads the registry already says are Workers. */
export function workerNameFromTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.startsWith(WORKER_THREAD_TITLE_PREFIX) ? trimmed.slice(WORKER_THREAD_TITLE_PREFIX.length).trim() || trimmed : trimmed;
}

/** The status dot beside a Worker row, in the tones the rest of the app uses. */
export function workerTone(worker: Pick<WorkerSummary, "status" | "waitingFor">): "spark" | "mint" | "amber" | "rose" | "mist" {
  switch (worker.status) {
    case "running":
    case "starting":
      return "spark";
    case "waiting":
      return worker.waitingFor === "decision" ? "amber" : "spark";
    case "finished":
      return "mint";
    case "failed":
      return "rose";
    default:
      return "mist";
  }
}

/** One timeline line for a Worker event, in plain words. */
export function describeWorkerEvent(event: WorkerEvent, coworkerName: string): { label: string; text: string; quiet: boolean } {
  switch (event.kind) {
    case "finding":
      if (event.report === "decision") return { label: "Needs a decision", text: event.text, quiet: false };
      if (event.report === "done") return { label: "Done", text: event.text, quiet: false };
      return { label: "Finding", text: event.text, quiet: false };
    case "steer":
      return { label: event.by === "coworker" ? `Steered by ${coworkerName}` : "Steered by you", text: event.text, quiet: true };
    case "review":
      return { label: "", text: event.error ? `${coworkerName} could not review this yet` : `${coworkerName} reviewed this`, quiet: true };
    case "status":
      return { label: "", text: event.text, quiet: true };
  }
}

/** The New Worker form's lifespan choice as the record the main process stores. */
export type LifespanChoice =
  | { kind: "turns"; turns: string }
  | { kind: "until"; at: string }
  | { kind: "open" };

/** Turn the form's choice into a lifespan, or say in plain words what is missing. */
export function lifespanFromChoice(choice: LifespanChoice, now = Date.now()): { lifespan: WorkerLifespan } | { error: string } {
  if (choice.kind === "open") return { lifespan: { kind: "open" } };
  if (choice.kind === "turns") {
    const max = Math.round(Number(choice.turns));
    if (!Number.isFinite(max) || max < 1 || max > 100) return { error: "Choose between 1 and 100 turns." };
    return { lifespan: { kind: "turns", max, used: 0 } };
  }
  const at = new Date(choice.at).getTime();
  if (!Number.isFinite(at)) return { error: "Choose when the Worker should stop." };
  if (at <= now) return { error: "Choose a time that is still ahead." };
  return { lifespan: { kind: "until", at } };
}

/** The line the Activity view and rail use for live Workers: "2 Workers running", "1 Worker waiting for a decision". */
export function describeWorkerCount(workers: ReadonlyArray<Pick<WorkerSummary, "status" | "waitingFor">>): string {
  const live = workers.filter(isLiveWorker);
  if (live.length === 0) return "";
  const running = live.filter((worker) => worker.status === "running" || worker.status === "starting" || (worker.status === "waiting" && worker.waitingFor === "turn")).length;
  const deciding = live.filter((worker) => worker.status === "waiting" && worker.waitingFor === "decision").length;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (deciding > 0) parts.push(`${deciding} waiting for a decision`);
  if (parts.length === 0) parts.push(`${live.length} paused`);
  return `${live.length === 1 ? "1 Worker" : `${live.length} Workers`} · ${parts.join(" · ")}`;
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

/** Must match the frame `workerTurnPrompt` writes in `electron/workers.mjs`. */
export const WORKER_TURN_OPENER = "You are a Worker named \"";
const WORKER_TURN_CONTRACT_LINE = "Work in bounded steps.";

/**
 * Read back one of the app's own turns in a Worker's thread — the frame plus
 * what this turn asked for — so the thread shows "Begin working toward the
 * goal now." or the steering, never the whole frame as a bubble from the person.
 */
export function parseWorkerTurn(text: string): { body: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(WORKER_TURN_OPENER)) return null;
  const lines = trimmed.split("\n");
  const contract = lines.findIndex((line) => line.startsWith(WORKER_TURN_CONTRACT_LINE));
  if (contract < 0) return null;
  const body = lines.slice(contract + 1).join("\n").trim();
  return { body };
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

// ---------------------------------------------------------------------------
// The coworker's Worker tools as the transcript shows them (`coworker_worker_spawn` …).

const WORKER_TOOLS = new Set(["workers_list", "worker_spawn", "worker_steer", "worker_cancel", "worker_findings"]);

/** `coworker_worker_spawn` → `worker_spawn`; empty for any other tool. */
export function workerToolName(tool: string): string {
  const lower = tool.toLowerCase();
  if (WORKER_TOOLS.has(lower)) return lower;
  for (const name of WORKER_TOOLS) {
    if (lower.endsWith(`_${name}`)) return name;
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `structuredContent.worker` a Worker tool returned, when the transcript kept it. */
export function structuredWorker(call: { output: unknown; metadata: Record<string, unknown> }): { id: string; name: string } | null {
  for (const candidate of [call.metadata.openworkMcpResult, call.metadata.openworkMcpApp, call.output]) {
    if (!isRecord(candidate) || !isRecord(candidate.structuredContent) || !isRecord(candidate.structuredContent.worker)) continue;
    const worker = candidate.structuredContent.worker;
    return { id: typeof worker.id === "string" ? worker.id : "", name: typeof worker.name === "string" ? worker.name : "" };
  }
  return null;
}

/**
 * The coworker's Worker tool calls in the words the person reads between
 * bubbles: "Started a Worker · Market scan", "Steered Market scan",
 * "Stopped Market scan", "Read Market scan's findings". The Worker names
 * itself through the kept result when there is one, else through the input.
 */
export function describeWorkerToolStep(
  name: string,
  call: { input?: Record<string, unknown>; output: unknown; metadata: Record<string, unknown> },
): { label: string; doing: string } {
  const input = call.input ?? {};
  const kept = structuredWorker(call);
  const inputName = typeof input.name === "string" ? input.name.trim() : "";
  const workerName = kept?.name || inputName;
  switch (name) {
    case "workers_list":
      return { label: "Looked over its Workers", doing: "looking over its Workers" };
    case "worker_spawn":
      return { label: workerName ? `Started a Worker · ${workerName}` : "Started a Worker", doing: "starting a Worker" };
    case "worker_steer":
      return { label: workerName ? `Steered ${workerName}` : "Steered a Worker", doing: workerName ? `steering ${workerName}` : "steering a Worker" };
    case "worker_cancel":
      return { label: workerName ? `Stopped ${workerName}` : "Stopped a Worker", doing: workerName ? `stopping ${workerName}` : "stopping a Worker" };
    default:
      return { label: workerName ? `Read ${workerName}'s findings` : "Read a Worker's findings", doing: "reading a Worker's findings" };
  }
}

// ---------------------------------------------------------------------------
// A Worker's "Needs a decision" as a lettered choice card in the discussion.

export type WorkerDecision = {
  /** The question, without the option lines. */
  question: string;
  /** The choices the Worker offered, in order; empty when it asked open-endedly. */
  options: string[];
};

const OPTION_LINE = /^\s*(?:[-*•]\s*)?(?:\(?([A-Za-z]|\d{1,2})[).:]|[-*•])\s+(.+?)\s*$/;

/**
 * Read a decision finding into a question and its choices: lines such as
 * "A) Include vendor C", "1. Yes", or "- Skip it" become options; the rest is
 * the question. One lone bullet is part of the question, not a choice.
 */
export function parseWorkerDecision(text: string): WorkerDecision {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const options: string[] = [];
  const question: string[] = [];
  for (const line of lines) {
    const match = OPTION_LINE.exec(line);
    if (match && match[2]) options.push(match[2].replace(/[*_`]/g, "").trim());
    else if (line.trim()) question.push(line.trim());
  }
  if (options.length < 2) return { question: text.trim(), options: [] };
  return { question: question.join(" ").trim(), options };
}
