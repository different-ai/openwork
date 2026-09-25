/**
 * Readiness policy for the optional work OpenWork does before an OpenCode v2
 * turn. The engine never needs these steps; they make a turn match OpenWork's
 * latest state. Each step chooses how to behave when that state is not yet
 * confirmed:
 *
 * - `block`: wait up to the step's budget, then refuse with a clear error.
 * - `wait`: wait up to the budget, then continue and record a warning.
 * - `background`: continue at once when the location was confirmed before;
 *   the first turn in a location still waits.
 *
 * Authorization, session ownership, and credential scrubbing are not steps
 * here and always refuse.
 */
export type V2ReadinessCheck = "skills" | "providers" | "mcp" | "instructions";
export type V2ReadinessMode = "block" | "wait" | "background";
export type V2ReadinessPolicy = Record<V2ReadinessCheck, V2ReadinessMode>;

const CHECKS: readonly V2ReadinessCheck[] = ["skills", "providers", "mcp", "instructions"];

/** Modes a step supports. MCP and instructions cannot run in the background:
 * a revoked connection must be removed before the turn, and instructions
 * written after the prompt starts would not apply to it. */
const SUPPORTED: Record<V2ReadinessCheck, readonly V2ReadinessMode[]> = {
  skills: ["block", "wait", "background"],
  providers: ["block", "wait", "background"],
  mcp: ["block", "wait"],
  instructions: ["block", "wait"],
};

export const BALANCED_V2_READINESS: V2ReadinessPolicy = {
  skills: "wait", providers: "wait", mcp: "wait", instructions: "wait",
};

const PRESETS: Record<string, V2ReadinessPolicy> = {
  balanced: BALANCED_V2_READINESS,
  strict: { skills: "block", providers: "block", mcp: "block", instructions: "block" },
  fast: { skills: "background", providers: "background", mcp: "wait", instructions: "wait" },
};

/**
 * Parse `OPENWORK_V2_READINESS`: a preset (`balanced`, `strict`, `fast`),
 * optionally followed by per-step overrides, e.g. `fast,mcp=block`.
 * Unknown or unsupported tokens are ignored so a typo never blocks chat.
 */
export function resolveV2ReadinessPolicy(value: string | undefined): V2ReadinessPolicy {
  const policy = { ...BALANCED_V2_READINESS };
  for (const token of (value ?? "").split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)) {
    const preset = PRESETS[token];
    if (preset) {
      Object.assign(policy, preset);
      continue;
    }
    const [check, mode] = token.split("=") as [V2ReadinessCheck, V2ReadinessMode];
    if (CHECKS.includes(check) && SUPPORTED[check].includes(mode)) policy[check] = mode;
  }
  return policy;
}

export class V2NotReadyError extends Error {
  constructor(readonly check: V2ReadinessCheck, detail: string) {
    super(`OpenCode v2 is not ready (${check}): ${detail}`);
    this.name = "V2NotReadyError";
  }
}

export type V2ReadinessEvent = {
  check: V2ReadinessCheck | "catalog" | "sessions";
  outcome: "degraded" | "blocked";
  detail: string;
  firstAt: string;
  lastAt: string;
  count: number;
};

/** Recent degraded or blocked steps, newest first. A repeat of the newest
 * event updates it instead of pushing older ones out. */
export function createV2ReadinessLog(limit = 20) {
  const events: V2ReadinessEvent[] = [];
  return {
    record(event: Pick<V2ReadinessEvent, "check" | "outcome" | "detail">) {
      const now = new Date().toISOString();
      const newest = events[0];
      if (newest && newest.check === event.check && newest.outcome === event.outcome && newest.detail === event.detail) {
        newest.lastAt = now;
        newest.count++;
        return;
      }
      events.unshift({ ...event, firstAt: now, lastAt: now, count: 1 });
      events.length = Math.min(events.length, limit);
    },
    recent(): V2ReadinessEvent[] {
      return events.map((event) => ({ ...event }));
    },
    clear() {
      events.length = 0;
    },
  };
}
