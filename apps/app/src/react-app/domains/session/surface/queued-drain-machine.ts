/**
 * Admission-aware drain state machine for queued composer follow-ups.
 *
 * The previous drain used a single boolean "awaiting busy" edge-wait: it was
 * armed before every queued send and cleared only by an observed busy edge or
 * a failed send. When a send was admitted but the busy event never surfaced
 * (dropped SSE event, upstream dispatch failure after admission, or a stream
 * reconnect during admission), the boolean stayed armed forever and every
 * later queued item was wedged behind it.
 *
 * This machine replaces the edge-wait with explicit per-item admission state
 * keyed by the queued item id (which the drain also uses as the engine
 * message admission key). Every queued item resolves to exactly one of:
 *
 * - `admitted_running`               — admission + a busy observation
 * - `admitted_awaiting_observation`  — admitted, run not yet observed
 * - `completed`                      — an authoritative idle level observed
 *                                      at/after admission released the item
 * - `needs_input`                    — the pre-send gate blocked; the user
 *                                      must retry explicitly
 * - `rejected`                       — the send was cancelled (context
 *                                      changed / unmounted); item re-queued
 * - `retryable_unknown`              — the send threw; item re-queued
 * - `terminal_failure`               — the same item exhausted its send
 *                                      attempts; drain halts until user retry
 *
 * A missing busy event is never the only signal that allows progress: an
 * item stuck in `awaiting_observation` is released by a *level-reconciled*
 * idle observation (an authoritative status read whose observation time is
 * at/after the admission time), never by a stale idle that predates the
 * admission.
 *
 * State lives in a module-level per-session store (not component refs) so an
 * in-flight admission survives navigating away from and back to the session.
 */

/** How long an admitted send may go unobserved before the drain probes an
 * authoritative status level instead of waiting for the busy edge. */
export const QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS = 10_000;

/** Spacing between authoritative probes when the first probe cannot decide
 * (for example the status endpoint is briefly unreachable). */
export const QUEUE_ADMISSION_PROBE_RETRY_MS = 5_000;

/** Send attempts allowed per queued item before the drain halts as a
 * terminal failure and waits for an explicit user retry. */
export const QUEUE_SEND_ATTEMPT_LIMIT = 3;

export type QueuedDrainPhase =
  | { kind: "ready" }
  | { kind: "sending"; itemId: string; busySeen: boolean }
  | { kind: "awaiting_observation"; itemId: string; admittedAt: number }
  | { kind: "running"; itemId: string }
  | { kind: "halted"; itemId: string; reason: "needs_input" | "terminal_failure" };

export type QueuedItemResolution =
  | "admitted_running"
  | "admitted_awaiting_observation"
  | "completed"
  | "needs_input"
  | "rejected"
  | "retryable_unknown"
  | "terminal_failure";

export type QueuedDrainState = {
  phase: QueuedDrainPhase;
  attemptsByItemId: Record<string, number>;
  lastResolution: { itemId: string; resolution: QueuedItemResolution } | null;
};

export type QueuedDrainEvent =
  | { type: "send_started"; itemId: string }
  | { type: "send_result"; itemId: string; outcome: "sent" | "accepted" | "blocked" | "cancelled"; at: number }
  | { type: "send_error"; itemId: string }
  | { type: "busy_observed" }
  /** An authoritative status level read (SSE-followed idle after a busy
   * observation, or an explicit snapshot/status probe). `observedAt` is when
   * the observation was initiated so stale idles are ordered against the
   * admission time and dropped. */
  | { type: "idle_reconciled"; observedAt: number }
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
    case "send_started": {
      if (phase.kind !== "ready") return state;
      const attempts = (state.attemptsByItemId[event.itemId] ?? 0) + 1;
      return {
        phase: { kind: "sending", itemId: event.itemId, busySeen: false },
        attemptsByItemId: { ...state.attemptsByItemId, [event.itemId]: attempts },
        lastResolution: state.lastResolution,
      };
    }
    case "send_result": {
      if (phase.kind !== "sending" || phase.itemId !== event.itemId) return state;
      if (event.outcome === "sent" || event.outcome === "accepted") {
        // Admitted. The engine may have rendered its busy status before the
        // send promise resolved; a busy seen during the send belongs to this
        // admission.
        if (phase.busySeen) {
          return resolved(state, { kind: "running", itemId: event.itemId }, event.itemId, "admitted_running");
        }
        return resolved(
          state,
          { kind: "awaiting_observation", itemId: event.itemId, admittedAt: event.at },
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
      // cancelled: the submission context changed; the caller re-queues the
      // item and the drain may try again when conditions settle.
      return resolved(state, { kind: "ready" }, event.itemId, "rejected");
    }
    case "send_error": {
      if (phase.kind !== "sending" || phase.itemId !== event.itemId) return state;
      const attempts = state.attemptsByItemId[event.itemId] ?? 1;
      if (attempts >= QUEUE_SEND_ATTEMPT_LIMIT) {
        return resolved(
          state,
          { kind: "halted", itemId: event.itemId, reason: "terminal_failure" },
          event.itemId,
          "terminal_failure",
        );
      }
      return resolved(state, { kind: "ready" }, event.itemId, "retryable_unknown");
    }
    case "busy_observed": {
      if (phase.kind === "sending") {
        return { ...state, phase: { ...phase, busySeen: true } };
      }
      if (phase.kind === "awaiting_observation") {
        return resolved(state, { kind: "running", itemId: phase.itemId }, phase.itemId, "admitted_running");
      }
      return state;
    }
    case "idle_reconciled": {
      if (phase.kind === "running") {
        // Busy was observed for this admission, so a later idle level is a
        // genuinely new level: the run finished.
        return resolved(state, { kind: "ready" }, phase.itemId, "completed", dropAttempt(state, phase.itemId));
      }
      if (phase.kind === "awaiting_observation") {
        // Negative invariant: a stale idle observed before the admission
        // must never release the item — that idle predates our send.
        if (event.observedAt < phase.admittedAt) return state;
        // Authoritative idle at/after admission: either the run started and
        // finished between observations (missed busy edge) or upstream
        // dispatch failed after admission. Either way the admitted item can
        // no longer block the queue.
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
      // Stop means stop: an aborted queue must not leave a halted or
      // awaiting admission behind to wedge the next queueing round. A
      // running admission resolves through the normal idle level.
      if (phase.kind === "running" || phase.kind === "sending") return state;
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

/** True when the drain may admit the next queued item. */
export function canAdmitNextQueuedItem(state: QueuedDrainState): boolean {
  return state.phase.kind === "ready";
}

/** When (epoch ms) the awaiting admission should be probed against an
 * authoritative status level; null when no probe is due. */
export function nextObservationProbeAt(state: QueuedDrainState, lastProbeAt: number | null): number | null {
  if (state.phase.kind !== "awaiting_observation") return null;
  const due = state.phase.admittedAt + QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS;
  if (lastProbeAt === null) return due;
  return Math.max(due, lastProbeAt + QUEUE_ADMISSION_PROBE_RETRY_MS);
}

// --- Per-session store -----------------------------------------------------
//
// Component refs die on unmount, but an admission does not: navigating away
// from a session and back while its first queued item is running must not
// forget the in-flight admission (a fresh boolean would either wedge or,
// worse, drain the next item into a stale idle render). Sessions are pruned
// from the map as soon as they return to the initial state.

const drainStateBySession = new Map<string, QueuedDrainState>();
const drainListenersBySession = new Map<string, Set<() => void>>();

export function getQueuedDrainState(sessionId: string): QueuedDrainState {
  return drainStateBySession.get(sessionId) ?? INITIAL_QUEUED_DRAIN_STATE;
}

export function dispatchQueuedDrain(sessionId: string, event: QueuedDrainEvent): QueuedDrainState {
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

/** Atomically claim the send slot for one queued item. Returns false when
 * another surface (for example a split view of the same session) already
 * holds a non-ready phase, so a queued item can never be sent twice. */
export function claimQueuedSend(sessionId: string, itemId: string): boolean {
  if (!canAdmitNextQueuedItem(getQueuedDrainState(sessionId))) return false;
  const next = dispatchQueuedDrain(sessionId, { type: "send_started", itemId });
  return next.phase.kind === "sending" && next.phase.itemId === itemId;
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

/** Test-only: forget every session's drain state. */
export function resetQueuedDrainForTests() {
  drainStateBySession.clear();
  drainListenersBySession.clear();
}
