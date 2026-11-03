/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkbenchPaneStatus } from "../src/react-app/domains/session/chat/workbench-pane-status";
import { shouldHideAttachedSideChat, withSideChatActivity } from "../src/react-app/domains/session/sidebar/side-chat-status";

const group = (workspaceId: string, ids: string[], archived: string[] = []) => ({
  workspace: { id: workspaceId },
  sessions: ids.map((id) => ({ id, title: id, time: archived.includes(id) ? { archived: 1 } : {} })),
}) as Parameters<typeof withSideChatActivity>[2][number];
const key = (workspaceId: string, sessionId: string) => JSON.stringify([workspaceId, sessionId]);
const side = (workspaceId: string, sessionId: string) => ({ workspaceId, sessionId });

describe("side chat sidebar status", () => {
  test("an attached side chat's work shows on its idle main chat, across workspaces", () => {
    const groups = [group("a", ["main"]), group("b", ["side"])];
    expect(withSideChatActivity({ main: "idle", side: "responding" }, { [key("a", "main")]: side("b", "side") }, groups).main).toBe("thinking");
    expect(withSideChatActivity({ side: "thinking" }, { [key("a", "main")]: side("b", "side") }, groups).main).toBe("thinking");
  });

  test("the main chat keeps its own work, error or request", () => {
    const groups = [group("a", ["main", "side"])];
    const chats = { [key("a", "main")]: side("a", "side") };
    for (const own of ["responding", "error", "waiting"]) {
      expect(withSideChatActivity({ main: own, side: "thinking" }, chats, groups).main).toBe(own);
    }
  });

  test("finished, waiting, archived and stale side chats do not light the main chat", () => {
    const chats = { [key("a", "main")]: side("a", "side") };
    for (const status of ["idle", "waiting", "error"]) {
      expect(withSideChatActivity({ main: "idle", side: status }, chats, [group("a", ["main", "side"])]).main).toBe("idle");
    }
    expect(withSideChatActivity({ main: "idle", side: "thinking" }, chats, [group("a", ["main", "side"], ["side"])]).main).toBe("idle");
    expect(withSideChatActivity({ main: "idle", side: "thinking" }, chats, [group("a", ["main"])]).main).toBe("idle");
  });

  test("a side chat waiting on the person keeps a row the count can point to", () => {
    expect(shouldHideAttachedSideChat(true, false, "waiting")).toBe(false);
    expect(shouldHideAttachedSideChat(true, false, "thinking")).toBe(true);
    expect(shouldHideAttachedSideChat(true, true, "idle")).toBe(false);
  });

  test("the side pane title shows work or a request", () => {
    expect(renderToStaticMarkup(<WorkbenchPaneStatus status="responding" />)).toContain('data-workbench-pane-status="working"');
    const waiting = renderToStaticMarkup(<WorkbenchPaneStatus status="waiting" attentionLabel="Needs permission: Search" />);
    expect(waiting).toContain('data-workbench-pane-status="waiting"');
    expect(waiting).toContain("Needs permission: Search");
    expect(renderToStaticMarkup(<WorkbenchPaneStatus status="idle" />)).toContain('data-workbench-pane-status="idle"');
  });
});
