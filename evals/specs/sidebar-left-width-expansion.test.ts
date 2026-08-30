import { expect } from "vitest";
import { test } from "@openwork/testkit";

import {
  DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH,
  setWorkspaceLeftSidebarWidth,
  type UiState,
} from "../../apps/app/src/react-app/shell/ui-state-store";

function uiState(overrides: Partial<UiState> = {}): UiState {
  return {
    sidebarOpen: true,
    sidePanelState: {},
    applicationMenuVisible: false,
    workspaceLeftSidebarWidth: DEFAULT_WORKSPACE_LEFT_SIDEBAR_WIDTH,
    workspaceLeftSidebarResizing: false,
    workspaceRightSidebarExpanded: false,
    workspaceRightSidebarExpandedWidth: 520,
    ...overrides,
  };
}

test("expanding the left sidebar past the old 420px ceiling grants title space", async ({ evidence }) => {
  // The reported bug: dragging the sidebar wider silently did nothing past
  // 420px, so long session and workspace titles stayed clipped and the drag
  // never granted them more room.
  const oldCeiling = 420;
  expect(MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH).toBeGreaterThan(oldCeiling);

  const expanded = setWorkspaceLeftSidebarWidth(uiState(), oldCeiling + 140);
  expect(expanded.workspaceLeftSidebarWidth).toBe(oldCeiling + 140);

  evidence.recordAssertionEvidence(
    "Left sidebar drag-expansion is honored beyond 420px",
    "setWorkspaceLeftSidebarWidth stores a width past the old 420px ceiling instead of silently clamping it, so titles gain the dragged space.",
    true,
  );
});

test("the left sidebar width still clamps to sane bounds", async ({ evidence }) => {
  // Negative half: the wider ceiling must not remove the guardrails.
  const tooNarrow = setWorkspaceLeftSidebarWidth(uiState(), 40);
  expect(tooNarrow.workspaceLeftSidebarWidth).toBe(MIN_WORKSPACE_LEFT_SIDEBAR_WIDTH);

  const tooWide = setWorkspaceLeftSidebarWidth(uiState(), 10_000);
  expect(tooWide.workspaceLeftSidebarWidth).toBe(MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH);

  const unchanged = uiState({ workspaceLeftSidebarWidth: MAX_WORKSPACE_LEFT_SIDEBAR_WIDTH });
  expect(setWorkspaceLeftSidebarWidth(unchanged, 10_000)).toBe(unchanged);

  evidence.recordAssertionEvidence(
    "Left sidebar clamp guardrails survive the wider ceiling",
    "Widths below the minimum and absurdly large widths still clamp, and a no-op update returns the same state object.",
    true,
  );
});
