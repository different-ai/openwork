import { expect, spyOn, test } from "bun:test";
import type { ComposerDraft } from "../src/app/types";

import {
  canAdmitNextQueuedItem,
  assertQueuedSendCurrent,
  claimQueuedSend,
  dispatchQueuedDrain,
  getQueuedDrainState,
  hasPendingQueuedAdmission,
  getQueuedSendGeneration,
  INITIAL_QUEUED_DRAIN_STATE,
  nextObservationProbeAt,
  QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS,
  QUEUE_ADMISSION_PROBE_RETRY_MS,
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

test("queue cancellation preserves admissions until stop is confirmed", () => {
  const sending = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "cancelled" });
  const awaiting = reduceQueuedDrain(sending, { type: "send_result", itemId: "cancelled", outcome: "sent", at: t0 });
  const running = reduceQueuedDrain(awaiting, { type: "busy_observed" });
  const unknown = reduceQueuedDrain(sending, { type: "send_unknown", itemId: "cancelled", messageID: "msg_unknown", at: t0 });
  for (const state of [sending, awaiting, running, unknown]) {
    expect(hasPendingQueuedAdmission(state)).toBe(true);
    expect(reduceQueuedDrain(state, { type: "queue_cleared" })).toBe(state);
  }
  expect(reduceQueuedDrain(sending, { type: "stop_confirmed" }).phase.kind).toBe("sending");
  expect(reduceQueuedDrain(unknown, { type: "stop_confirmed" })).toBe(unknown);
  expect(hasPendingQueuedAdmission(reduceQueuedDrain(awaiting, { type: "stop_confirmed" }))).toBe(false);
});

test("an immediate follow-up cannot inherit its interrupted predecessor's busy observation", () => {
  let state = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "old" });
  state = reduceQueuedDrain(state, { type: "busy_observed" });
  state = reduceQueuedDrain(state, { type: "send_result", itemId: "old", outcome: "sent", at: t0 });
  expect(canAdmitNextQueuedItem(reduceQueuedDrain(state, { type: "stop_confirmed" }))).toBe(true);
  state = reduceQueuedDrain(state, { type: "send_started", itemId: "new", steer: true });
  state = reduceQueuedDrain(state, { type: "busy_observed" });
  expect(state.phase).toEqual({ kind: "sending", itemId: "new", busySeen: true });
  state = reduceQueuedDrain(state, { type: "stop_confirmed" });
  expect(state.phase).toEqual({ kind: "sending", itemId: "new", busySeen: false });
  state = reduceQueuedDrain(state, { type: "send_result", itemId: "new", outcome: "sent", at: t0 + 10 });
  expect(state.phase).toEqual({ kind: "awaiting_observation", itemId: "new", admittedAt: t0 + 10 });
  expect(reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: t0 })).toBe(state);
  expect(canAdmitNextQueuedItem(state)).toBe(false);
  state = reduceQueuedDrain(state, { type: "busy_observed" });
  state = reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: t0 + 20 });
  expect(canAdmitNextQueuedItem(state)).toBe(true);
});

function admit(state: QueuedDrainState, itemId: string, at: number): QueuedDrainState {
  const sending = reduceQueuedDrain(state, { type: "send_started", itemId });
  expect(sending.phase).toEqual({ kind: "sending", itemId, busySeen: false });
  return reduceQueuedDrain(sending, { type: "send_result", itemId, outcome: "sent", at });
}

test("a synchronous shell terminal response settles without needing a busy event, but accepted commands do not", () => {
  const sending = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "shell" });
  const completed = reduceQueuedDrain(sending, { type: "send_result", itemId: "shell", outcome: "sent", at: t0, terminalObserved: true });
  expect(completed.phase.kind).toBe("ready");
  expect(completed.lastResolution?.resolution).toBe("completed");
  expect(reduceQueuedDrain(sending, { type: "send_result", itemId: "shell", outcome: "accepted", at: t0, terminalObserved: true }).phase.kind).toBe("awaiting_observation");
});

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

  // Ordinary prompt admission retains current-dev's authoritative idle recovery.
  const probedAt = t0 + QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS;
  state = reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: probedAt });
  expect(state.lastResolution).toEqual({ itemId: "item-1", resolution: "completed" });
  expect(canAdmitNextQueuedItem(state)).toBe(true);
});

test("an accepted deferred command never releases on idle alone or another turn's busy edge", () => {
  // The admission call returned accepted, but dispatch never produced a run:
  // no busy level ever exists. Progress must not depend on the busy event.
  let state = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "item-1" });
  state = reduceQueuedDrain(state, { type: "busy_observed" });
  state = reduceQueuedDrain(state, { type: "send_result", itemId: "item-1", outcome: "accepted", at: t0, deferredMessageID: "msg_command" });
  expect(reduceQueuedDrain(state, { type: "busy_observed" })).toBe(state);

  // No busy is ever observed. The first probe is inconclusive (endpoint
  // briefly unreachable) — retries stay bounded and spaced.
  const firstProbeAt = t0 + QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS;
  expect(nextObservationProbeAt(state, firstProbeAt)).toBe(firstProbeAt + QUEUE_ADMISSION_PROBE_RETRY_MS);

  // No terminal acknowledgment means the command may still dispatch later.
  state = reduceQueuedDrain(state, {
    type: "idle_reconciled",
    observedAt: firstProbeAt + QUEUE_ADMISSION_PROBE_RETRY_MS,
  });
  expect(state.phase.kind).toBe("awaiting_observation");
  expect(canAdmitNextQueuedItem(state)).toBe(false);

  state = reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: firstProbeAt + QUEUE_ADMISSION_PROBE_RETRY_MS, terminalObserved: true });
  expect(canAdmitNextQueuedItem(state)).toBe(true);

  // Only a definite rejection/preflight failure is retryable, and even that
  // requires explicit user action. An uncertain POST uses send_unknown.
  let failing = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "item-2" });
  failing = reduceQueuedDrain(failing, { type: "send_error", itemId: "item-2" });
  expect(failing.phase).toEqual({ kind: "halted", itemId: "item-2", reason: "terminal_failure" });
  expect(failing.lastResolution).toEqual({ itemId: "item-2", resolution: "terminal_failure" });
  // Negative half: a terminal failure never self-heals into a send.
  expect(canAdmitNextQueuedItem(failing)).toBe(false);
  // An explicit user retry — and only that — releases it.
  failing = reduceQueuedDrain(failing, { type: "user_retry" });
  expect(canAdmitNextQueuedItem(failing)).toBe(true);
});

test("unknown admission survives idle, busy, retry, Stop, and remount until the exact message is observed", () => {
  resetQueuedDrainForTests();
  const sessionId = "ses_unknown";
  expect(claimQueuedSend(sessionId, "item-1")).toBe(true);
  dispatchQueuedDrain(sessionId, { type: "send_unknown", itemId: "item-1", messageID: "msg_exact", at: t0 });
  const held = getQueuedDrainState(sessionId);
  const unsubscribe = subscribeQueuedDrain(sessionId, () => {});
  unsubscribe();
  for (const event of [
    { type: "idle_reconciled", observedAt: t0 + 60_000 },
    { type: "busy_observed" },
    { type: "user_retry" },
    { type: "queue_cleared" },
    { type: "admission_observed", itemId: "item-1", messageID: "msg_other", at: t0 + 1 },
    { type: "admission_observed", itemId: "item-other", messageID: "msg_exact", at: t0 + 1 },
  ] satisfies Parameters<typeof dispatchQueuedDrain>[1][]) {
    dispatchQueuedDrain(sessionId, event);
    expect(getQueuedDrainState(sessionId)).toBe(held);
    expect(claimQueuedSend(sessionId, "item-1", true)).toBe(false);
    expect(claimQueuedSend(sessionId, "item-2", true)).toBe(false);
  }
  expect(nextObservationProbeAt(held, null)).toBe(t0 + QUEUE_ADMISSION_OBSERVATION_TIMEOUT_MS);
  dispatchQueuedDrain(sessionId, { type: "admission_observed", itemId: "item-1", messageID: "msg_exact", at: t0 + 100_000 });
  expect(canAdmitNextQueuedItem(getQueuedDrainState(sessionId))).toBe(false);
  dispatchQueuedDrain(sessionId, { type: "idle_reconciled", observedAt: t0 + 60_000 });
  expect(canAdmitNextQueuedItem(getQueuedDrainState(sessionId))).toBe(false);
  dispatchQueuedDrain(sessionId, { type: "idle_reconciled", observedAt: t0 + 110_000 });
  expect(claimQueuedSend(sessionId, "item-2")).toBe(true);
  resetQueuedDrainForTests();
});

test("an authoritative listing without the message halts an unknown admission for an explicit retry", () => {
  let state = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "item-1" });
  state = reduceQueuedDrain(state, { type: "send_unknown", itemId: "item-1", messageID: "msg_exact", at: t0 });
  // Another item or message is not evidence about this admission.
  expect(reduceQueuedDrain(state, { type: "admission_rejected", itemId: "item-1", messageID: "msg_other" })).toBe(state);
  expect(reduceQueuedDrain(state, { type: "admission_rejected", itemId: "item-other", messageID: "msg_exact" })).toBe(state);
  const halted = reduceQueuedDrain(state, { type: "admission_rejected", itemId: "item-1", messageID: "msg_exact" });
  expect(halted.phase).toEqual({ kind: "halted", itemId: "item-1", reason: "terminal_failure" });
  expect(halted.lastResolution).toEqual({ itemId: "item-1", resolution: "terminal_failure" });
  // Negative half: the halt never resends on its own; only the person's retry releases it.
  expect(canAdmitNextQueuedItem(halted)).toBe(false);
  expect(canAdmitNextQueuedItem(reduceQueuedDrain(halted, { type: "user_retry" }))).toBe(true);
  // Rejection is only meaningful while the admission is unknown.
  const running = reduceQueuedDrain(reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "item-2" }), { type: "send_result", itemId: "item-2", outcome: "sent", at: t0 });
  expect(reduceQueuedDrain(running, { type: "admission_rejected", itemId: "item-2", messageID: "msg_2" })).toBe(running);
});

test("observing a deferred command's user message cannot erase its terminal-evidence requirement", () => {
  let state = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "command" });
  state = reduceQueuedDrain(state, { type: "send_unknown", itemId: "command", messageID: "msg_command", at: t0, deferred: true });
  state = reduceQueuedDrain(state, { type: "admission_observed", itemId: "command", messageID: "msg_command", at: t0 + 1 });
  expect(state.phase).toEqual({ kind: "awaiting_observation", itemId: "command", messageID: "msg_command", admittedAt: t0 + 1 });
  expect(reduceQueuedDrain(state, { type: "busy_observed" })).toBe(state);
  expect(reduceQueuedDrain(state, { type: "queue_cleared" })).toBe(state);
  expect(reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: t0 + 100 })).toBe(state);
  expect(canAdmitNextQueuedItem(reduceQueuedDrain(state, { type: "idle_reconciled", observedAt: t0 + 100, terminalObserved: true }))).toBe(true);
});

test("send now shares the current claim with the idle drain and every split pane", () => {
  resetQueuedDrainForTests();
  const sessionId = "ses_steer";
  expect(claimQueuedSend(sessionId, "item-1")).toBe(true);
  expect(claimQueuedSend(sessionId, "item-1", true)).toBe(false);
  expect(claimQueuedSend(sessionId, "item-2", true)).toBe(false);
  dispatchQueuedDrain(sessionId, { type: "send_result", itemId: "item-1", outcome: "sent", at: t0 });
  expect(claimQueuedSend(sessionId, "item-1", true)).toBe(false);
  dispatchQueuedDrain(sessionId, { type: "busy_observed" });
  expect(claimQueuedSend(sessionId, "item-2", true)).toBe(true);
  expect(claimQueuedSend(sessionId, "item-2")).toBe(false);
  expect(claimQueuedSend(sessionId, "item-3", true)).toBe(false);
  dispatchQueuedDrain(sessionId, { type: "send_error", itemId: "item-2" });
  expect(claimQueuedSend(sessionId, "item-2")).toBe(false);
  expect(claimQueuedSend(sessionId, "item-3", true)).toBe(true);
  expect(claimQueuedSend(sessionId, "item-2", true)).toBe(false);
  resetQueuedDrainForTests();
});

test("deferred steers release after admission, not busy or run completion, and share one send slot", () => {
  resetQueuedDrainForTests();
  const sessionId = "ses_starting_steer";
  expect(claimQueuedSend(sessionId, "initial")).toBe(true);
  expect(canAdmitNextQueuedItem(getQueuedDrainState(sessionId), true)).toBe(false);
  expect(canAdmitNextQueuedItem(reduceQueuedDrain(getQueuedDrainState(sessionId), { type: "busy_observed" }), true)).toBe(false);
  dispatchQueuedDrain(sessionId, { type: "send_result", itemId: "initial", outcome: "accepted", at: t0 });
  const admitted = getQueuedDrainState(sessionId);
  expect(canAdmitNextQueuedItem(admitted)).toBe(false);
  expect(canAdmitNextQueuedItem(admitted, true)).toBe(true);
  expect(claimQueuedSend(sessionId, "steer", true)).toBe(true);
  expect(claimQueuedSend(sessionId, "steer", true)).toBe(false);
  expect(claimQueuedSend(sessionId, "second-steer", true)).toBe(false);
  dispatchQueuedDrain(sessionId, { type: "send_result", itemId: "steer", outcome: "accepted", at: t0 + 1 });
  expect(getQueuedDrainState(sessionId).phase.kind).toBe("awaiting_observation");
  expect(canAdmitNextQueuedItem(getQueuedDrainState(sessionId), true)).toBe(true);
  expect(claimQueuedSend(sessionId, "queued")).toBe(false);
  expect(claimQueuedSend(sessionId, "second-steer", true)).toBe(true);
  resetQueuedDrainForTests();
});

test("deferred steers cannot bypass unknown, failed, blocked, or cancelled admissions", () => {
  const sending = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "initial" });
  for (const event of [
    { type: "send_unknown", itemId: "initial", messageID: "msg_initial", at: t0 },
    { type: "send_error", itemId: "initial" },
    { type: "send_result", itemId: "initial", outcome: "blocked", at: t0 },
    { type: "send_result", itemId: "initial", outcome: "cancelled", at: t0 },
  ] satisfies Parameters<typeof reduceQueuedDrain>[1][]) {
    const state = reduceQueuedDrain(sending, event);
    expect(canAdmitNextQueuedItem(state, true)).toBe(false);
    expect(canAdmitNextQueuedItem(reduceQueuedDrain(state, { type: "user_retry" }), true)).toBe(false);
  }
  const unknown = reduceQueuedDrain(sending, { type: "send_unknown", itemId: "initial", messageID: "msg_initial", at: t0 });
  expect(canAdmitNextQueuedItem(reduceQueuedDrain(unknown, { type: "admission_observed", itemId: "initial", messageID: "msg_initial", at: t0 + 1 }), true)).toBe(true);
});

test("promotion after definite failure claims atomically without exposing a ready slot", () => {
  resetQueuedDrainForTests();
  const sessionId = "ses_atomic_promotion";
  expect(claimQueuedSend(sessionId, "failed")).toBe(true);
  dispatchQueuedDrain(sessionId, { type: "send_error", itemId: "failed" });
  const phases: string[] = [];
  const unsubscribe = subscribeQueuedDrain(sessionId, () => {
    phases.push(getQueuedDrainState(sessionId).phase.kind);
    expect(claimQueuedSend(sessionId, "automatic-follower")).toBe(false);
    expect(claimQueuedSend(sessionId, "rival-promotion", true)).toBe(false);
  });
  try {
    expect(claimQueuedSend(sessionId, "selected", true)).toBe(true);
    expect(phases).toEqual(["sending"]);
    expect(getQueuedDrainState(sessionId).phase).toEqual({ kind: "sending", itemId: "selected", busySeen: false });
  } finally {
    unsubscribe();
    resetQueuedDrainForTests();
  }
});

test("a different promotion does not bypass a needs-input halt", () => {
  const sending = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "blocked" });
  const blocked = reduceQueuedDrain(sending, { type: "send_result", itemId: "blocked", outcome: "blocked", at: t0 });
  expect(reduceQueuedDrain(blocked, { type: "send_started", itemId: "other", steer: true })).toBe(blocked);
  expect(reduceQueuedDrain(blocked, { type: "send_started", itemId: "blocked", steer: true }).phase.kind).toBe("sending");
});

test("Stop invalidates preflight and late requeue without erasing a possibly admitted POST", () => {
  resetQueuedDrainForTests();
  const sessionId = "ses_stop";
  expect(claimQueuedSend(sessionId, "item-1")).toBe(true);
  const generation = getQueuedSendGeneration(sessionId);
  assertQueuedSendCurrent(sessionId, generation);
  dispatchQueuedDrain(sessionId, { type: "queue_cleared" });
  expect(() => assertQueuedSendCurrent(sessionId, generation)).toThrow("Send cancelled by Stop.");
  expect(getQueuedSendGeneration(sessionId)).not.toBe(generation);
  expect(claimQueuedSend(sessionId, "item-2", true)).toBe(false);
  dispatchQueuedDrain(sessionId, { type: "send_unknown", itemId: "item-1", messageID: "msg_exact", at: t0 });
  expect(getQueuedDrainState(sessionId).phase.kind).toBe("admission_unknown");
  resetQueuedDrainForTests();
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
  // reconciliation reports authoritative idle after ordinary prompt admission.
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

test.each(["steer", "queued", "chain"])("background eligible %s skips stale owners and generations without losing unsent items", async (followup) => {
  const sessionId = `ses_background_${followup}`;
  const owner = "background-owner";
  const [sync, parts, context, native] = await Promise.all([
    import("../src/react-app/domains/session/sync/session-sync"),
    import("../src/react-app/domains/session/sync/draft-parts"),
    import("../src/react-app/domains/session/sync/env-context"),
    import("../src/app/lib/opencode-session-native"),
  ]);
  const session = { id: sessionId, slug: sessionId, title: "Background steer", projectID: "project", directory: "/tmp/workspace", version: "1", time: { created: 1, updated: 1 } };
  const spies = [
    spyOn(sync, "ensureWorkspaceSessionSync").mockImplementation(() => () => {}),
    spyOn(sync, "trackWorkspaceSessionSync").mockImplementation(() => () => {}),
    spyOn(parts, "draftToParts").mockImplementation(async (draft) => [{ type: "text", text: draft.text }]),
    spyOn(context, "buildOpenworkSessionSystemContext").mockResolvedValue(""),
    spyOn(native, "composeNativeSessionSnapshot").mockResolvedValue({ session, messages: [], todos: [], status: { type: "idle" } }),
    spyOn(native, "getNativeSession").mockResolvedValue(session),
    spyOn(native, "getNativeSessionMessages").mockResolvedValue([]),
  ];
  const { startGlobalQueueDrainer } = await import("../src/react-app/domains/session/sync/global-queue-drainer");
  const { useComposerStateStore } = await import("../src/react-app/domains/session/surface/composer-state-store");
  const { setQueuedSendContext, clearQueuedSendContext } = await import("../src/react-app/domains/session/sync/queued-send-context");
  const { createOpenworkServerClient } = await import("../src/app/lib/openwork-server");
  const posts: unknown[] = [];
  let admission = Promise.withResolvers<Response>();
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "POST") {
      posts.push(await request.json());
      return admission.promise;
    }
    return Response.json({});
  });
  resetQueuedDrainForTests();
  expect(claimQueuedSend(sessionId, "initial")).toBe(true);
  setQueuedSendContext(sessionId, {
    owner, workspaceId: "workspace", workspaceRoot: "/tmp/workspace", opencodeBaseUrl: "http://localhost:1/opencode",
    openworkToken: "test-token", client: createOpenworkServerClient({ baseUrl: "http://localhost:1", token: "test-token" }),
    agent: "plan", variant: null, model: null, environmentRuntimeKey: null,
  });
  const draft: ComposerDraft = { mode: "prompt", text: "After the run", parts: [{ type: "text", text: "After the run" }], attachments: [] };
  useComposerStateStore.getState().appendQueuedDraft(sessionId, draft);
  useComposerStateStore.getState().appendQueuedDraft(sessionId, { ...draft, text: "Other owner steer" }, {
    owner: "wrong-owner", generation: getQueuedSendGeneration(sessionId), agent: "build",
  });
  useComposerStateStore.getState().appendQueuedDraft(sessionId, { ...draft, text: "Old generation steer" }, {
    owner, generation: getQueuedSendGeneration(sessionId) - 1, agent: "build",
  });
  const staleItems = useComposerStateStore.getState().queuedDrafts[sessionId]?.slice(1);
  const stop = startGlobalQueueDrainer();
  try {
    if (followup === "chain") {
      for (const text of ["A", "B", "C"]) useComposerStateStore.getState().appendQueuedDraft(sessionId, { ...draft, text });
      const items = useComposerStateStore.getState().queuedDrafts[sessionId] ?? [];
      const [a, b, c] = items.slice(-3);
      if (!a || !b || !c) throw new Error("Expected chain rows");
      const request = (id: string) => useComposerStateStore.getState().requestQueuedDraftSend(sessionId, id, {
        owner, generation: getQueuedSendGeneration(sessionId), agent: "build",
      });
      request(c.id);
      request(a.id);
      const requested = useComposerStateStore.getState().queuedDrafts[sessionId];
      request(c.id);
      request(a.id);
      expect(useComposerStateStore.getState().queuedDrafts[sessionId]).toBe(requested);
      useComposerStateStore.getState().reorderQueuedDrafts(sessionId, items.map((item) => item.id).reverse());
      expect(posts).toHaveLength(0);
      dispatchQueuedDrain(sessionId, { type: "send_result", itemId: "initial", outcome: "accepted", at: Date.now() });
      for (let index = 0; index < 3; index++) {
        for (let attempt = 0; posts.length < index + 1 && attempt < 50; attempt++) await Bun.sleep(10);
        expect(posts).toHaveLength(index + 1);
        const expected = [c, a, b][index];
        if (!expected) throw new Error("Expected a requested row");
        expect(posts[index]).toMatchObject({ messageID: expected.draft.messageId, parts: [{ type: "text", text: expected.draft.text }] });
        expect(claimQueuedSend(sessionId, "other-pane", true)).toBe(false);
        request(expected.id);
        if (index === 0) request(b.id);
        expect(posts).toHaveLength(index + 1);
        const current = admission;
        admission = Promise.withResolvers<Response>();
        current.resolve(new Response(null, { status: 204 }));
      }
      for (let attempt = 0; getQueuedDrainState(sessionId).phase.kind === "sending" && attempt < 50; attempt++) await Bun.sleep(10);
      expect(posts).toHaveLength(3);
      expect(useComposerStateStore.getState().queuedDrafts[sessionId]?.map((item) => item.draft.text).sort()).toEqual(["After the run", "Old generation steer", "Other owner steer"]);
      return;
    }
    dispatchQueuedDrain(sessionId, { type: "send_unknown", itemId: "initial", messageID: "msg_initial", at: Date.now() });
    await Bun.sleep(10);
    expect(posts).toHaveLength(0);
    dispatchQueuedDrain(sessionId, { type: "admission_observed", itemId: "initial", messageID: "msg_initial", at: Date.now() });
    await Bun.sleep(10);
    expect(posts).toHaveLength(0);
    if (followup === "steer") {
      useComposerStateStore.getState().appendQueuedDraft(sessionId, { ...draft, text: "Steer now" }, {
        owner, generation: getQueuedSendGeneration(sessionId), agent: "build",
      });
    } else {
      dispatchQueuedDrain(sessionId, { type: "idle_reconciled", observedAt: Date.now() });
    }
    for (let attempt = 0; posts.length === 0 && attempt < 50; attempt++) await Bun.sleep(10);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ agent: followup === "steer" ? "build" : "plan", parts: [{ type: "text", text: followup === "steer" ? "Steer now" : "After the run" }] });
    expect(useComposerStateStore.getState().queuedDrafts[sessionId]?.slice(1, 3)).toEqual(staleItems);
    expect(claimQueuedSend(sessionId, "rival", true)).toBe(false);
    useComposerStateStore.getState().clearQueuedDrafts(sessionId);
    useComposerStateStore.getState().appendQueuedDraft(sessionId, { ...draft, text: "Cancelled steer" }, {
      owner, generation: getQueuedSendGeneration(sessionId), agent: "build",
    });
    dispatchQueuedDrain(sessionId, { type: "queue_cleared" });
    admission.resolve(new Response(null, { status: 204 }));
    await Bun.sleep(20);
    expect(posts).toHaveLength(1);
    expect(useComposerStateStore.getState().queuedDrafts[sessionId]?.some((item) => item.draft.text === "Cancelled steer")).toBe(true);
  } finally {
    admission.resolve(new Response(null, { status: 204 }));
    stop();
    useComposerStateStore.getState().clearQueuedDrafts(sessionId);
    clearQueuedSendContext(sessionId);
    resetQueuedDrainForTests();
    fetch.mockRestore();
    for (const spy of spies) spy.mockRestore();
  }
});

test("blocked and cancelled sends classify as needs_input and rejected without wedging", () => {
  // Blocked by the pre-send gate: the user must act; drain halts loudly.
  let blocked = reduceQueuedDrain(INITIAL_QUEUED_DRAIN_STATE, { type: "send_started", itemId: "item-1" });
  blocked = reduceQueuedDrain(blocked, { type: "send_result", itemId: "item-1", outcome: "blocked", at: t0 });
  expect(blocked.phase).toEqual({ kind: "halted", itemId: "item-1", reason: "needs_input" });
  expect(hasPendingQueuedAdmission(blocked)).toBe(false);
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
