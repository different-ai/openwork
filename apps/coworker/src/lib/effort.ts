/**
 * Dynamic effort: how hard a coworker thinks, decided per turn from what the
 * turn is and how hard the person wants the coworker to work in general.
 *
 * The person sets a *preference* on a five-stop dial — Light, Steady,
 * Balanced, Thorough, All in — never an exact effort. Each kind of work has a
 * baseline (a quick reply thinks little, a Worker turn or an assignment run
 * thinks hard, the facilitator thinks least), the preference shifts it, and
 * the result snaps to the nearest effort the model actually offers. A model
 * that offers no efforts runs at its default whatever the dial says, and an
 * exact thinking effort the person fixed in Coworker settings always wins.
 * The same preference nudges which lane a message takes and how many turns a
 * Worker gets when nobody chose, so "work harder" reaches the Workers too.
 */
import type { ModelLane } from "./model-choice.ts";

/** The dial's stops, from the least to the most thinking. */
export const EFFORT_STOPS = ["light", "steady", "balanced", "thorough", "all-in"] as const;
export type EffortStop = (typeof EFFORT_STOPS)[number];
export const DEFAULT_EFFORT_STOP: EffortStop = "balanced";

/** The stop a stored value means; anything unknown is the default, so an older record never turns the dial. */
export function effortStopOf(value: unknown): EffortStop {
  return typeof value === "string" && (EFFORT_STOPS as readonly string[]).includes(value) ? (value as EffortStop) : DEFAULT_EFFORT_STOP;
}

/** How many steps the stop moves the baseline: Light −2 … All in +2. */
export function effortShift(stop: EffortStop): number {
  return EFFORT_STOPS.indexOf(stop) - EFFORT_STOPS.indexOf(DEFAULT_EFFORT_STOP);
}

/** The engine's effort names in order; a model offers some subset (or names of its own, which keep their order). */
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = number;

/** What a turn is, for the baseline. */
export type EffortKind = "quick-reply" | "reply" | "deep-reply" | "worker-turn" | "assignment-run" | "review" | "facilitator";

const BASELINES: Record<EffortKind, EffortLevel> = {
  "quick-reply": 1,
  reply: 2,
  "deep-reply": 3,
  "worker-turn": 3,
  "assignment-run": 3,
  review: 2,
  facilitator: 0,
};

/** A discussion turn's kind from its lane. */
export function replyKindForLane(lane: ModelLane): EffortKind {
  return lane === "quick" ? "quick-reply" : lane === "deep" ? "deep-reply" : "reply";
}

/**
 * The effort level (0 = minimal … 5 = max) for one turn: the kind's baseline
 * moved by the preference and clamped. The facilitator never moves: it decides
 * who answers, and thinks least whatever the dial says.
 */
export function effortLevelFor(kind: EffortKind, stop: EffortStop): EffortLevel {
  if (kind === "facilitator") return BASELINES.facilitator;
  return Math.min(EFFORT_LEVELS.length - 1, Math.max(0, BASELINES[kind] + effortShift(stop)));
}

/** A model's offered efforts in the engine's order; names the engine does not know keep the order the model gave. */
export function orderedVariants(variants: readonly string[]): string[] {
  return [...variants].sort((left, right) => {
    const a = EFFORT_LEVELS.indexOf(left as (typeof EFFORT_LEVELS)[number]);
    const b = EFFORT_LEVELS.indexOf(right as (typeof EFFORT_LEVELS)[number]);
    if (a === -1 && b === -1) return 0;
    if (a === -1) return 1;
    if (b === -1) return -1;
    return a - b;
  });
}

/**
 * The effort a model is asked for at a level: the nearest of the efforts it
 * offers (ties go to the lower one, so the dial never overshoots), or "" for
 * the model default when it offers none.
 */
export function variantForLevel(level: EffortLevel, variants: readonly string[]): string {
  const offered = orderedVariants(variants);
  if (offered.length === 0) return "";
  const known = offered.filter((name) => (EFFORT_LEVELS as readonly string[]).includes(name));
  if (known.length === 0) {
    // Efforts named by the provider alone: read them as evenly spaced from least to most.
    const index = Math.round((level / (EFFORT_LEVELS.length - 1)) * (offered.length - 1));
    return offered[Math.min(offered.length - 1, Math.max(0, index))] ?? "";
  }
  let best = known[0] ?? "";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of known) {
    const distance = Math.abs(EFFORT_LEVELS.indexOf(name as (typeof EFFORT_LEVELS)[number]) - level);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The effort one turn is sent with. An exact effort the person fixed wins when
 * the model offers it; otherwise the dial decides through the kind's level.
 */
export function effortForTurn(input: { kind: EffortKind; stop: EffortStop; fixedVariant: string; variants: readonly string[] }): string {
  const fixed = input.fixedVariant.trim();
  if (fixed && input.variants.includes(fixed)) return fixed;
  return variantForLevel(effortLevelFor(input.kind, input.stop), input.variants);
}

/**
 * The dial nudges the lane a message takes: Thorough turns a quick ask into an
 * ordinary one, All in turns ordinary work into deep work; Light and Steady
 * the other way. Balanced leaves the message's own lane alone.
 */
export function laneWithPreference(lane: ModelLane, stop: EffortStop): ModelLane {
  const order: readonly ModelLane[] = ["quick", "standard", "deep"];
  const shift = effortShift(stop);
  const step = shift >= 2 ? 1 : shift <= -2 ? -1 : shift === 1 && lane === "quick" ? 1 : shift === -1 && lane === "deep" ? -1 : 0;
  const index = Math.min(order.length - 1, Math.max(0, order.indexOf(lane) + step));
  return order[index] ?? lane;
}

/** Turns a Worker gets when nobody chose a lifespan: the dial says how much work is welcome. */
export function workerTurnsFor(stop: EffortStop): number {
  switch (stop) {
    case "light":
      return 6;
    case "steady":
      return 8;
    case "balanced":
      return 10;
    case "thorough":
      return 14;
    case "all-in":
      return 20;
  }
}

/** The stop's name as the dial shows it. */
export function effortStopLabel(stop: EffortStop): string {
  switch (stop) {
    case "light":
      return "Light";
    case "steady":
      return "Steady";
    case "balanced":
      return "Balanced";
    case "thorough":
      return "Thorough";
    case "all-in":
      return "All in";
  }
}

/** One line under the stop's name: what it means for the turns the coworker takes. */
export function describeEffortStop(stop: EffortStop): string {
  switch (stop) {
    case "light":
      return "Quick, short work: brief replies, little thinking, Workers with a few steps. Good for chat and small asks.";
    case "steady":
      return "A bit less thinking than usual on real work; quick questions stay quick.";
    case "balanced":
      return "The usual: quick questions get quick answers, real work and Workers think harder.";
    case "thorough":
      return "More thinking on real work, and quick asks get a proper look. Workers take more steps.";
    case "all-in":
      return "Prioritizes deeper thinking and gives Workers more steps. Can take longer and use more of your allowance.";
  }
}

/** The effort a turn ran at, in plain words for a receipt's technical details: "Thinking effort: high — Thorough, a Worker turn". */
export function describeEffortUsed(input: { variant: string; stop: EffortStop; kind: EffortKind; fixed: boolean }): string {
  const kind: Record<EffortKind, string> = {
    "quick-reply": "a quick reply",
    reply: "a reply",
    "deep-reply": "deep work",
    "worker-turn": "a Worker turn",
    "assignment-run": "an assignment run",
    review: "a review",
    facilitator: "choosing who answers",
  };
  if (!input.variant) return `Thinking effort: the model's default — ${kind[input.kind]}`;
  if (input.fixed) return `Thinking effort: ${input.variant} — fixed in Coworker settings`;
  return `Thinking effort: ${input.variant} — ${effortStopLabel(input.stop)}, ${kind[input.kind]}`;
}
