import {
  ACTIVATION_STEP_TITLES,
  activationChecklistPresentation,
  activationProgress,
  nextActivationStep,
  orderedActivationSteps,
  type ActivationClientEvent,
  type ActivationState,
  type ActivationStepId,
} from "@openwork/types/den/activation";

/**
 * The Desktop "Get set up" card: what it shows for a checklist Den computed, and
 * when this app reports a step only it can observe. Pure, so the rules are unit-tested.
 */

export type ActivationRowAction = "invite" | "skill" | "provider" | "gateway" | "connect";

export type ActivationRow = {
  id: ActivationStepId;
  title: string;
  state: "done" | "open" | "locked";
  /** State in a person's words (done) or who can do it (locked). */
  line: string | null;
  /** At most one action, only for an open step. */
  action: { kind: ActivationRowAction; label: string } | null;
};

const ACTIONS: Partial<Record<ActivationStepId, { kind: ActivationRowAction; label: string }>> = {
  invite_teammate: { kind: "invite", label: "Invite" },
  use_skill: { kind: "skill", label: "Try a skill" },
  own_provider: { kind: "provider", label: "Add key" },
  gateway_provider: { kind: "gateway", label: "Share" },
  connector: { kind: "connect", label: "Connect" },
};

export type ActivationCardModel =
  | { presentation: "hidden" }
  | { presentation: "next" | "full"; done: number; total: number; next: string | null; rows: ActivationRow[]; dismissed: boolean };

export function activationCardModel(state: ActivationState | null | undefined): ActivationCardModel {
  const presentation = activationChecklistPresentation(state);
  if (presentation === "hidden" || !state) return { presentation: "hidden" };
  const progress = activationProgress(state);
  const next = nextActivationStep(state);
  return {
    presentation,
    done: progress.done,
    total: progress.total,
    next: next ? ACTIVATION_STEP_TITLES[next.id] : null,
    dismissed: state.dismissed,
    rows: orderedActivationSteps(state).map((step) => {
      const rowState = step.done ? "done" : step.lockedReason ? "locked" : "open";
      return {
        id: step.id,
        title: ACTIVATION_STEP_TITLES[step.id],
        state: rowState,
        line: step.done ? step.detail ?? null : step.lockedReason ?? null,
        action: rowState === "open" ? ACTIONS[step.id] ?? null : null,
      };
    }),
  };
}

/**
 * Report only while Den shows the checklist for this person and the step is still open: nothing is sent when the
 * checklist is unavailable, before it loaded, or once Den already counts the step.
 */
export function shouldReportActivationEvent(state: ActivationState | null | undefined, step: ActivationClientEvent): boolean {
  if (!state) return false;
  if (step === "dismiss") return !state.dismissed;
  return orderedActivationSteps(state).some((entry) => entry.id === step && !entry.done);
}

/**
 * One report per step and scope at a time; a failure is swallowed (it never affects the person) and may be retried
 * on the next occurrence, since Den ignores repeats anyway.
 */
export function createActivationReporter<Scope extends { key: string }>(input: {
  readState: (scope: Scope) => ActivationState | null | undefined;
  send: (scope: Scope, step: ActivationClientEvent, durationMs: number | undefined) => Promise<ActivationState | null>;
  onState: (scope: Scope, state: ActivationState) => void;
}) {
  const inFlight = new Set<string>();
  return async function report(scope: Scope, step: ActivationClientEvent, durationMs?: number): Promise<boolean> {
    if (!shouldReportActivationEvent(input.readState(scope), step)) return false;
    const key = `${scope.key}:${step}`;
    if (inFlight.has(key)) return false;
    inFlight.add(key);
    try {
      const next = await input.send(scope, step, durationMs);
      if (next) input.onState(scope, next);
      return true;
    } catch {
      return false;
    } finally {
      inFlight.delete(key);
    }
  };
}

/** Composer draft parts that run a skill (a local skill or one assigned through OpenWork). */
export function draftUsesSkill(parts: readonly { type: string }[] | undefined): boolean {
  return Boolean(parts?.some((part) => part.type === "skill" || part.type === "connect-skill"));
}
