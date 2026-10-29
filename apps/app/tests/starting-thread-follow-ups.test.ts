import { beforeEach, expect, test } from "bun:test";
import type { ComposerDraft } from "../src/app/types";
import { resolveComposerSubmit } from "../src/react-app/domains/session/surface/composer/composer-submit";
import {
  getComposerQueuedDrafts,
  getNextComposerQueuedDraft,
  useComposerStateStore,
} from "../src/react-app/domains/session/surface/composer-state-store";
import {
  consumeComposerAutoSend,
  hasPendingComposerAutoSend,
  markComposerAutoSend,
  subscribeComposerAutoSend,
} from "../src/react-app/domains/session/surface/composer-auto-send";
import { canAdmitNextQueuedItem, INITIAL_QUEUED_DRAIN_STATE, type QueuedDrainState } from "../src/react-app/domains/session/surface/queued-drain-machine";

const SESSION = "ses_starting";
const OWNER = "owner_current";

const draft = (text: string): ComposerDraft => ({ mode: "prompt", parts: [{ type: "text", text }], attachments: [], text });
const texts = () => getComposerQueuedDrafts(useComposerStateStore.getState(), SESSION).map((item) => item.draft.text);
const next = (owner = OWNER, generation = 0) => getNextComposerQueuedDraft(useComposerStateStore.getState(), SESSION, owner, generation)?.draft.text;

beforeEach(() => useComposerStateStore.getState().clearQueuedDrafts(SESSION));

test("Enter and Cmd+Enter while a thread is starting keep the follow-up instead of dropping it", () => {
  const starting = { hasContent: true, disabled: false, busy: true, editing: false, stopping: false, submissionPreparing: true };
  expect(resolveComposerSubmit({ ...starting, steer: false })).toBe("queue");
  expect(resolveComposerSubmit({ ...starting, steer: true })).toBe("steer");

  // A fresh send with nothing running still waits for preparation, as does Enter after Stop.
  expect(resolveComposerSubmit({ ...starting, busy: false, steer: false })).toBeNull();
  expect(resolveComposerSubmit({ ...starting, stopping: true, steer: false })).toBeNull();
  expect(resolveComposerSubmit({ ...starting, stopping: true, submissionPreparing: false, steer: false })).toBe("send");
  expect(resolveComposerSubmit({ ...starting, busy: false, submissionPreparing: false, steer: false })).toBe("send");
  expect(resolveComposerSubmit({ ...starting, disabled: true, steer: false })).toBeNull();
  expect(resolveComposerSubmit({ ...starting, hasContent: false, steer: true })).toBeNull();
});

test("Send now requests go out once each, in click order, ahead of plain queued rows", () => {
  const store = useComposerStateStore.getState();
  store.appendQueuedDraft(SESSION, draft("first"));
  store.appendQueuedDraft(SESSION, draft("second"));
  store.appendQueuedDraft(SESSION, draft("third"));
  const [first, , third] = getComposerQueuedDrafts(useComposerStateStore.getState(), SESSION);
  const steer = { owner: OWNER, generation: 0, agent: null };
  store.requestQueuedDraftSend(SESSION, third.id, steer);
  store.requestQueuedDraftSend(SESSION, first.id, steer);
  // A repeat click keeps the original place in line.
  store.requestQueuedDraftSend(SESSION, third.id, steer);

  expect(next()).toBe("third");
  store.removeQueuedDraft(SESSION, third.id);
  expect(next()).toBe("first");
  store.removeQueuedDraft(SESSION, first.id);
  expect(next()).toBe("second");
  expect(texts()).toEqual(["second"]);
});

test("a steer from another owner or queue generation is never sent for this one", () => {
  const store = useComposerStateStore.getState();
  store.appendQueuedDraft(SESSION, draft("theirs"), { owner: "owner_previous", generation: 0, agent: null });
  store.appendQueuedDraft(SESSION, draft("stale"), { owner: OWNER, generation: 0, agent: null });
  store.appendQueuedDraft(SESSION, draft("plain"));

  expect(next(OWNER, 1)).toBe("plain");
  expect(next(OWNER, 0)).toBe("stale");
  expect(next("owner_previous", 0)).toBe("theirs");
});

test("a steer is admitted once the first turn is admitted, never during an uncertain admission", () => {
  const at = (phase: QueuedDrainState["phase"], lastResolution: QueuedDrainState["lastResolution"] = null): QueuedDrainState =>
    ({ ...INITIAL_QUEUED_DRAIN_STATE, phase, lastResolution });

  expect(canAdmitNextQueuedItem(at({ kind: "ready" }), true)).toBe(true);
  expect(canAdmitNextQueuedItem(at({ kind: "running", itemId: "q1" }), true)).toBe(true);
  expect(canAdmitNextQueuedItem(at({ kind: "awaiting_observation", itemId: "q1", admittedAt: 1 }), true)).toBe(true);
  expect(canAdmitNextQueuedItem(at({ kind: "sending", itemId: "q1", busySeen: false }), true)).toBe(false);
  expect(canAdmitNextQueuedItem(at({ kind: "admission_unknown", itemId: "q1", messageID: "msg_1", at: 1 }), true)).toBe(false);
  expect(canAdmitNextQueuedItem(at({ kind: "halted", itemId: "q1", reason: "needs_input" }), true)).toBe(false);

  // After a blocked, cancelled or stopped send the queue is ready again; a requested
  // send must not wait for a completion that will never come (and hold rows behind it).
  for (const resolution of ["needs_input", "rejected", "terminal_failure", "admitted_running"] as const) {
    expect(canAdmitNextQueuedItem(at({ kind: "ready" }, { itemId: "q1", resolution }), true)).toBe(true);
  }

  // Plain queued rows still wait for an idle, ready queue.
  expect(canAdmitNextQueuedItem(at({ kind: "running", itemId: "q1" }))).toBe(false);
  expect(canAdmitNextQueuedItem(at({ kind: "ready" }))).toBe(true);
});

test("the sidebar hears when a new thread's first message starts and stops waiting to send", () => {
  let notified = 0;
  const unsubscribe = subscribeComposerAutoSend(SESSION, () => { notified += 1; });
  expect(hasPendingComposerAutoSend(SESSION)).toBe(false);

  markComposerAutoSend(SESSION);
  expect(hasPendingComposerAutoSend(SESSION)).toBe(true);
  expect(consumeComposerAutoSend(SESSION)).toBe(true);
  expect(hasPendingComposerAutoSend(SESSION)).toBe(false);
  // Nothing left to consume, so nobody is told the state changed.
  expect(consumeComposerAutoSend(SESSION)).toBe(false);
  expect(notified).toBe(2);

  unsubscribe();
  markComposerAutoSend(SESSION);
  expect(notified).toBe(2);
  consumeComposerAutoSend(SESSION);
});
