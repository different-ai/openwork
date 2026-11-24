export const QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS = 10_000;

export const QUEUE_ADMISSION_PROBE_RETRY_MS = 5_000;

export type QueuedDrainPhase =
  | { kind: "ready" }
  | { kind: "sending"; itemId: string; busySeen: boolean }
  | { kind: "admission_unknown"; itemId: string; messageID: string; at: number; deferred?: boolean }
  | { kind: "awaiting_observation"; itemId: string; admittedAt: number; messageID?: string }
  | { kind: "running"; itemId: string }
  | { kind: "halted"; itemId: string; reason: "needs_input" | "terminal_failure" };

export type QueuedItemResolution =
  | "admitted_running"
  | "admitted_awaiting_observation"
  | "completed"
  | "needs_input"
  | "rejected"
  | "admission_unknown"
  | "terminal_failure";

export type QueuedDrainState = {
  phase: QueuedDrainPhase;
  attemptsByItemId: Record<string, number>;
  lastResolution: { itemId: string; resolution: QueuedItemResolution } | null;
};

export type QueuedDrainEvent =
  | { type: "send_started"; itemId: string; steer?: boolean }
  | { type: "stop_confirmed" }
  | { type: "send_result"; itemId: string; outcome: "sent" | "accepted" | "blocked" | "cancelled"; at: number; deferredMessageID?: string; terminalObserved?: boolean }
  | { type: "send_error"; itemId: string }
  | { type: "send_unknown"; itemId: string; messageID: string; at: number; deferred?: boolean }
  | { type: "admission_observed"; itemId: string; messageID: string; at: number }
  | { type: "admission_rejected"; itemId: string; messageID: string }
  | { type: "busy_observed" }
  | { type: "idle_reconciled"; observedAt: number; terminalObserved?: boolean }
  | { type: "user_retry" }
  | { type: "queue_cleared" };

export const INITIAL_QUEUED_DRAIN_STATE: QueuedDrainState = {
  phase: { kind: "ready" },
  attemptsByItemId: {},
  lastResolution: null,
};

function resolved(
  state: QueuedDrainState,
  phase: QueuedDrainPhase,
  itemId: string,
  resolution: QueuedItemResolution,
  attemptsByItemId?: Record<string, number>,
): QueuedDrainState {
  return {
    phase,
    attemptsByItemId: attemptsByItemId ?? state.attemptsByItemId,
    lastResolution: { itemId, resolution },
  };
}

export function reduceQueuedDrain(state: QueuedDrainState, event: QueuedDrainEvent): QueuedDrainState {
  const { phase } = state;
  switch (event.type) {
    case "stop_confirmed":
      if (phase.kind === "sending") return { ...state, phase: { ...phase, busySeen: false } };
      if (phase.kind === "admission_unknown") return state;
      return { ...INITIAL_QUEUED_DRAIN_STATE, lastResolution: state.lastResolution };
    case "send_started": {
      if (phase.kind !== "ready") {
        if (!event.steer) return state;
        if (phase.kind === "running" || phase.kind === "awaiting_observation") {
          if (phase.itemId === event.itemId) return state;
        } else if (phase.kind !== "halted" || (phase.reason !== "terminal_failure" && phase.itemId !== event.itemId)) return state;
      }
      const attempts = (state.attemptsByItemId[event.itemId] ?? 0) + 1;
      return {
        phase: { kind: "sending", itemId: event.itemId, busySeen: phase.kind === "running" },
        attemptsByItemId: { ...state.attemptsByItemId, [event.itemId]: attempts },
        lastResolution: state.lastResolution,
      };
    }
    case "send_result": {
      if (phase.kind !== "sending" || phase.itemId !== event.itemId) return state;
      if (event.outcome === "sent" && event.terminalObserved) {
        return resolved(state, { kind: "ready" }, event.itemId, "completed", dropAttempt(state, event.itemId));
      }
      if (event.outcome === "sent" || event.outcome === "accepted") {
        if (phase.busySeen && !event.deferredMessageID) {
          return resolved(state, { kind: "running", itemId: event.itemId }, event.itemId, "admitted_running");
        }
        return resolved(
          state,
          { kind: "awaiting_observation", itemId: event.itemId, admittedAt: event.at, ...(event.deferredMessageID ? { messageID: event.deferredMessageID } : {}) },
          event.itemId,
          "admitted_awaiting_observation",
        );
      }
      if (event.outcome === "blocked") {
        return resolved(
          state,
          { kind: "halted", itemId: event.itemId, reason: "needs_input" },
          event.itemId,
          "needs_input",
        );
      }
      return resolved(state, { kind: "ready" }, event.itemId, "rejected");
    }
    case "send_error": {
      if (phase.kind !== "sending" || phase.itemId !== event.itemId) return state;
      return resolved(state, { kind: "halted", itemId: event.itemId, reason: "terminal_failure" }, event.itemId, "terminal_failure");
    }
    case "send_unknown": {
      if (phase.kind !== "sending" || phase.itemId !== event.itemId) return state;
      return resolved(state, { kind: "admission_unknown", itemId: event.itemId, messageID: event.messageID, at: event.at, ...(event.deferred ? { deferred: true } : {}) }, event.itemId, "admission_unknown");
    }
    case "admission_observed": {
      if (phase.kind !== "admission_unknown" || phase.itemId !== event.itemId || phase.messageID !== event.messageID) return state;
      return resolved(state, { kind: "awaiting_observation", itemId: event.itemId, admittedAt: event.at, ...(phase.deferred ? { messageID: phase.messageID } : {}) }, event.itemId, "admitted_awaiting_observation");
    }
    case "admission_rejected": {
      if (phase.kind !== "admission_unknown" || phase.itemId !== event.itemId || phase.messageID !== event.messageID) return state;
      return resolved(state, { kind: "halted", itemId: event.itemId, reason: "terminal_failure" }, event.itemId, "terminal_failure");
    }
    case "busy_observed": {
      if (phase.kind === "sending") {
        return { ...state, phase: { ...phase, busySeen: true } };
      }
      if (phase.kind === "awaiting_observation" && !phase.messageID) {
        return resolved(state, { kind: "running", itemId: phase.itemId }, phase.itemId, "admitted_running");
      }
      return state;
    }
    case "idle_reconciled": {
      if (phase.kind === "running") {
        return resolved(state, { kind: "ready" }, phase.itemId, "completed", dropAttempt(state, phase.itemId));
      }
      if (phase.kind === "awaiting_observation") {
        if (event.observedAt < phase.admittedAt) return state;
        if (phase.messageID && !event.terminalObserved) return state;
        return resolved(state, { kind: "ready" }, phase.itemId, "completed", dropAttempt(state, phase.itemId));
      }
      return state;
    }
    case "user_retry": {
      if (phase.kind !== "halted") return state;
      return {
        phase: { kind: "ready" },
        attemptsByItemId: dropAttempt(state, phase.itemId),
        lastResolution: state.lastResolution,
      };
    }
    case "queue_cleared": {
      if (phase.kind === "running" || phase.kind === "sending" || phase.kind === "admission_unknown" || phase.kind === "awaiting_observation") return state;
      return { ...INITIAL_QUEUED_DRAIN_STATE, lastResolution: state.lastResolution };
    }
  }
}

function dropAttempt(state: QueuedDrainState, itemId: string): Record<string, number> {
  if (!(itemId in state.attemptsByItemId)) return state.attemptsByItemId;
  const next = { ...state.attemptsByItemId };
  delete next[itemId];
  return next;
}

export function canAdmitNextQueuedItem(state: QueuedDrainState, steer = false): boolean {
  if (state.phase.kind === "ready") return true;
  return steer && (state.phase.kind === "running" || state.phase.kind === "awaiting_observation");
}

export function hasPendingQueuedAdmission(state: QueuedDrainState): boolean {
  return state.phase.kind === "sending" || state.phase.kind === "awaiting_observation" || state.phase.kind === "running" || state.phase.kind === "admission_unknown";
}

export function nextObservationProbeAt(state: QueuedDrainState, lastProbeAt: number | null): number | null {
  if (state.phase.kind !== "awaiting_observation" && state.phase.kind !== "admission_unknown") return null;
  const due = (state.phase.kind === "admission_unknown" ? state.phase.at : state.phase.admittedAt) + QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS;
  if (lastProbeAt === null) return due;
  return Math.max(due, lastProbeAt + QUEUE_ADMISSION_PROBE_RETRY_MS);
}

const drainStateBySession = new Map<string, QueuedDrainState>();
const drainListenersBySession = new Map<string, Set<() => void>>();
const sendGenerationBySession = new Map<string, number>();

export function getQueuedSendGeneration(sessionId: string): number {
  return sendGenerationBySession.get(sessionId) ?? 0;
}

export function assertQueuedSendCurrent(sessionId: string, generation: number): void {
  if (getQueuedSendGeneration(sessionId) !== generation) throw new Error("Send cancelled by Stop.");
}

export function getQueuedDrainState(sessionId: string): QueuedDrainState {
  return drainStateBySession.get(sessionId) ?? INITIAL_QUEUED_DRAIN_STATE;
}

export function dispatchQueuedDrain(sessionId: string, event: QueuedDrainEvent): QueuedDrainState {
  if (event.type === "queue_cleared") {
    sendGenerationBySession.set(sessionId, getQueuedSendGeneration(sessionId) + 1);
  }
  const current = getQueuedDrainState(sessionId);
  const next = reduceQueuedDrain(current, event);
  if (next === current) return current;
  if (next.phase.kind === "ready" && Object.keys(next.attemptsByItemId).length === 0 && next.lastResolution === null) {
    drainStateBySession.delete(sessionId);
  } else {
    drainStateBySession.set(sessionId, next);
  }
  const listeners = drainListenersBySession.get(sessionId);
  if (listeners) for (const listener of listeners) listener();
  return next;
}

export function claimQueuedSend(sessionId: string, itemId: string, steer = false): boolean {
  const current = getQueuedDrainState(sessionId);
  const next = dispatchQueuedDrain(sessionId, { type: "send_started", itemId, steer });
  return next !== current && next.phase.kind === "sending" && next.phase.itemId === itemId;
}

export function subscribeQueuedDrain(sessionId: string, listener: () => void): () => void {
  const listeners = drainListenersBySession.get(sessionId) ?? new Set();
  drainListenersBySession.set(sessionId, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) drainListenersBySession.delete(sessionId);
  };
}

export function resetQueuedDrainForTests() {
  drainStateBySession.clear();
  drainListenersBySession.clear();
  sendGenerationBySession.clear();
}
