/** @jsxImportSource react */
import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type { MenuAction } from "../src/components/ui/action-menu-model";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });
const { applySessionSelectionClick, EMPTY_SESSION_SELECTION, visibleSessionRowOrder } = await import("../src/react-app/domains/session/sidebar/session-selection-store");
const { buildSelectedSessionsMenuActions } = await import("../src/react-app/domains/session/sidebar/session-menu-actions");

const row = (sessionId: string, workspaceId = "w1") => ({ workspaceId, sessionId });
const order = ["a", "b", "c", "d", "e"].map((id) => row(id));
const ids = (state: { selected: { sessionId: string }[] }) => state.selected.map((ref) => ref.sessionId);

describe("sidebar row selection", () => {
  test("Cmd/Ctrl-click starts from the open session, then toggles rows in and out", () => {
    let state = applySessionSelectionClick(EMPTY_SESSION_SELECTION, { target: row("c"), mode: "toggle", order, open: row("a") });
    expect(ids(state)).toEqual(["a", "c"]);
    state = applySessionSelectionClick(state, { target: row("e"), mode: "toggle", order, open: row("a") });
    expect(ids(state)).toEqual(["a", "c", "e"]);
    state = applySessionSelectionClick(state, { target: row("a"), mode: "toggle", order, open: row("a") });
    expect(ids(state)).toEqual(["c", "e"]);
  });

  test("Shift-click selects every row between the anchor and the clicked row, either direction", () => {
    const down = applySessionSelectionClick(EMPTY_SESSION_SELECTION, { target: row("d"), mode: "range", order, open: row("b") });
    expect(ids(down)).toEqual(["b", "c", "d"]);
    const up = applySessionSelectionClick(down, { target: row("a"), mode: "range", order, open: row("b") });
    expect(ids(up)).toEqual(["a", "b"]);
  });

  test("Shift-click ranges from the last Cmd/Ctrl-clicked row", () => {
    const toggled = applySessionSelectionClick(EMPTY_SESSION_SELECTION, { target: row("d"), mode: "toggle", order, open: null });
    const ranged = applySessionSelectionClick(toggled, { target: row("b"), mode: "range", order, open: null });
    expect(ids(ranged)).toEqual(["b", "c", "d"]);
  });

  test("the same session id in another workspace is a different row", () => {
    const mixed = [row("a"), row("a", "w2"), row("b")];
    const state = applySessionSelectionClick(EMPTY_SESSION_SELECTION, { target: row("b"), mode: "range", order: mixed, open: row("a") });
    expect(state.selected).toEqual(mixed);
  });

  test("on-screen order comes from the rows, each listed once", () => {
    document.body.innerHTML = ["a", "b", "a"].map((id) =>
      `<li data-sidebar-session-id="${id}" data-sidebar-session-workspace-id="w1"></li>`).join("");
    const state = applySessionSelectionClick(EMPTY_SESSION_SELECTION, {
      target: row("b"), mode: "range", order: visibleSessionRowOrder(document), open: row("a"),
    });
    expect(ids(state)).toEqual(["a", "b"]);
  });
});

function item(actions: readonly MenuAction[], id: string) {
  const found = actions.find((entry) => entry.type === "item" && entry.id === id);
  if (!found || found.type !== "item") throw new Error(`Missing action ${id}`);
  return found;
}

describe("menu for several selected sessions", () => {
  const base = { count: 3, archivedCount: 0, pinnedCount: 0, onPin: () => {}, onClear: () => {} };

  test("Archive names how many rows it changes and archives", () => {
    const calls: boolean[] = [];
    const actions = buildSelectedSessionsMenuActions({ ...base, archivedCount: 1, onArchive: (archived) => calls.push(archived) });
    const archive = item(actions, "selection-archive");
    expect(archive.label).toBe("Archive 2 sessions");
    archive.onSelect?.();
    expect(calls).toEqual([true]);
  });

  test("an all-archived selection offers Unarchive, an all-pinned one offers Unpin", () => {
    const actions = buildSelectedSessionsMenuActions({ ...base, archivedCount: 3, pinnedCount: 3, onArchive: () => {} });
    expect(item(actions, "selection-archive").label).toBe("Unarchive 3 sessions");
    expect(item(actions, "selection-pin").label).toBe("Unpin 3 sessions");
  });

  test("Move to group only appears for one workspace; Archive only when archiving is wired", () => {
    const without = buildSelectedSessionsMenuActions(base);
    expect(without.some((entry) => entry.type === "item" && (entry.id === "selection-move-to-group" || entry.id === "selection-archive"))).toBe(false);
    const withGroup = buildSelectedSessionsMenuActions({ ...base, group: { groups: [{ id: "g", label: "Review" }], onAssignGroup: () => {} } });
    expect(item(withGroup, "selection-move-to-group").submenu?.some((entry) => entry.type === "item" && entry.id === "group:g")).toBe(true);
    expect(item(withGroup, "selection-clear").label).toBe("Clear selection");
  });
});
