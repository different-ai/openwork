import { setTimeout as delay } from "node:timers/promises";
import type { Sandbox } from "./api.ts";

/** Wall clock for build waits; tests pass a fake one. */
export interface BuildClock {
  now(): number;
  sleep(ms: number): Promise<unknown>;
}

export const SYSTEM_CLOCK: BuildClock = { now: () => Date.now(), sleep: (ms) => delay(ms) };

/**
 * Evidence world timing, in one place. A CI step that prepares a world passes
 * its budget (OPENWORK_EVIDENCE_PREPARE_BUDGET_MINUTES) below its own
 * `timeout-minutes`, and every wait inside stops `reserveMs` before that
 * budget so the step fails with a diagnosis instead of being cancelled
 * silently. `.github/scripts/pr-proof-budgets.test.mjs` checks the workflow
 * numbers nest.
 */
export const BUILD_TIMING = Object.freeze({
  /** A preparation's limit when the caller sets no budget (the dev warm-up, previews). */
  defaultBudgetMs: 45 * 60_000,
  /** Left before the deadline for one slow provider call, a bounded diagnostic and releasing the builder. */
  reserveMs: 2 * 60_000,
  /** At most one "still waiting" line per wait this often. */
  progressEveryMs: 30_000,
  /** A builder whose controller is this far past the deadline it recorded has been abandoned. */
  staleGraceMs: 2 * 60_000,
  /** Builders from controllers that did not record a deadline. */
  legacyStaleBuilderMs: 60 * 60_000,
});

export const PREPARE_BUDGET_ENV = "OPENWORK_EVIDENCE_PREPARE_BUDGET_MINUTES";

export interface BuildBudget {
  readonly clock: BuildClock;
  /** When the caller's preparation must be over. */
  readonly deadline: number;
  /** When waits stop, leaving the reserve for a diagnosis and cleanup. */
  readonly waitUntil: number;
  readonly started: number;
  /** Milliseconds a wait may still take; never negative. */
  remaining(): number;
  /** `limitMs`, shortened so it ends by `waitUntil`. */
  cap(limitMs: number): number;
}

export function buildBudget(input: { deadline?: number; clock?: BuildClock } = {}): BuildBudget {
  const clock = input.clock ?? SYSTEM_CLOCK;
  const started = clock.now();
  const deadline = input.deadline ?? started + BUILD_TIMING.defaultBudgetMs;
  const waitUntil = deadline - BUILD_TIMING.reserveMs;
  const remaining = () => Math.max(0, waitUntil - clock.now());
  return { clock, deadline, waitUntil, started, remaining, cap: (limitMs) => Math.min(limitMs, remaining()) };
}

/** The deadline for a preparation that starts at `now`, from the CI step's budget; undefined when none is set. */
export function deadlineFromEnv(env: Readonly<Record<string, string | undefined>>, now: number): number | undefined {
  const raw = env[PREPARE_BUDGET_ENV]?.trim();
  if (!raw) return undefined;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`${PREPARE_BUDGET_ENV} must be a positive number of minutes`);
  if (minutes * 60_000 <= BUILD_TIMING.reserveMs) throw new Error(`${PREPARE_BUDGET_ENV} must leave more than ${BUILD_TIMING.reserveMs / 60_000} minutes for diagnosis`);
  return now + minutes * 60_000;
}

export type BuildWait = "builder" | "snapshot" | "script" | "sandbox";

export interface BuilderView {
  name: string;
  state: string;
  ageMs: number | null;
  /** How long until the builder's controller gives up, by the deadline it recorded; negative when past. */
  ownerDeadlineInMs: number | null;
  /** Public commit labels only (what the builder is building). */
  labels: Record<string, string>;
}

export interface BuildProgress {
  stage: string;
  waiting: BuildWait;
  elapsedMs: number;
  remainingMs: number;
  builder?: BuilderView;
  snapshot?: { name: string; state: string };
}

const PUBLIC_BUILDER_LABELS = ["layer", "devSha", "sourceSha"];

export function describeBuilder(owner: Sandbox, now: number): BuilderView {
  const created = owner.createdAt ? Date.parse(owner.createdAt) : Number.NaN;
  const ownerDeadline = Number(owner.labels.deadline);
  return {
    name: owner.name,
    state: owner.state,
    ageMs: Number.isFinite(created) ? now - created : null,
    ownerDeadlineInMs: Number.isFinite(ownerDeadline) && ownerDeadline > 0 ? ownerDeadline - now : null,
    labels: Object.fromEntries(PUBLIC_BUILDER_LABELS.flatMap((key) => owner.labels[key] ? [[key, owner.labels[key]]] : [])),
  };
}

/**
 * Whether another controller's builder holds the layer lock without making
 * progress: it failed or stopped, its controller is past the deadline it
 * recorded (the controller deletes its builder before then), or, for builders
 * from controllers that recorded none, it is older than an hour.
 */
export function builderIsStale(owner: Sandbox, now: number): boolean {
  if (["error", "build_failed", "stopped", "archived"].includes(owner.state)) return true;
  const view = describeBuilder(owner, now);
  if (view.ownerDeadlineInMs !== null) return view.ownerDeadlineInMs < -BUILD_TIMING.staleGraceMs;
  return (view.ageMs ?? 0) > BUILD_TIMING.legacyStaleBuilderMs;
}

/** Reports each kind of wait at most once per interval, so long waits say what they wait on without flooding the log. */
export function progressReporter(budget: BuildBudget, sink: ((event: BuildProgress) => void) | undefined, everyMs = BUILD_TIMING.progressEveryMs) {
  const last = new Map<string, number>();
  return (event: Omit<BuildProgress, "elapsedMs" | "remainingMs">) => {
    if (!sink) return;
    const now = budget.clock.now();
    const key = `${event.stage}:${event.waiting}`;
    const previous = last.get(key);
    if (previous !== undefined && now - previous < everyMs) return;
    last.set(key, now);
    sink({ ...event, elapsedMs: now - budget.started, remainingMs: Math.max(0, budget.deadline - now) });
  };
}

export function minutes(ms: number): string {
  return `${Math.max(0, Math.round(ms / 6_000) / 10)} min`;
}
