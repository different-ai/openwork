/** @jsxImportSource react */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { MenuAction } from "../src/components/ui/action-menu-model";
import type { WorkbenchSnapshot } from "../src/react-app/domains/session/chat/workbench-store";
import type { SessionSettleState } from "../src/react-app/domains/session/sidebar/session-settle";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });
const { buildSessionMenuActions, buildSessionGroupActions, captureSessionActionTarget } = await import("../src/react-app/domains/session/sidebar/session-menu-actions");
const { sessionMenuActionsToPalette, sessionGroupActionsToPalette } = await import("../src/react-app/shell/command-palette-session-actions");
const { dispatchMenuAction, serializeMenuActions } = await import("../src/components/ui/action-menu-model");
const { requestSessionDialog, sessionDialogRequestFromEvent, OPEN_SESSION_ACTION_EVENT } = await import("../src/react-app/shell/session-actions-bus");
const { buildCommandPaletteSplitSessions } = await import("../src/react-app/shell/command-palette-sessions");
const { setWorkbenchSplit } = await import("../src/react-app/domains/session/chat/workbench-store");

function actions(overrides: Partial<Parameters<typeof buildSessionMenuActions>[0]> = {}) {
  return buildSessionMenuActions({
    isPinned: false, isArchived: false,
    settle: { available: true, settled: false, canSettle: true, toggle: () => {} },
    groups: [{ id: "review", label: "Review" }], assignedGroupId: null,
    onAssignGroup: () => {}, onTogglePin: () => {}, onRename: () => {}, onArchive: () => {}, onDelete: () => {},
    onCreateGroup: () => {}, ...overrides,
  });
}

function item(items: readonly MenuAction[], id: string) {
  const found = items.find((entry) => entry.type === "item" && entry.id === id);
  if (!found || found.type !== "item") throw new Error(`Missing action ${id}`);
  return found;
}

describe("human session actions share one menu/palette definition", () => {
  test.each([false, true])("active/archived parity (archived=%s), including unchanged pin availability", (isArchived) => {
    const menu = actions({ isArchived, isPinned: true });
    const palette = sessionMenuActionsToPalette(menu, "Main conversation", () => {});
    expect(palette.map((entry) => entry.id)).toEqual([
      "session.pin.toggle", ...(!isArchived ? ["session.settle.toggle"] : []), "session.rename", "session.archive", "session.delete",
    ]);
    for (const [menuId, paletteId] of [["pin", "session.pin.toggle"], ["rename", "session.rename"], ["archive", "session.archive"], ["delete", "session.delete"]]) {
      expect(palette.find((entry) => entry.id === paletteId)?.title).toBe(item(menu, menuId).label);
    }
    expect(item(menu, "archive").label).toBe(isArchived ? "Unarchive session" : "Archive session");
    expect(item(menu, "pin").label).toBe("Unpin session");
    expect(item(menu, "delete").variant).toBe("destructive");
    expect(palette.every((entry) => entry.detail?.includes("Main conversation"))).toBe(true);
  });

  test("busy Settle remains discoverable with the same reason and cannot dispatch from either adapter", async () => {
    const toggle = mock(() => {});
    const close = mock(() => {});
    const menu = actions({ settle: { available: true, settled: false, canSettle: false, toggle } });
    const palette = sessionMenuActionsToPalette(menu, "Busy main", close);
    const settle = palette.find((entry) => entry.id === "session.settle.toggle");
    expect(settle?.disabled).toBe(true);
    expect(settle?.detail).toContain(item(menu, "settle").disabledReason);
    expect(settle?.detail).toContain("after it finishes");
    expect(serializeMenuActions(menu).find((entry) => entry.type === "item" && entry.id === "settle")).toMatchObject({ enabled: false });
    expect(await dispatchMenuAction(menu, "settle")).toBe(false);
    settle?.action();
    expect(toggle).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  test("unsupported/flag-off/child Settle stays hidden, but Unsettle remains enabled", () => {
    const unavailable: SessionSettleState = { available: false, settled: false, canSettle: false, toggle: () => {} };
    expect(sessionMenuActionsToPalette(actions({ settle: unavailable }), "Main", () => {}).some((entry) => entry.id === "session.settle.toggle")).toBe(false);
    const menu = actions({ settle: { ...unavailable, available: true, settled: true } });
    expect(item(menu, "settle").disabled).toBe(false);
    expect(item(menu, "settle").label).toBe("Un-settle session");
  });

  test("Delete dispatch is a named dialog intent after palette close, not a deletion", () => {
    const events: string[] = [];
    const target = { workspaceId: "owner", sessionId: "main", title: "Captured main" };
    const menu = actions({ onDelete: () => requestSessionDialog({ action: "delete", target }) });
    const listener = (event: Event) => {
      events.push("dialog");
      expect(sessionDialogRequestFromEvent(event)).toEqual({ action: "delete", target });
    };
    window.addEventListener(OPEN_SESSION_ACTION_EVENT, listener);
    try {
      const palette = sessionMenuActionsToPalette(menu, target.title, () => events.push("close"));
      palette.find((entry) => entry.id === "session.delete")?.action();
      expect(events).toEqual(["close", "dialog"]);
    } finally { window.removeEventListener(OPEN_SESSION_ACTION_EVENT, listener); }
  });

  test("Archive and Restore dispatch exactly the supplied safeguard, never a new primitive", () => {
    const archive = mock(() => {});
    const menu = actions({ onArchive: archive });
    sessionMenuActionsToPalette(menu, "Main", () => {}).find((entry) => entry.id === "session.archive")?.action();
    expect(archive).toHaveBeenCalledTimes(1);
  });
});

describe("group destinations", () => {
  test("zero groups still has disabled No group and enabled create-only New group", () => {
    const assign = mock((_id: string | null) => {});
    const create = mock(() => {});
    const palette = sessionGroupActionsToPalette(buildSessionGroupActions({ groups: [], assignedGroupId: null, onAssignGroup: assign, onCreateGroup: create }), () => {});
    expect(palette.map((entry) => [entry.title, Boolean(entry.disabled)])).toEqual([["No group", true], ["New group...", false]]);
    palette[0]?.action();
    palette[1]?.action();
    expect(assign).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("current group is disabled; No group passes null and other groups keep their ids", async () => {
    const assign = mock((_id: string | null) => {});
    const menu = buildSessionGroupActions({ groups: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }], assignedGroupId: "a", onAssignGroup: assign });
    const palette = sessionGroupActionsToPalette(menu, () => {});
    expect(await dispatchMenuAction(menu, "group:a")).toBe(false);
    palette.find((entry) => entry.id === "group:a")?.action();
    expect(assign).not.toHaveBeenCalled();
    palette.find((entry) => entry.id === "group:none")?.action();
    palette.find((entry) => entry.id === "group:b")?.action();
    expect(assign.mock.calls).toEqual([[null], ["b"]]);
  });
});

describe("captured session identity and workbench scope", () => {
  test("same ids in different owners never fall back to the selected workspace; titles are snapshots", () => {
    const groups = [
      { workspace: { id: "other" }, sessions: [{ id: "same", title: "Other conversation" }] },
      { workspace: { id: "owner" }, sessions: [{ id: "same", title: "Main conversation" }] },
    ];
    const target = captureSessionActionTarget(groups, "same", "owner");
    expect(target).toEqual({ workspaceId: "owner", sessionId: "same", title: "Main conversation" });
    groups[1]!.sessions[0]!.title = "Changed later";
    expect(target?.title).toBe("Main conversation");
    expect(captureSessionActionTarget(groups, "same", "missing")).toBeNull();
    expect(captureSessionActionTarget(groups, "missing", "owner")).toBeNull();
  });

  test("dialog bridge rejects missing owners and malformed targets; creation captures only its owner", () => {
    const event = (detail: unknown) => new CustomEvent(OPEN_SESSION_ACTION_EVENT, { detail });
    expect(sessionDialogRequestFromEvent(event({ action: "delete", target: { sessionId: "main", title: "Main" } }))).toBeNull();
    expect(sessionDialogRequestFromEvent(event({ action: "delete", target: { workspaceId: "", sessionId: "main", title: "Main" } }))).toBeNull();
    expect(sessionDialogRequestFromEvent(event({ action: "create-group", workspaceId: "owner" }))).toEqual({ action: "create-group", workspaceId: "owner" });
    expect(sessionDialogRequestFromEvent(new Event(OPEN_SESSION_ACTION_EVENT))).toBeNull();
  });

  test("split candidates exclude both visible owners/ids, not identically named ids in a third workspace", () => {
    const sessions = ["main", "side", "third"].map((workspaceId) => ({ workspaceId, sessionId: "same", title: workspaceId, workspaceTitle: workspaceId, updatedAt: 1, searchText: workspaceId, isActive: false }));
    expect(buildCommandPaletteSplitSessions(sessions, { workspaceId: "main", sessionId: "same" }, { workspaceId: "side", sessionId: "same" }).map((entry) => entry.workspaceId)).toEqual(["third"]);
    expect(buildCommandPaletteSplitSessions(sessions, null)).toEqual([]);
  });

  test("closing a saved or unsent side chat keeps every conversation/tab and returns focus to main", () => {
    const main = { workspaceId: "owner", sessionId: "main", title: "Main" };
    for (const side of [
      { workspaceId: "other", sessionId: "side", title: "Side" },
      { workspaceId: "other", sessionId: "draft", draftDestination: { workspaceId: "other" } },
    ]) {
      const state: WorkbenchSnapshot = { revision: 1, primary: main, secondary: side, tabs: [main, side], focusedPane: "secondary", sideChats: { '["owner","main"]': side } };
      const closed = setWorkbenchSplit(state, null);
      expect(closed.primary).toBe(main);
      expect(closed.secondary).toBeNull();
      expect(closed.tabs).toBe(state.tabs);
      expect(closed.focusedPane).toBe("primary");
      expect(state.secondary).toBe(side);
    }
  });
});
