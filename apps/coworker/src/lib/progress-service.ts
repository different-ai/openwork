import { PROGRESS_LIMITS } from "./progress-config.ts";
import { EXECUTION_KINDS, EXECUTION_STATES, executionKind, executionState, executionTimestamp, type ExecutionMetadataInput } from "./work-receipt.ts";

export const PROGRESS_STATES = {
  sending: "Sending request",
  preparing: "Preparing a reply",
  tool: "Using a tool",
  streaming: "Reply text received",
  retrying: "Retrying",
  waiting: "Waiting for a result",
  queued: "Continuation queued",
  resuming: "Resuming work",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "Status unavailable",
};
export type ProgressStatus = keyof typeof PROGRESS_STATES;
export type ProgressObservation = {
  /** Scope to one execution, not a coworker or a conversation. Never sent to the model. */
  executionId: string;
  status: ProgressStatus;
  startedAt: number | null;
  completedAt?: number | null;
  tool?: ExecutionMetadataInput | null;
  /** Omit unknown counts; zero means observed zero. No prompts, names, or payloads. */
  completedSteps?: number;
  failedSteps?: number;
  pendingCoworkers?: number;
  pendingWorkers?: number;
};
type FactId = "status" | "steps" | "dependencies";
type ProgressFact = { id: FactId; text: string };
export type ProgressNote = { fingerprint: string; factIds: FactId[]; source: "observed" | "selected" };

function count(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(PROGRESS_LIMITS.maxCount, Math.floor(value)) : null;
}

function countWords(value: number): string {
  return value === PROGRESS_LIMITS.maxCount ? `${value}+` : String(value);
}

function snapshot(observation: ProgressObservation) {
  const status = Object.hasOwn(PROGRESS_STATES, observation.status) ? observation.status : "unknown";
  return {
    status,
    kind: observation.tool ? executionKind(observation.tool.tool) : "other",
    toolStatus: executionState(observation.tool?.status),
    completed: count(observation.completedSteps),
    failed: count(observation.failedSteps),
    coworkers: count(observation.pendingCoworkers),
    workers: count(observation.pendingWorkers),
  };
}

/** Clock ticks and raw payload changes do not change this content hash. */
export function progressFingerprint(observation: ProgressObservation): string {
  const key = JSON.stringify(snapshot(observation));
  let hash = 2166136261;
  for (let index = 0; index < key.length; index++) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  return `${observation.executionId}:${(hash >>> 0).toString(16)}`;
}

export function progressFacts(observation: ProgressObservation): ProgressFact[] {
  const facts = snapshot(observation);
  const label = facts.status === "tool" ? `${EXECUTION_KINDS[facts.kind]}: ${EXECUTION_STATES[facts.toolStatus]}` : PROGRESS_STATES[facts.status];
  const result: ProgressFact[] = [{ id: "status", text: `${label}.` }];
  const dependencies: string[] = [];
  if (facts.coworkers) dependencies.push(`${countWords(facts.coworkers)} coworker result${facts.coworkers === 1 ? "" : "s"}`);
  if (facts.workers) dependencies.push(`${countWords(facts.workers)} Worker result${facts.workers === 1 ? "" : "s"}`);
  if (dependencies.length) result.push({ id: "dependencies", text: `Pending: ${dependencies.join(" and ")}.` });
  const steps: string[] = [];
  if (facts.completed !== null) steps.push(`${countWords(facts.completed)} tool step${facts.completed === 1 ? "" : "s"} completed`);
  if (facts.failed) steps.push(`${countWords(facts.failed)}${steps.length ? "" : ` tool step${facts.failed === 1 ? "" : "s"}`} failed`);
  if (steps.length) result.push({ id: "steps", text: `${steps.join("; ")}.` });
  return result;
}

export function progressNoteText(observation: ProgressObservation, note?: ProgressNote): string {
  const facts = progressFacts(observation);
  // Models select existing facts, never author display text. Missing/stale/invalid selections fall back.
  const ids = note?.fingerprint === progressFingerprint(observation) ? note.factIds : [];
  const selected = facts.filter((fact) => ids.includes(fact.id));
  const required = facts.filter((fact) => fact.id !== "steps" || Boolean(count(observation.failedSteps)));
  const valid = required.every((fact) => selected.includes(fact));
  return (valid ? selected : facts).map((fact) => fact.text).join(" ").slice(0, PROGRESS_LIMITS.maxNoteChars);
}

export function isLongProgress(observation: ProgressObservation, now: number): boolean {
  const startedAt = executionTimestamp(observation.startedAt);
  return startedAt !== null && now - startedAt >= PROGRESS_LIMITS.longRunningMs;
}

/** Adapter must enforce both token cap and abort at the provider; no tools, history, or model fallback. */
export type ProgressSummarizer = (request: {
  modelId: string;
  prompt: string;
  maxOutputTokens: number;
  signal: AbortSignal;
}) => Promise<string>;

/** One instance per execution, not a remounting UI row. Dispose on cancellation or config change. */
export function createProgressService(options: {
  executionId: string;
  enabled?: boolean;
  /** Explicitly selected inexpensive model. Absence always means zero inference. */
  cheapModelId?: string;
  summarize?: ProgressSummarizer;
  onNote: (note: ProgressNote) => void;
}) {
  const { executionId, enabled, cheapModelId, summarize, onNote } = options;
  const modelId = cheapModelId?.trim();
  let currentKey = "";
  let generation = 0;
  let calls = 0;
  let lastCallAt = -Infinity;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let latest: ProgressNote | undefined;
  const attempted = new Set<string>();
  const cancel = () => {
    generation++;
    clearTimeout(timer);
    clearTimeout(timeout);
    timer = undefined;
    controller?.abort();
    controller = undefined;
  };

  return {
    /** Synchronous deterministic result; optional inference never blocks the turn or its UI. */
    update(observation: ProgressObservation, now = Date.now()): ProgressNote {
      const facts = progressFacts(observation);
      const fallback: ProgressNote = { fingerprint: progressFingerprint(observation), factIds: facts.map((fact) => fact.id), source: "observed" };
      if (disposed || observation.executionId !== executionId) return fallback;
      // Compare canonical content as well as the hash so collisions cannot suppress updates.
      const key = JSON.stringify(snapshot(observation));
      if (key !== currentKey) {
        cancel();
        currentKey = key;
        latest = fallback;
      }
      const terminal = ["completed", "failed", "cancelled", "unknown", "streaming"].includes(observation.status);
      if (!enabled || !modelId || !summarize || terminal || !isLongProgress(observation, now)
        || timer !== undefined || controller || attempted.has(key) || calls >= PROGRESS_LIMITS.maxCallsPerExecution) return latest ?? fallback;

      const version = generation;
      const required = facts.filter((fact) => fact.id !== "steps" || Boolean(count(observation.failedSteps)));
      const prompt = `Select useful observed progress facts. Return only JSON {"facts":["status",...]}. Include status and dependencies when present, and steps if any failed. Do not write prose, predictions, ETA, confidence, or reasoning.\n${JSON.stringify(facts)}`;
      if (prompt.length > PROGRESS_LIMITS.maxInputChars) return latest ?? fallback;
      timer = setTimeout(() => {
        timer = undefined;
        if (disposed || version !== generation) return;
        calls++;
        lastCallAt = Date.now();
        attempted.add(key);
        const active = new AbortController();
        controller = active;
        timeout = setTimeout(() => {
          active.abort();
          if (controller === active) controller = undefined;
        }, PROGRESS_LIMITS.timeoutMs);
        void (async () => {
          try {
            const result = await summarize({ modelId, prompt, maxOutputTokens: PROGRESS_LIMITS.maxOutputTokens, signal: active.signal });
            if (active.signal.aborted || disposed || version !== generation || result.length > PROGRESS_LIMITS.maxOutputChars) return;
            const parsed: unknown = JSON.parse(result);
            if (!parsed || typeof parsed !== "object" || !("facts" in parsed) || !Array.isArray(parsed.facts)) return;
            const ids: unknown[] = parsed.facts;
            if (ids.length === 0 || ids.length > PROGRESS_LIMITS.maxFacts || new Set(ids).size !== ids.length
              || ids.some((id) => !facts.some((fact) => fact.id === id))) return;
            const selected = facts.filter((fact) => ids.includes(fact.id));
            if (required.some((fact) => !selected.includes(fact))) return;
            latest = { fingerprint: fallback.fingerprint, factIds: selected.map((fact) => fact.id), source: "selected" };
            onNote(latest);
          } catch {
            // Failure, cancellation, and invalid output keep the observed fallback. No retries.
          } finally {
            if (controller === active) {
              clearTimeout(timeout);
              controller = undefined;
            }
          }
        })();
      }, Math.max(PROGRESS_LIMITS.debounceMs, PROGRESS_LIMITS.minCallIntervalMs - (now - lastCallAt)));
      return latest ?? fallback;
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
