import { beforeEach, describe, expect, test } from "bun:test";

import type { ComposerDraft } from "../src/app/types";
import {
  composerDraftNeedsHydration,
  getComposerQueuedDrafts,
  getComposerRevertMessageId,
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

function queuedTexts(sessionId: string) {
  return getComposerQueuedDrafts(useComposerStateStore.getState(), sessionId).map((item) => item.draft.text);
}

describe("composer state store", () => {
  beforeEach(reset);

  test("scopes queued drafts by session", () => {
    const { appendQueuedDraft } = useComposerStateStore.getState();
    appendQueuedDraft("session-a", draft("queued in A"));
    appendQueuedDraft("session-b", draft("queued in B"));

    expect(queuedTexts("session-a")).toEqual(["queued in A"]);
    expect(queuedTexts("session-b")).toEqual(["queued in B"]);
  });

  test("clearing composer input does not clear queued drafts", () => {
    const { appendQueuedDraft, clearSession, setDraft } = useComposerStateStore.getState();
    setDraft("session-a", "in-progress draft");
    appendQueuedDraft("session-a", draft("queued follow-up"));

    clearSession("session-a");

    expect(queuedTexts("session-a")).toEqual(["queued follow-up"]);
  });

  test("remove and clear only affect the target session", () => {
    const { appendQueuedDraft, clearQueuedDrafts, removeQueuedDraft } = useComposerStateStore.getState();
    appendQueuedDraft("session-a", draft("first A"));
    appendQueuedDraft("session-a", draft("second A"));
    appendQueuedDraft("session-b", draft("only B"));

    const firstId = getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a")[0]?.id;
    expect(firstId).toBeTruthy();
    removeQueuedDraft("session-a", firstId ?? "");
    expect(queuedTexts("session-a")).toEqual(["second A"]);
    expect(queuedTexts("session-b")).toEqual(["only B"]);

    clearQueuedDrafts("session-a");
    expect(queuedTexts("session-a")).toEqual([]);
    expect(queuedTexts("session-b")).toEqual(["only B"]);
  });

  test("reorders queued drafts and updates their text", () => {
    const { appendQueuedDraft, reorderQueuedDrafts, updateQueuedDraft } = useComposerStateStore.getState();
    appendQueuedDraft("session-a", draft("first"));
    appendQueuedDraft("session-a", draft("second"));
    appendQueuedDraft("session-a", draft("third"));

    const items = getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a");
    const ids = items.map((item) => item.id);
    reorderQueuedDrafts("session-a", [ids[2] ?? "", ids[0] ?? "", ids[1] ?? ""]);
    expect(queuedTexts("session-a")).toEqual(["third", "first", "second"]);

    const secondId = getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a")[1]?.id;
    expect(secondId).toBeTruthy();
    updateQueuedDraft("session-a", secondId ?? "", draft("first edited"));
    expect(queuedTexts("session-a")).toEqual(["third", "first edited", "second"]);
  });

  test("carries an edit boundary until clear, replacement, or session switch", () => {
    const { clearRevertTarget, replaceDraft, setDraft } = useComposerStateStore.getState();
    replaceDraft("session-a", "original prompt", "message-a");

    expect(getComposerRevertMessageId(useComposerStateStore.getState(), "session-a")).toBe("message-a");
    setDraft("session-a", "edited prompt");
    expect(getComposerRevertMessageId(useComposerStateStore.getState(), "session-a")).toBe("message-a");

    setDraft("session-a", "");
    expect(getComposerRevertMessageId(useComposerStateStore.getState(), "session-a")).toBeNull();

    replaceDraft("session-a", "original prompt", "message-a");
    replaceDraft("session-a", "normal replacement");
    expect(getComposerRevertMessageId(useComposerStateStore.getState(), "session-a")).toBeNull();

    replaceDraft("session-a", "original prompt", "message-a");
    clearRevertTarget("session-a");
    expect(getComposerRevertMessageId(useComposerStateStore.getState(), "session-a")).toBeNull();
    expect(useComposerStateStore.getState().sessions["session-a"]?.draft).toBe("original prompt");
  });

  test("retains live attachment state only inside the same claimed draft scope", () => {
    const currentText = "Review this[attachment att-private]";
    const storedText = "Review this";

    expect(composerDraftNeedsHydration({
      claimedScopeKey: "alice-org-a|workspace|session",
      nextScopeKey: "alice-org-a|workspace|session",
      currentText,
      storedText,
    })).toBe(false);
    expect(composerDraftNeedsHydration({
      claimedScopeKey: "alice-org-a|workspace|session",
      nextScopeKey: "bob-org-a|workspace|session",
      currentText,
      storedText,
    })).toBe(true);
    expect(composerDraftNeedsHydration({
      claimedScopeKey: "alice-org-a|workspace|session",
      nextScopeKey: "alice-org-b|workspace|session",
      currentText: storedText,
      storedText,
    })).toBe(true);
  });
});
