import { expect, test } from "bun:test";

import {
  DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  setWorkspaceLeftSidebarWidth,
  type UiState,
} from "../src/react-app/shell/ui-state-store";

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

test("the left sidebar expands beyond the old 420px ceiling", () => {
  const oldCeiling = 420;
  expect(MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH).toBeGreaterThan(oldCeiling);

  const expanded = setWorkspaceLeftSidebarWidth(uiState(), oldCeiling + 140);
  expect(expanded.workspaceLeftSidebarWidth).toBe(oldCeiling + 140);
});

test("the left sidebar width clamps to its bounds", () => {
  const tooNarrow = setWorkspaceLeftSidebarWidth(uiState(), 40);
  expect(tooNarrow.workspaceLeftSidebarWidth).toBe(MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH);

  const tooWide = setWorkspaceLeftSidebarWidth(uiState(), 10_000);
  expect(tooWide.workspaceLeftSidebarWidth).toBe(MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH);

  const unchanged = uiState({ workspaceLeftSidebarWidth: MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH });
  expect(setWorkspaceLeftSidebarWidth(unchanged, 10_000)).toBe(unchanged);
});
