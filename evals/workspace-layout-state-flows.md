# Workspace layout state flows

End-to-end scenarios for persisted workspace layout state: sidebar sizing,
browser panel sizing, browser open state, and migration from legacy layout keys.
These flows are user-driven because the user expects their workspace layout to
survive navigation, reloads, and upgrades even if implementation storage moves.

## Preflight

1. Start Electron through Daytona or locally.
2. Create or select a local workspace.
3. Open a session route with the sidebar visible.

## Flow 1: Sidebar width persists after reload

**Goal:** A user resizes the workspace sidebar and the width remains stable after
navigation and reload.

### Steps

1. Drag the sidebar resize handle to a noticeably wider width.
2. Navigate to Settings.
3. Return to the session route.
4. Reload the Electron renderer.

### CDP steering

- Prefer pointer events against the visible sidebar resize handle.
- If pointer drag is unreliable, use `browser_eval` to dispatch mouse events to
  the handle and then read the sidebar bounding box.
- Use `location.reload()` for the reload step.

### Verification

- Read the sidebar bounding box before navigation, after returning, and after
  reload.
- Inspect local storage only as supporting evidence, not as the primary pass
  signal.

### Pass criteria

- Sidebar width remains within a small tolerance of the user-selected width.
- The page does not jump back to the default width after reload.
- No console error appears during resize or reload.

## Flow 2: Browser panel width and open state persist

**Goal:** A user opens the browser panel, resizes it, and does not lose that
layout while working.

### Steps

1. Open the browser panel from the right-side rail or browser action.
2. Navigate the browser panel to `https://example.com` if the browser tools are
   available.
3. Resize the browser panel to a visibly different width.
4. Switch sessions or navigate to Settings and back.
5. Reload the renderer.

### CDP steering

- Click the browser rail/action through the UI.
- Use browser tool calls or embedded browser controls to navigate to Example
  Domain.
- Drag the browser panel resize handle with CDP pointer events or synthetic
  mouse events.

### Verification

- Read the browser panel bounding box and visible mode before and after each
  navigation/reload.
- Confirm Example Domain or the browser tab state remains visible when expected.

### Pass criteria

- Browser panel remains open after session navigation.
- Width remains within a small tolerance of the selected width.
- Browser panel sync does not close or resize unexpectedly after reload.

## Flow 3: Legacy layout keys migrate without user-visible reset

**Goal:** A returning user keeps their previous layout after upgrading from the
legacy workspace shell layout storage.

### Steps

1. Before app boot, seed local storage with the legacy workspace layout keys used
   by the prior release for sidebar and browser widths.
2. Launch Electron on the new build.
3. Open a session route.
4. Reload the renderer once.

### CDP steering

- Use `browser_eval` before reload to set legacy local-storage keys if the app
  is already open, then reload.
- Use visible layout measurements rather than relying only on storage shape.

### Verification

- The UI-store-backed layout state contains the migrated values.
- Legacy keys are removed or ignored after migration, depending on the intended
  migration behavior.

### Pass criteria

- Sidebar/browser dimensions match the seeded legacy values.
- Values remain stable after a second reload.
- No layout reset, blank shell, or console migration error appears.

## Flow 4: Layout state is workspace-safe

**Goal:** Changing layout in one workspace does not corrupt the user's ability to
work in another workspace.

### Steps

1. Create Workspace A and Workspace B.
2. In Workspace A, set a wide sidebar and open the browser panel.
3. Switch to Workspace B and use the default or a different layout.
4. Switch back to Workspace A.

### CDP steering

- Use workspace switcher/sidebar controls to move between workspaces.
- Measure sidebar and browser panel dimensions after each switch.

### Verification

- Workspace switching succeeds and no selected workspace id points at a missing
  workspace.
- Layout state remains valid for both workspaces.

### Pass criteria

- Workspace A layout returns when Workspace A is reselected, or the shared
  global layout behavior is consistent with product intent.
- Workspace B remains usable and does not inherit an invalid hidden/zero-width
  shell.
- No console errors from layout store migration or resizing helpers.
