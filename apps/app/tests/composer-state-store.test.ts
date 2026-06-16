import { beforeEach, describe, expect, test } from "bun:test";

import type { ComposerDraft } from "../src/app/types";
import {
  getComposerQueuedDrafts,
  useComposerStateStore,
} from "../src/react-app/domains/session/surface/composer-state-store";

function reset() {
  useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, history: {} });
}

function draft(text: string): ComposerDraft {
  return {
    mode: "prompt",
    parts: [{ type: "text", text }],
    attachments: [],
    text,
    resolvedText: text,
    command: undefined,
  };
}

describe("composer state store", () => {
  beforeEach(reset);

  test("scopes queued drafts by session", () => {
    const { appendQueuedDraft } = useComposerStateStore.getState();
    appendQueuedDraft("session-a", draft("queued in A"));
    appendQueuedDraft("session-b", draft("queued in B"));

    const state = useComposerStateStore.getState();
    expect(getComposerQueuedDrafts(state, "session-a").map((item) => item.text)).toEqual(["queued in A"]);
    expect(getComposerQueuedDrafts(state, "session-b").map((item) => item.text)).toEqual(["queued in B"]);
  });

  test("clearing composer input does not clear queued drafts", () => {
    const { appendQueuedDraft, clearSession, setDraft } = useComposerStateStore.getState();
    setDraft("session-a", "in-progress draft");
    appendQueuedDraft("session-a", draft("queued follow-up"));

    clearSession("session-a");

    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a").map((item) => item.text)).toEqual([
      "queued follow-up",
    ]);
  });

  test("remove and clear only affect the target session", () => {
    const { appendQueuedDraft, clearQueuedDrafts, removeQueuedDraft } = useComposerStateStore.getState();
    appendQueuedDraft("session-a", draft("first A"));
    appendQueuedDraft("session-a", draft("second A"));
    appendQueuedDraft("session-b", draft("only B"));

    removeQueuedDraft("session-a", 0);
    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a").map((item) => item.text)).toEqual([
      "second A",
    ]);
    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-b").map((item) => item.text)).toEqual([
      "only B",
    ]);

    clearQueuedDrafts("session-a");
    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a")).toEqual([]);
    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-b").map((item) => item.text)).toEqual([
      "only B",
    ]);
  });
});
