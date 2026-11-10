/** @jsxImportSource react */
import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionActionOptions } from "../src/react-app/domains/session/sidebar/session-action-resolver";
import ts from "typescript";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});
const { sessionAction, sessionActionCatalog, sessionQuickActions } = await import("../src/react-app/domains/session/sidebar/session-action-catalog");
const { resolveSessionActions, resolveWorkbenchActions } = await import("../src/react-app/domains/session/sidebar/session-action-resolver");
const { dispatchMenuAction, serializeMenuActions } = await import("../src/components/ui/action-menu-model");
const { sessionMenuActionsToPalette } = await import("../src/react-app/shell/command-palette-session-actions");
const { SessionQuickActionButton } = await import("../src/react-app/domains/session/sidebar/session-quick-action-button");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

function fixture(overrides: Partial<SessionActionOptions> = {}) {
  const calls: unknown[][] = [];
  const management = { togglePin: (id: string) => { calls.push(["pin", id]); },
    assignGroup: (owner: string, id: string, group: string | null) => { calls.push(["group", owner, id, group]); } };
  const services = { management: () => management,
    onOpenRenameSession: (id: string, owner: string) => { calls.push(["rename", owner, id]); },
    onOpenDeleteSession: (id: string, owner: string) => { calls.push(["delete-dialog", owner, id]); },
    onArchiveSession: (id: string, archived: boolean, owner: string) => { calls.push(["archive-service", owner, id, archived]); },
    onOpenCreateGroupModal: (owner: string) => { calls.push(["create-group", owner]); } };
  return { calls, actions: resolveSessionActions({ target: { workspaceId: "row-owner", sessionId: "same", title: "Captured" },
    surface: "sidebar", isPinned: false, isArchived: false, groups: [], assignedGroupId: null, services, ...overrides }) };
}

describe("session UI catalog projections", () => {
  test("palette ids stay unique and quick projections match their physical slots", () => {
    const ids = Object.values(sessionActionCatalog).flatMap((definition) => definition.palette ? [definition.palette.id] : []);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("session.archive");
    // The Feed has one physical shortcut slot. A new inclusion must update that adapter, not vanish at [0].
    const feedActions = Object.entries(sessionActionCatalog).filter(([, definition]) => definition.feedQuick);
    const legacyActions = Object.entries(sessionActionCatalog).filter(([, definition]) => definition.legacyQuick);
    expect(feedActions.map(([kind]) => kind)).toEqual(["archive"]);
    expect(legacyActions.map(([kind]) => kind)).toEqual(["pin", "archive"]);
  });

  test("future unknown descriptors fail closed with a diagnostic, not the old silent allowlist", () => {
    const diagnostic = spyOn(console, "error").mockImplementation(() => {});
    try {
      const future = { ...sessionAction("pin"), kind: "future-action", id: "future-action" };
      // @ts-expect-error Deliberately simulate an untyped runtime descriptor.
      expect(sessionMenuActionsToPalette([future], "Main", () => {})).toEqual([]);
      expect(diagnostic).toHaveBeenCalledWith("Unmapped session UI action", "future-action");
      // @ts-expect-error Every quick adapter also diagnoses unknown descriptors.
      expect(sessionQuickActions([future], "legacyQuick")).toEqual([]);
      expect(diagnostic).toHaveBeenCalledTimes(2);
    } finally { diagnostic.mockRestore(); }
  });

  test("compiler rejects missing definitions, adapter policy and unknown projection inputs", () => {
    const configPath = new URL("../tsconfig.json", import.meta.url).pathname;
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, new URL("../", import.meta.url).pathname);
    const path = new URL("./session-action-coverage.typecheck.ts", import.meta.url).pathname;
    const program = ts.createProgram([path], parsed.options);
    expect(ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.file?.fileName === path)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
  });
});

describe("bound session state, owner and shipped surface differences", () => {
  test.each([false, true])("menu, native, palette and quick instances preserve pin/archive state (%s)", async (archived) => {
    const { actions, calls } = fixture({ isArchived: archived, isPinned: true });
    const quick = sessionQuickActions(actions, "legacyQuick");
    expect(quick.map((action) => action.id)).toEqual(["pin", "archive"]);
    expect(sessionQuickActions(actions, "feedQuick")).toEqual([quick[1]!]);
    expect(quick.every((action) => actions.includes(action))).toBe(true);
    const palette = sessionMenuActionsToPalette(actions, "Captured", () => {});
    expect(palette.find((action) => action.id === "session.archive")?.title).toBe(quick[1]?.label);
    expect(serializeMenuActions(actions).find((action) => action.type === "item" && action.id === "archive"))
      .toMatchObject({ label: quick[1]?.label, enabled: true });
    await dispatchMenuAction(actions, "archive");
    await dispatchMenuAction(actions, "pin");
    expect(calls).toEqual([["archive-service", "row-owner", "same", !archived], ["pin", "same"]]);
  });

  test("sidebar reason omits Archive everywhere on that row; palette intentionally follows runtime capability", () => {
    const row = fixture({ archiveDisabledReason: "Unsupported runtime" });
    expect(sessionQuickActions(row.actions, "legacyQuick").map((action) => action.id)).toEqual(["pin"]);
    expect(serializeMenuActions(row.actions).some((action) => action.type === "item" && action.id === "archive")).toBe(false);
    expect(sessionMenuActionsToPalette(fixture({ surface: "palette", archiveDisabledReason: "Unsupported runtime" }).actions, "Main", () => {})
      .some((action) => action.id === "session.archive")).toBe(true);
    const disconnected = fixture({ surface: "palette", capabilities: { rename: false, delete: false, archive: false },
      services: { management: () => ({ togglePin: () => {}, assignGroup: () => {} }), requestDialog: () => {}, onArchiveSession: () => {} } });
    expect(sessionMenuActionsToPalette(disconnected.actions, "Main", () => {}).map((action) => action.id)).toEqual(["session.pin.toggle"]);
  });

  test("named palette dialogs freeze main target, close first, and group create stays create-only", async () => {
    const target = { workspaceId: "main-owner", sessionId: "same", title: "Main" };
    const events: unknown[] = [];
    const { actions } = fixture({ target, surface: "palette", capabilities: { rename: true, delete: true, archive: true },
      services: { management: () => ({ togglePin: () => {}, assignGroup: () => { throw new Error("No automatic group assignment"); } }),
        requestDialog: (request) => { events.push(request); }, onOpenCreateGroupModal: (owner) => { events.push(owner); } } });
    target.workspaceId = "now-focused-side-owner";
    sessionMenuActionsToPalette(actions, "Main", () => events.push("close")).find((action) => action.id === "session.delete")?.action();
    await dispatchMenuAction(actions, "new-group");
    expect(events).toEqual(["close", { action: "delete", target: { workspaceId: "main-owner", sessionId: "same", title: "Main" } }, "main-owner"]);
  });
});

describe("workbench intents and quick rendering", () => {
  test.each([undefined, "", "   ", "Raw title"])("row split preserves raw title %j while dialogs retain display fallback", async (sessionTitle) => {
    const { captureSessionActionTarget } = await import("../src/react-app/domains/session/sidebar/session-menu-actions");
    const { getDisplaySessionTitle } = await import("../src/app/lib/session-title");
    const { sessionDialogRequestFromEvent, OPEN_SESSION_ACTION_EVENT } = await import("../src/react-app/shell/session-actions-bus");
    const target = captureSessionActionTarget([
      { workspace: { id: "row-owner" }, sessions: [{ id: "same", title: sessionTitle }] },
    ], "same", "row-owner")!;
    expect(target.title).toBe(getDisplaySessionTitle(sessionTitle));
    const openedTabs: unknown[] = [];
    const splitTabs: unknown[] = [];
    const { actions } = fixture({
      target,
      workbench: {
        primary: { workspaceId: "main-owner", sessionId: "main" },
        secondary: null,
        sessionTitle,
        getState: () => ({
          openTab: (tab) => { openedTabs.push(tab); },
          setSplit: (tab) => { splitTabs.push(tab); },
        }),
      },
    });
    await dispatchMenuAction(actions, "open-split");
    const expectedTab = { ...target, title: sessionTitle, workspaceTitle: "row-owner" };
    expect(openedTabs).toEqual([expectedTab]);
    expect(splitTabs).toEqual([expectedTab]);
    // The dialog bridge still accepts only display-string targets, not raw undefined titles.
    const event = (title: unknown) => new CustomEvent(OPEN_SESSION_ACTION_EVENT, {
      detail: { action: "delete", target: { ...target, title } },
    });
    expect(sessionDialogRequestFromEvent(event(target.title))).toEqual({ action: "delete", target });
    expect(sessionDialogRequestFromEvent(event(undefined))).toBeNull();
    expect(sessionDialogRequestFromEvent(event(1))).toBeNull();
  });

  test("row binding opens the captured explicit owner and closes through the existing non-destructive workbench service", async () => {
    const main = { workspaceId: "main", sessionId: "same" };
    const side = { workspaceId: "side", sessionId: "same" };
    const events: unknown[] = [];
    const workbench = { primary: main, secondary: side, workspaceTitle: " Row workspace ", sessionTitle: "Captured",
      getState: () => ({ openTab: (tab: unknown) => { events.push(["open", tab]); }, setSplit: (tab: unknown) => { events.push(["split", tab]); } }) };
    const row = fixture({ workbench });
    expect(row.actions.map((action) => action.type === "item" ? action.id : "separator")).toEqual([
      "pin", "open-split", "rename", "move-to-group", "archive", "separator", "delete",
    ]);
    await dispatchMenuAction(row.actions, "open-split");
    const expectedTab = { workspaceId: "row-owner", sessionId: "same", title: "Captured", workspaceTitle: "Row workspace" };
    expect(events).toEqual([["open", expectedTab], ["split", expectedTab]]);
    for (const secondary of [side, { workspaceId: "side", sessionId: "draft", draftDestination: { workspaceId: "side" } }]) {
      const mainRow = fixture({ target: { ...main, title: "Main" }, workbench: { ...workbench, secondary } });
      expect(mainRow.actions.some((action) => action.type === "item" && action.id === "open-split")).toBe(false);
      await dispatchMenuAction(mainRow.actions, "close-split");
    }
    expect(events.slice(2)).toEqual([["split", null], ["split", null]]);
  });

  test("row-open excludes both visible owners, chooser does not close palette, new/close do", () => {
    const main = { workspaceId: "main", sessionId: "same" };
    const side = { workspaceId: "side", sessionId: "same" };
    const open = mock(() => {});
    expect(resolveWorkbenchActions({ row: main, primary: main, secondary: side, onOpenRow: open }).length).toBe(0);
    expect(resolveWorkbenchActions({ row: side, primary: main, secondary: side, onOpenRow: open }).length).toBe(0);
    expect(resolveWorkbenchActions({ row: { workspaceId: "other", sessionId: "same" }, primary: main, secondary: side, onOpenRow: open })[0])
      .toMatchObject({ kind: "open-split" });
    const events: string[] = [];
    const items = sessionMenuActionsToPalette(resolveWorkbenchActions({ primary: main, secondary: side,
      onChoose: () => { events.push("choose"); }, onNew: () => { events.push("new"); }, onClose: () => { events.push("close-side"); } }), "", () => events.push("close-palette"));
    expect(items.map((action) => action.id)).toEqual(["open-in-split-view", "new-split", "close-split"]);
    items.forEach((action) => action.action());
    expect(events).toEqual(["choose", "close-palette", "new", "close-palette", "close-side"]);
  });

  test("quick component renders instance metadata, stops row navigation, and guarded dispatch blocks disabled state", async () => {
    const { actions, calls } = fixture({ isArchived: true });
    const action = sessionQuickActions(actions, "feedQuick")[0]!;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const rowNavigation = mock(() => {});
    try {
      await act(async () => root.render(<div onClick={rowNavigation}><SessionQuickActionButton actions={actions} action={action} showTitle data-session-row-archive /></div>));
      const button = host.querySelector("button")!;
      expect(button.getAttribute("aria-label")).toBe(action.label);
      expect(button.title).toBe(action.label);
      expect(button.querySelector("svg")?.classList.contains("lucide-archive-restore")).toBe(true);
      await act(async () => button.click());
      expect(rowNavigation).not.toHaveBeenCalled();
      expect(calls).toEqual([["archive-service", "row-owner", "same", false]]);
      action.disabled = true;
      await act(async () => root.render(<div onClick={rowNavigation}><SessionQuickActionButton actions={actions} action={action} /></div>));
      expect(button.disabled).toBe(true);
      await act(async () => button.click());
      expect(calls).toHaveLength(1);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

});
