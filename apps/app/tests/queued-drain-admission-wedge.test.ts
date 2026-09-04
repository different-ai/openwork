import { expect, test } from "bun:test";

import {
  canAdmitNextQueuedItem,
  claimQueuedSend,
  dispatchQueuedDrain,
  getQueuedDrainState,
  INITIAL_QUEUED_DRAIN_STATE,
  nextObservationProbeAt,
  QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS,
  QUEUE_ADMISSION_PROBE_RETRY_MS,
  QUEUE_SEND_ATTEMPT_LIMIT,
  reduceQueuedDrain,
  resetQueuedDrainForTests,
  subscribeQueuedDrain,
  type QueuedDrainState,
} from "../src/react-app/domains/session/surface/queued-drain-machine";

// The queued-message drain protocol lives entirely in the admission-aware
// machine these tests drive; session-surface.tsx is a thin adapter that maps
// engine status levels and send outcomes onto these events. Each scenario
// asserts both the progress claim and its negative half: what must NOT allow
// the next queued item to be sent.

const t0 = 1_000_000;

function admit(state: QueuedDrainState, itemId: string, at: number): QueuedDrainState {
  const sending = reduceQueuedDrain(state, { type: "send_started", itemId });
  expect(sending.phase).toEqual({ kind: "sending", itemId, busySeen: false });
  return reduceQueuedDrain(sending, { type: "send_result", itemId, outcome: "sent", at });
}

test("a dropped busy event after a successful admission cannot wedge the drain", () => {
  // Admission succeeds, but the engine's busy event never arrives (dropped
  // SSE event). The old boolean edge-wait stayed armed forever here.
  let state = admit(INITIAL_QUEUED_DRAIN_STATE, "item-1", t0);
  expect(state.phase).toEqual({ kind: "awaiting_observation", itemId: "item-1", admittedAt: t0 });
  expect(state.lastResolution).toEqual({ itemId: "item-1", resolution: "admitted_awaiting_observation" });

  // Negative half: while the admission is unobserved, nothing may drain — a
  // stale idle level observed BEFORE the admission must be dropped.
  expect(canAdmitNextQueuedItem(state)).toBe(false);
  const staleIdle = reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: t0 - 1 });
  expect(staleIdle).toBe(state);
  expect(canAdmitNextQueuedItem(staleIdle)).toBe(false);

  // The machine schedules an authoritative observation probe instead of
  // waiting on the missing edge forever.
  expect(nextObservationProbeAt(state, null)).toBe(t0 + QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS);

  // The probe observes an authoritative idle level at/after the admission:
  // the run started and finished between observations. The item completes
  // and the next queued item may be admitted.
  const probedAt = t0 + QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS;
  state = reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: probedAt });
  expect(state.lastResolution).toEqual({ itemId: "item-1", resolution: "completed" });
  expect(canAdmitNextQueuedItem(state)).toBe(true);
});

test("a message accepted by admission whose upstream dispatch fails still releases the queue", () => {
  // The admission call returned accepted, but dispatch never produced a run:
  // no busy level ever exists. Progress must not depend on the busy event.
  let state = admit(INITIAL_QUEUED_DRAIN_STATE, "item-1", t0);

  // No busy is ever observed. The first probe is inconclusive (endpoint
  // briefly unreachable) — retries stay bounded and spaced.
  const firstProbeAt = t0 + QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS;
  expect(nextObservationProbeAt(state, firstProbeAt)).toBe(firstProbeAt + QUEUE_ADMISSION_PROBE_RETRY_MS);

  // The retry probe reads the authoritative level: still idle, at a time
  // after the admission. The admitted-but-never-ran item cannot block the
  // queue: it resolves and the next item drains.
  state = reduceQueuedDrain(state, {
    type: "idle_reconciled",
    observedAt: firstProbeAt + QUEUE_ADMISSION_PROBE_RETRY_MS,
  });
  expect(state.lastResolution).toEqual({ itemId: "item-1", resolution: "completed" });
  expect(canAdmitNextQueuedItem(state)).toBe(true);

  // Contrast: a send whose transport THREW was never admitted — it stays
  // retryable and halts as a terminal failure once attempts are exhausted,
  // instead of retrying forever or silently dropping the item.
  let failing = INITIAL_QUEUED_DRAIN_STATE;
  for (let attempt = 1; attempt <= QUEUE_SEND_ATTEMPT_LIMIT; attempt += 1) {
    failing = reduceQueuedDrain(failing, { type: "send_started", itemId: "item-2" });
    failing = reduceQueuedDrain(failing, { type: "send_error", itemId: "item-2" });
    if (attempt < QUEUE_SEND_ATTEMPT_LIMIT) {
      expect(failing.lastResolution).toEqual({ itemId: "item-2", resolution: "retryable_unknown" });
      expect(canAdmitNextQueuedItem(failing)).toBe(true);
    }
  }
  expect(failing.phase).toEqual({ kind: "halted", itemId: "item-2", reason: "terminal_failure" });
  expect(failing.lastResolution).toEqual({ itemId: "item-2", resolution: "terminal_failure" });
  // Negative half: a terminal failure never self-heals into a send.
  expect(canAdmitNextQueuedItem(failing)).toBe(false);
  // An explicit user retry — and only that — releases it.
  failing = reduceQueuedDrain(failing, { type: "user_retry" });
  expect(canAdmitNextQueuedItem(failing)).toBe(true);
});

test("an event-stream disconnect and reconnect during admission is healed by level reconciliation", () => {
  // Busy can render before the send promise resolves; an admission must
  // attach that observation instead of losing it (fast engine, slow HTTP).
  let racing = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "item-1" });
  racing = reduceQueuedDrain(racing, { type: "busy_observed" });
  racing = reduceQueuedDrain(racing, { type: "send_result", itemId: "item-1", outcome: "sent", at: t0 });
  expect(racing.phase).toEqual({ kind: "running", itemId: "item-1" });
  expect(racing.lastResolution).toEqual({ itemId: "item-1", resolution: "admitted_running" });

  // Disconnect during admission: the stream dies right after the send is
  // admitted, so no live busy event ever arrives.
  let state = admit(INITIAL_QUEUED_DRAIN_STATE, "item-1", t0);
  expect(canAdmitNextQueuedItem(state)).toBe(false);

  // Reconnect path A: the reconnect-time status reconciliation reports the
  // session busy — the admission attaches to the running run, and only a
  // LATER observed idle completes it.
  const reconnectBusy = reduceQueuedDrain(state, { type: "busy_observed" });
  expect(reconnectBusy.phase).toEqual({ kind: "running", itemId: "item-1" });
  const finished = reduceQueuedDrain(reconnectBusy, { type: "idle_reconciled", observedAt: t0 + 20_000 });
  expect(finished.lastResolution).toEqual({ itemId: "item-1", resolution: "completed" });
  expect(canAdmitNextQueuedItem(finished)).toBe(true);

  // Reconnect path B: the run already finished while disconnected; the
  // reconciliation reports idle observed after the admission. That level —
  // not a busy edge — releases the item.
  const reconnectIdle = reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: t0 + 20_000 });
  expect(reconnectIdle.lastResolution).toEqual({ itemId: "item-1", resolution: "completed" });
  expect(canAdmitNextQueuedItem(reconnectIdle)).toBe(true);

  // Negative half: an idle captured before the admission (a snapshot fetched
  // pre-send that resolves late) must not release the admission.
  const staleIdle = reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: t0 - 5 });
  expect(staleIdle).toBe(state);
  expect(canAdmitNextQueuedItem(staleIdle)).toBe(false);
});

test("three queued items are admitted exactly once each and in order", () => {
  resetQueuedDrainForTests();
  const sessionId = "ses_fifo";
  const items = ["item-1", "item-2", "item-3"];
  const admitted: string[] = [];

  for (const [index, itemId] of items.entries()) {
    // The drain claims the send slot atomically before sending.
    expect(claimQueuedSend(sessionId, itemId)).toBe(true);
    admitted.push(itemId);

    // Negative half (exactly once): while this item is in flight — through
    // sending, admission, and the run itself — no other surface (for
    // example a split view of the same session) can claim another send.
    const rival = items[index + 1] ?? "item-extra";
    expect(claimQueuedSend(sessionId, rival)).toBe(false);
    dispatchQueuedDrain(sessionId, { type: "send_result", itemId, outcome: "sent", at: t0 + index * 100 });
    expect(claimQueuedSend(sessionId, rival)).toBe(false);
    dispatchQueuedDrain(sessionId, { type: "busy_observed" });
    expect(claimQueuedSend(sessionId, rival)).toBe(false);

    // The run finishes: an observed idle level completes the item.
    dispatchQueuedDrain(sessionId, { type: "idle_reconciled", observedAt: t0 + index * 100 + 50 });
  }

  expect(admitted).toEqual(items);
  expect(canAdmitNextQueuedItem(getQueuedDrainState(sessionId))).toBe(true);
  resetQueuedDrainForTests();
});

test("an active admission survives navigating away and back", () => {
  resetQueuedDrainForTests();
  const sessionId = "ses_navigation";

  // The surface mounts, drains the first item, and observes its run start.
  const unsubscribe = subscribeQueuedDrain(sessionId, () => {});
  expect(claimQueuedSend(sessionId, "item-1")).toBe(true);
  dispatchQueuedDrain(sessionId, { type: "send_result", itemId: "item-1", outcome: "sent", at: t0 });
  dispatchQueuedDrain(sessionId, { type: "busy_observed" });

  // Navigate away: the surface unmounts and its subscription is dropped.
  // Component-local refs would die here; the admission must not.
  unsubscribe();

  // Navigate back: a fresh surface reads the same in-flight admission.
  const remounted = getQueuedDrainState(sessionId);
  expect(remounted.phase).toEqual({ kind: "running", itemId: "item-1" });

  // Negative half: the remount briefly renders a fallback idle before any
  // status level is observed. The adapter never emits idle_reconciled for a
  // fallback, and the machine keeps the queue closed until a real level
  // arrives — the next item is not sent into the still-active run.
  expect(canAdmitNextQueuedItem(remounted)).toBe(false);
  expect(claimQueuedSend(sessionId, "item-2")).toBe(false);

  // The run completes and a real observed idle level arrives: the queue
  // reopens and the next item drains in order.
  dispatchQueuedDrain(sessionId, { type: "idle_reconciled", observedAt: t0 + 30_000 });
  expect(claimQueuedSend(sessionId, "item-2")).toBe(true);
  resetQueuedDrainForTests();
});

test("blocked and cancelled sends classify as needs_input and rejected without wedging", () => {
  // Blocked by the pre-send gate: the user must act; drain halts loudly.
  let blocked = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "item-1" });
  blocked = reduceQueuedDrain(blocked, { type: "send_result", itemId: "item-1", outcome: "blocked", at: t0 });
  expect(blocked.phase).toEqual({ kind: "halted", itemId: "item-1", reason: "needs_input" });
  expect(blocked.lastResolution).toEqual({ itemId: "item-1", resolution: "needs_input" });
  expect(canAdmitNextQueuedItem(blocked)).toBe(false);
  const retried = reduceQueuedDrain(blocked, { type: "user_retry" });
  expect(canAdmitNextQueuedItem(retried)).toBe(true);

  // Cancelled (submission context changed): the item is rejected and
  // re-queued by the caller; the drain itself stays open.
  let cancelled = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "item-1" });
  cancelled = reduceQueuedDrain(cancelled, { type: "send_result", itemId: "item-1", outcome: "cancelled", at: t0 });
  expect(cancelled.lastResolution).toEqual({ itemId: "item-1", resolution: "rejected" });
  expect(canAdmitNextQueuedItem(cancelled)).toBe(true);

  // Stopping the queue clears a halted drain so the next queueing round
  // starts clean, but never erases a live admission.
  const cleared = reduceQueuedDrain(blocked, { type: "queue_cleared" });
  expect(cleared.phase).toEqual({ kind: "ready" });
  const live = admit(INITIAL_QUEUED_DRAIN_STATE, "item-9", t0);
  const running = reduceQueuedDrain(live, { type: "busy_observed" });
  expect(reduceQueuedDrain(running, { type: "queue_cleared" })).toBe(running);
});
