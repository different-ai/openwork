import { beforeEach, describe, expect, test } from "bun:test";

import type { ComposerDraft } from "../src/app/types";
import {
  claimComposerSessionDraftScope,
  getComposerQueuedDrafts,
  useComposerStateStore,
} from "../src/react-app/domains/session/surface/composer-state-store";
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
