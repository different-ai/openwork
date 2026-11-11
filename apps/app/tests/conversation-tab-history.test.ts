import { describe, expect, test } from "bun:test";
import {
  canNavigateSelectedConversationHistory,
  createConversationTabHistory,
  navigateConversationTabHistory,
  removeConversationHistoryEntry,
  syncConversationTabHistory,
} from "../src/react-app/domains/session/chat/conversation-tab-history";

describe("conversation navigation history", () => {
  test("sidebar A → B → C traverses exactly one entry per selection", () => {
    let history = createConversationTabHistory("one", "a");
    history = syncConversationTabHistory(history, "one", "b");
    history = syncConversationTabHistory(history, "one", "c");
    expect(history.entries).toHaveLength(3);
    const back = navigateConversationTabHistory(history, "back");
    expect(back.entry?.sessionId).toBe("b");
    expect(canNavigateSelectedConversationHistory(back.history, "one", "b", "forward")).toBe(true);
    expect(navigateConversationTabHistory(back.history, "forward").entry?.sessionId).toBe("c");
  });

  test("cross-workspace links preserve the source and destination workspace", () => {
    const source = createConversationTabHistory("one", "a");
    const destination = syncConversationTabHistory(source, "two", "b");
    expect(destination.entries).toHaveLength(2);
    const back = navigateConversationTabHistory(destination, "back");
    expect(back.entry).toMatchObject({ workspaceId: "one", sessionId: "a" });
    expect(canNavigateSelectedConversationHistory(back.history, "one", "a", "forward")).toBe(true);
    expect(navigateConversationTabHistory(back.history, "forward").entry).toMatchObject({ workspaceId: "two", sessionId: "b" });
  });

  test("same-session clicks preserve the stack and the forward branch", () => {
    const initial = createConversationTabHistory("one", "a");
    expect(syncConversationTabHistory(initial, "one", "a")).toBe(initial);
    const visited = syncConversationTabHistory(initial, "one", "b");
    const back = navigateConversationTabHistory(visited, "back").history;
    expect(syncConversationTabHistory(back, "one", "a")).toBe(back);
    expect(canNavigateSelectedConversationHistory(back, "one", "a", "back")).toBe(false);
    expect(canNavigateSelectedConversationHistory(back, "one", "a", "forward")).toBe(true);
  });

  test("identical session ids in different workspaces are different visits", () => {
    const history = syncConversationTabHistory(createConversationTabHistory("one", "a"), "two", "a");
    expect(history.entries).toHaveLength(2);
    const back = navigateConversationTabHistory(history, "back");
    expect(back.history.workspaceId).toBe("one");
    expect(back.entry).toMatchObject({ workspaceId: "one", sessionId: "a" });
    expect(canNavigateSelectedConversationHistory(back.history, "two", "a", "forward")).toBe(false);
  });

  test("back and forward preserve each visit's side chat and stop at both ends", () => {
    const source = createConversationTabHistory("one", "a", "side-a");
    expect(navigateConversationTabHistory(source, "back")).toEqual({ history: source, entry: null });
    const destination = syncConversationTabHistory(source, "two", "b", "side-b");
    const back = navigateConversationTabHistory(destination, "back");
    expect(back.entry).toEqual({ workspaceId: "one", sessionId: "a", splitSessionId: "side-a" });
    expect(syncConversationTabHistory(back.history, "one", "a", "side-a")).toBe(back.history);
    const forward = navigateConversationTabHistory(back.history, "forward");
    expect(forward.entry).toEqual({ workspaceId: "two", sessionId: "b", splitSessionId: "side-b" });
    expect(navigateConversationTabHistory(forward.history, "forward")).toEqual({ history: forward.history, entry: null });
  });

  test("removing old visits preserves the current workspace and repeated visit cursor", () => {
    let history = createConversationTabHistory("one", "a");
    history = syncConversationTabHistory(history, "two", "b");
    history = syncConversationTabHistory(history, "one", "a");
    history = syncConversationTabHistory(history, "three", "c");
    history = removeConversationHistoryEntry(history, "one", "a");
    expect(history.entries.map(entry => entry.sessionId)).toEqual(["b", "c"]);
    expect(history.index).toBe(1);
    expect(canNavigateSelectedConversationHistory(history, "three", "c", "back")).toBe(true);
    expect(navigateConversationTabHistory(history, "back").entry).toMatchObject({ workspaceId: "two", sessionId: "b" });
  });

  test("removal is scoped to workspace identity and collapses adjacent duplicates", () => {
    let history = createConversationTabHistory("one", "a", "side");
    history = syncConversationTabHistory(history, "two", "a");
    history = syncConversationTabHistory(history, "one", "a", "side");
    history = removeConversationHistoryEntry(history, "two", "a");
    expect(history.entries).toEqual([{ workspaceId: "one", sessionId: "a", splitSessionId: "side" }]);
    expect(history.index).toBe(0);
    expect(history.workspaceId).toBe("one");
    expect(removeConversationHistoryEntry(history, "missing", "a")).toBe(history);
  });

  test("a new selection after back drops only the forward branch", () => {
    let history = syncConversationTabHistory(createConversationTabHistory("one", "a"), "two", "b");
    history = navigateConversationTabHistory(history, "back").history;
    history = syncConversationTabHistory(history, "three", "c");
    expect(history.entries.map(entry => entry.sessionId)).toEqual(["a", "c"]);
    expect(canNavigateSelectedConversationHistory(history, "three", "c", "forward")).toBe(false);
  });
});
