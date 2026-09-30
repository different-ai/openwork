import { beforeEach, describe, expect, test } from "bun:test";

import type { ComposerDraft } from "../src/app/types";
import {
  claimComposerSessionDraftScope,
  getComposerQueuedDrafts,
  useComposerStateStore,
} from "../src/react-app/domains/session/surface/composer-state-store";
import { claimQueuedSend, dispatchQueuedDrain, getQueuedDrainState, resetQueuedDrainForTests } from "../src/react-app/domains/session/surface/queued-drain-machine";
import { startQueuedDraftPersistence } from "../src/react-app/domains/session/sync/queued-draft-persistence";

function draft(text: string): ComposerDraft {
  return { mode: "prompt", parts: [{ type: "text", text }], attachments: [], text, resolvedText: text, command: undefined };
}

describe("queued draft persistence", () => {
  const writes: { scopeKey: string; queued: readonly string[] }[] = [];
  let stop = () => {};

  beforeEach(() => {
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {} });
    writes.length = 0;
    stop();
    stop = startQueuedDraftPersistence((scopeKey, queued) => {
      writes.push({ scopeKey, queued: [...queued] });
      return { status: "saved", snapshot: null };
    });
  });

  test("mirrors every queue mutation of a claimed conversation, in order, and only that conversation", () => {
    claimComposerSessionDraftScope("session-a", "local|ws|session-a");
    claimComposerSessionDraftScope("session-b", "local|ws|session-b");
    const store = useComposerStateStore.getState();

    store.appendQueuedDraft("session-a", draft("first [attachment shot.png] follow-up"));
    store.appendQueuedDraft("session-a", draft("second follow-up"));
    store.appendQueuedDraft("session-b", draft("other conversation"));
    expect(writes).toEqual([
      { scopeKey: "local|ws|session-a", queued: ["first  follow-up"] },
      { scopeKey: "local|ws|session-a", queued: ["first  follow-up", "second follow-up"] },
      { scopeKey: "local|ws|session-b", queued: ["other conversation"] },
    ]);

    // The background drain removes the head item without any surface mounted.
    const head = getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a")[0];
    if (!head) throw new Error("missing head item");
    store.removeQueuedDraft("session-a", head.id);
    expect(writes.at(-1)).toEqual({ scopeKey: "local|ws|session-a", queued: ["second follow-up"] });

    // A failed send re-queues it at the front; Stop clears the whole queue.
    store.prependQueuedDrafts("session-a", [head]);
    expect(writes.at(-1)).toEqual({ scopeKey: "local|ws|session-a", queued: ["first  follow-up", "second follow-up"] });
    store.clearQueuedDrafts("session-a");
    expect(writes.at(-1)).toEqual({ scopeKey: "local|ws|session-a", queued: [] });
    expect(writes.filter((write) => write.scopeKey === "local|ws|session-b")).toHaveLength(1);
  });

  test.each(["removed queued message", "composer message"])("promotes a queued follow-up after a failed %s without replaying it", (source) => {
    resetQueuedDrainForTests();
    const sessionId = `promotion-${source}`;
    claimComposerSessionDraftScope(sessionId, `local|ws|${sessionId}`);
    const store = useComposerStateStore.getState();
    store.appendQueuedDraft(sessionId, draft("Failed queued A"));
    store.appendQueuedDraft(sessionId, draft("Promote queued B"));
    const [first, selected] = getComposerQueuedDrafts(useComposerStateStore.getState(), sessionId);
    if (!first || !selected) throw new Error("Expected queued messages");
    const failedId = source === "composer message" ? "msg_failed_composer" : first.id;
    try {
      expect(claimQueuedSend(sessionId, failedId, true)).toBe(true);
      dispatchQueuedDrain(sessionId, { type: "send_error", itemId: failedId });
      if (source === "removed queued message") store.removeQueuedDraft(sessionId, first.id);
      expect(getQueuedDrainState(sessionId).phase).toMatchObject({ kind: "halted", itemId: failedId });
      const queuedBefore = getComposerQueuedDrafts(useComposerStateStore.getState(), sessionId);
      const writesBefore = writes.length;
      expect(claimQueuedSend(sessionId, selected.id)).toBe(false);
      expect(claimQueuedSend(sessionId, selected.id, true)).toBe(true);
      expect(claimQueuedSend(sessionId, selected.id, true)).toBe(false);
      expect(claimQueuedSend(sessionId, failedId, true)).toBe(false);
      expect(getQueuedDrainState(sessionId).phase).toEqual({ kind: "sending", itemId: selected.id, busySeen: false });
      expect(getComposerQueuedDrafts(useComposerStateStore.getState(), sessionId)).toBe(queuedBefore);
      expect(writes).toHaveLength(writesBefore);
      store.removeQueuedDraft(sessionId, selected.id);
      dispatchQueuedDrain(sessionId, { type: "send_result", itemId: selected.id, outcome: "sent", at: Date.now() });
      expect(getComposerQueuedDrafts(useComposerStateStore.getState(), sessionId).map((item) => item.id))
        .toEqual(source === "removed queued message" ? [] : [first.id]);
    } finally {
      resetQueuedDrainForTests();
    }
  });

  test("ignores composer edits and conversations whose draft scope is unknown", () => {
    const store = useComposerStateStore.getState();
    store.appendQueuedDraft("session-unclaimed", draft("nowhere to store"));
    store.setDraft("session-unclaimed", "typing");
    expect(writes).toEqual([]);

    claimComposerSessionDraftScope("session-c", "local|ws|session-c");
    store.appendQueuedDraft("session-c", draft("stored"));
    store.setDraft("session-c", "typing more");
    store.setAttachments("session-c", []);
    expect(writes).toEqual([{ scopeKey: "local|ws|session-c", queued: ["stored"] }]);
  });
});
