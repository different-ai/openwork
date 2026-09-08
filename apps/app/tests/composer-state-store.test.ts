import { beforeEach, describe, expect, test } from "bun:test";

import type { ComposerAttachment, ComposerDraft } from "../src/app/types";
import {
  consumeComposerAutoSend,
  consumeComposerAutoSendPayload,
  getComposerAutoSendPayload,
  hasComposerAutoSend,
  markComposerAutoSend,
} from "../src/react-app/domains/session/surface/composer-auto-send";
import {
  composerDraftNeedsHydration,
  getComposerQueuedDrafts,
  getComposerRevertMessageId,
  type ComposerSessionState,
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
    const messageIDs = items.map((item) => item.draft.messageId);
    expect(new Set(messageIDs).size).toBe(3);
    for (const messageID of messageIDs) expect(messageID).toMatch(/^msg_[0-9a-f]{26}$/);
    reorderQueuedDrafts("session-a", [ids[2] ?? "", ids[0] ?? "", ids[1] ?? ""]);
    expect(queuedTexts("session-a")).toEqual(["third", "first", "second"]);

    const secondId = getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a")[1]?.id;
    expect(secondId).toBeTruthy();
    updateQueuedDraft("session-a", secondId ?? "", draft("first edited"));
    expect(queuedTexts("session-a")).toEqual(["third", "first edited", "second"]);
    const reordered = getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a");
    expect(reordered.map((item) => item.draft.messageId)).toEqual([messageIDs[2], messageIDs[0], messageIDs[1]]);
    const first = reordered[0]!;
    useComposerStateStore.getState().removeQueuedDraft("session-a", first.id);
    useComposerStateStore.getState().prependQueuedDrafts("session-a", [first]);
    expect(getComposerQueuedDrafts(useComposerStateStore.getState(), "session-a")[0]?.draft.messageId).toBe(first.draft.messageId);
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

  test("keeps auto-send payloads immutable and scoped while preserving legacy marks", () => {
    const file = new File(["image"], "submitted.png", { type: "image/png" });
    const attachment: ComposerAttachment = {
      id: "attachment-a",
      name: "submitted.png",
      mimeType: "image/png",
      size: file.size,
      kind: "image",
      file,
      previewUrl: "blob:submitted-preview",
    };
    const submitted: ComposerSessionState = {
      draft: "submitted",
      attachments: [attachment],
      mentions: { source: "file" },
      pasteParts: [{ id: "paste-a", label: "A", text: "submitted paste", lines: 1 }],
      revertMessageId: null,
    };
    markComposerAutoSend("scoped-session", { scopeKey: "owner-a", composer: submitted });
    submitted.draft = "mutated after mark";
    submitted.mentions.source = "app";
    const submittedPaste = submitted.pasteParts[0];
    if (!submittedPaste) throw new Error("Expected submitted paste metadata");
    submittedPaste.text = "mutated paste";
    attachment.name = "mutated.png";
    attachment.previewUrl = "blob:mutated-preview";

    expect(hasComposerAutoSend("scoped-session", "owner-b")).toBe(false);
    expect(getComposerAutoSendPayload("scoped-session", "owner-b")).toBeNull();
    expect(consumeComposerAutoSend("scoped-session", "owner-b")).toBe(false);
    const capturedAttachment = getComposerAutoSendPayload("scoped-session", "owner-a")?.composer.attachments[0];
    expect(capturedAttachment?.name).toBe("submitted.png");
    expect(capturedAttachment?.previewUrl).toBe("blob:submitted-preview");
    expect(capturedAttachment?.file).toBe(file);
    expect(capturedAttachment).not.toBe(attachment);
    expect(getComposerAutoSendPayload("scoped-session", "owner-a")?.composer.mentions.source).toBe("file");
    expect(getComposerAutoSendPayload("scoped-session", "owner-a")?.composer.pasteParts[0]?.text).toBe("submitted paste");
    markComposerAutoSend("scoped-session", {
      scopeKey: "owner-b",
      composer: { ...submitted, draft: "submitted by B" },
    });
    expect(hasComposerAutoSend("scoped-session")).toBe(false);
    expect(consumeComposerAutoSend("scoped-session")).toBe(false);
    expect(getComposerAutoSendPayload("scoped-session", "owner-a")?.composer.draft).toBe("submitted");
    expect(getComposerAutoSendPayload("scoped-session", "owner-b")?.composer.draft).toBe("submitted by B");

    markComposerAutoSend("scoped-session");
    expect(hasComposerAutoSend("scoped-session")).toBe(true);
    expect(getComposerAutoSendPayload("scoped-session", "owner-a")?.composer.draft).toBe("submitted");
    expect(getComposerAutoSendPayload("scoped-session", "owner-b")?.composer.draft).toBe("submitted by B");
    expect(consumeComposerAutoSend("scoped-session")).toBe(true);
    expect(hasComposerAutoSend("scoped-session")).toBe(false);
    expect(consumeComposerAutoSendPayload("scoped-session", "owner-a")?.composer.draft).toBe("submitted");
    expect(getComposerAutoSendPayload("scoped-session", "owner-b")?.composer.draft).toBe("submitted by B");
    expect(consumeComposerAutoSendPayload("scoped-session", "owner-b")?.composer.draft).toBe("submitted by B");
    expect(hasComposerAutoSend("scoped-session")).toBe(false);
  });
});
