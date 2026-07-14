import { describe, expect, test } from "bun:test";

import {
  canNavigateConversationHistory,
  createConversationTabHistory,
  navigateConversationTabHistory,
  removeConversationHistoryEntry,
  syncConversationTabHistory,
} from "../src/react-app/domains/session/chat/conversation-tab-history";

describe("conversation tab history", () => {
  test("records visits without duplicate adjacent entries", () => {
    let history = createConversationTabHistory("workspace-a", "session-a");
    history = syncConversationTabHistory(history, "workspace-a", "session-a");
    history = syncConversationTabHistory(history, "workspace-a", "session-b");
    history = syncConversationTabHistory(history, "workspace-a", "session-b");

    expect(history.entries).toEqual(["session-a", "session-b"]);
    expect(history.index).toBe(1);
  });

  test("navigates back and forward without wrapping", () => {
    let history = createConversationTabHistory("workspace-a", "session-a");
    history = syncConversationTabHistory(history, "workspace-a", "session-b");
    history = syncConversationTabHistory(history, "workspace-a", "session-c");

    expect(canNavigateConversationHistory(history, "back")).toBe(true);
    expect(canNavigateConversationHistory(history, "forward")).toBe(false);

    const back = navigateConversationTabHistory(history, "back");
    expect(back.sessionId).toBe("session-b");
    expect(back.history.index).toBe(1);

    const secondBack = navigateConversationTabHistory(back.history, "back");
    expect(secondBack.sessionId).toBe("session-a");
    expect(canNavigateConversationHistory(secondBack.history, "back")).toBe(false);

    const noWrapBack = navigateConversationTabHistory(secondBack.history, "back");
    expect(noWrapBack.sessionId).toBeNull();
    expect(noWrapBack.history).toBe(secondBack.history);

    const forward = navigateConversationTabHistory(secondBack.history, "forward");
    expect(forward.sessionId).toBe("session-b");
  });

  test("clears the forward branch after a new selection", () => {
    let history = createConversationTabHistory("workspace-a", "session-a");
    history = syncConversationTabHistory(history, "workspace-a", "session-b");
    history = syncConversationTabHistory(history, "workspace-a", "session-c");

    const back = navigateConversationTabHistory(history, "back");
    const branched = syncConversationTabHistory(back.history, "workspace-a", "session-d");

    expect(branched.entries).toEqual(["session-a", "session-b", "session-d"]);
    expect(branched.index).toBe(2);
    expect(canNavigateConversationHistory(branched, "forward")).toBe(false);
  });

  test("resets when the workspace changes", () => {
    let history = createConversationTabHistory("workspace-a", "session-a");
    history = syncConversationTabHistory(history, "workspace-a", "session-b");

    const reset = syncConversationTabHistory(history, "workspace-b", "session-c");

    expect(reset.workspaceId).toBe("workspace-b");
    expect(reset.entries).toEqual(["session-c"]);
    expect(reset.index).toBe(0);
  });

  test("removes an inactive closed entry without moving the current session", () => {
    let history = createConversationTabHistory("workspace-a", "session-a");
    history = syncConversationTabHistory(history, "workspace-a", "session-b");
    history = syncConversationTabHistory(history, "workspace-a", "session-c");

    const closed = removeConversationHistoryEntry(history, "workspace-a", "session-b");

    expect(closed.entries).toEqual(["session-a", "session-c"]);
    expect(closed.index).toBe(1);
    expect(navigateConversationTabHistory(closed, "back").sessionId).toBe("session-a");
  });

  test("removes an active closed entry and lands on the nearest remaining history", () => {
    let history = createConversationTabHistory("workspace-a", "session-a");
    history = syncConversationTabHistory(history, "workspace-a", "session-b");
    history = syncConversationTabHistory(history, "workspace-a", "session-c");
    history = navigateConversationTabHistory(history, "back").history;

    const closed = removeConversationHistoryEntry(history, "workspace-a", "session-b");

    expect(closed.entries).toEqual(["session-a", "session-c"]);
    expect(closed.index).toBe(0);
    expect(canNavigateConversationHistory(closed, "back")).toBe(false);
    expect(navigateConversationTabHistory(closed, "forward").sessionId).toBe("session-c");
  });
});
