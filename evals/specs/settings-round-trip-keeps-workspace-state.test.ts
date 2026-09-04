import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

import {
  DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  expandWorkspace,
  persistUiState,
  toggleWorkspaceExpanded,
  type UiState,
} from "../../apps/app/src/react-app/shell/ui-state-store";
import {
  settingsNavigationFromPathname,
  settingsReturnRoute,
} from "../../apps/app/src/react-app/shell/workspace-routes";

// Reported bug: open Settings in OpenWork desktop, come back, and the state of
// which workspaces were "opened" is gone. Two independent causes:
//   1. The sidebar kept expanded workspace groups in component state, and
//      Settings is a separate route that unmounts the sidebar.
//   2. Cmd+, (native menu) and agent settings actions entered Settings on the
//      bare /settings route with no navigation state, so closing Settings could
//      not return to the open session.

function uiState(overrides: Partial<UiState> = {}): UiState {
  return {
    sidebarOpen: true,
    sidePanelState: {},
    expandedWorkspaceIds: [],
    applicationMenuVisible: false,
    workspaceLeftSidebarWidth: DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH,
    workspaceLeftSidebarResizing: false,
    workspaceRightSidebarExpanded: false,
    workspaceRightSidebarExpandedWidth: 520,
    ...overrides,
  };
}

function appSource(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(`../../apps/app/src/${relativePath}`, import.meta.url)), "utf8");
}

test("expanded workspace groups live in the UI store, not in the sidebar component", async ({ evidence }) => {
  // The sidebar must read expansion from the store so unmounting it (Settings
  // is its own route) cannot reset which groups are open.
  const sidebar = appSource("react-app/domains/session/sidebar/app-sidebar.tsx");
  expect(sidebar).toContain("useUiStateStore((state) => state.expandedWorkspaceIds)");
  expect(sidebar).toContain("useUiStateStore((state) => state.toggleWorkspaceExpanded)");
  expect(sidebar).not.toMatch(/useState<Set<string>>/);

  // Store semantics: expanding is idempotent, toggling collapses only the
  // requested group, and other groups are untouched.
  const one = expandWorkspace(uiState(), " ws_a ");
  expect(one.expandedWorkspaceIds).toEqual(["ws_a"]);
  expect(expandWorkspace(one, "ws_a")).toBe(one);
  const two = toggleWorkspaceExpanded(one, "ws_b");
  expect(two.expandedWorkspaceIds).toEqual(["ws_a", "ws_b"]);
  const collapsedA = toggleWorkspaceExpanded(two, "ws_a");
  expect(collapsedA.expandedWorkspaceIds).toEqual(["ws_b"]);

  evidence.recordAssertionEvidence(
    "Sidebar workspace expansion survives the sidebar unmounting",
    "AppSidebar reads expandedWorkspaceIds and its toggles from useUiStateStore instead of a local useState Set; the store reducers add, keep, and remove exactly the requested workspace id.",
    true,
  );
});

test("workspace expansion is session-scoped memory and is never written to disk", async ({ evidence }) => {
  // Negative half: a fresh app load must still start with only the selected
  // workspace open, so the store keeps this in memory only.
  const written: Record<string, string> = {};
  const storage = {
    setItem(key: string, value: string) {
      written[key] = value;
    },
  };
  const previousWindow = Reflect.get(globalThis, "window");
  Reflect.set(globalThis, "window", { localStorage: storage });
  try {
    persistUiState(uiState({ expandedWorkspaceIds: ["ws_a", "ws_b"] }));
  } finally {
    Reflect.set(globalThis, "window", previousWindow);
  }
  const persisted = Object.values(written);
  expect(persisted).toHaveLength(1);
  expect(persisted[0]).not.toContain("expandedWorkspaceIds");
  expect(persisted[0]).not.toContain("ws_a");

  evidence.recordAssertionEvidence(
    "Expanded workspaces are not persisted across app launches",
    "persistUiState writes the UI state blob without expandedWorkspaceIds, so a relaunch still opens only the selected workspace group.",
    true,
  );
});

test("Cmd+, and agent settings actions return to the session they were opened from", async ({ evidence }) => {
  const pathname = "/workspace/ws_a/session/ses_1";

  // Entering Settings from a URL-only caller keeps the workspace in the route
  // and carries the open session in navigation state...
  const entry = settingsNavigationFromPathname(pathname, "general");
  expect(entry.to).toBe("/workspace/ws_a/settings/general");
  expect(entry.state).toEqual({ workspaceId: "ws_a", sessionId: "ses_1" });

  // ...so closing Settings lands on the exact same session.
  expect(settingsReturnRoute("ws_a", entry.state.workspaceId, entry.state.sessionId)).toBe(pathname);

  // Regression guard: the old bare-route entries dropped the session.
  expect(settingsReturnRoute("ws_a", null, null)).toBe("/workspace/ws_a/session");

  // Both URL-only callers must go through the shared helper.
  const appMenu = appSource("react-app/shell/app-menu.tsx");
  const controlProvider = appSource("react-app/shell/control/control-provider.tsx");
  expect(appMenu).toContain("settingsNavigationFromPathname(");
  expect(appMenu).not.toContain('navigate("/settings/general")');
  expect(controlProvider).toContain("settingsNavigationFromPathname(");
  expect(controlProvider).not.toContain('navigate("/settings/general")');
  expect(controlProvider).not.toContain("navigate(`/settings/${panel}`)");

  evidence.recordAssertionEvidence(
    "Native menu and settings.panel.open round-trip back to the open session",
    "settingsNavigationFromPathname produces a workspace-scoped settings route plus {workspaceId, sessionId} state, settingsReturnRoute maps that state back to the originating session route, and app-menu.tsx and control-provider.tsx no longer navigate to the bare /settings route.",
    true,
  );
});

test("the session is not carried into a different workspace's settings", async ({ evidence }) => {
  // Negative half: switching workspace inside Settings must not reopen a
  // session that belongs to the workspace Settings was opened from.
  const entry = settingsNavigationFromPathname("/workspace/ws_a/session/ses_1", "ai");
  expect(settingsReturnRoute("ws_b", entry.state.workspaceId, entry.state.sessionId)).toBe(
    "/workspace/ws_b/session",
  );

  // Routes without a workspace still produce a valid global settings entry.
  expect(settingsNavigationFromPathname("/automations", "general")).toEqual({
    to: "/settings/general",
    state: { workspaceId: "", sessionId: null },
  });
  expect(settingsReturnRoute("", null, null)).toBe("/session");

  evidence.recordAssertionEvidence(
    "Remembered session stays bound to its own workspace",
    "settingsReturnRoute only restores the session when the selected workspace matches the one Settings was opened from; other workspaces and workspace-less routes fall back to their session root.",
    true,
  );
});
