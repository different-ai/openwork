import {
  ACTIVATION_OPTIONAL_DETAIL,
  ACTIVATION_STEP_TITLES,
  activationChecklistPresentation,
  activationProgress,
  nextActivationStep,
  orderedActivationSteps,
  type ActivationClientEvent,
  type ActivationState,
  type ActivationStepId,
} from "@openwork/types/den/activation";

export type ActivationRowAction = "invite" | "skill" | "provider" | "gateway" | "connect";

export type ActivationRow = {
  id: ActivationStepId;
  title: string;
  state: "done" | "open" | "locked";
  line: string | null;
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

export function activationCardModel(state: ActivationState | null | undefined, options: { hidden?: boolean } = {}): ActivationCardModel {
  const presentation = activationChecklistPresentation(state);
  if (presentation === "hidden" || !state || options.hidden) return { presentation: "hidden" };
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
        line: step.done ? step.detail ?? null : step.lockedReason ?? (step.optional ? ACTIVATION_OPTIONAL_DETAIL : null),
        action: rowState === "open" ? ACTIONS[step.id] ?? null : null,
      };
    }),
  };
}

export function shouldReportActivationEvent(state: ActivationState | null | undefined, step: ActivationClientEvent): boolean {
  if (!state) return false;
  if (step === "dismiss") return !state.dismissed;
  return orderedActivationSteps(state).some((entry) => entry.id === step && !entry.done);
}

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

const BUILT_IN_PROVIDER_ID = "opencode";

export function hasVerifiedDeviceProvider(
  health: {
    entries: Readonly<Record<string, { status: string }>>;
    workspaceScopes: Readonly<Record<string, string>>;
  },
  managed: (providerId: string) => boolean,
): boolean {
  return Object.entries(health.entries).some(([key, entry]) => {
    if (entry.status !== "verified") return false;
    let parsed: unknown;
    try { parsed = JSON.parse(key); } catch { return false; }
    if (!Array.isArray(parsed)) return false;
    const [workspaceId, providerId]: unknown[] = parsed;
    if (typeof workspaceId !== "string" || typeof providerId !== "string") return false;
    const id = providerId.trim();
    return health.workspaceScopes[workspaceId] === "device" && Boolean(id) && id.toLowerCase() !== BUILT_IN_PROVIDER_ID && !managed(id);
  });
}

export function hasDeviceConnection(statuses: Readonly<Record<string, { status: string }>> | null | undefined): boolean {
  return Object.entries(statuses ?? {}).some(([name, entry]) => entry.status === "connected" && !name.trim().toLowerCase().startsWith("openwork"));
}

export function draftUsesSkill(parts: readonly { type: string }[] | undefined): boolean {
  return Boolean(parts?.some((part) => part.type === "skill" || part.type === "connect-skill"));
}

export function activationHiddenStorageKey(input: { origin: string; organizationId: string; principalId: string }): string {
  return `openwork.activation.hidden:${input.origin}:${input.organizationId}:${input.principalId}`;
}
